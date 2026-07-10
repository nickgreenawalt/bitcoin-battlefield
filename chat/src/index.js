// Bitcoin Battlefield — live chat backend.
// A single global chat room lives in one Durable Object. Visitors connect over a
// WebSocket; every message is broadcast to everyone and the last N are persisted so
// new arrivals see recent history. Messages and nicknames are run through a profanity
// censor (word list below) before broadcast/storage. No rate limiting.

import { BADWORDS } from './badwords.js';

const MAX_LEN = 2000;   // max characters per message (technical bound, not moderation)
const MAX_NICK = 24;    // max characters per nickname
const HISTORY = 50;     // how many recent messages new visitors receive

// Build the censor once per isolate. Alphanumeric entries are matched on word
// boundaries (so "class" is never censored for containing "ass"); symbolic entries
// (e.g. emoji) are matched as plain substrings.
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordEntries = BADWORDS.filter(w => /^[a-z0-9 '&.\-]+$/i.test(w));
const symbolEntries = BADWORDS.filter(w => !/^[a-z0-9 '&.\-]+$/i.test(w));
const WORD_RE = new RegExp('\\b(?:' + wordEntries.map(escapeRe).join('|') + ')\\b', 'gi');

function censor(text) {
  let out = String(text).replace(WORD_RE, m => '*'.repeat(m.length));
  for (const s of symbolEntries) out = out.split(s).join('*'.repeat([...s].length));
  return out;
}

const CORS = { 'Access-Control-Allow-Origin': '*' };

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/chat') {
      if (request.headers.get('Upgrade') === 'websocket') {
        const id = env.CHAT_ROOM.idFromName('global');   // one shared room for the whole site
        return env.CHAT_ROOM.get(id).fetch(request);
      }
      return new Response('Bitcoin Battlefield chat. Connect with a WebSocket.', { headers: CORS });
    }
    // Moderation endpoint: trim/clear stored history. Guarded by the ADMIN_KEY secret.
    //   POST /admin?trim=N   -> drop the oldest N stored messages
    //   POST /admin?clear=1  -> wipe all stored history
    if (url.pathname === '/admin') {
      if (!env.ADMIN_KEY || request.headers.get('x-admin-key') !== env.ADMIN_KEY)
        return new Response('forbidden', { status: 403, headers: CORS });
      const id = env.CHAT_ROOM.idFromName('global');
      return env.CHAT_ROOM.get(id).fetch(request);
    }
    return new Response('Not found', { status: 404, headers: CORS });
  },
};

export class ChatRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/admin') return this.admin(url);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Hibernatable WebSocket: the DO can sleep between messages and keep the socket.
    this.ctx.acceptWebSocket(server);

    // Send recent history straight away so the visitor lands in an active room.
    const history = (await this.ctx.storage.get('history')) || [];
    server.send(JSON.stringify({ type: 'history', messages: history }));
    this.broadcastPresence();

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let data;
    try { data = JSON.parse(raw); } catch (e) { return; }

    if (data.type === 'join') {
      const nick = sanitizeNick(data.nick);
      ws.serializeAttachment({ nick });   // survives DO hibernation
      this.broadcast({ type: 'system', text: nick + ' joined', ts: Date.now() });
      this.broadcastPresence();
      return;
    }

    if (data.type === 'msg') {
      const att = ws.deserializeAttachment() || {};
      const nick = att.nick || 'anon';
      const text = censor(String(data.text || '').slice(0, MAX_LEN));
      if (!text.trim()) return;
      const msg = { type: 'msg', nick, text, ts: Date.now() };
      this.broadcast(msg);
      await this.store(msg);
    }
  }

  async webSocketClose() { this.broadcastPresence(); }
  async webSocketError() { this.broadcastPresence(); }

  // Trim oldest N (?trim=N) or wipe all (?clear=1) stored messages, then live-refresh
  // every connected client so open chat windows update immediately.
  async admin(url) {
    let history = (await this.ctx.storage.get('history')) || [];
    if (url.searchParams.get('clear') === '1') {
      history = [];
    } else {
      const n = parseInt(url.searchParams.get('trim') || '0', 10);
      if (n > 0) history = history.slice(n);
    }
    await this.ctx.storage.put('history', history);
    this.broadcast({ type: 'history', messages: history });
    return new Response(JSON.stringify({ ok: true, remaining: history.length }),
      { headers: { ...CORS, 'content-type': 'application/json' } });
  }

  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(s); } catch (e) { /* socket gone */ }
    }
  }

  broadcastPresence() {
    this.broadcast({ type: 'presence', count: this.ctx.getWebSockets().length });
  }

  async store(msg) {
    const history = (await this.ctx.storage.get('history')) || [];
    history.push({ nick: msg.nick, text: msg.text, ts: msg.ts });
    while (history.length > HISTORY) history.shift();
    await this.ctx.storage.put('history', history);
  }
}

// Keep only printable characters, cap length. Not moderation — just keeps names renderable.
function sanitizeNick(n) {
  const str = String(n || '');
  let out = '';
  for (let i = 0; i < str.length && out.length < MAX_NICK; i++) {
    const code = str.charCodeAt(i);
    if (code >= 32 && code !== 127) out += str[i];
  }
  return censor(out.trim()) || 'anon';
}
