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
    lastSeen: h.lastSeen,
  });
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
  function validateNew(body) {
    const h = hosts.get(String(body.host || ''));
    if (!h) throw httpError(400, 'Pick a computer to run Claude Code on.');
    const cwd = typeof body.cwd === 'string' ? body.cwd : '';
    if (!h.folders.includes(cwd) && !h.roots.includes(cwd)) throw httpError(400, `That folder isn't one "${h.name}" allows.`);
    return {
      title: `${path.basename(cwd) || cwd} · ${h.name}`,
      fields: { host: h.id, hostName: h.name, cwd, permissionMode: body.permissionMode === 'acceptEdits' ? 'acceptEdits' : 'default' },
    };
  }

  async function message(chat, body) {
    if (chat.run) throw httpError(409, 'Claude Code is still working in this session. Stop it first, or wait.');
    const text = typeof body.content === 'string' ? body.content.trim().slice(0, 100000) : '';
    if (!text) throw httpError(400, 'The message is empty.');
    command(chat.host, {
      type: 'message',
      chatId: chat.id,
      content: text,
      cwd: chat.cwd,
      permissionMode: chat.permissionMode,
      resume: chat.sdkSessionId || undefined,
    });
    const user = { id: chats.newId(), role: 'user', content: text, at: Date.now() };
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
  }

  function apply(hostId, ev) {
    const chat = chats.chats.get(ev.chatId);
    if (!chat || chat.kind !== 'code' || chat.host !== hostId) return;
    const turn =
      (chat.run && chat.messages.find((m) => m.id === chat.run.messageId)) ||
      [...chat.messages].reverse().find((m) => m.role === 'assistant');
    if (ev.type === 'session') {
      chat.sdkSessionId = ev.sessionId;
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
      case 'result': {
        const stopping = !!(chat.run && chat.run.stopping);
        turn.result = { subtype: ev.subtype, turns: ev.turns, durationMs: ev.durationMs, isError: !!ev.isError, stopped: stopping };
        turn.notice = '';
        Object.assign(out, { result: turn.result });
        chats.emit(chat, out);
        if (chat.run) chats.endRun(chat, stopping ? 'stopped' : ev.isError ? 'error' : 'done', ev.isError && !stopping ? ev.text || ev.subtype : undefined);
        return;
      }
      case 'error':
        endTurn(chat, 'error', String(ev.message || 'Claude Code failed.'));
        return;
      case 'ended':
        if (chat.run) endTurn(chat, 'stopped', 'The session ended on its computer.');
        return;
      default:
        return;
    }
    chats.emit(chat, out);
  }

  function hostGone(h) {
    for (const chat of chats.chats.values())
      if (chat.kind === 'code' && chat.host === h.id && chat.run) endTurn(chat, 'stopped', `"${h.name}" disconnected while Claude Code was working.`);
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
          if (!h.send) hostGone(h);
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
          apply(id, ev);
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

  const api = { list, validateNew, message, stop, permission, end, handle, startLocalHost };
  chats.setCode(api);
  return api;
};
