/**
 * Created with JetBrains PhpStorm.
 * User: nanashiRei
 * Date: 05.12.12
 * Time: 11:32
 * To change this template use File | Settings | File Templates.
 */

(function () {
    "use strict";

    var forever = require("forever-monitor"),
        color = require("color");

    var child = new (forever.Monitor)("service.js", {
        max: 50,
        silent: false,
        options: []
    });

    child.on('exit', function () {
        console.log();
    });

    child.start();

}());
