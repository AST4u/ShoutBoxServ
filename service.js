var irc = require("irc");
var request = require("request");
var anyDb = require("any-db");
var _ = require("underscore");
var util = require("util");
require("colors");

var query = {
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

    console.log("I [Boot] [ Creating RelayClient ]".grey);
    console.log("I [Boot] ** Server: %s".yellow, bot.conf.server);
    console.log("I [Boot] ** Port: %s %s".yellow, bot.conf.clientConfig.port, (bot.conf.clientConfig.secure ? "SSL".green : "insecure".red));
    console.log("I [Boot] ** Nickname: %s".yellow, bot.conf.nickname);

    /** Stored informations */
    bot.info = {};

    /** Event Handlers */
    bot.handlers = {
        Ready : function () {
            bot.channels.forEach(function (channel) {
                bot.irc.join(channel);
                if (bot.handlers.channelMessage[channel]) {
                    console.log("H [Handler]".cyan + " MessageHandler for %s installed.", channel);
                    bot.irc.addListener("message" + channel, bot.handlers.channelMessage[channel]);
                }
            });
            console.log("I [DB]".red + " Connecting to MySQL DataBase ...".yellow);
            var dbUrl = bot.conf.dbConfig.driver + "://" + bot.conf.dbConfig.user + ":" + bot.conf.dbConfig.password + "@" + bot.conf.dbConfig.hostname + "/" + bot.conf.dbConfig.database;
            bot.info.dbconn = anyDb.createConnection(dbUrl, bot.handlers.dbConnected);
            bot.perform();
        },
        nickServAuth : function () {
            if (bot.irc.opt.nick == bot.conf.nickname) {
                console.log("A [Auth]".yellow + " Sending indentify to NickServ ...");
                bot.irc.say("NickServ", "IDENTIFY " + bot.conf.nickserv.password);
            }
        },
        nickServLoggedIn : function () {
            console.log("A [Auth]".yellow + " Logged in to NickServ, performing ready event ...".green);
            bot.irc.opt.authed = true;
            bot.handlers.Ready();
        },
        channelMessage : {
            all : function (nick, to, text, message) {
                if (!bot.handlers.channelMessage[to]) {
                    console.log("G [%s] <%s> %s".grey, to, nick, text);
                    //TODO: Gloabl command handlers
                }
            },
            "#ast4u-talk" : function (nick, text, message) {
                console.log("R [%s/%s] <%s> %s".cyan,
                    '#ast4u-talk',
                    (bot.info.users[nick] ? 'OKAY' : 'FAIL'),
                    nick,
                    text);
                //TODO: Relay to DataBase
            }
        },
        privateMessage : function (nick, text, message) {
            console.log("Q [Query]".blue + " <%s> %s", nick, text);
            bot.irc.say(nick, "Okay, ich habe deine Nachricht direkt an das Team geschickt!");
            //var user = bot.whoisUser(nick);
        },
        names : function (channel, names) {
            if (bot.channels.indexOf(channel) >= 0) {
                //console.log(names);
                console.log("I [%s] Users: %s".cyan, channel, Objekt.keys(names).join(', '));
                Object.keys(names).forEach(function (user) {
                    bot.irc.whois(user);
                });
            } else {
                console.log("I [%s] Dropping info, i don't care.".yellow, channel);
            }
        },
        channelJoin : function (channel, nick, message) {
            bot.irc.whois(nick);
        },
        channelPart : function (channel, nick, reason, message) {
            if (bot.info.users[nick]) {
                delete bot.info.users[nick];
            }
            //TODO: Channel left -> SB
        },
        userQuit : function (nick, reason, channels, message) {
            if (bot.info.users[nick]) {
                delete bot.info.users[nick];
            }
            //TODO: Channel quit -> SB
        },
        whois : function (who) {
            bot.whoisUser(who, bot.handlers.joinWhois);
        },
        joinWhois : function (user, isFound) {
            if (isFound) {
                bot.info.users[user.username] = user;
            }
        },
        dbConnected : function (err, adapter) {
            console.log("I [DB]".cyan + " Database connection established!".green);
            bot.info.db = adapter;
        },
        Error : function (error) {
            console.log("! [Fatality]".red + (" " + error).yellow.bold);
        }
    };

    /** Connect / Reconnect the bot to IRC & MySQL */
    bot.connect = function () {
        if (bot.irc && bot.irc.connected) {
            console.log("! [Fatality]".red + " Disconnecting previous connection ...".yellow);
            bot.disconnect("Reconnecting...", bot.createConnection);
        } else {
            bot.createConnection();
        }
    };

    bot.createConnection = function () {
        console.log("S [Server] Connecting to IRC Server %s ...".cyan, bot.conf.server);

        bot.irc = new irc.Client(bot.conf.server, bot.conf.nickname, bot.conf.clientConfig);

        bot.irc.addListener("error", bot.handlers.Error);
        bot.irc.addListener("message#", bot.handlers.channelMessage.all);
        bot.irc.addListener("pm", bot.handlers.privateMessage);

        bot.irc.addListener("join", bot.handlers.channelJoin);
        bot.irc.addListener("part", bot.handlers.channelPart);
        bot.irc.addListener("quit", bot.handlers.userQuit);
        bot.irc.addListener("names", bot.handlers.names);

        bot.irc.addListener("motd", function (motd) {
            console.log("S [Server] Received MOTD from Server".cyan);
            if (!bot.conf.nickserv.enabled) {
                console.log("? [Madness] Running early Ready ...".magenta);

                bot.handlers.Ready();
                bot.info.motd = motd;
            }
        });

        bot.irc.addListener("notice", function (nick, to, text, message) {
            console.log("N [%s] <%s> %s".magenta, to, nick, text);
            if (bot.conf.nickserv.enabled && to == bot.irc.opt.nick && nick == "NickServ") {
                if (text.search(/identify/i) != -1) {
                    bot.handlers.nickServAuth();
                }
                if (text.search(/passwort akzeptiert/i) != -1) {
                    bot.handlers.nickServLoggedIn();
                }
            }
        });

        bot.info.users = {};

        bot.irc.connect();
        bot.irc.opt.authed = false;
    };

    bot.whoisUser = function (username, callback) {
        if (bot.info.db) {

            var whois = bot.info.db.query(query.whois, {nick: username});
            whois.fired = false;
            whois.on('row', function (row) {
               whois.fired = true;
               callback(row, true);
            });
            whois.on('end', function () {
               if (!whois.fired) {
                   callback(username);
               }
            });
        }
    };
    /** Tries to login with whatever Service that is configured */
    bot.perform = function () {
        //TODO: Implement performs
    };
}

var RelayConfig = require("./configuration.js");

var Relay = new RelayClient( RelayConfig );
Relay.connect();
