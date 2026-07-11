// Bitcoin Battlefield — live chat backend.
// A single global chat room lives in one Durable Object. Visitors connect over a
// WebSocket; every message is broadcast to everyone and the last N are persisted so
// new arrivals see recent history.
//
// Censoring (via `obscenity`) defeats leetspeak, suffixes ("raped"), concatenations
// ("fuckniggers"), AND separator evasions ("N I G G E R", "f.u.c.k") — the last via a
// skip-non-alphabetic transformer — while whitelisting innocent words (class, cockpit,
// shiitake...). A cross-message pass also catches slurs spelled one letter per message.

import {
  RegExpMatcher, TextCensor, DataSet, pattern,
  englishDataset, englishRecommendedTransformers, skipNonAlphabeticTransformer,
  asteriskCensorStrategy,
} from 'obscenity';

const MAX_LEN = 2000;   // max characters per message (technical bound, not moderation)
const MAX_NICK = 24;    // max characters per nickname
const HISTORY = 50;     // how many recent messages new visitors receive

// Extra terms to block (not in / weakly covered by the base dataset). Note: "gay" also
// masks non-offensive uses — included at the owner's request.
const EXTRA_BAD = ['gay', 'niga', 'nigga'];
// Innocent words that the aggressive matcher would otherwise flag.
const EXTRA_OK = ['cockpit', 'shiitake', 'shiitakes', 'mishit'];

let _dataset = new DataSet().addAll(englishDataset);
for (const w of EXTRA_BAD)
  _dataset = _dataset.addPhrase(p => p.setMetadata({ originalWord: w }).addPattern(pattern`${w}`));
const _built = _dataset.build();
_built.whitelistedTerms = [...(_built.whitelistedTerms || []), ...EXTRA_OK];

const _matcher = new RegExpMatcher({
  ..._built,
  // skip-non-alphabetic lets us catch "N I G G E R" / "f.u.c.k" without new false positives.
  blacklistMatcherTransformers: [
    ...englishRecommendedTransformers.blacklistMatcherTransformers,
    skipNonAlphabeticTransformer(),
  ],
  whitelistMatcherTransformers: englishRecommendedTransformers.whitelistMatcherTransformers,
});
const _censor = new TextCensor().setStrategy(asteriskCensorStrategy());

function censor(text) {
  const s = String(text);
  return _censor.applyTo(s, _matcher.getAllMatches(s));
}
function hasProfanity(text) {
  return _matcher.hasMatch(String(text));
}
// history entries carry an unshown `raw` (original text) used only for cross-message
// detection; strip it before anything goes to clients.
function stripRaw(history) {
  return history.map(m => ({ nick: m.nick, text: m.text, ts: m.ts }));
}

// Catch slurs spelled one (or two) letters per message: concatenate a nick's recent
// short messages; if that spells profanity, mask each contributing message. The length
// gate keeps normal conversation (which is much longer) from ever being touched.
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

// Retroactive: scan the ENTIRE history (no recent-window limit) and mask any nick whose
// short messages concatenate into profanity spelled one letter at a time.
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
        const id = env.CHAT_ROOM.idFromName('global');   // one shared room for the whole site
        return env.CHAT_ROOM.get(id).fetch(request);
      }
      return new Response('Bitcoin Battlefield chat. Connect with a WebSocket.', { headers: CORS });
    }
    // Moderation endpoint, guarded by the ADMIN_KEY secret.
    //   POST /admin?trim=N   -> drop the oldest N stored messages
    //   POST /admin?clear=1  -> wipe all stored history
    //   POST /admin?censor=1 -> re-censor stored history with the current filter
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

    this.ctx.acceptWebSocket(server);

    const history = (await this.ctx.storage.get('history')) || [];
    server.send(JSON.stringify({ type: 'history', messages: stripRaw(history) }));
    this.broadcastPresence();

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let data;
    try { data = JSON.parse(raw); } catch (e) { return; }

    if (data.type === 'join') {
      const nick = sanitizeNick(data.nick);
      ws.serializeAttachment({ nick });
      this.broadcast({ type: 'system', text: nick + ' joined', ts: Date.now() });
      this.broadcastPresence();
      return;
    }

    if (data.type === 'msg') {
      const att = ws.deserializeAttachment() || {};
      const nick = att.nick || 'anon';
      const raw = String(data.text || '').slice(0, MAX_LEN);
      const text = censor(raw);
      if (!text.trim()) return;
      const ts = Date.now();
      this.broadcast({ type: 'msg', nick, text, ts });
      const history = await this.store({ nick, text, raw, ts });
      // If this nick just completed a slur spelled across several short messages,
      // mask the whole run and push the corrected history to everyone.
      if (scrubVerticalRun(history, nick)) {
        await this.ctx.storage.put('history', history);
        this.broadcast({ type: 'history', messages: stripRaw(history) });
      }
    }
  }

  async webSocketClose() { this.broadcastPresence(); }
  async webSocketError() { this.broadcastPresence(); }

  async admin(url) {
    let history = (await this.ctx.storage.get('history')) || [];
    if (url.searchParams.get('clear') === '1') history = [];
    const n = parseInt(url.searchParams.get('trim') || '0', 10);
    if (n > 0) history = history.slice(n);
    if (url.searchParams.get('censor') === '1') {
      history = history.map(m => ({ ...m, nick: censor(m.nick || ''), text: censor(m.text || '') }));
      scrubVerticalAll(history);   // also clean letter-per-message spellings
    }
    await this.ctx.storage.put('history', history);
    this.broadcast({ type: 'history', messages: stripRaw(history) });
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
    history.push({ nick: msg.nick, text: msg.text, raw: msg.raw, ts: msg.ts });
    while (history.length > HISTORY) history.shift();
    await this.ctx.storage.put('history', history);
    return history;
  }
}

// Keep only printable characters, cap length, then censor. Not moderation of content —
// just keeps names renderable and blocks slurs in nicknames.
function sanitizeNick(n) {
  const str = String(n || '');
  let out = '';
  for (let i = 0; i < str.length && out.length < MAX_NICK; i++) {
    const code = str.charCodeAt(i);
    if (code >= 32 && code !== 127) out += str[i];
  }
  return censor(out.trim()) || 'anon';
}
