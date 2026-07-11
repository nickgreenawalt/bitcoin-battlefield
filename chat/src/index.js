// Bitcoin Battlefield — live chat backend (efficient rewrite).
//
// One global chat room in a Durable Object. Design goals after hitting the free-tier
// storage-write cap under launch traffic:
//   1. CLASSIC (non-hibernating) WebSockets — accepting a socket and relaying messages
//      writes NOTHING to storage (the hibernation API wrote on every connect/message,
//      which is what blew the 100k rows_written/day limit).
//   2. History is kept in memory and PERSISTED on a throttled flush (~1 write / 15s max)
//      instead of once per message — a ~95%+ reduction in writes.
//   3. AUTO-PAUSE budgets: hard daily ceilings on writes and messages. When hit, the room
//      pauses (stops persisting / refuses new work) until 00:00 UTC, so cost can't run away.
//   4. Flush failures are swallowed — if storage is unavailable, the chat keeps running
//      live in memory and simply resumes persisting later.
//
// Censoring (via `obscenity`) defeats leetspeak, suffixes, concatenations, and separator
// evasions, whitelisting innocent words; a cross-message pass catches letter-per-message
// spellings.

import {
  RegExpMatcher, TextCensor, DataSet, pattern,
  englishDataset, englishRecommendedTransformers, skipNonAlphabeticTransformer,
  asteriskCensorStrategy,
} from 'obscenity';

const MAX_LEN = 2000;   // max characters per message
const MAX_NICK = 24;    // max characters per nickname
const HISTORY = 50;     // recent messages new visitors receive
const FLUSH_MS = 15000; // never persist more often than this

// ---- auto-pause cost ceilings (per UTC day). Tune to taste. ----
const DAILY_WRITE_BUDGET = 50000;   // storage flushes/day before the room pauses
const DAILY_MSG_BUDGET   = 300000;  // messages/day before the room pauses
const DAILY_CONN_BUDGET  = 200000;  // new connections/day before the room pauses

// ---- anti-abuse / anti-bot limits ----
// Per-IP limits are kept LENIENT so carrier-grade NAT (many legit mobile users share one
// IP) isn't blocked; the global daily budgets + auto-pause are the real cost ceiling.
const MAX_CONNS          = 800;     // global concurrent connections (protects the single DO)
const MAX_CONNS_PER_IP   = 20;      // concurrent connections per IP
const IP_CONN_WINDOW_MS  = 60000;   // window for per-IP new-connection rate limiting
const IP_CONN_MAX        = 60;      // max new connections per IP per minute (churn guard)
const MSG_WINDOW_MS      = 4000;    // window for per-connection message rate limiting
const MSG_MAX            = 8;       // max messages per window per connection
const JOIN_MIN_MS        = 400;     // ignore join spam faster than this

const EXTRA_BAD = ['gay', 'niga', 'nigga'];
const EXTRA_OK = ['cockpit', 'shiitake', 'shiitakes', 'mishit'];

let _dataset = new DataSet().addAll(englishDataset);
for (const w of EXTRA_BAD)
  _dataset = _dataset.addPhrase(p => p.setMetadata({ originalWord: w }).addPattern(pattern`${w}`));
const _built = _dataset.build();
_built.whitelistedTerms = [...(_built.whitelistedTerms || []), ...EXTRA_OK];

const _matcher = new RegExpMatcher({
  ..._built,
  blacklistMatcherTransformers: [
    ...englishRecommendedTransformers.blacklistMatcherTransformers,
    skipNonAlphabeticTransformer(),
  ],
  whitelistMatcherTransformers: englishRecommendedTransformers.whitelistMatcherTransformers,
});
const _censor = new TextCensor().setStrategy(asteriskCensorStrategy());

function censor(text) { const s = String(text); return _censor.applyTo(s, _matcher.getAllMatches(s)); }
function hasProfanity(text) { return _matcher.hasMatch(String(text)); }
function stripRaw(history) { return history.map(m => ({ nick: m.nick, text: m.text, ts: m.ts })); }
function utcDay() { return new Date().toISOString().slice(0, 10); }

function scrubVerticalRun(history, nick) {
  const window = history.slice(-15);
  const base = history.length - window.length;
  const idxs = [];
  window.forEach((m, i) => { if (m.nick === nick && [...(m.text || '')].length <= 3) idxs.push(base + i); });
  if (idxs.length < 3) return false;
  const concat = idxs.map(i => history[i].raw ?? history[i].text).join('');
  if (concat.replace(/\s/g, '').length > 30 || !hasProfanity(concat)) return false;
  let changed = false;
  for (const i of idxs) {
    const t = history[i].text;
    if (!/^\*+$/.test(t)) { history[i] = { ...history[i], text: '*'.repeat(Math.max(1, [...t].length)) }; changed = true; }
  }
  return changed;
}
function scrubVerticalAll(history) {
  let changed = false;
  for (const nick of new Set(history.map(m => m.nick))) {
    const idxs = [];
    history.forEach((m, i) => { if (m.nick === nick && [...(m.text || '')].length <= 3) idxs.push(i); });
    if (idxs.length < 3) continue;
    const concat = idxs.map(i => history[i].raw ?? history[i].text).join('');
    if (!hasProfanity(concat)) continue;
    for (const i of idxs) {
      const t = history[i].text;
      if (!/^\*+$/.test(t)) { history[i] = { ...history[i], text: '*'.repeat(Math.max(1, [...t].length)) }; changed = true; }
    }
  }
  return changed;
}

const CORS = { 'Access-Control-Allow-Origin': '*' };

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/chat') {
      if (request.headers.get('Upgrade') === 'websocket') {
        return env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName('global')).fetch(request);
      }
      return new Response('Bitcoin Battlefield chat. Connect with a WebSocket.', { headers: CORS });
    }
    if (url.pathname === '/admin') {
      if (!env.ADMIN_KEY || request.headers.get('x-admin-key') !== env.ADMIN_KEY)
        return new Response('forbidden', { status: 403, headers: CORS });
      return env.CHAT_ROOM.get(env.CHAT_ROOM.idFromName('global')).fetch(request);
    }
    return new Response('Not found', { status: 404, headers: CORS });
  },
};

export class ChatRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sessions = new Set();   // live WebSockets (in memory)
    this.history = null;         // loaded lazily
    this.loaded = false;
    this.dirty = false;
    this.flushTimer = null;
    this.day = utcDay();
    this.dayWrites = 0;
    this.dayMsgs = 0;
    this.dayConns = 0;
    this.paused = false;
    this.connsByIp = new Map();     // ip -> current concurrent count
    this.recentConnByIp = new Map();// ip -> [recent connect timestamps]
  }

  async load() {
    if (this.loaded) return;
    let s = {};
    try { s = (await this.ctx.storage.get('state')) || {}; } catch (e) { s = {}; } // storage down? start empty, keep serving
    this.history = s.history || [];
    this.day = s.day || utcDay();
    this.dayWrites = s.dayWrites || 0;
    this.dayMsgs = s.dayMsgs || 0;
    this.dayConns = s.dayConns || 0;
    this.rollDay();
    this.loaded = true;
  }

  rollDay() {
    if (this.day !== utcDay()) { this.day = utcDay(); this.dayWrites = 0; this.dayMsgs = 0; this.dayConns = 0; this.paused = false; }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/admin') { await this.load(); return this.admin(url); }

    await this.load();
    this.rollDay();
    // Budget hit -> refuse new connections so cost stays capped until the UTC reset.
    if (this.paused) return new Response('paused', { status: 503, headers: CORS });
    if (this.dayConns >= DAILY_CONN_BUDGET) { this.pause(); return new Response('paused', { status: 503, headers: CORS }); }

    // ---- anti-abuse gates (cheap, before we accept the socket) ----
    if (this.sessions.size >= MAX_CONNS) return new Response('busy', { status: 503, headers: CORS });
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    const now = Date.now();
    const recent = (this.recentConnByIp.get(ip) || []).filter(t => now - t < IP_CONN_WINDOW_MS);
    if (recent.length >= IP_CONN_MAX) return new Response('rate limited', { status: 429, headers: CORS });
    if ((this.connsByIp.get(ip) || 0) >= MAX_CONNS_PER_IP) return new Response('too many connections', { status: 429, headers: CORS });
    recent.push(now); this.recentConnByIp.set(ip, recent);
    this.connsByIp.set(ip, (this.connsByIp.get(ip) || 0) + 1);
    this.dayConns++;

    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    server.accept();   // classic accept — no storage write
    const session = { ws: server, nick: 'anon', ip, msgTimes: [], lastJoin: 0 };
    this.sessions.add(session);

    server.send(JSON.stringify({ type: 'history', messages: stripRaw(this.history) }));
    this.broadcastPresence();

    server.addEventListener('message', ev => { try { this.onMessage(session, ev.data); } catch (e) {} });
    const drop = () => {
      if (this.sessions.delete(session)) {
        const c = (this.connsByIp.get(ip) || 1) - 1;
        if (c <= 0) this.connsByIp.delete(ip); else this.connsByIp.set(ip, c);
      }
      this.broadcastPresence();
      if (this.sessions.size === 0 && this.dirty) this.flush();
    };
    server.addEventListener('close', drop);
    server.addEventListener('error', drop);

    return new Response(null, { status: 101, webSocket: client });
  }

  onMessage(s, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_LEN + 200) return; // ignore binary / oversized frames
    let data;
    try { data = JSON.parse(raw); } catch (e) { return; }

    const now = Date.now();
    // per-connection message rate limit: drop anything past the window budget (bot/flood guard)
    s.msgTimes = (s.msgTimes || []).filter(t => now - t < MSG_WINDOW_MS);
    if (s.msgTimes.length >= MSG_MAX) return;
    s.msgTimes.push(now);

    if (data.type === 'join') {
      if (now - (s.lastJoin || 0) < JOIN_MIN_MS) return;   // join-spam guard
      s.lastJoin = now;
      s.nick = sanitizeNick(data.nick);
      this.broadcast({ type: 'system', text: s.nick + ' joined', ts: Date.now() });
      this.broadcastPresence();
      return;
    }

    if (data.type === 'msg') {
      this.rollDay();
      if (this.paused) return;
      const raw2 = String(data.text || '').slice(0, MAX_LEN);
      const text = censor(raw2);
      if (!text.trim()) return;
      const nick = s.nick || 'anon';
      const ts = Date.now();
      this.broadcast({ type: 'msg', nick, text, ts });
      this.history.push({ nick, text, raw: raw2, ts });
      while (this.history.length > HISTORY) this.history.shift();
      if (scrubVerticalRun(this.history, nick)) this.broadcast({ type: 'history', messages: stripRaw(this.history) });
      this.dayMsgs++;
      if (this.dayMsgs >= DAILY_MSG_BUDGET) this.pause();
      this.markDirty();
    }
  }

  markDirty() {
    this.dirty = true;
    if (!this.flushTimer && !this.paused) this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  async flush() {
    this.flushTimer = null;
    if (!this.dirty) return;
    this.rollDay();
    if (this.dayWrites >= DAILY_WRITE_BUDGET) { this.pause(); return; }
    try {
      await this.ctx.storage.put('state', {
        history: this.history, day: this.day, dayWrites: this.dayWrites + 1, dayMsgs: this.dayMsgs, dayConns: this.dayConns,
      });
      this.dayWrites++;
      this.dirty = false;
    } catch (e) {
      // storage unavailable (e.g. over the free cap) — keep running in memory, retry later
      this.flushTimer = setTimeout(() => this.flush(), 60000);
    }
  }

  // Enter paused state: stop persisting and disconnect everyone; new connections are
  // refused (503) until 00:00 UTC. Guarantees a hard daily activity ceiling.
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.broadcast({ type: 'system', text: 'Chat paused — daily limit reached. Back at 00:00 UTC.', ts: Date.now() });
    for (const s of this.sessions) { try { s.ws.close(1013, 'paused'); } catch (e) {} }
    this.sessions.clear();
    // best-effort persist of the paused flag counters
    this.ctx.storage.put('state', { history: this.history, day: this.day, dayWrites: this.dayWrites, dayMsgs: this.dayMsgs, dayConns: this.dayConns }).catch(() => {});
  }

  broadcast(obj) {
    const str = JSON.stringify(obj);
    for (const s of this.sessions) { try { s.ws.send(str); } catch (e) { this.sessions.delete(s); } }
  }
  broadcastPresence() { this.broadcast({ type: 'presence', count: this.sessions.size }); }

  async admin(url) {
    if (url.searchParams.get('clear') === '1') this.history = [];
    const n = parseInt(url.searchParams.get('trim') || '0', 10);
    if (n > 0) this.history = this.history.slice(n);
    if (url.searchParams.get('censor') === '1') {
      this.history = this.history.map(m => ({ ...m, nick: censor(m.nick || ''), text: censor(m.text || '') }));
      scrubVerticalAll(this.history);
    }
    if (url.searchParams.get('resume') === '1') { this.paused = false; this.dayWrites = 0; this.dayMsgs = 0; this.dayConns = 0; }
    this.dirty = true;
    await this.flush();
    this.broadcast({ type: 'history', messages: stripRaw(this.history) });
    return new Response(JSON.stringify({ ok: true, remaining: this.history.length, paused: this.paused, dayWrites: this.dayWrites, dayMsgs: this.dayMsgs, dayConns: this.dayConns, live: this.sessions.size, ips: this.connsByIp.size }),
      { headers: { ...CORS, 'content-type': 'application/json' } });
  }
}

function sanitizeNick(n) {
  const str = String(n || '');
  let out = '';
  for (let i = 0; i < str.length && out.length < MAX_NICK; i++) {
    const code = str.charCodeAt(i);
    if (code >= 32 && code !== 127) out += str[i];
  }
  return censor(out.trim()) || 'anon';
}
