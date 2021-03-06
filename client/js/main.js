/**
 * Created by Chris on 9/27/2015.
 */

document.title = "Web Worker Engine";

//
// changelog - need to rewrite libraries to separate render logic and control logic from the actual data
//
//
//
//

const CONSTANTS = Object.freeze({
    'REQUEST_ANIMATION_FRAME_FUNCTION': (
        window.requestAnimationFrame ?
            function(f){
                window.requestAnimationFrame(f);
            }:
            function(f){
                setTimeout(f,5);
            }
    ),
    'BACKGROUND': "background",
    'FOREGROUND': "foreground",
    'INTERFACE': "interface",
    'WORKER_DIR': "/js/workers/",
    'TWOPI': Math.PI*2
});

setLoadingBar(function(description, percent){
    var id = 'loadingBarDiv';
    var cont = get(id);
    if(!cont){
        cont = document.createElement('div');
        cont.id = id;
        cont.style.color = 'green';
        cont.style.fontSize = '16pt';
        cont.style.zIndex = '5000';
        document.body.appendChild(cont);
    }
    var str = description+' '+(percent*100).toFixed(0)+'%';
    console.info(str);
    if(percent >= 1){
        document.body.removeChild(cont);
        return;
    }
    cont.innerHTML = str;
});

var imagePreloadMap = {
//    'name': 'url'
    'character': 'http://www.clipartbest.com/cliparts/4Tb/rxn/4TbrxnATg.gif',
    'trash': 'http://vignette1.wikia.nocookie.net/muppet/images/5/5b/Oscar-can.png/revision/latest?cb=20120117061845',
    'can': '../can.png'
};


var boardSize = 2000;
function bakeRendering(one, loadingCallback){
    const i = one;
    var def = 3;
    if (i > def){
        return false;
    }
    var percent = i/def;
    //var angle = percent * 2 * Math.PI;
    ImageBaker.initialize(boardSize, boardSize);
    ImageBaker.bakeImage('starfield' + i, function (ctx) {
        var stars = rand(boardSize*boardSize/8e4 | 0, boardSize*boardSize/2e4 | 0);
        for(var j=0;j<stars;j++) {
            var r = rand(150, 250),
                num = rand(4, 12) * 2,
                x = rand(0, boardSize),
                y = rand(0, boardSize),
                rad1 = (rand(3, 8) * (10 - i*3))/4,
                rad2 = rand(rad1 *.2, rad1 *.8);

            ctx.fillStyle = 'rgba(' +
                r + ',' +
                rand(r *.8, r) + ',' +
                rand(r *.6, r) + ',' +
                (.6*(1-percent)) + ')';

            ctx.beginPath();
            ctx.moveTo(x + rad1, y);
            for (var t = 0; t < num; t++) {
                var rad = (t % 2 == 0) ? rad1 : rad2;
                ctx.lineTo(
                    Math.floor(x + Math.cos(t / num * CONSTANTS.TWOPI) * rad),
                    Math.floor(y + Math.sin(t / num * CONSTANTS.TWOPI) * rad)
                );
            }
            ctx.closePath();
            ctx.fill();
        }
    });
    return true;
}

var sendLogicWorkerMessage;
var subscribeToLogic;
var unsubscribeFromLogic;


function init(){
    var w = 800;
    var h = 600;

    var loader = get('canvasLoader');
    initCanvas(loader, CONSTANTS.BACKGROUND, w, h);
    initCanvas(loader, CONSTANTS.FOREGROUND, w, h);
    initCanvas(loader, CONSTANTS.INTERFACE, w, h);

    initLogicWorker(w, h);
    initRenderWorker("renderForeWorker.js", CONSTANTS.FOREGROUND);
    initRenderWorker("renderBackWorker.js", CONSTANTS.BACKGROUND);

    // init metric timers
    metrics.createTimer('LogicWorker');
    metrics.createTimer('Logic');
    ([
        CONSTANTS.BACKGROUND,
        CONSTANTS.FOREGROUND,
        CONSTANTS.INTERFACE
    ]).forEach(function(name){
        metrics.createTimer('RenderQueue'+name);
        metrics.createTimer('Render'+name);
    });

    IO.bind("TILDE", "toggleDevMode", 500);

    IO.bind("W","up");
    IO.bind("UP_ARROW","up");
    IO.bind("A","left");
    IO.bind("LEFT_ARROW","left");
    IO.bind("D","right");
    IO.bind("RIGHT_ARROW","right");
    IO.bind("S","down");
    IO.bind("DOWN_ARROW","down");

    IO.bind("B","speed");
    IO.bind(" ","shoot");

    IO.handleMouse(function(coords){
        var data = {
            'type': 'mouse',
            'data': coords
        };
        sendLogicWorkerMessage(data);
    });

    const gamepadPollRate = Math.floor(1000/60);
    function Stick(stick){
        const x=stick.x, y=stick.y;
        var a = Math.atan(y/x);
        if(x<0){
            a+=Math.PI;
        }
        return {
            'angle': (a + CONSTANTS.TWOPI) % (CONSTANTS.TWOPI),
            'distance': Math.floor(Math.sqrt(x * x + y * y)*100)/100
        };
    }
    (function gamepadUpdate(){
        var gp = IO.gamepad.getState();
        var data = {
            'type': 'gamepad',
            'data': {
                buttons: gp.buttons,
                leftStick: Stick(gp.leftStick),
                rightStick: Stick(gp.rightStick)
            }
        };
        logger.log(data.data.leftStick.distance);
        if(gp.buttons.select){
            window.location.reload();// TODO remove
        }
        sendLogicWorkerMessage(data);
        setTimeout(gamepadUpdate, gamepadPollRate);
    })();

    runLogic();
    runRender();
}

function initLogicWorker(w, h){
    var worker = new Worker(CONSTANTS.WORKER_DIR + "logicWorker.js");
    // send initial values
    worker.postMessage({
        'width':w,
        'height':h,
        'socketInfo': window.location.origin,
        'boardSize': boardSize
    });

    var subscribers = [];
    subscribeToLogic = function(s){
        subscribers.push(s);
    };
    unsubscribeFromLogic = function(s){
        subscribers.splice(subscribers.indexOf(s), 1);
    };
    worker.onmessage = function(e){
        metrics.markTimer('LogicWorker');
        subscribers.forEach(function(s){
            s.postMessage(e.data);
        });
    };
    sendLogicWorkerMessage = function(obj){
        worker.postMessage(messageEncode(obj));
    };
    return worker;
}

function initRenderWorker(filename, name){
    var worker = new Worker(CONSTANTS.WORKER_DIR + filename);
    var canvas = canvases[name];

    renderQueues[name] = [];
    // send initial values
    worker.postMessage({
        'width':canvas.width,
        'height':canvas.height
    });

    subscribeToLogic(worker);

    worker.onmessage = function(e){
        metrics.markTimer('RenderQueue'+name);
        renderQueues[name] = JSON.parse(ab2str(e.data));
    };
}

function runRender(){
    renderAbstract(CONSTANTS.INTERFACE, false);
    renderAbstract(CONSTANTS.FOREGROUND, true);
    renderAbstract(CONSTANTS.BACKGROUND, false);
    // uses request anim frame if it exists, otherwise just spam setTimeout
    CONSTANTS.REQUEST_ANIMATION_FRAME_FUNCTION(runRender);
}

function renderAbstract(name, log){
    // if new render data is in, render it
    if(renderQueues[name]){
        metrics.markTimer('Render'+name);

        var canvas = canvases[name];
        var ctx = ctxs[name];
        canvas.clear();
        renderCommands(name, ctx);

        if(isDevMode()){
            if(log){
                logger.setCtx(ctx);
                logger.output();
                logger.clear();
                logger.log("Gen LPS:", metrics.getRate('LogicWorker'));
                logger.log("Input LPS:", metrics.getRate('Logic'));
                ([
                    CONSTANTS.BACKGROUND,
                    CONSTANTS.FOREGROUND,
                    CONSTANTS.INTERFACE
                ]).forEach(function (name){
                        logger.log(name.toUpperCase(), "Worker FPS:", metrics.getRate('RenderQueue' + name));
                        logger.log(name.toUpperCase(), "Canvas FPS:", metrics.getRate('Render' + name));
                    });
            }
        }
        else{
            logger.clear();
        }
    }
}


// key toggle getter functions go here
// they are defined inside of the handleHeys closure memory
var isDevMode;

var keyMapHandler = (function(){
    // closure memory for togglables
    var devmode = !1;// false, heh
    function toggleDevMode(){
        devmode = !devmode;
    }
    // must give a getter to outer scope for hidden togglables
    isDevMode = function(){
        return devmode;
    };

    return function (ioCmd, mem, msg){
        switch (ioCmd){
            case "initialize":
                mem = {
                    rev: 0
                };
                break;
            case "toggleDevMode":
                toggleDevMode();
                break;
            case "up":
            case "down":
            case "left":
            case "right":
            case "shoot":
            case "speed":
                msg.push({
                    'cmd': ioCmd
                });
                break;
        }
        return mem;
    };
})();