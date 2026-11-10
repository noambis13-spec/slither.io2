'use strict';
/* Slither.io 2 server. Same protocol as V1 (create / join / i / respawn / leave / ping -> joined / s / dead / err / pong).
   V2 only ADDS optional fields (fx, ev, dead.ho/eq), which V1 clients simply ignore.
   The game rules live in the <script id="sim"> block of public/index.html, so the browser (vs Bots) and this
   server always run the exact same simulation. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const INDEX = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const SG = (() => {
  const m = INDEX.match(/<script id="sim">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('sim block not found in public/index.html');
  const mod = { exports: {} };
  new Function('module', 'exports', m[1])(mod, mod.exports);
  return mod.exports;
})();

const PORT = process.env.PORT || 3000;
const TICK_MS = 33;        // simulation ~30 Hz
const SEND_MS = 50;        // snapshots 20 Hz
const VIEW = 2300;         // half-size of per-client interest area
const MAX_PLAYERS = 16;
const ROOM_BOTS = 6;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(INDEX);
  }
  res.writeHead(404); res.end('Not found');
});

const wss = new WebSocketServer({ server, maxPayload: 2048 });
const rooms = new Map();
const send = (ws, obj) => { if (ws.readyState === 1 && ws.bufferedAmount < 1e6) ws.send(JSON.stringify(obj)); };

function newCode() {
  let c;
  do { c = ''; for (let i = 0; i < 4; i++) c += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0]; } while (rooms.has(c));
  return c;
}

class Room {
  constructor(code) {
    this.code = code; this.clients = new Set(); this.n = 0;
    this.world = new SG.World({ bots: ROOM_BOTS, onDeath: (s, k, ho) => this.onDeath(s, k, ho) });
  }
  onDeath(s, killer, ho) {
    const c = s.client;
    if (!c) return;
    c.snake = null;
    const msg = { t: 'dead', score: Math.floor(s.score), by: killer ? killer.name : null };
    if (ho && killer) { msg.ho = 1; if (Math.floor(killer.score / 4) === Math.floor(s.score / 4)) msg.eq = 1; }
    send(c.ws, msg);
  }

  snapshot(c, ranked, events) {
    const w = this.world, me = c.snake;
    if (me) { c.pos.x = me.segs[0].x; c.pos.y = me.segs[0].y; }
    const cx = c.pos.x, cy = c.pos.y, sn = [];
    const addSnake = (s, boosting) => {
      let vis = s === me;
      if (!vis) {
        for (let i = 0; i < s.segs.length; i += 2) {
          const p = s.segs[i];
          if (Math.abs(p.x - cx) < VIEW && Math.abs(p.y - cy) < VIEW) { vis = true; break; }
        }
      }
      if (!vis) return;
      const p = new Array(s.segs.length * 2);
      for (let i = 0; i < s.segs.length; i++) { p[2 * i] = Math.round(s.segs[i].x); p[2 * i + 1] = Math.round(s.segs[i].y); }
      sn.push({ i: s.id, n: s.name, k: s.skin, a: Math.round(s.angle * 100) / 100, b: boosting ? 1 : 0, s: Math.floor(s.score), p });
    };
    for (const s of w.snakes) addSnake(s, s.boosting);
    for (const d of w.dying) addSnake(d, false);          // dying snakes shrink tail -> head (own id, never the player's id)

    const seen = new Set(), fa = [], fx = [], fr = [];
    for (const f of w.foods) {
      if (Math.abs(f.x - cx) < VIEW && Math.abs(f.y - cy) < VIEW) {
        seen.add(f.id);
        if (!c.known.has(f.id)) {
          fa.push(f.id, Math.round(f.x), Math.round(f.y), f.v, f.c);
          if (f.skin >= 0) fx.push(f.id, f.skin, f.idx, f.k);     // V2 extra: exact snake colour + death-orb flag
        }
      }
    }
    for (const id of c.known) if (!seen.has(id)) fr.push(id);
    c.known = seen;
    const msg = { t: 's', ts: Date.now(), sn, fa, fr, n: w.snakes.length };
    if (fx.length) msg.fx = fx;
    const ev = [];
    for (const e of events) {
      if (e.k === 'c') { if (Math.abs(e.x - cx) < 1500 && Math.abs(e.y - cy) < 1500) ev.push(['c', Math.round(e.x), Math.round(e.y), 0]); }
      else if (me && e.id === me.id) ev.push([e.k, Math.round(e.x), Math.round(e.y), e.p || 0]);
    }
    if (ev.length) msg.ev = ev;
    if (ranked) {
      msg.lb = ranked.slice(0, 10).map(s => [s.name, Math.floor(s.score), s === me ? 1 : 0]);
      msg.rk = me ? ranked.indexOf(me) + 1 : 0;
    }
    return msg;
  }

  broadcast() {
    this.n++;
    const ranked = this.n % 10 === 0 ? [...this.world.snakes].sort((a, b) => b.score - a.score) : null;
    const events = this.world.events;
    for (const c of this.clients) send(c.ws, this.snapshot(c, ranked, events));
    events.length = 0;
  }
}

const cleanName = n => (String(n || '').replace(/[^\w \-.]/g, '').trim().slice(0, 16)) || 'Player';
const cleanSkin = k => { k = Number(k) | 0; return k >= 0 && k < SG.SKINS.length ? k : 0; };

function spawn(c) {
  c.snake = c.room.world.addSnake(c.name, c.skin, false);
  c.snake.client = c; c.known = new Set();
  send(c.ws, { t: 'joined', code: c.room.code, id: c.snake.id });
}
function enter(c, room, m) {
  if (room.clients.size >= MAX_PLAYERS) { send(c.ws, { t: 'err', m: 'Room is full' }); return; }
  c.name = cleanName(m.name); c.skin = cleanSkin(m.skin);
  c.room = room; room.clients.add(c);
  spawn(c);
}
function leave(c) {
  const room = c.room;
  if (!room) return;
  c.room = null;
  if (c.snake) { const s = c.snake; c.snake = null; s.client = null; room.world.kill(s, null, false); }
  room.clients.delete(c);
  if (!room.clients.size) rooms.delete(room.code);   // destroy empty room
}

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const c = { ws, room: null, snake: null, name: 'Player', skin: 0, pos: { x: 0, y: 0 }, known: new Set() };
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'ping': send(ws, { t: 'pong', c: m.c }); break;
      case 'create': {
        if (c.room) return;
        const room = new Room(newCode());
        rooms.set(room.code, room);
        enter(c, room, m);
        break;
      }
      case 'join': {
        if (c.room) return;
        const room = rooms.get(String(m.code || '').toUpperCase().trim());
        if (!room) { send(ws, { t: 'err', m: 'Room not found' }); return; }
        enter(c, room, m);
        break;
      }
      case 'i':
        if (c.snake) {
          const a = Number(m.a);
          if (isFinite(a)) c.snake.target = a;
          c.snake.boost = !!m.b;
        }
        break;
      case 'respawn':
        if (c.room && !c.snake) {
          if (m.name) c.name = cleanName(m.name);
          if (m.skin != null) c.skin = cleanSkin(m.skin);
          spawn(c);
        }
        break;
      case 'leave': leave(c); break;
    }
  });
  ws.on('close', () => leave(c));
  ws.on('error', () => {});
});

// Heartbeat: keeps connections alive behind Render's proxy and drops dead sockets.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 30000);

let last = Date.now();
setInterval(() => {
  const now = Date.now(), dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  for (const room of rooms.values()) room.world.step(dt);
}, TICK_MS);
setInterval(() => { for (const room of rooms.values()) room.broadcast(); }, SEND_MS);

server.listen(PORT, '0.0.0.0', () => console.log('Slither.io 2 server running on port ' + PORT));
