'use strict';
// Computers that run Claude Code sessions for the website ("hosts"), and those sessions.
//
// A host is host/claude-remote.mjs running on some computer (this PC starts one itself). It
// connects out to the bridge: it registers, keeps a command stream open (GET .../commands), and
// posts what its sessions do (POST .../events). A session is stored like any other chat
// (kind: 'code'), so it gets the same list, live streaming and catch-up on every device.
//
// A code session's messages: the user's messages, and one assistant "turn" per message with
// blocks: { type: 'text' | 'thinking', text }, { type: 'tool', id, name, input, ok, result },
// and { type: 'permission', requestId, toolName, input, state: pending | allowed | denied | expired }.
//
// Note (the terminal agent, its own repo) also connects as a host, one per terminal ("terminal"
// hosts). Its sessions start in the terminal, not from the website: it announces each one
// (session_open) and the messages typed there (user_message), and its events name the session
// (`session`) instead of a chat id. The website can watch, message, approve and stop them.

const path = require('path');
const fs = require('fs');

module.exports = function createHosts(d) {
  const { log, httpError, readJson, json, openEventStream, chats } = d;
  const hosts = new Map(); // id -> host
  const OFFLINE_GRACE_MS = 15000;

  const summary = (h) => ({
    id: h.id,
    name: h.name,
    os: h.os,
    platform: h.platform,
    roots: h.roots,
    folders: h.folders,
    online: !!h.send,
    claude: h.claude,
    managed: h.managed,
    terminal: !!h.terminal,
    lastSeen: h.lastSeen,
  });
  const agentName = (chat) => (chat.origin === 'terminal' ? 'Note' : 'Claude Code');
  // A session's permission mode: default = ask before changes and commands, acceptEdits = file
  // changes in the folder are automatic, allowAll = commands too (Note: its own Auto mode),
  // plan = plan only. The host applies it; it can change at any time.
  const MODES = ['default', 'acceptEdits', 'allowAll', 'plan'];
  const list = () => [...hosts.values()].map(summary).sort((a, b) => (b.managed ? 1 : 0) - (a.managed ? 1 : 0) || a.name.localeCompare(b.name));
  const announce = () => chats.broadcastList({ type: 'hosts', hosts: list() });

  function command(hostId, cmd) {
    const h = hosts.get(hostId);
    if (!h || !h.send) {
      const name = (h && h.name) || hostId;
      throw httpError(409, `The computer "${name}" isn't connected. Start claude-remote on it, then try again.`);
    }
    h.send(cmd);
  }

  // ----------------------------------------------------- website side --
  async function validateNew(body) {
    const h = hosts.get(String(body.host || ''));
    if (!h) throw httpError(400, 'Pick a computer to run Claude Code on.');
    if (h.terminal) throw httpError(400, 'Note sessions start in a terminal on that computer.');
    const cwd = typeof body.cwd === 'string' ? body.cwd : '';
    // On this PC, a project folder belongs to that project (its chats list, its CLAUDE.md).
    const project = h.managed ? d.projectForFolder(cwd) : null;
    if (project) await d.getProjectDir(project); // must exist (a just-created one may not be in h.folders yet)
    else if (!h.folders.includes(cwd) && !h.roots.includes(cwd)) throw httpError(400, `That folder isn't one "${h.name}" allows.`);
    if (project && (await d.ensureProjectMd(project))) log(`Created a starter CLAUDE.md for project "${project}"`);
    return {
      title: `${path.basename(cwd) || cwd} · ${h.name}`,
      fields: { host: h.id, hostName: h.name, cwd, project, permissionMode: MODES.includes(body.permissionMode) ? body.permissionMode : 'default' },
    };
  }

  // Sessions made before they could belong to a project: attach the ones in a project folder.
  async function adoptExisting() {
    for (const chat of chats.chats.values()) {
      if (chat.kind !== 'code' || chat.project) continue;
      const project = d.projectForFolder(chat.cwd);
      if (!project) continue;
      chat.project = project;
      await chats.saveNow(chat);
    }
  }

  const IMAGE_RE = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+=*$/;
  const MAX_IMAGES = 16;
  const MAX_FILE_BYTES = 25 * 1024 * 1024;

  // Images (and video frames) go to the model; other files are saved in the session folder.
  function attachments(list) {
    const images = [];
    const files = [];
    const notes = [];
    const shown = [];
    let bytes = 0;
    for (const a of Array.isArray(list) ? list : []) {
      if (!a || typeof a !== 'object') continue;
      const name = String(a.name || 'file').slice(0, 200);
      if (a.kind === 'file') {
        const data = typeof a.data === 'string' ? a.data : '';
        bytes += Math.floor((data.length * 3) / 4);
        if (!data || bytes > MAX_FILE_BYTES) throw httpError(413, 'Attached files can be up to 25 MB in total.');
        files.push({ name, data });
        shown.push({ kind: 'file', name, size: Math.floor((data.length * 3) / 4) });
        continue;
      }
      const urls = (Array.isArray(a.images) ? a.images : []).filter((u) => typeof u === 'string' && IMAGE_RE.test(u));
      if (!urls.length) continue;
      if (images.length + urls.length > MAX_IMAGES) throw httpError(400, `Up to ${MAX_IMAGES} images per message (a video counts as several).`);
      images.push(...urls);
      if (typeof a.note === 'string' && a.note) notes.push(a.note.slice(0, 2000));
      shown.push({
        kind: a.kind === 'video' ? 'video' : 'image',
        name,
        thumb: typeof a.thumb === 'string' && IMAGE_RE.test(a.thumb) && a.thumb.length < 200000 ? a.thumb : '',
        frames: urls.length,
      });
    }
    return { images, files, notes, shown };
  }

  async function message(chat, body) {
    if (chat.run) throw httpError(409, `${agentName(chat)} is still working in this session. Stop it first, or wait.`);
    const text = typeof body.content === 'string' ? body.content.trim().slice(0, 100000) : '';
    const att = attachments(body.attachments);
    if (!text && !att.shown.length) throw httpError(400, 'The message is empty.');
    command(chat.host, {
      type: 'message',
      chatId: chat.id,
      content: text,
      images: att.images,
      files: att.files,
      notes: att.notes,
      cwd: chat.cwd,
      permissionMode: chat.permissionMode,
      model: chat.model || undefined,
      resume: chat.sdkSessionId || undefined,
    });
    const user = { id: chats.newId(), role: 'user', content: text, at: Date.now() };
    if (att.shown.length) user.attachments = att.shown;
    const turn = { id: chats.newId(), role: 'assistant', blocks: [], at: Date.now() };
    chat.messages.push(user, turn);
    chat.updatedAt = Date.now();
    chats.emit(chat, { type: 'message', message: user });
    chats.emit(chat, { type: 'message', message: turn });
    chats.setRun(chat, { kind: 'turn', state: 'running', messageId: turn.id });
    await chats.saveNow(chat);
    return { userId: user.id, assistantId: turn.id };
  }

  function stop(chat) {
    if (!chat.run) return false;
    chat.run.stopping = true;
    try {
      command(chat.host, { type: 'interrupt', chatId: chat.id });
    } catch {
      endTurn(chat, 'stopped', 'Stopped. The computer running this session is offline.');
    }
    return true;
  }

  function permission(chat, body) {
    const requestId = String(body.requestId || '');
    const turn = chat.run && chat.messages.find((m) => m.id === chat.run.messageId);
    const b = turn && turn.blocks.find((x) => x.type === 'permission' && x.requestId === requestId);
    if (!b || b.state !== 'pending') throw httpError(409, 'That request was already answered or has expired.');
    command(chat.host, { type: 'permission', chatId: chat.id, requestId, allow: !!body.allow, always: !!body.always });
    return { ok: true };
  }

  function setMode(chat, body) {
    const mode = String(body.mode || '');
    if (!MODES.includes(mode)) throw httpError(400, `Unknown mode "${mode}". Use one of: ${MODES.join(', ')}.`);
    try {
      command(chat.host, { type: 'mode', chatId: chat.id, mode });
    } catch (e) {
      // A Claude Code session that isn't running picks the mode up with its next message.
      if (chat.origin === 'terminal') throw e;
    }
    modeChanged(chat, mode);
    return { ok: true, mode };
  }

  function modeChanged(chat, mode) {
    // 'yolo' (Note, set in its terminal) is shown but can't be picked on the website.
    if (![...MODES, 'yolo'].includes(mode) || chat.permissionMode === mode) return;
    chat.permissionMode = mode;
    chats.emit(chat, { type: 'mode', mode });
    chats.saveSoon(chat);
  }

  // ------------------------------------------------------------- model --
  // A Claude Code session's model ('' = the bridge's default). Claude Code fixes the model and
  // context size when it starts, so the host restarts the session on the new model and resumes
  // the same conversation (from the next message). If the conversation is past the point where
  // Claude Code would compact on the new model, it is compacted on the current model first, as
  // its own turn, and the switch happens when that turn finishes.
  // Claude Code compacts at about context − 16,384 (reply cap) − 7,000 (claude-remote's reserve).
  const COMPACT_MARGIN = 16384 + 7000;

  // How big the conversation is now: the size of its last model call (recorded by the bridge
  // from the call itself, server.js handleAnthropic) or what the latest turn reported, whichever
  // is bigger. A compaction resets it.
  function lastUsed(chat) {
    const t = [...chat.messages].reverse().find((m) => m.role === 'assistant');
    const reported = t && t.ctx && t.ctx.used ? t.ctx.used : 0;
    return Math.max(reported, (chat.lastPrompt && chat.lastPrompt.tokens) || 0);
  }

  async function setModel(chat, body) {
    if (chat.origin === 'terminal') throw httpError(400, 'Switch Note\'s model in its terminal, with /model.');
    if (chat.run) throw httpError(409, 'Claude Code is still working in this session. Wait or stop it, then switch.');
    const model = typeof body.model === 'string' ? body.model : '';
    if (model) {
      const known = (await d.listModels().catch(() => [])).map((m) => m.id);
      if (!known.includes(model)) throw httpError(400, `Unknown model "${model}".`);
    }
    if (model === (chat.model || '')) return { ok: true, model, compacting: false };
    const ctx = await d.contextOf(model || (await d.listModels().then((l) => (l.find((m) => m.loaded) || {}).id).catch(() => '')));
    const used = lastUsed(chat);
    if (ctx && used > ctx - COMPACT_MARGIN) {
      // Too big for the new model: compact first (on the current model), then switch.
      const { assistantId } = await message(chat, { content: '/compact' });
      chat.pendingModel = { model, turnId: assistantId };
      chats.emit(chat, { type: 'model', model: chat.model || '', pending: model });
      chats.saveSoon(chat);
      log(`Session ${chat.id}: compacting (~${used} tokens) before switching to ${model || 'the default model'} (${ctx} context)`);
      return { ok: true, model, compacting: true };
    }
    switchModel(chat, model);
    return { ok: true, model, compacting: false };
  }

  function switchModel(chat, model) {
    chat.pendingModel = undefined;
    chat.model = model || undefined;
    // A session running on its computer restarts on the new model with the next message; an
    // offline one just gets the model with its next message.
    try {
      command(chat.host, { type: 'model', chatId: chat.id, model: model || undefined });
    } catch {}
    chats.emit(chat, { type: 'model', model: model || '' });
    chats.saveSoon(chat);
    log(`Session ${chat.id}: model set to ${model || 'the default model'}`);
  }

  // A turn ended: if it was the compaction before a switch, switch if it worked, otherwise
  // stay on the current model.
  function compactDone(chat, turnId, ok) {
    const p = chat.pendingModel;
    if (!p || p.turnId !== turnId) return;
    if (ok) return switchModel(chat, p.model);
    chat.pendingModel = undefined;
    chats.emit(chat, { type: 'model', model: chat.model || '' });
    chats.saveSoon(chat);
    log(`Session ${chat.id}: compaction didn't finish, so the model stays ${chat.model || 'the default'}`);
  }

  function end(chat) {
    try {
      command(chat.host, { type: 'end', chatId: chat.id });
    } catch {}
  }

  // ------------------------------------------------------ host events --
  function endTurn(chat, state, error) {
    const turn = chat.run && chat.messages.find((m) => m.id === chat.run.messageId);
    if (turn && error && !turn.error) {
      turn.error = error;
      chats.emit(chat, { type: 'error', id: turn.id, message: error });
    }
    if (chat.run) chats.endRun(chat, state, error);
    if (turn) compactDone(chat, turn.id, false);
  }

  // Note: a terminal session the website hasn't seen yet becomes a code chat.
  async function openTerminalSession(hostId, ev) {
    const h = hosts.get(hostId);
    if (!h || !h.terminal || typeof ev.session !== 'string' || !ev.session) return;
    if (sessionChat(hostId, ev.session)) return;
    const cwd = typeof ev.cwd === 'string' ? ev.cwd : '';
    const now = Date.now();
    const chat = {
      id: chats.newId(),
      kind: 'code',
      origin: 'terminal',
      title: `${path.basename(cwd) || cwd || 'Terminal'} · ${h.name}`,
      project: null,
      createdAt: now,
      updatedAt: now,
      seq: 0,
      messages: [],
      host: hostId,
      hostName: h.name,
      cwd,
      noteSession: ev.session,
      permissionMode: 'default',
    };
    chats.chats.set(chat.id, chat);
    await chats.saveNow(chat);
    chats.listChanged(chat);
    log(`Note session opened on "${h.name}" (${cwd})`);
  }

  function sessionChat(hostId, session) {
    for (const c of chats.chats.values()) if (c.kind === 'code' && c.host === hostId && c.noteSession === session) return c;
    return null;
  }

  // A message typed in a Note terminal (the website's own messages are added when sent).
  function terminalMessage(chat, ev) {
    if (chat.run) endTurn(chat, 'done');
    const user = { id: chats.newId(), role: 'user', content: String(ev.text || '').slice(0, 100000), at: Date.now(), from: 'terminal' };
    const turn = { id: chats.newId(), role: 'assistant', blocks: [], at: Date.now() };
    chat.messages.push(user, turn);
    chat.updatedAt = Date.now();
    chats.emit(chat, { type: 'message', message: user });
    chats.emit(chat, { type: 'message', message: turn });
    chats.setRun(chat, { kind: 'turn', state: 'running', messageId: turn.id });
    chats.saveSoon(chat);
  }

  async function apply(hostId, ev) {
    if (ev.type === 'session_open') return openTerminalSession(hostId, ev);
    const chat = ev.chatId ? chats.chats.get(ev.chatId) : sessionChat(hostId, String(ev.session || ''));
    if (!chat || chat.kind !== 'code' || chat.host !== hostId) return;
    if (ev.type === 'user_message') return terminalMessage(chat, ev);
    // The mode in effect on the host (it may also have been changed there, e.g. Shift+Tab in Note).
    if (ev.type === 'mode') return modeChanged(chat, String(ev.mode || ''));
    const turn =
      (chat.run && chat.messages.find((m) => m.id === chat.run.messageId)) ||
      [...chat.messages].reverse().find((m) => m.role === 'assistant');
    if (ev.type === 'session') {
      chat.sdkSessionId = ev.sessionId;
      chats.saveSoon(chat);
      return;
    }
    if (ev.type === 'compacted') {
      // Claude Code compacted the conversation: the last call's size no longer applies.
      chat.lastPrompt = undefined;
      if (turn && turn.ctx) turn.ctx = undefined;
      chats.saveSoon(chat);
      return;
    }
    if (!turn) return;
    const out = { type: ev.type, id: turn.id };
    switch (ev.type) {
      case 'status':
        turn.notice = String(ev.text || '');
        out.text = turn.notice;
        break;
      case 'block_start':
        turn.blocks.push({ type: ev.kind === 'thinking' ? 'thinking' : 'text', text: '' });
        out.kind = ev.kind === 'thinking' ? 'thinking' : 'text';
        break;
      case 'delta': {
        let b = turn.blocks[turn.blocks.length - 1];
        if (!b || (b.type !== 'text' && b.type !== 'thinking')) turn.blocks.push((b = { type: 'text', text: '' }));
        b.text += String(ev.text || '');
        out.text = String(ev.text || '');
        break;
      }
      case 'tool_use':
        turn.blocks.push({ type: 'tool', id: ev.toolId, name: ev.name, input: ev.input });
        Object.assign(out, { toolId: ev.toolId, name: ev.name, input: ev.input });
        break;
      case 'tool_result': {
        const b = turn.blocks.find((x) => x.type === 'tool' && x.id === ev.toolId);
        if (b) {
          b.ok = !!ev.ok;
          b.result = ev.result;
        }
        Object.assign(out, { toolId: ev.toolId, ok: !!ev.ok, result: ev.result });
        break;
      }
      case 'permission_request':
        turn.blocks.push({ type: 'permission', requestId: ev.requestId, toolName: ev.toolName, input: ev.input, blockedPath: ev.blockedPath, state: 'pending' });
        chat.waiting = (chat.waiting || 0) + 1;
        Object.assign(out, { requestId: ev.requestId, toolName: ev.toolName, input: ev.input, blockedPath: ev.blockedPath });
        chats.emit(chat, out);
        chats.listChanged(chat);
        return;
      case 'permission_resolved': {
        const b = turn.blocks.find((x) => x.type === 'permission' && x.requestId === ev.requestId);
        if (b && b.state === 'pending') {
          b.state = ev.allow ? 'allowed' : 'denied';
          if (ev.always) b.always = true;
          chat.waiting = Math.max(0, (chat.waiting || 0) - 1);
        }
        Object.assign(out, { requestId: ev.requestId, allow: !!ev.allow, always: !!ev.always });
        chats.emit(chat, out);
        chats.listChanged(chat);
        return;
      }
      case 'ctx_usage':
        turn.ctx = { used: Number(ev.used) || 0, context: Number(ev.context) || null };
        out.ctx = turn.ctx;
        break;
      case 'gen':
        chats.live(chat, { type: 'gen', id: turn.id, phase: ev.phase, tokens: ev.tokens, thinking: ev.thinking, tps: ev.tps, waited: ev.waited });
        return;
      case 'result': {
        const stopping = !!(chat.run && chat.run.stopping);
        turn.result = { subtype: ev.subtype, turns: ev.turns, durationMs: ev.durationMs, isError: !!ev.isError, stopped: stopping, stats: ev.stats || undefined };
        turn.notice = '';
        Object.assign(out, { result: turn.result });
        chats.emit(chat, out);
        if (chat.run) chats.endRun(chat, stopping ? 'stopped' : ev.isError ? 'error' : 'done', ev.isError && !stopping ? ev.text || ev.subtype : undefined);
        compactDone(chat, turn.id, !stopping && !ev.isError);
        return;
      }
      case 'error':
        endTurn(chat, 'error', String(ev.message || `${agentName(chat)} failed.`));
        return;
      case 'ended':
        if (chat.run) endTurn(chat, 'stopped', 'The session ended on its computer.');
        if (chat.origin === 'terminal' && !chat.closed) {
          chat.closed = true;
          chats.saveSoon(chat);
          chats.listChanged(chat);
        }
        return;
      default:
        return;
    }
    chats.emit(chat, out);
  }

  function hostGone(h) {
    for (const chat of chats.chats.values())
      if (chat.kind === 'code' && chat.host === h.id && chat.run) endTurn(chat, 'stopped', `"${h.name}" disconnected while ${agentName(chat)} was working.`);
  }

  // ------------------------------------------------------------ routes --
  async function handle(req, res, url) {
    const p = url.pathname.replace(/\/+$/, '');
    if (p === '/api/hosts' && req.method === 'GET') {
      json(res, 200, { hosts: list() });
      return true;
    }
    const m = /^\/api\/hosts\/([a-z0-9-]{1,60})\/(register|commands|events)$/.exec(p);
    if (!m) return false;
    const id = m[1];
    const action = `${req.method} ${m[2]}`;
    if (action === 'POST register') {
      const b = await readJson(req);
      const strs = (a, n) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string').slice(0, n) : []);
      const h = hosts.get(id) || { id, send: null };
      const restarted = h.bootId !== b.bootId;
      Object.assign(h, {
        bootId: String(b.bootId || ''),
        name: String(b.name || id).slice(0, 60),
        os: String(b.os || '').slice(0, 80),
        platform: String(b.platform || ''),
        roots: strs(b.roots, 20),
        folders: strs(b.folders, 400),
        claude: b.claude !== false,
        managed: !!b.managed,
        terminal: !!b.terminal,
        lastSeen: Date.now(),
      });
      hosts.set(id, h);
      // The host restarted: sessions it no longer has can't finish their running turns.
      if (restarted) {
        const alive = new Set(strs(b.sessions, 1000));
        for (const chat of chats.chats.values())
          if (chat.kind === 'code' && chat.host === id && chat.run && !alive.has(chat.id)) endTurn(chat, 'stopped', `"${h.name}" restarted while Claude Code was working.`);
      }
      announce();
      json(res, 200, { ok: true });
      return true;
    }
    const h = hosts.get(id);
    if (!h) throw httpError(404, 'Register first.');
    if (action === 'GET commands') {
      if (h.send) h.close();
      const { send, close } = openEventStream(req, res, () => {
        if (h.send !== send) return;
        h.send = null;
        h.close = null;
        h.lastSeen = Date.now();
        log(`Claude Code host "${h.name}" disconnected`);
        announce();
        // Give it a moment to reconnect before giving up on running sessions.
        setTimeout(() => {
          if (h.send) return;
          hostGone(h);
          // A Note terminal that closed won't come back under this id: forget it (its sessions stay).
          if (h.terminal && hosts.get(id) === h) {
            hosts.delete(id);
            announce();
          }
        }, OFFLINE_GRACE_MS);
      });
      h.send = send;
      h.close = close;
      h.lastSeen = Date.now();
      log(`Claude Code host "${h.name}" connected (${h.roots.join(', ')})`);
      announce();
      return true;
    }
    if (action === 'POST events') {
      const b = await readJson(req, 16 * 1024 * 1024);
      h.lastSeen = Date.now();
      for (const ev of Array.isArray(b.events) ? b.events : []) {
        try {
          await apply(id, ev);
        } catch (e) {
          log(`Bad event from "${h.name}": ${e.message}`);
        }
      }
      json(res, 200, { ok: true });
      return true;
    }
    throw httpError(405, 'Not supported.');
  }

  // --------------------------------------------- the PC's own host --
  // Started by the bridge so this PC can always run sessions in its projects folder.
  function startLocalHost({ port, token, root, name }) {
    const dir = path.join(__dirname, '..', 'host');
    const script = path.join(dir, 'claude-remote.mjs');
    if (!fs.existsSync(path.join(dir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk'))) {
      log('Claude Code sessions: not set up on this PC. Run "npm install --omit=optional" in the host folder, then restart the bridge.');
      return;
    }
    const { spawn } = require('child_process');
    let delay = 2000;
    let child = null;
    const run = () => {
      const args = [script, '--managed', '--name', name, '--root', root];
      child = spawn(process.execPath, args, {
        cwd: root,
        env: { ...process.env, CLAUDE_REMOTE_BRIDGE: `http://127.0.0.1:${port}`, CLAUDE_REMOTE_TOKEN: token },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const pipe = (s) => s.on('data', (b) => String(b).split(/\r?\n/).filter(Boolean).forEach((l) => log('[host] ' + l.replace(/^\[[^\]]*\]\s*/, ''))));
      pipe(child.stdout);
      pipe(child.stderr);
      const started = Date.now();
      child.on('exit', (code) => {
        child = null;
        if (stopped) return;
        if (Date.now() - started > 60000) delay = 2000;
        log(`[host] exited (${code}); restarting in ${delay / 1000} s`);
        setTimeout(run, delay);
        delay = Math.min(delay * 2, 60000);
      });
    };
    let stopped = false;
    process.on('exit', () => {
      stopped = true;
      if (child) child.kill();
    });
    for (const sig of ['SIGINT', 'SIGTERM'])
      process.on(sig, () => {
        stopped = true;
        if (child) child.kill();
        process.exit(0);
      });
    run();
  }

  const api = { list, validateNew, adoptExisting, message, stop, permission, setMode, setModel, end, handle, startLocalHost };
  chats.setCode(api);
  return api;
};
