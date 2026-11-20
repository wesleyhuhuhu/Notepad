'use strict';
// Chats stored on this PC, and replies that run in the background.
//
// Every chat is a folder in bridge/chats/<id>/ with chat.json (the messages) and files/ (the full
// images sent with them). Replies and compactions run here, not in the browser: closing the tab
// or losing the connection doesn't stop them. Any number of devices can watch a chat live; each
// change goes out as an event with an increasing `seq`, so a device that reconnects asks for
// "everything after seq N" and catches up.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

module.exports = function createChats(d) {
  const { cfg, log, friendlyError, httpError, readJson, json, openEventStream } = d;
  const ROOT = path.join(__dirname, 'chats');
  const TRASH = path.join(ROOT, '.trash');
  const BUFFER_MAX = 20000; // events kept per chat for devices that reconnect
  const BUFFER_IDLE_MS = 10 * 60 * 1000;

  const newId = () => Date.now().toString(36) + crypto.randomBytes(5).toString('hex');
  const validId = (id) => typeof id === 'string' && /^[a-z0-9]{8,40}$/.test(id);
  const dirOf = (id) => path.join(ROOT, id);

  const chats = new Map(); // id -> chat, all kept in memory (text and small thumbnails only)
  const watchers = new Map(); // chat id -> Set of send functions
  const listWatchers = new Set(); // send functions for /api/events
  const buffers = new Map(); // chat id -> { events, timer }
  const saveTimers = new Map();
  const locks = new Map();
  const running = new Map(); // chat id -> AbortController of its active run
  let queue = []; // chat ids waiting for the model, in order
  let code = null; // Claude Code sessions (hosts.js), set by setCode()
  let pumping = false;

  // ------------------------------------------------------------ storage --
  function withLock(id, fn) {
    const prev = locks.get(id) || Promise.resolve();
    const run = prev.then(fn, fn);
    locks.set(id, run.catch(() => {}));
    return run;
  }

  function saveNow(chat) {
    clearTimeout(saveTimers.get(chat.id));
    saveTimers.delete(chat.id);
    return withLock(chat.id, async () => {
      if (!chats.has(chat.id)) return; // deleted meanwhile
      const dir = dirOf(chat.id);
      await fsp.mkdir(dir, { recursive: true });
      const file = path.join(dir, 'chat.json');
      await fsp.writeFile(file + '.tmp', JSON.stringify(chat), 'utf8');
      await fsp.rename(file + '.tmp', file);
    }).catch((e) => log(`Could not save chat ${chat.id}: ${e.message}`));
  }

  function saveSoon(chat) {
    if (saveTimers.has(chat.id)) return;
    saveTimers.set(chat.id, setTimeout(() => saveNow(chat), 1000));
  }

  async function init() {
    await fsp.mkdir(ROOT, { recursive: true });
    for (const e of await fsp.readdir(ROOT, { withFileTypes: true })) {
      if (!e.isDirectory() || !validId(e.name)) continue;
      try {
        const chat = JSON.parse(await fsp.readFile(path.join(ROOT, e.name, 'chat.json'), 'utf8'));
        chats.set(chat.id, chat);
        if (chat.run) {
          // The bridge stopped while this chat was replying or compacting.
          const a = chat.messages.find((m) => m.id === chat.run.messageId);
          if (a) {
            a.notice = '';
            a.error = 'Stopped: the bridge restarted before this reply finished.';
          }
          chat.lastRun = { state: 'stopped', kind: chat.run.kind, at: Date.now() };
          delete chat.run;
          // Past anything a device saw before the restart, so it reloads instead of waiting.
          chat.seq = (chat.seq || 0) + 1000;
          await saveNow(chat);
        }
      } catch (err) {
        log(`Skipped chat folder ${e.name}: ${err.message}`);
      }
    }
    log(`Chats: ${chats.size} stored in ${ROOT}`);
  }

  // ------------------------------------------------------------- events --
  const summaryOf = (c) => ({
    id: c.id,
    kind: c.kind,
    title: c.title,
    project: c.project,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    state: c.run ? c.run.state : 'idle',
    lastRun: c.lastRun || null,
    messages: c.messages.length,
    host: c.host || undefined,
    cwd: c.cwd || undefined,
    waiting: c.waiting || 0,
  });

  function broadcastList(ev) {
    for (const send of listWatchers) send(ev);
  }
  const listChanged = (chat) => broadcastList({ type: 'chat', chat: summaryOf(chat) });

  function emit(chat, ev) {
    chat.seq = (chat.seq || 0) + 1;
    ev.seq = chat.seq;
    let b = buffers.get(chat.id);
    if (!b) buffers.set(chat.id, (b = { events: [], timer: null }));
    b.events.push(ev);
    if (b.events.length > BUFFER_MAX) b.events.splice(0, b.events.length - BUFFER_MAX);
    clearTimeout(b.timer);
    b.timer = setTimeout(() => buffers.delete(chat.id), BUFFER_IDLE_MS);
    for (const send of watchers.get(chat.id) || []) send(ev);
    saveSoon(chat);
  }

  // --------------------------------------------- what goes to the model --
  // The latest summary (if any) plus the messages after it that aren't compacted.
  function sendable(messages) {
    let s = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'summary' && !messages[i].archived) {
        s = i;
        break;
      }
    }
    const live = messages
      .slice(s + 1)
      .filter((m) => m.role !== 'summary' && !m.archived && (m.role === 'user' || m.content));
    return { summary: s >= 0 ? messages[s] : null, live };
  }

  const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

  async function apiMessage(chat, m) {
    if (m.role === 'user' && m.attachments && m.attachments.length) {
      const urls = [];
      for (const a of m.attachments) {
        for (const f of a.files || []) {
          try {
            const buf = await fsp.readFile(path.join(dirOf(chat.id), 'files', f));
            urls.push(`data:${MIME[path.extname(f).slice(1)] || 'image/jpeg'};base64,${buf.toString('base64')}`);
          } catch {}
        }
      }
      const notes = m.attachments.map((a) => a.note).filter(Boolean);
      if (urls.length) {
        const intro = [m.content || (urls.length > 1 ? 'Here are some images.' : 'Here is an image.'), ...notes].join('\n\n');
        return { role: 'user', content: [{ type: 'text', text: intro }, ...urls.map((url) => ({ type: 'image_url', image_url: { url } }))] };
      }
      const gone = m.attachments
        .map((a) => `[${a.kind === 'video' ? 'A video' : 'An image'} ("${a.name}") was attached here earlier but is no longer available.]`)
        .join('\n');
      return { role: 'user', content: [m.content, gone].filter(Boolean).join('\n\n') };
    }
    return { role: m.role, content: m.content };
  }

  async function payloadOf(chat, summary, live) {
    const out = summary ? [{ role: 'summary', content: summary.content }] : [];
    for (const m of live) out.push(await apiMessage(chat, m));
    return out;
  }

  // The model summarized the first `count` live messages: mark them compacted and put the summary after them.
  function applyCompaction(chat, ev, prev, live) {
    const victims = live.slice(0, ev.count);
    for (const m of victims) m.archived = true;
    if (prev) prev.archived = true;
    const s = {
      id: newId(),
      role: 'summary',
      content: ev.summary,
      auto: !!ev.auto,
      progressSaved: !!ev.progressSaved,
      count: ev.count + ((prev && prev.count) || 0),
      tokensBefore: ev.tokensBefore,
      tokensAfter: ev.tokensAfter,
      context: ev.context,
      at: Date.now(),
    };
    const last = victims[victims.length - 1];
    chat.messages.splice(last ? chat.messages.indexOf(last) + 1 : chat.messages.length, 0, s);
    return { type: 'compacted', summary: s, archived: [...victims, ...(prev ? [prev] : [])].map((m) => m.id), after: last ? last.id : null };
  }

  // -------------------------------------------------------------- runs --
  function setRun(chat, run) {
    chat.run = run;
    emit(chat, { type: 'run', state: run.state, kind: run.kind, messageId: run.messageId || null });
    listChanged(chat);
  }

  function endRun(chat, state, error) {
    const kind = chat.run ? chat.run.kind : 'reply';
    const messageId = chat.run ? chat.run.messageId : null;
    const turn = messageId && chat.messages.find((m) => m.id === messageId);
    if (turn && turn.blocks) {
      for (const b of turn.blocks) if (b.type === 'permission' && b.state === 'pending') b.state = 'expired';
      turn.notice = '';
    }
    chat.waiting = 0;
    delete chat.run;
    running.delete(chat.id);
    chat.lastRun = { state, kind, at: Date.now() };
    chat.updatedAt = Date.now();
    emit(chat, { type: 'run', state, kind, messageId, error: error || undefined });
    listChanged(chat);
    saveNow(chat);
    log(`Chat "${chat.title || chat.id}": ${kind} ${state}${error ? ` (${error})` : ''}`);
  }

  function enqueue(chat) {
    queue.push(chat.id);
    pump();
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length) {
        const chat = chats.get(queue.shift());
        if (!chat || !chat.run || chat.run.state !== 'queued') continue;
        const ac = new AbortController();
        running.set(chat.id, ac);
        setRun(chat, { ...chat.run, state: 'running', startedAt: Date.now() });
        try {
          if (chat.run.kind === 'compact') await runCompact(chat, ac.signal);
          else await runReply(chat, ac.signal);
        } catch (e) {
          log(`Run error in chat ${chat.id}: ${e.message}`);
          if (chat.run) endRun(chat, 'error', friendlyError(e));
        }
      }
    } finally {
      pumping = false;
    }
  }

  async function runReply(chat, signal) {
    const opts = chat.run.opts || {};
    const a = chat.messages.find((m) => m.id === chat.run.messageId);
    if (!a) return endRun(chat, 'error', 'The reply message is missing.');
    const before = chat.messages.slice(0, chat.messages.indexOf(a));
    const { summary: prev, live } = sendable(before);
    let firstPrompt = 0;
    const send = (ev) => {
      switch (ev.type) {
        case 'compacted':
          return emit(chat, applyCompaction(chat, ev, prev, live));
        case 'context':
          a.ctxEstimate = ev.estimate;
          a.ctxContext = ev.context;
          return emit(chat, { type: 'context', id: a.id, estimate: ev.estimate, context: ev.context });
        case 'usage': {
          // What the next message will start from: this request's prompt plus the visible answer.
          // Tool results from this reply are not sent again, so later steps only count as the peak.
          if (!firstPrompt) firstPrompt = ev.prompt;
          const peak = Math.max((a.usage && a.usage.peak) || 0, ev.prompt + ev.completion);
          a.usage = { used: firstPrompt + Math.max(0, ev.completion - ev.reasoning), peak, context: ev.context };
          // Like LM Studio's stats: tokens, tokens per second, time to first token, prompt size.
          const st = a.stats || { tokens: 0, thinking: 0, genSeconds: 0, ttft: ev.ttft, prompt: ev.prompt, rounds: 0 };
          st.tokens += ev.completion || 0;
          st.thinking += ev.reasoning || 0;
          st.genSeconds += ev.genSeconds || 0;
          st.rounds++;
          st.tps = st.genSeconds > 0 ? Math.round((st.tokens / st.genSeconds) * 10) / 10 : 0;
          a.stats = st;
          return emit(chat, { type: 'usage', id: a.id, usage: a.usage, stats: a.stats });
        }
        case 'token':
          a.content += ev.text;
          break;
        case 'reasoning':
          a.reasoning = (a.reasoning || '') + ev.text;
          break;
        case 'round_end':
          if (a.content && !a.content.endsWith('\n\n')) a.content += '\n\n';
          break;
        case 'tool_call':
          a.tools.push({ id: ev.id, name: ev.name, args: ev.args });
          break;
        case 'tool_result': {
          const t = a.tools.find((x) => x.id === ev.id);
          if (t) {
            t.ok = ev.ok;
            t.result = ev.result;
          }
          break;
        }
        case 'status':
          a.notice = ev.text;
          break;
        case 'gen':
          // Live progress isn't saved; it goes to the devices that are watching.
          for (const send of watchers.get(chat.id) || []) send({ ...ev, id: a.id });
          return;
      }
      emit(chat, { ...ev, id: ev.type === 'claude_md_updated' ? undefined : a.id, toolId: ev.id });
    };

    try {
      await d.chatCore(
        {
          messages: await payloadOf(chat, prev, live),
          project: chat.project || null,
          model: opts.model,
          allowEdits: opts.allowEdits,
          system: opts.system,
        },
        send,
        signal
      );
      a.notice = '';
      endRun(chat, 'done');
    } catch (e) {
      a.notice = '';
      if (signal.aborted) {
        if (!a.content) a.error = 'Stopped.';
        emit(chat, { type: 'error', id: a.id, message: a.error || '' });
        endRun(chat, 'stopped');
      } else {
        a.error = friendlyError(e);
        log('chat error: ' + e.message);
        emit(chat, { type: 'error', id: a.id, message: a.error });
        endRun(chat, 'error', a.error);
      }
    }
  }

  async function runCompact(chat, signal) {
    const opts = chat.run.opts || {};
    const { summary: prev, live } = sendable(chat.messages);
    const send = (ev) => {
      if (ev.type === 'compacted') return emit(chat, applyCompaction(chat, ev, prev, live));
      if (ev.type === 'status') return emit(chat, { type: 'compact_status', text: ev.text });
      emit(chat, ev);
    };
    try {
      await d.compactCore(
        {
          messages: await payloadOf(chat, prev, live),
          project: chat.project || null,
          model: opts.model,
          allowEdits: opts.allowEdits,
          instructions: opts.instructions,
          saveProgress: opts.saveProgress,
        },
        send,
        signal
      );
      endRun(chat, 'done');
    } catch (e) {
      if (signal.aborted) endRun(chat, 'stopped');
      else endRun(chat, 'error', friendlyError(e));
    }
  }

  function stop(chat) {
    if (!chat.run) return false;
    const ac = running.get(chat.id);
    if (ac) {
      ac.abort();
      return true;
    }
    // Still waiting in the queue.
    queue = queue.filter((id) => id !== chat.id);
    const a = chat.run.messageId && chat.messages.find((m) => m.id === chat.run.messageId);
    if (a && !a.content) {
      a.error = 'Stopped.';
      emit(chat, { type: 'error', id: a.id, message: a.error });
    }
    endRun(chat, 'stopped');
    return true;
  }

  // ---------------------------------------------------------- messages --
  const IMAGE_RE = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/]+=*)$/;
  const MAX_IMAGES = 24;

  async function saveAttachments(chat, msgId, list) {
    const out = [];
    let n = 0;
    for (const a of Array.isArray(list) ? list : []) {
      if (!a || typeof a !== 'object') continue;
      const files = [];
      for (const url of Array.isArray(a.images) ? a.images : []) {
        const m = typeof url === 'string' && IMAGE_RE.exec(url);
        if (!m || n >= MAX_IMAGES) continue;
        const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
        const name = `${msgId}-${n++}.${ext}`;
        await fsp.mkdir(path.join(dirOf(chat.id), 'files'), { recursive: true });
        await fsp.writeFile(path.join(dirOf(chat.id), 'files', name), Buffer.from(m[2], 'base64'));
        files.push(name);
      }
      if (!files.length) continue;
      out.push({
        kind: a.kind === 'video' ? 'video' : 'image',
        name: String(a.name || 'image').slice(0, 200),
        thumb: typeof a.thumb === 'string' && IMAGE_RE.test(a.thumb) && a.thumb.length < 200000 ? a.thumb : '',
        frames: files.length,
        note: typeof a.note === 'string' ? a.note.slice(0, 2000) : undefined,
        files,
      });
    }
    return out;
  }

  const titleFrom = (text) => {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    return t.length > 60 ? t.slice(0, 57).replace(/\s+\S*$/, '') + '…' : t;
  };

  function getChat(id) {
    const chat = validId(id) && chats.get(id);
    if (!chat) throw httpError(404, 'That chat no longer exists.');
    return chat;
  }

  async function createChat(body) {
    if (body.kind === 'code') {
      if (!code) throw httpError(400, 'Claude Code sessions are not available on this bridge.');
      const extra = await code.validateNew(body);
      const now = Date.now();
      const chat = { id: newId(), kind: 'code', title: extra.title, project: null, createdAt: now, updatedAt: now, seq: 0, messages: [], ...extra.fields };
      chats.set(chat.id, chat);
      await saveNow(chat);
      listChanged(chat);
      return chat;
    }
    const project = typeof body.project === 'string' && body.project ? body.project : null;
    if (project) await d.getProjectDir(project);
    const now = Date.now();
    const chat = { id: newId(), kind: 'chat', title: '', project, createdAt: now, updatedAt: now, seq: 0, messages: [] };
    chats.set(chat.id, chat);
    await saveNow(chat);
    listChanged(chat);
    return chat;
  }

  async function addMessage(chat, body) {
    if (chat.kind !== 'chat') throw httpError(400, 'This is not a model chat.');
    if (chat.run) throw httpError(409, 'A reply is still running in this chat. Stop it first.');
    const text = typeof body.content === 'string' ? body.content.slice(0, 500000) : '';
    const userId = newId();
    const attachments = await saveAttachments(chat, userId, body.attachments);
    if (!text.trim() && !attachments.length) throw httpError(400, 'The message is empty.');
    const user = { id: userId, role: 'user', content: text, at: Date.now() };
    if (attachments.length) user.attachments = attachments;
    const a = { id: newId(), role: 'assistant', content: '', reasoning: '', tools: [], at: Date.now() };
    chat.messages.push(user, a);
    if (!chat.title) chat.title = titleFrom(text) || (attachments.length ? attachments[0].name : 'New chat');
    chat.updatedAt = Date.now();
    emit(chat, { type: 'message', message: user });
    emit(chat, { type: 'message', message: a });
    setRun(chat, {
      kind: 'reply',
      state: 'queued',
      messageId: a.id,
      opts: {
        model: typeof body.model === 'string' && body.model ? body.model : undefined,
        allowEdits: body.allowEdits !== false,
        system: typeof body.system === 'string' ? body.system.slice(0, 20000) : undefined,
      },
    });
    await saveNow(chat);
    enqueue(chat);
    return { userId: user.id, assistantId: a.id };
  }

  function startCompact(chat, body) {
    if (chat.kind !== 'chat') throw httpError(400, 'This is not a model chat.');
    if (chat.run) throw httpError(409, 'Something is still running in this chat. Stop it first.');
    const { summary, live } = sendable(chat.messages);
    if (!live.length) throw httpError(400, summary ? 'Nothing new to compact since the last summary.' : 'This chat is empty.');
    setRun(chat, {
      kind: 'compact',
      state: 'queued',
      opts: {
        model: typeof body.model === 'string' && body.model ? body.model : undefined,
        allowEdits: body.allowEdits !== false,
        instructions: typeof body.instructions === 'string' ? body.instructions : '',
        saveProgress: body.saveProgress !== false,
      },
    });
    enqueue(chat);
  }

  async function deleteChat(chat) {
    if (chat.kind === 'code') {
      if (code) code.end(chat);
    } else stop(chat);
    chats.delete(chat.id);
    clearTimeout(saveTimers.get(chat.id));
    saveTimers.delete(chat.id);
    buffers.delete(chat.id);
    for (const send of watchers.get(chat.id) || []) send({ type: 'deleted' });
    await withLock(chat.id, async () => {
      await fsp.mkdir(TRASH, { recursive: true });
      await fsp.rename(dirOf(chat.id), path.join(TRASH, chat.id)).catch(async (e) => {
        if (e.code !== 'ENOENT') throw e;
      });
    });
    broadcastList({ type: 'chat_deleted', id: chat.id });
    log(`Chat "${chat.title || chat.id}" moved to ${TRASH}`);
  }

  // A device watching one chat: replay what it missed after `since`, then stream live.
  function watch(req, res, chat, since) {
    const { send, close } = openEventStream(req, res, () => {
      const set = watchers.get(chat.id);
      if (set) {
        set.delete(send);
        if (!set.size) watchers.delete(chat.id);
      }
    });
    const seq = chat.seq || 0;
    if (Number.isFinite(since) && since > seq) {
      // The device saw changes this bridge no longer has (it restarted before saving them).
      send({ type: 'reload', current: seq });
    } else if (Number.isFinite(since) && since < seq) {
      const b = buffers.get(chat.id);
      if (b && b.events.length && b.events[0].seq <= since + 1) {
        for (const ev of b.events) if (ev.seq > since) send(ev);
      } else {
        send({ type: 'reload', current: seq });
      }
    }
    if (!watchers.has(chat.id)) watchers.set(chat.id, new Set());
    watchers.get(chat.id).add(send);
    return close;
  }

  // ------------------------------------------------------------ routes --
  // Returns true if it handled the request.
  async function handle(req, res, url) {
    const p = url.pathname.replace(/\/+$/, '');
    if (req.method === 'GET' && p === '/api/events') {
      const { send } = openEventStream(req, res, () => listWatchers.delete(send));
      listWatchers.add(send);
      send({ type: 'hello', running: [...chats.values()].filter((c) => c.run).map((c) => c.id), ...(code ? { hosts: code.list() } : {}) });
      return true;
    }
    if (p === '/api/chats') {
      if (req.method === 'GET') {
        const list = [...chats.values()].map(summaryOf).sort((a, b) => b.updatedAt - a.updatedAt);
        json(res, 200, { chats: list });
        return true;
      }
      if (req.method === 'POST') {
        json(res, 201, await createChat(await readJson(req)));
        return true;
      }
    }
    const m = /^\/api\/chats\/([a-z0-9]+)(?:\/(messages|stop|compact|stream|permission))?$/.exec(p);
    if (!m) return false;
    const chat = getChat(m[1]);
    const action = `${req.method} ${m[2] || ''}`;
    switch (action) {
      case 'GET ':
        json(res, 200, chat);
        return true;
      case 'PATCH ': {
        const body = await readJson(req);
        if (typeof body.title === 'string') chat.title = body.title.replace(/\s+/g, ' ').trim().slice(0, 120) || chat.title;
        chat.updatedAt = Date.now();
        emit(chat, { type: 'chat', title: chat.title });
        listChanged(chat);
        await saveNow(chat);
        json(res, 200, summaryOf(chat));
        return true;
      }
      case 'DELETE ':
        await deleteChat(chat);
        json(res, 200, { ok: true });
        return true;
      case 'POST messages':
        // Larger limit: messages can carry images.
        if (chat.kind === 'code') json(res, 202, await code.message(chat, await readJson(req)));
        else json(res, 202, await addMessage(chat, await readJson(req, 64 * 1024 * 1024)));
        return true;
      case 'POST stop':
        json(res, 200, { stopped: chat.kind === 'code' ? code.stop(chat) : stop(chat) });
        return true;
      case 'POST permission':
        if (chat.kind !== 'code') throw httpError(400, 'Only Claude Code sessions ask for approval.');
        json(res, 200, code.permission(chat, await readJson(req)));
        return true;
      case 'POST compact':
        startCompact(chat, await readJson(req));
        json(res, 202, { ok: true });
        return true;
      case 'GET stream':
        watch(req, res, chat, Number(url.searchParams.get('since')));
        return true;
      default:
        throw httpError(405, 'Not supported.');
    }
  }

  return {
    init, handle, chats, emit, listChanged, broadcastList, summaryOf, newId, saveNow, saveSoon, setRun, endRun, titleFrom,
    setCode: (c) => { code = c; },
    // Sends an event to the devices watching a chat without storing it (live progress).
    live: (chat, ev) => { for (const send of watchers.get(chat.id) || []) send(ev); },
  };
};
