function Client ( ) {
    var bot = this;

    this.conf = require("./configuration.js");
    this.conf.clientConfig.autoConnect = false;
    this.conf.clientConfig.autoRejoin = false;

    this.irc = require("irc");
    this.con = null;
    this.colr = require("colors");
    this.req = require("request");
    this.util = require("underscore");

    /** Stored informations */
    this.info = {};

    /** Event Handlers */
    this.handlers = {
        Ready : function () {
            bot.performLogin();
        },
        authNickServ : function () {
            if (bot.con.connected && bot.opt.nick == bot.conf.nickname) {
                bot.say("NickServ", "IDENTIFY " + bot.conf.nickserv.password);
            }
        }
    };

    /** Connect the bot to IRC & MySQL */
    this.connect = function () {
        bot.con = bot.irc.Client(bot.conf.server, bot.conf.nickname, this.conf.clientConfig);
        this.con.addListener("motd", function (motd) {
            bot.handlers.Ready();
            bot.info.motd = motd;
        });
        this.con.addListener("notice", function (nick, to, text, message) {
            if (bot.conf.nickserv.enabled && to == bot.con.opt.nick && nick == "NickServ") {
                bot.handlers.authNickServ();
            }
        });
        this.con.connect();
    };

    /** Tries to login with whatever Service that is configured */
    this.performLogin = function () {

    };
}

