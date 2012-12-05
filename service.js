function Client ( ) {
    var self = this;

    this.conf = require("./configuration.js");
    this.conf.autoConnect = false;
    this.conf.autoRejoin = false;

    this.irc = require("irc");
    this.colr = require("colors");
    this.req = require("request");
    this.util = require("underscore");


    /** Connect the bot to IRC & MySQL */
    this.connect = function(conf, irc, colr, req, util) {

    }
}

