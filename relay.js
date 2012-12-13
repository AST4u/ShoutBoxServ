var child_process = require("child_process");
var util = require("util");
require("colors");

var ShoutBoxRelay = null;

process.stdin.resume();

var comMessage = function(comEvent) {
    switch (comEvent.type) {
        case "ready":
            util.log("[ Child Message ] Ready received!".magenta.bold);
            ShoutBoxRelay.send({command: "start"});
            break;
        case "restart":
            util.log("[ Child Message ] Restart requested ...".yellow.bold);
            setTimeout(spawnService, 5000);
            break;
        case "exit":
            util.log("[ Child Message ] Child was stopped!".red.bold);
            util.log("[ Control Message ] Good Bye!".cyan);
            process.exit();
            break;
        case "end":
            util.log("[ Child End ]");
            break;
    }
};

var comExit = function() {
    util.log("[ Child Exit ] Done.");
    ShoutBoxRelay = null;
};

var spawnService = function () {
    ShoutBoxRelay = child_process.fork("service");
    ShoutBoxRelay.on("message", comMessage);
    ShoutBoxRelay.on("exit", comExit);
};

process.stdin.resume();
process.stdin.on("data", function (text) {
    if (ShoutBoxRelay) {
        ShoutBoxRelay.send({command: "message", content: text});
    }
});

process.on("SIGINT", function() {
    if (ShoutBoxRelay) {
        util.log("[ Control Message ] SIGINT received, stopping service ...");
        ShoutBoxRelay.send({command: "stop"});
    }
});
process.on("SIGHUP", function() {
    util.log("[ Control Message ] SIGHUP received, restarting service ...");
    ShoutBoxRelay.send({command: "restart"});
});
spawnService();