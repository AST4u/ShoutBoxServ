var irc = require("irc");
var request = require("request");
var anyDb = require("any-db");
var _ = require("underscore");
var util = require("util");
//var tty = require("tty");
require("colors");

var queryStrings = {
    messagePoll : "select s.id as message_id, s.userid as id, s.username as nick, s.text as message from shoutbox s " +
        "where s.deleted = 0 and s.sticky = 0 " +
        "order by s.date desc limit 10",
    whois : "select * from users where username like $nick limit 1",
    sendQry : "insert into shoutbox (userid, username, date, text) VALUES($id,$nick,$timestamp,$message)"
};

var RelayClient = function ( config ) {
    var bot = this;

    bot.channels = _.clone(config.clientConfig.channels);

    /** Generally override this: */
    config.clientConfig.autoConnect = false;
    config.clientConfig.autoRejoin = false;
    config.clientConfig.channels = [];
    bot.conf = config;

    /** Stored informations */
    _.extend(bot, {
        info: {},
        authed: false,
        users: {},
        db: null
    });

    /** Event Handlers */
    bot.handlers = {
        nickServAuth : function () {
            if (!bot.authed && bot.irc.opt.nick == bot.conf.nickname) {
                bot.log(1, "Auth", "Sending identify command to NickServ.", ["yellow", "cyan"]);
                bot.irc.say("NickServ", "IDENTIFY " + bot.conf.nickserv.password);
            }
        },

        nickServLoggedIn : function () {
            bot.log(1, "Auth", "We are now logged in.", ["yellow", "green"]);
            bot.authed = true;
            bot.ready();
        },

        channelMessage : {
            all : function (nick, to, text, message) {
                if (!bot.handlers.channelMessage[to]) {
                    bot.log(0, "Channel", util.format("[%s] <%s> %s", to, nick, text), ["cyan", "white"]);
                    //TODO: Talk with me?!
                }
            },

            "#ast4u-talk" : function (nick, text, message) {
                var channel = "#ast4u-talk";
                var dbUser = bot.getUser(nick);
                bot.log(0, "Relay", util.format("[%s] <%s> %s (%s)",
                    channel, nick, text, (dbUser.id || 'not-verified')), ["red", "cyan"]);
                //TODO: Relay to DataBase
            }
        },

        privateMessage : function (nick, text, message) {
            bot.log(1, "Query", util.format("<%s> %s", nick, text), ["yellow","cyan"]);
            bot.irc.say(nick, "Okay, ich habe deine Nachricht direkt an das Team geschickt!");
        },

        dbConnected : function (err, adapter) {
            bot.log(1, "Database", "Database connection established!", ["cyan", "green"]);
            bot.db = adapter;
        },

        Error : function (error) {
            bot.log(4, "Fatality", error, ["red","red"]);
        },

        auto_names : function (channel, names) {
            if (_.contains(bot.channels, channel) >= 0) {
                bot.log(1, "Names", util.format("Got names for %s. Processing them now ...", channel), ["cyan", "grey"]);
                bot.log(0, "Names", channel + ": " + _.keys(names).join(', '), ["cyan", "grey"]);
                _.keys(names).forEach(function (nickname) {
                    bot.registerUser(nickname);
                });
            } else {
                bot.log(1, "Names", util.format("Got names for %s but ignoring it!", channel), ["cyan", "grey"]);
            }
        },

        /** Register user */
        auto_join : function (channel, nick, message) { bot.registerUser(nick); },

        /** Forget user */
        auto_part : function (channel, nick, message) { bot.dropUser(nick); },
        auto_kick : function (channel, nick, by, reason, message) { bot.dropUser(nick); },
        auto_quit : function (nick, reason, channels, message) { bot.dropUser(nick); },
        auto_kill : function (nick, reason, channels, message) { bot.dropUser(nick); },

        /** Handle incomming commands */
        command : function(nick, channel, command, args, message) {
            //TODO: Handle commands
        }
    };

    /** Loggin helper, just ignore it. */
    bot.padStr = function (str, num) { while (str.length < num) str += " "; return str; };
    bot.logLevel = ['info','notice','warn','error','fatality','madness','debug'];
    bot.log = function (level, tag, message, colors) {
        var levelName = bot.padStr(bot.logLevel[level] || bot.logLevel[5], 11);
        console.log( levelName.grey + '| ' + ('[' + bot.padStr(tag, 11) + '] ')[colors[0]] + message[colors[1]] );
    };

    /** Connect / Reconnect the bot to IRC & MySQL */
    bot.connect = function () {
        if (bot.irc && bot.irc.connected) {
            bot.log(4, "IRC", "Disconnecting previous connection ...", ["red", "red"]);
            bot.disconnect("Reconnecting...", bot.createConnection);
        } else {
            bot.createConnection();
        }
    };

    /** Print some info */
    bot.log(0, "Boot", "Starting up ...", ["yellow", "gray"]);
    bot.log(0, "Boot",
        util.format("Server: %s:%s %s, Nick: %s",
            bot.conf.server,
            bot.conf.clientConfig.port,
            (bot.conf.clientConfig ? 'SSL' : 'insecure'),
            bot.conf.nickname
        ), ["yellow", "gray"]);

    /** Create the base and connect to IRC & MySQL */
    bot.createConnection = function () {
        bot.log(1, "Server", util.format("Connecting to IRC Server %s ...", bot.conf.server), ["cyan","white"]);

        bot.irc = new irc.Client(bot.conf.server, bot.conf.nickname, bot.conf.clientConfig);

        bot.irc.addListener("error", bot.handlers.Error);
        bot.irc.addListener("message#", bot.handlers.channelMessage.all);
        bot.irc.addListener("pm", bot.handlers.privateMessage);

        _.each(_.keys(bot.handlers), function(handler) {
            if (handler.length >= 6 && handler.substr(0,4) == "auto") {
                var event = handler.substr(5);
                bot.log(1, "Handler", "Installing auto-registered handler for: " + event, ["magenta", "cyan"]);
                bot.irc.addListener(event, bot.handlers[handler]);
            }
        });

        /** NickServ */
        bot.irc.addListener("notice", function (nick, to, text, message) {
            bot.log(1, "Notice", util.format("[%s] <%s> %s", to, nick, text), ["green", "white"]);
            if (bot.conf.nickserv.enabled && to == bot.irc.opt.nick && nick == "NickServ") {
                if (text.search(/identify/i) != -1) {
                    bot.handlers.nickServAuth();
                }
                if (text.search(/passwort akzeptiert/i) != -1) {
                    bot.handlers.nickServLoggedIn();
                }
            }
        });

        var dbConf = bot.conf.dbConfig;
        var dbUrl = util.format("%s://%s:%s@%s/%s", dbConf.driver, dbConf.user, dbConf.password, dbConf.hostname, dbConf.database);
        bot.dbconn = anyDb.createConnection(dbUrl, bot.handlers.dbConnected);

        bot.irc.connect();
        bot.authed = false;
    };

    bot.ready = function () {
        bot.channels.forEach(function (channel) {
            bot.irc.join(channel);
            if (bot.handlers.channelMessage[channel]) {
                bot.log(1, "Handler", "MessageHandler installed for " + channel, ["magenta","white"]);
                bot.irc.addListener("message" + channel, bot.handlers.channelMessage[channel]);
            }
        });

        bot.perform();
    };

    bot.getUser = function (nickname) {
        return _.extend({nickname: nickname}, bot.users[nickname] || {});
    };

    bot.dropUser = function (nickname) {
        if (bot.users[nickname]) {
            delete bot.users[nickname];
        }
    };

    bot.registerUser = function (nickname) {
        bot.log(1, "DB Whois", "Trying to find " + nickname, ["magenta", "white"]);
        bot.whoisUser(nickname, bot.registerUserCallback);
    };

    bot.registerUserCallback = function (nickname, dbRow) {
        bot.users[nickname] = _.extend((bot.users[nickname]|| {}), dbRow);
    };

    /** Perform a whois on an IRC user */
    bot.whoisUser = function (username, callback) {
        var query = bot.db.query(queryStrings.whois, {nick: username});
        var result = false;
        query.on('row', function (row) {
            bot.log(1, "DB Whois", "Possitive hit for " + username, ["magenta", "green"]);
            result = row;
        });
        query.on('end', function () {
            callback(username, result);
        });
    };

    /** Tries to login with whatever Service that is configured */
    bot.perform = function () {
        //TODO: Implement performs
    };
}


var RelayConfig = require("./configuration.js");

var Relay = new RelayClient( RelayConfig );
Relay.connect();
