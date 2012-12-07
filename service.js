var irc = require("irc");
var request = require("request");
var anyDb = require("any-db");
var _ = require("underscore");

require("colors");

var RelayClient = function ( config ) {
    var bot = this;

    bot.channels = _.clone(config.clientConfig.channels);

    /** Generally override this: */
    config.clientConfig.autoConnect = false;
    config.clientConfig.autoRejoin = false;
    config.clientConfig.channels = [];
    bot.conf = config;

    console.log("[ Creating RelayClient ]".grey);
    console.log("Server: %s".yellow, bot.conf.server);
    console.log("Port: %s [%s]".yellow, bot.conf.clientConfig.port, (bot.conf.clientConfig.secure ? "yes".green : "no".red));
    console.log("Nickname: %s", bot.conf.nickname);

    /** Stored informations */
    bot.info = {};

    /** Event Handlers */
    bot.handlers = {
        Ready : function () {
            bot.channels.forEach(function (channel) {
               bot.irc.join(channel);
               if (bot.handlers.channelMessage[channel]) {
                   console.log("[Handler]".magenta + " MessageHandler for %s installed.".green, channel);
                   bot.irc.addListener("message" + channel, bot.handlers.channelMessage[channel]);
               }
            });
            console.log("Connecting to MySQL DataBase ...".yellow);
            var dbUrl = bot.conf.dbConfig.driver + "://" + bot.conf.dbConfig.user + ":" + bot.conf.dbConfig.password + "@" + bot.conf.dbConfig.hostname + "/" + bot.conf.dbConfig.database;
            bot.db = anyDb.createConnection(dbUrl, bot.handlers.dbConnected);
            bot.perform();
        },
        nickServAuth : function () {
            if (bot.irc.opt.nick == bot.conf.nickname) {
                console.log("Sending indentify to NickServ ...".green);
                bot.irc.say("NickServ", "IDENTIFY " + bot.conf.nickserv.password);
            }
        },
        nickServLoggedIn : function () {
            console.log("Logged in to NickServ, performing ready event ...".green);
            bot.irc.opt.authed = true;
            bot.handlers.Ready();
        },
        channelMessage : {
            all : function (nick, to, text, message) {
                if (!bot.handlers.channelMessage[to]) {
                    console.log("G [%s] <%s> %s".gray, to, nick, text);
                    //TODO: Gloabl command handlers
                }
            },
            "#ast-4-you" : function (nick, to, text, message) {
                console.log("C [%s] <%s> %s".gray, to, nick, text);
                //TODO: Relay to DataBase
            }
        },
        privateMessage : function () {

        },
        dbConnected : function () {
            console.log("Database connection established!".green);
            console.log(arguments);
        },
        Error : function (error) {
            console.log(error.red);
        }
    };

    /** Connect / Reconnect the bot to IRC & MySQL */
    bot.connect = function () {
        if (bot.irc && bot.irc.connected) {
            console.log("Disconnection previous connection ...".yellow);
            bot.disconnect("Reconnecting...", bot.createConnection);
        } else {
            bot.createConnection();
        }
    };

    bot.createConnection = function () {
        console.log("Connecting to IRC Server %s ...".cyan, bot.conf.server);

        bot.irc = new irc.Client(bot.conf.server, bot.conf.nickname, bot.conf.clientConfig);

        bot.irc.addListener("error", bot.handlers.Error);
        bot.irc.addListener("message#", bot.handlers.channelMessage.all);
        bot.irc.addListener("pm", bot.handlers.privateMessage);

        bot.irc.addListener("motd", function (motd) {
            console.log("Received MOTD from Server".cyan);
            if (!bot.conf.nickserv.enabled) {
                console.log("Running early Ready ...".magenta);

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

        bot.irc.connect();
        bot.irc.opt.authed = false;
    };

    /** Tries to login with whatever Service that is configured */
    bot.perform = function () {
        //TODO: Implement performs
    };
}

var RelayConfig = require("./configuration.js");

var Relay = new RelayClient( RelayConfig );
Relay.connect();
