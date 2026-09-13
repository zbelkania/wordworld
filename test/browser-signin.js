'use strict';

// Loads public/index.html + game.js in a simulated DOM against the real
// server, then clicks "Start playing" and reports what happens. Catches
// load-time script errors that would silently kill every event listener.

const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const BASE = process.env.BASE || 'http://localhost:3000';
const pub = path.join(__dirname, '..', 'public');

const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');

const errors = [];
const logs = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (err) => errors.push(`jsdomError: ${err.message}`));
virtualConsole.on('error', (...args) => errors.push(`console.error: ${args.join(' ')}`));
virtualConsole.on('warn', (...args) => logs.push(`warn: ${args.join(' ')}`));

const dom = new JSDOM(html, {
  url: BASE + '/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  virtualConsole,
});

const { window } = dom;

// jsdom has no canvas backend, so stub just enough for the renderer to run.
const ctxStub = new Proxy(
  {
    canvas: {},
    measureText: () => ({ width: 40 }),
    setTransform() {}, fillRect() {}, strokeRect() {}, beginPath() {},
    moveTo() {}, lineTo() {}, stroke() {}, fill() {}, fillText() {},
    setLineDash() {}, save() {}, restore() {}, clearRect() {},
  },
  {
    get(target, prop) {
      if (prop in target) return target[prop];
      return () => {};
    },
    set() { return true; },
  }
);

window.HTMLCanvasElement.prototype.getContext = () => ctxStub;
window.localStorage.clear();

// Node's fetch, pointed at the real server.
window.fetch = (url, opts) => fetch(new URL(url, BASE).toString(), opts);

// Minimal WebSocket bridge so connectSocket() behaves like a browser's.
const WS = require('ws');
window.WebSocket = class extends WS {
  constructor(url) {
    super(url.replace('ws://localhost', 'ws://127.0.0.1'));
  }
  addEventListener(type, handler) {
    this.on(type === 'message' ? 'message' : type, (arg) => {
      handler(type === 'message' ? { data: arg.toString() } : arg);
    });
  }
};
// OPEN is inherited from the ws class already.

const gameJs = fs.readFileSync(path.join(pub, 'game.js'), 'utf8');

console.log('\nloading game.js ...');
try {
  window.eval(gameJs);
  console.log('  script evaluated with no thrown error');
} catch (err) {
  console.log(`  SCRIPT THREW AT LOAD: ${err.message}`);
  console.log(err.stack.split('\n').slice(0, 4).join('\n'));
}

if (errors.length) {
  console.log('\nerrors during load:');
  for (const e of errors) console.log('  ' + e);
}

const doc = window.document;
const button = doc.getElementById('signin-go');
const input = doc.getElementById('username');

console.log('\nbefore click');
console.log(`  sign-in overlay hidden? ${doc.getElementById('signin').hidden}`);
console.log(`  stage hidden?           ${doc.getElementById('stage').hidden}`);

input.value = 'zurab';
console.log('\nclicking "Start playing" with username "zurab" ...');
errors.length = 0;
button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

setTimeout(() => {
  console.log('\nafter click');
  console.log(`  sign-in overlay hidden? ${doc.getElementById('signin').hidden}`);
  console.log(`  stage hidden?           ${doc.getElementById('stage').hidden}`);
  console.log(`  topbar hidden?          ${doc.getElementById('topbar').hidden}`);
  const err = doc.getElementById('signin-error');
  console.log(`  error shown?            ${!err.hidden} ${err.hidden ? '' : '-> ' + err.textContent}`);
  console.log(`  token saved?            ${!!window.localStorage.getItem('ww.token')}`);
  console.log(`  score element text      "${doc.getElementById('score').textContent}"`);

  if (errors.length) {
    console.log('\nerrors after click:');
    for (const e of errors) console.log('  ' + e);
  } else {
    console.log('\nno errors after click');
  }

  const worked = doc.getElementById('signin').hidden && !doc.getElementById('stage').hidden;
  console.log(`\nRESULT: sign-in ${worked ? 'WORKED' : 'DID NOT WORK'}\n`);
  process.exit(worked ? 0 : 1);
}, 2500);
