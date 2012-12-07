function Client ( ) {
    var bot = this;

    this.conf = require("./configuration.js");
    console.log(JSON.stringify(this.conf));
    this.conf.clientConfig.autoConnect = false;
    this.conf.clientConfig.autoRejoin = false;

    this.irc = require("irc");
    this.con = null;
    this.req = require("request");
    this.util = require("underscore");

    require("colors");

    /** Stored informations */
    this.info = {};

    /** Event Handlers */
    this.handlers = {
        Ready : function () {
            bot.conf.clientConfig.channels.forEach(function (channel) {
               bot.con.join(channel);
               if (bot.handlers.channelMessage[channel]) {
                   bot.con.addListener("message" + channel, bot.handlers.channelMessage[channel]);
               }
            });
            bot.con.addListener("message#", bot.handlers.channelMessage.all);
            bot.perform();
        },
        nickServAuth : function () {
            if (bot.con.connected && bot.opt.nick == bot.conf.nickname) {
                console.log("info", "Sending indentify to NickServ ...".green);
                bot.say("NickServ", "IDENTIFY " + bot.conf.nickserv.password);
            }
        },
        nickServLoggedIn : function () {
            console.log("info", "Logged in to NickServ, performing ready event ...".green);
            bot.con.opt.authed = true;
            bot.handlers.Ready();
        },
        channelMessage : {
            all : function (nick, to, text, message) {
                if (!bot.handlers.channelMessage[to]) {
                    console.log("info", "G [%s] <%s> %s".gray, to, nick, text);
                    //TODO: Gloabl command handlers
                }
            },
            "#ast-4-you" : function (nick, to, text, message) {
                console.log("info", "C [%s] <%s> %s".gray, to, nick, text);
                //TODO: Relay to DataBase
            }
        }
    };

    /** Connect / Reconnect the bot to IRC & MySQL */
    this.connect = function () {
        if (bot.con && bot.con.connected) {
            console.log("info", "Disconnection previous connection ...".yellow);
            bot.disconnect("Reconnecting...", bot.createConnection);
        }
    };

    this.createConnection = function () {
        console.log("info", "Connecting to IRC Server %s ...".cyan, bot.conf.server);

        bot.con = bot.irc.Client(bot.conf.server, bot.conf.nickname, this.conf.clientConfig);

        bot.con.addListener("motd", function (motd) {
            console.log("info", "Received MOTD from Server".cyan);
            if (!bot.conf.nickserv.enabled) {
                bot.handlers.Ready();
                bot.info.motd = motd;
            }
        });

        bot.con.addListener("notice", function (nick, to, text, message) {
            if (bot.conf.nickserv.enabled && to == bot.con.opt.nick && nick == "NickServ") {
                if (text.search(/identify/) != -1) {
                    bot.handlers.nickServAuth();
                }
                if (text.search(/passwort akzeptiert/) != -1) {
                    bot.handlers.nickServLoggedIn();
                }
            }
        });

        bot.con.connect();
        bot.con.opt.authed = false;
    };

    /** Tries to login with whatever Service that is configured */
    this.perform = function () {
        //TODO: Implement performs
    };
}

var Relay = new Client();
Relay.connect();
