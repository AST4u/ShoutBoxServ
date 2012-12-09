var irc = require("irc");
var request = require("request");
var anyDb = require("any-db");
var _ = require("underscore");
var util = require("util");
require("colors");

var queryStrings = {
    messagePoll : "SELECT s.id AS messageId, s.userid as id, s.username as nick, s.text as message FROM shoutbox s " +
        "WHERE s.deleted = 0 AND s.sticky = 0 " +
        "ORDER BY s.date DESC LIMIT 10",

    whois : "SELECT * FROM users WHERE username LIKE $nick AND enabled = 'yes' AND parked = 'no' LIMIT 1",

    sendQry : "INSERT INTO shoutbox (userid, username, date, text) VALUES($id,$nick,$timestamp,$message)",

    login: "SELECT u.id, u.username, u.class " +
        "FROM irc_relayusers r " +
        "LEFT JOIN users u ON u.id = r.id " +
        "WHERE (r.irckey = UNHEX($key) OR r.ident = SHA1($ident))" +
        "AND u.enabled = 'yes' AND u.parked = 'no' " +
        "LIMIT 1",

    updateIdent: "UPDATE irc_relayusers SET ident = SHA1($ident) WHERE irckey = UNHEX($key) LIMIT 1",
    removeKey: "DELETE FROM irc_relayusers WHERE id = $id LIMIT 1",
    selectKey: "SELECT HEX(irckey) as irckey, id FROM irc_relayusers WHERE irckey = $key LIMIT 1",
    createKey: "INSERT INTO irc_relayusers (id,irckey) VALUES ($id,UNHEX($key))",
    sendPM: "INSERT INTO messages (sender,receiver,folder_in,folder_out,added,read_date,subject,msg,unread) VALUES " +
        "(0,$id,-1,0,CURDATE(),NULL,'IRC Shoutbox Key',$msg,'yes')"
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
        db: null,
        pollid: false,
        lookup: {}
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
                if (bot.conf.ignore.indexOf(nick) != -1) {
                    return;
                }
                var cmdParams = text.split(/\s+/);
                var command = cmdParams.splice(0,1)[0];
                var prefix = command.substr(0,1);
                command = command.substr(1);
                if (prefix == "@" && bot.commands[command]) {
                    bot.log(1, "Command", command + " called from " + to, ["magenta", "cyan"]);
                    bot.commands[command](to, nick, cmdParams, text, message);
                } else {
                    if (!bot.handlers.channelMessage[to]) {
                        bot.log(0, "Channel", util.format("[%s] <%s> %s", to, nick, text), ["cyan", "white"]);
                    } else {
                        bot.handlers.channelMessage[to](nick, to, text, message);
                    }
                }
            },

            "#ast4u-talk" : function (nick, to, text, message) {
                var dbUser = bot.getUser(nick);
                bot.log(0, "Relay", util.format("[%s] <%s> %s (%s)",
                    to, nick, text, (dbUser.id || 'not-verified')), ["magenta", "white"]);
                bot.db.query(queryStrings.sendQry, {
                    id: dbUser.id || -1,
                    nick: (dbUser.id ? dbUser.username : 'IRC ' + nick),
                    timestamp: Math.floor(new Date().getTime() / 1000),
                    message: text
                });
            }
        },

        privateMessage : function (nick, text, message) {
            var cmdParams = text.split(/\s+/);
            var command = cmdParams.splice(0,1)[0];
            if (bot.commands[command]) {
                bot.commands[command](false, nick, cmdParams, text, message);
            } else {
                bot.log(1, "Query", util.format("<%s> %s", nick, text), ["yellow","cyan"]);
                bot.irc.say(nick, "Okay, ich habe deine Nachricht direkt an das Team geschickt!");
            }
        },

        dbConnected : function (err, adapter) {
            bot.log(1, "Database", "Database connection established!", ["cyan", "green"]);
            bot.db = adapter;
        },

        dbDisconnected : function () {
            bot.log(2, "MySQL", "Connection closed!", ["cyan","red"]);
            bot.db = undefined;
            bot.dbconn = undefined;
        },

        Error : function (error) {
            bot.log(5, "Fatality", error, ["red","red"]);
        },

        auto_names : function (channel, names) {
            if (_.contains(bot.channels, channel) >= 0) {
                bot.log(1, "Names", util.format("Got names for %s. Processing them now ...", channel), ["cyan", "grey"]);
                bot.log(0, "Names", channel + ": " + _.keys(names).join(', '), ["cyan", "grey"]);
                _.keys(names).forEach(function (nickname) {
                    //bot.registerUser(nickname);
                    if (nickname != bot.irc.opt.nick) {
                        bot.irc.send("mode", channel, "-v", nickname);
                        bot.irc.whois(nickname);
                    }
                });
            } else {
                bot.log(1, "Names", util.format("Got names for %s but ignoring it!", channel), ["cyan", "grey"]);
            }
        },

        /** Register user */
        //auto_join : function (channel, nick, message) { bot.registerUser(nick); },
        auto_join : function (channel, nick, message) {
            if (nick == bot.irc.opt.nick) {
                bot.log(1, "Join", channel, ["green","white"]);
            } else {
                bot.irc.whois(nick);
            }
        },

        /** Forget user */
//        auto_part : function (channel, nick, message) { bot.dropUser(nick); },
//        auto_kick : function (channel, nick, by, reason, message) { bot.dropUser(nick); },
//        auto_quit : function (nick, reason, channels, message) { bot.dropUser(nick); },
//        auto_kill : function (nick, reason, channels, message) { bot.dropUser(nick); },

        /** Nickchange */
        auto_nick : function (oldnick, newnick, channels, message) {
            bot.users[newnick] =  bot.users[oldnick];
            bot.irc.whois(newnick);
        },

        auto_whois : function (who) {
            var ident = bot.makeIdent(who);

            if (!bot.users[who.nick] && !bot.lookup[ident]) {
                bot.log(1, "Whois", who.nick + " set= " + ident, ["green","white"]);
                bot.users[who.nick] = ident;
                bot.lookup[ident] = who;
            } else {
                bot.log(1, "Whois", who.nick + " restored= " + ident, ["green","green"]);
            }
            bot.identifyUserByIdent(who.nick, ident);
        }
    };

    bot.commands = {
        whoami : function (channel, nick, params, text, message) {
            var user = bot.getUser(nick);
            var tell = (channel ? 'say' : 'notice');
            if (user && user.id) {
                bot.irc[tell](channel || nick, util.format("%s: %s [%s] https://ast-4-you.senshi.jp/userdetails.php?id=%s",
                    nick, user.username, bot.conf.ranks[user.class] || 'MADNESS', user.id));
            } else {
                bot.irc[tell](channel || nick, nick + ": Hmmm...? Mag ihhh neeet D:");
            }
        },
        login : function (channel, nick, params, text, message) {
            if (channel) {
                if (params.length > 0) {
                    bot.log(2, "Security", util.format("IRC-Key von %s wird neu generiert! (Channel Message)", nick),
                        ["red","yellow"]);
                    bot.recreateUser(params[0]);
                } else {
                    bot.irc.say(channel, "Stopp, " + nick + "!!! Du musst mir deinen Key privat schreiben! " +
                        "/msg " + bot.irc.opt.nick + " login <irc-key>");
                }
            } else {
                if (params.length > 0) {
                    bot.identifyUser(nick, params[0]);
                } else {
                    bot.irc.notice(nick, "Syntax: login <irc-key>");
                }
            }
        },
        getkey : function (channel, nick, params, text, message) {
            bot.createUser(nick, params.join(" "));
        },
        fuckoff : function (channel, nick, params, text, message) {
            var user = bot.getUser(nick);
            if (user && user.class >= 105) {
                bot.quit("Fucking off... :'(");
            } else {
                if (channel) {
                    bot.irc.say(channel, "Fuck off, yourself!");
                } else {
                    bot.irc.notice(nick, "1 + 1 = 2 ... hm? Man bin ich gut!");
                }

            }
        },
        help : function (channel, nick, params, text, message) {
            _.keys(bot.commands).forEach(function(cmd) {
                bot.irc.notice(nick, "Command: @" + cmd);
            });
            bot.irc.notice(nick, "Für details: @help <command>");
        }
    };

    /** Loggin helper, just ignore it. */
    bot.padStr = function (str, num) { while (str.length < num) str += " "; return str; };
    bot.logLevel = ['info','notice','warn','error','fatality','madness','debug'];
    bot.log = function (level, tag, message, colors) {
        if (level >= bot.conf.loglevel) {
            var levelName = bot.padStr(bot.logLevel[level] || bot.logLevel[5], 11);
            if (level >= 2) {
                levelName = levelName.yellow
            } else if(level >= 4) {
                levelName = levelName.red
            } else if(level == 6) {
                levelName = levelName.red.inverse;
            } else if (level < 1) {
                levelName = levelName.grey
            } else {
                levelName = levelName.cyan
            }
            if (util.isError(message)) {
                util.error( "    >>>>> EXCEPTION <<<<<     ".red.inverse, message, "    >>>>> CONTINUE! <<<<<     ".blue.inverse);
            } else {
                util.log( levelName + ("[" + bot.padStr(tag, 11) + "]")[colors[0]]
                    + " " + message[colors[1]] );
            }
        }
    };

    /** Print some info */
    bot.log(0, "Boot", "Starting up ...", ["yellow", "grey"]);
    bot.log(0, "Boot",
        util.format("Server: %s:%s %s, Nick: %s",
            bot.conf.server,
            bot.conf.clientConfig.port,
            (bot.conf.clientConfig ? "SSL".green : "insecure".red),
            bot.conf.nickname
        ), ["yellow", "grey"]);

    /** Connect / Reconnect the bot to IRC & MySQL */
    bot.connect = function () {
        if (bot.dbconn) {
            bot.dbconn.end();
        }
        if (bot.irc && bot.irc.conn.connected) {
            bot.log(4, "IRC", "Disconnecting previous connection ...", ["red", "red"]);
            bot.irc.disconnect("Reconnecting...", function () { bot.createConnection(); });
        } else {
            bot.createConnection();
        }

    };

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
        var notice = function (nick, to, text, message) {
            //bot.log(1, "Notice", util.format("[%s] <%s> %s", to, nick, text), ["green", "white"]);
            if (bot.conf.nickserv.enabled && to == bot.irc.opt.nick && nick == "NickServ") {
                if (text.search(/identify/i) != -1) {
                    bot.handlers.nickServAuth();
                }
                if (text.search(/passwort akzeptiert/i) != -1) {
                    bot.handlers.nickServLoggedIn();
                    bot.irc.removeListener("notice", notice);
                }
            }
        }
        bot.irc.addListener("notice", notice);

        var dbConf = bot.conf.dbConfig;
        var dbUrl = util.format("%s://%s:%s@%s/%s", dbConf.driver, dbConf.user, dbConf.password, dbConf.hostname, dbConf.database);
        bot.dbconn = anyDb.createConnection(dbUrl, bot.handlers.dbConnected);
        bot.dbconn.on("end", bot.handlers.dbDisconnected);

        setTimeout(function() { bot.irc.connect(); bot.irc.conn.setEncoding("ISO-8859-1"); }, 1500);
        bot.authed = false;
    };

    bot.quit = function (message) {
        bot.log(3, "Quit", message, ["magenta","yellow"]);
        if (bot.irc && bot.irc.conn.connected) {
            bot.irc.disconnect(message, function() {
                //process.send({type: "end"});
                process.nextTick(function() {
                    process.exit();
                });
            });
        } else {
            //process.send({type: "end"});
            process.nextTick(function() {
                process.exit();
            });
        }
    };

    bot.restart = function() {
        bot.log(3, "Restart", "Restarting ...", ["magenta", "cyan"]);
        bot.irc.disconnect("Restarting ...", function() {
            //process.send("restart");
            process.nextTick(function() {
                process.exit();
            });
        });
    };

    bot.ready = function () {
        bot.channels.forEach(function (channel) {
            bot.irc.join(channel);
        });
        bot.perform();
    };

    bot.broadcast = function (text) {
        if (bot.irc && bot.irc.conn.connected) {
            bot.log(1, "Broadcast", text, ["inverse","white"]);
            bot.channels.forEach(function (channel) {
                bot.irc.say(channel, text);
            });
        }
    };

    bot.makeIdent = function (who) {
        return _.chain(who).pick("host", "user", "realname").values().value()
            .join("").replace(/[^a-z0-9]+/ig,"").toLowerCase();
    };

    bot.getUser = function (nickname, callback) {
        if (bot.users[nickname]) {
            return bot.lookup[ bot.users[nickname] ];
        }
        bot.irc.whois(nickname, function(who) {
            bot.handlers.auto_whois(who);
            if (typeof callback == "function") {
                callback(bot.getUser(nickname));
            }
        });
        return false;
    };

    bot.recreateUser = function(nickname, irckey) {
        bot.db.query(queryStrings.selectKey, {key: irckey}).on('row', function (row) {
            bot.db.query("SELECT username FROM users WHERE id = $1", [row.id]).on('row', function (row) {
                bot.irc.notice(nickname, "Oh, nein! Ich habe dir einen neuen Key per PM zugeschickt, nächstes mal bitte als" +
                    " private Nachricht an mich schicken! /msg " + bot.irc.opt.nick + " login <irc-key>");
                bot.createUser(nickname, row.username);
            });
        });
    };

    bot.createUser = function (nickname, username) {
        var next = _.once(bot.createUserEnd);
        bot.db.query(queryStrings.whois, {nick: username}).on('row', function (row) {
            next(row, nickname, username);
        }).on('end', function() {
            next(false, nickname, username);
        });
    };

    bot.createUserEnd = function(result, nickname, username) {
        if (result) {
            var key = "";
            var chars = "0123456789ABCDEF";
            while (key.length < 16) {
                key += chars.charAt(_.random(0,15));
            }
            bot.db.query(queryStrings.removeKey, {id: result.id});
            bot.db.query(queryStrings.sendPM, {
                id: result.id,
                msg: "Dein IRC Key: " + key
            }).on('end', function() {
                bot.irc.notice(nickname, "Du hast deinen Key als PM auf dem Tracker erhalten.");
            });
            bot.db.query(queryStrings.createKey, {id: result.id, key: key});
        } else {
            bot.irc.notice(nickname, util.format("Ich kann %s leider nicht finden, überprüfe den Usernamen.", username));
        }
    };

    bot.identifyUser = function (nickname, irckey) {
        var finish = _.once(function (success) {
            bot.applyUserStatus(nickname, success);
            if (success) {
                bot.log(1, "Identify", nickname + " hat sich erfolglreich eingeloggt!", ["green", "green"]);
            }
            bot.irc.notice(nickname, "Login " + (success ? "war erfolgreich!" : "ist fehltgeschlagen."));
        });
        bot.db.query(queryStrings.login, {key: irckey, ident: ''}).on('row', function (row) {
            var ident = bot.users[nickname];
            bot.lookup[ident] = _.extend(bot.lookup[ident] || {}, row);
            bot.db.query(queryStrings.updateIdent, {ident: ident, key: irckey});
            finish(true);
        }).on('end', function() { finish(false); });
    };

    bot.identifyUserByIdent = function(nickname, ident) {
        bot.db.query(queryStrings.login, {key: 'FF', ident: ident}).on('row', function (row) {
            var ident = bot.users[nickname];
            bot.lookup[ident] = _.extend(bot.lookup[ident], row);
            bot.log(1, "Identify", nickname + " wurde erkannt!", ["green", "cyan"]);
            bot.applyUserStatus(nickname, true);
        });
    };

    bot.applyUserStatus = function (nickname, set) {
        bot.channels.forEach(function (channel) {
            bot.irc.send("mode", channel, (set ? "+" : "-") + "v", nickname);
        });
    };

    /** Tries to login with whatever Service that is configured */
    bot.perform = function () {
        //TODO: Implement performs
    };
};


var RelayConfig = require("./configuration.js");

var Relay = new RelayClient( RelayConfig );
Relay.connect();

process.on("SIGINT", function() {
    Relay.connect();
});


//process.on("message", function(comSignal) {
//    util.log("[ Child Message ] Control message received: ", comSignal);
//    switch (comSignal.command) {
//        case "stop":
//            Relay.quit("Exit on request! Good bye.");
//            break;
//        case "restart":
//            Relay.restart();
//            break;
//        case "start":
//            Relay.connect();
//            break;
//        case "message":
//            console.log(comSignal.content);
//            Relay.broadcast(comSignal.content);
//            break;
//    }
//});