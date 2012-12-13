var irc = require("irc");
var anyDb = require("any-db");
var _ = require("underscore");
var util = require("util");
var readline = require("readline");
var utf8 = require("utf8");
var queryStrings = require("./query_strings.json");
var fs = require("fs");
require("colors");


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
        lastMsgId: 0,
        lookup: {},
        addons: {}
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
                if (channel == bot.conf.poller.channel) {
                    bot.startPolling(bot.conf.poller.interval);
                }
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
            if (channel == "__shorthelp")
                return "Zeigt deinen Identifikations-Status an.";
            if (channel == "__help")
                return ["Beispiel: @whoami"];

            var user = bot.getUser(nick);
            var tell = (channel ? 'say' : 'notice');
            if (user && user.id) {
                bot.irc[tell](channel || nick, util.format("%s: %s [%s] https://ast-4-you.senshi.jp/userdetails.php?id=%s",
                    nick, user.username, bot.conf.ranks[user.class] || 'MADNESS', user.id));
            } else {
                bot.irc[tell](channel || nick, nick + ": Hmmm...? Mag ihhh neeet D:");
            }
            return true;
        },
        login : function (channel, nick, params, text, message) {
            if (channel == "__shorthelp")
                return "Identifiziert dich mit deinem IRC-Key (@help getkey) im ShoutBox-Relay.";
            if (channel == "__help")
                return [
                    "Ein Relay ist eine Weiterleitung/Durchschaltung zwischen 2 Endpunkten,",
                    "was in unserem Fall bedeutet, dass IRC und Shoutbox miteinander verbunden werden.",
                    "Beispiel: /msg " + bot.irc.opt.nick + " login <irc-key>"
                ];

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
            return true;
        },
        getkey : function (channel, nick, params, text, message) {
            if (channel == "__shorthelp")
                return "Fordert einen IRC-Key an. Siehe '@help getkey' für details.";
            if (channel == "__help")
                return [
                    "Hi, " + nick + ", mit diesem Kommando forderst du deinen IRC Key an,",
                    "dieser ist wie dein Passkey ein persönliches Geheimnis!",
                    irc.colors.wrap("red", "Es wird dir auf dem Tracker eine PM mit dem Key zugestellt."),
                    irc.colors.wrap("bold", "In der PM findest du weitere Anweisungen!"),
                    "Beispiel: @getkey <tracker-user>"
                ];
            bot.createUser(nick, params.join(" "));
            return true;
        },
        fuckoff : function (channel, nick, params, text, message) {
            if (channel == "__shorthelp")
                return "Nichts für dich :P";
            if (channel == "__help")
                return ["Verwendung: @fuckoff"];

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
            return true;
        },
        help : function (channel, nick, params, text, message) {
            if (channel == "__shorthelp")
                return "Diese Hilfe...!?";
            if (channel == "__help")
                return ["Verwendung: @help command - für Details"];

            if (params.length <= 0) {
                _.keys(bot.commands).forEach(function(cmd) {
                    bot.irc.notice(nick, "Command: @" + cmd + " - " + irc.colors.wrap("bold",bot.commands[cmd]("__shorthelp", nick)));
                });
                bot.irc.notice(nick, "Für details: @help <command>");
            } else {
                if (bot.commands[params[0]]) {
                    bot.irc.notice(nick, "Command: @" + params[0]);
                    bot.irc.notice(nick, bot.commands[params[0]]("__shorthelp", nick));
                    bot.commands[params[0]]("__help", nick).forEach(function (line) {
                        bot.irc.notice(nick, "- " + line);
                    });
                } else {
                    bot.irc.notice(nick, "Das Kommando kennen ich nicht!");
                }
            }
            return true;
        }
    };

    bot.ctcpVersionReply = function (from, to) {
        bot.irc.ctcp(from, "VERSION", "AST4u ShoutBox Version " + bot.version + " - ")
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
            util.log( levelName + ("[" + bot.padStr(tag, 11) + "]")[colors[0]]
                + " " + (message[colors[1]]).toString() );
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

    /** Imports and registers Addons */
    bot.autoImportAddons = function () {
        fs.readdir("./lib", function (addons) {
            addons.forEach(function (moduleFile) {
                if (moduleFile.match(/\.js$/i)) {
                    var mod = require("./lib/" + moduleFile);
                    bot.loadModule(mod, moduleFile);
                }
            });
        });
    };

    /** Safely load a module */
    bot.loadModule = function (mod, source) {
        if (mod.name && mod.version && mod.addon) {
            if (!bot.addons[name]) {
                bot.addons[name].module = mod;
                /** Events */
                if (mod.addon.events) {
                    var events = [];
                    _.each(mod.addon.events, function (handlers, event) {
                        _.each(handlers, function (callback, index) {
                            bot.irc.addListener(event, callback);
                            events.push(event + ":" + index);
                        });
                    });
                    bot.log(1, mod.name, "Registered events: " + events.join(", "), ["magenta","green"]);
                }
                /** Commands */
                if (mod.addon.commands) {
                    bot.log(1, mod.name, "Registering commands: " + _.keys(mod.addon.commands).join(", "), ["magenta","green"]);
                } else {
                    bot.log(0, mod.name, "Has no commands.", ["magenta","grey"]);
                }
                /** Extending the base  */
                if (mod.addon.base) {
                    _.each(mod.addon.base, function (func, on, self) {
                        if (!bot[on]) {
                            bot.log(1, mod.name, "Hooking RelayClient." + on + " into the base.", ["magenta","white"]);
                            bot[on] = self[on];
                        } else {
                            if (bot.conf.allowOverrides) {
                                bot.log(2, mod.name, "Overriding RelayClient." + on +
                                    " because config.allowOverrides is 'true'.", ["magenta","yellow"]);
                                //bot["original_" + on] = bot[on].bind(bot);
                                bot[on] = _.wrap(bot[on], function(parent) {
                                    parent.apply(bot, arguments);
                                    return self[on].apply(bot, arguments);
                                });
                            } else {

                            }
                        }
                    });
                }
            } else {
                bot.log(3, mod.name, "Addon already loaded. Unload it first before loading it again!", ["red","yellow"]);
            }
        } else {
            bot.log(3, "Addon", source + ": Does not look like a module, skipping it.", ["magenta","red"]);
        }
    };

    /** Connect / Reconnect the bot to IRC & MySQL */
    bot.connect = function () {
        if (bot.dbconn) {
            bot.dbconn.end();
        }
        bot.stopPolling();
        if (bot.irc && bot.irc.conn && bot.irc.conn.connected) {
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
        };

        bot.irc.addListener("notice", notice);

        var dbConf = bot.conf.dbConfig;
        var dbUrl = util.format("%s://%s:%s@%s/%s", dbConf.driver, dbConf.user, dbConf.password, dbConf.hostname, dbConf.database);
        bot.dbconn = anyDb.createConnection(dbUrl, bot.handlers.dbConnected);
        bot.dbconn.on("end", bot.handlers.dbDisconnected);

        setTimeout(function() {
            bot.irc.connect();
            //bot.irc.conn.setEncoding("ISO-8859-1");
        }, 1500);

        bot.authed = false;
    };

    bot.quit = function (message) {
        bot.log(3, "Quit", message, ["magenta","yellow"]);
        bot.channels.forEach(function (channel) {
            bot.irc.say(channel, "Ich starte schnell neu! Einen Augenblick bitte...")
        });
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

    bot.startPolling = function (intertval) {
        if (bot.pollid) {
            clearInterval(bot.pollid);
        }
        bot.firstPoll = true;
        bot.pollid = setInterval(bot.pollForMessages, intertval);
        bot.log(1, "Poller", "Message poller started!", ["magenta","green"]);
    };

    bot.stopPolling = function () {
        if (bot.pollid) {
            clearInterval(bot.pollid);
        }
        bot.pollid = false;
        bot.log(1, "Poller", "Message poller has been halted.", ["magenta","red"]);
    };

    bot.pollForMessages = function() {
        if (bot.db && bot.irc) {
            try {
                bot.db.query(queryStrings.messagePoll, {fromid: bot.lastMsgId}, function (err, result) {
                    if (err) {
                        throw err;
                    }
                    result.rows.reverse().forEach(function (mrow) {
                        mrow.nick = mrow.nick.replace(/^IRC\s(.*)$/,"$1");
                        mrow.message = bot.bbParse(mrow.message);
                        mrow.message = utf8.decode(mrow.message);
                        bot.lastMsgId = Math.max(bot.lastMsgId, mrow.messageId);
                        if (!bot.firstPoll && mrow.message.substr(0,2) != "@@") {
                            bot.irc.say(bot.conf.poller.channel,
                                util.format("%s: %s", irc.colors.wrap("bold", mrow.nick), mrow.message));
                            bot.log(1, "Relay", util.format("%s: %s", mrow.nick, mrow.message), ["cyan","white"]);
                        }
                    });
                    bot.firstPoll = false;
                });
            } catch(error) {
                bot.log(4, "Poll Error", error.toString(), ["red","yellow"]);
            }
        }
    };

    bot.bbParse = function (text) {
        var output = "";
        output = text.replace(/\[b\]/gi, "\u0002");
        output = output.replace(/\[\/b\]/gi, "\u000f");
        /** Match [url=http://www.google.com]Google[/url] */
        output = output.replace(/\[\/url(=(.+?))?\](.*?)\[\/url\]/gi,"\u0002$3\u0002 $2");
        output = output.replace(/\[[^\]]+?\]/gi, "");
        return output;
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
                msg: "Dein IRC Key. Benutze folgenden Befehl um dich einzuloggen: \n" +
                    "/msg " + bot.irc.opt.nick + " login " + key
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
            bot.log(1, "Mode", "Giving user " + nickname + (set ? "+" : "-") + "v mode", ["green","white"]);
            bot.irc.send("mode", channel, (set ? "+" : "-") + "v", nickname);
        });
    };

    /** Tries to login with whatever Service that is configured */
    bot.perform = function () {
        //TODO: Implement performs
    };
};

var cli = readline.createInterface(process.stdin, process.stdout);
cli.setPrompt("> ");
cli.prompt();

var RelayConfig = require("./configuration.json");

var Relay = new RelayClient( RelayConfig );
Relay.connect();

//process.on("SIGINT", function() {
//    Relay.quit("Got CTRL + C in console! Cya :(");
//});

cli.on('line', function(line) {
    if (line.length) {
        if (line.charAt(0) != "/") {
            Relay.broadcast(line);
        } else {
            var comLine = line.substr(1),
                params = comLine.split(/\s+/),
                command = params.splice(0,1);
            if (Relay.irc && Relay.irc[command]) {
                Relay.log(1, "cli IRC", "Running native function RelayClient\\irc\\"
                    + command + "(" + params.join(", ") + ") ...", ["cyan","white"]);
                Relay.irc[command].apply(Relay.irc, params);
            } else if(Relay[command]) {
                Relay.log(1, "cli BASE", "Running base function RelayClient\\"
                    + command + "(" + params.join(", ") + ") ...", ["cyan","white"]);
                Relay.irc[command].apply(Relay, params);
            } else {
                params = command.concat(params);
                Relay.log(2, "cli raw", "Sending raw IRC command [ " + params.join(" ") + " ]", ["cyan","yellow"]);
                try {
                    Relay.irc.send.apply(Relay.irc, params);
                } catch (err) {
                    Relay.log(3, "Error", "Raw > " + err.message, ["red","red"]);
                }
            }
        }
    }
    cli.prompt();
});

cli.on("SIGINT", function () {
    cli.question("Are you mad? [yes/no] ", function (ismad){
        if (ismad.match(/(ja?|y(es)?)/i)) {
            Relay.quit("THIS IS SPARTAAAAAAAAAAAAAAAAAAAAAA!");
        }
    });
});