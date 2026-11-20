#!/usr/bin/env node
// claude-remote: lets the Local LLM website run Claude Code sessions on this computer.
//
// It connects OUT to the bridge on your PC (so nothing has to be opened on this computer), waits
// for messages sent from the website, and runs Claude Code with your local model through the
// Claude Agent SDK. Every tool call that needs approval is shown on the website as an
// Allow / Deny card. Sessions only work inside the folders you allow (--root).
//
//   node claude-remote.mjs                       use this folder, bridge and token from claude-local's config
//   node claude-remote.mjs --root D:\code --root C:\work --name laptop
//   node claude-remote.mjs --bridge https://pc.tailnet.ts.net --token ...
//
// The launchers cli/claude-remote.ps1 / .sh install the dependency and start this.

import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// ------------------------------------------------------------- options --
const args = process.argv.slice(2);
const opt = { roots: [], name: '', bridge: '', token: '', managed: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--root') opt.roots.push(args[++i]);
  else if (a === '--name') opt.name = args[++i];
  else if (a === '--bridge') opt.bridge = args[++i];
  else if (a === '--token') opt.token = args[++i];
  else if (a === '--managed') opt.managed = true; // started by the bridge itself
  else if (a === '--help' || a === '-h') {
    console.log('Usage: claude-remote [--root <folder>]... [--name <name>] [--bridge <url>] [--token <token>]');
    process.exit(0);
  }
}

function readLauncherConfig() {
  try {
    if (process.platform === 'win32') {
      const f = path.join(process.env.APPDATA || '', 'claude-local', 'config.json');
      const j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
      return { bridge: j.bridge, token: j.token };
    }
    const f = path.join(os.homedir(), '.config', 'claude-local', 'config');
    const out = {};
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const m = /^(BRIDGE_URL|TOKEN)=(.*)$/.exec(line.trim());
      // Values were written with printf %q: drop simple quoting and backslash escapes.
      if (m) out[m[1]] = m[2].replace(/^'(.*)'$/, '$1').replace(/\\(.)/g, '$1');
    }
    return { bridge: out.BRIDGE_URL, token: out.TOKEN };
  } catch {
    return {};
  }
}

const saved = readLauncherConfig();
const BRIDGE = String(opt.bridge || process.env.CLAUDE_REMOTE_BRIDGE || saved.bridge || '').replace(/\/+$/, '');
const TOKEN = opt.token || process.env.CLAUDE_REMOTE_TOKEN || saved.token || '';
if (!BRIDGE || !TOKEN) {
  console.error('No bridge address or token. Run claude-local once to set them up, or pass --bridge and --token.');
  process.exit(1);
}
const NAME = (opt.name || os.hostname()).trim().slice(0, 60);
const HOST_ID = NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'host';
const ROOTS = (opt.roots.length ? opt.roots : [process.cwd()]).map((r) => fs.realpathSync(path.resolve(r)));

// Claude Code itself: the installed `claude` (the SDK's bundled copy is optional and may be absent).
function findClaude() {
  if (process.env.CLAUDE_CODE_PATH) return process.env.CLAUDE_CODE_PATH;
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, ['claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return lines.find((l) => /\.exe$/i.test(l)) || lines[0];
  } catch {
    return undefined;
  }
}
const CLAUDE = findClaude();

const log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };

// Folders the website may pick: each root and the folders directly inside it.
function folderList() {
  const out = [];
  for (const root of ROOTS) {
    out.push(root);
    try {
      for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') out.push(path.join(root, e.name));
        if (out.length > 300) break;
      }
    } catch {}
  }
  return out;
}

function insideRoots(dir) {
  let real;
  try {
    real = fs.realpathSync(path.resolve(dir));
  } catch {
    return null;
  }
  const ok = ROOTS.some((r) => real === r || real.startsWith(r + path.sep));
  return ok ? real : null;
}

// --------------------------------------------------- events to the bridge --
let outbox = [];
let flushing = null;
function send(chatId, ev) {
  outbox.push({ chatId, ...ev });
  if (!flushing) flushing = setTimeout(flush, 80);
}
async function flush() {
  const batch = outbox;
  outbox = [];
  try {
    if (batch.length) {
      const r = await fetch(`${BRIDGE}/api/hosts/${HOST_ID}/events`, { method: 'POST', headers: H, body: JSON.stringify({ events: batch }) });
      if (!r.ok) throw new Error('bridge returned ' + r.status);
    }
  } catch (e) {
    // Keep them for the next try (the bridge may be restarting).
    outbox = batch.concat(outbox).slice(-5000);
    log('Could not send updates: ' + e.message);
    await sleep(1000);
  } finally {
    flushing = null;
    if (outbox.length) flushing = setTimeout(flush, 80);
  }
}

// ------------------------------------------------------------ sessions --
const sessions = new Map(); // chatId -> session

const short = (v, n = 2000) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > n ? s.slice(0, n) + '…' : s || '';
};

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '[image]' : '')).join('\n');
  return '';
}

async function modelInfo() {
  const r = await fetch(`${BRIDGE}/api/claude-code?load=1`, { headers: H, signal: AbortSignal.timeout(240000) });
  if (!r.ok) throw new Error(`The bridge returned ${r.status} when asked for the model.`);
  const text = await r.text();
  const model = (/^MODEL=(.*)$/m.exec(text) || [])[1];
  const ctx = Number((/^CONTEXT=(\d+)/m.exec(text) || [])[1]) || 32768;
  if (!model) throw new Error('The bridge has no model available in LM Studio.');
  return { model: model.trim(), ctx };
}

async function startSession(chatId, cmd) {
  const cwd = insideRoots(cmd.cwd);
  if (!cwd) throw new Error(`"${cmd.cwd}" is not inside the folders this computer allows (${ROOTS.join(', ')}).`);
  const { model, ctx } = await modelInfo();
  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: BRIDGE,
    ANTHROPIC_AUTH_TOKEN: TOKEN,
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(ctx),
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_AGENT_SDK_CLIENT_APP: 'local-llm-claude-remote/1.0',
  };

  const s = { chatId, cwd, inbox: [], wake: null, perms: new Map(), q: null, closed: false, deltas: new Set() };
  async function* input() {
    while (!s.closed) {
      while (s.inbox.length) yield s.inbox.shift();
      await new Promise((r) => (s.wake = r));
      s.wake = null;
    }
  }
  s.push = (text) => {
    s.inbox.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
    if (s.wake) s.wake();
  };

  s.q = query({
    prompt: input(),
    options: {
      cwd,
      env,
      model,
      pathToClaudeCodeExecutable: CLAUDE,
      tools: ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write', 'WebFetch', 'WebSearch'],
      permissionMode: cmd.permissionMode === 'acceptEdits' ? 'acceptEdits' : 'default',
      includePartialMessages: true,
      ...(cmd.resume ? { resume: cmd.resume } : {}),
      canUseTool: (toolName, toolInput, o) =>
        new Promise((resolve) => {
          const requestId = o.toolUseID || Math.random().toString(36).slice(2);
          s.perms.set(requestId, { resolve, input: toolInput, suggestions: o.suggestions || [] });
          send(chatId, { type: 'permission_request', requestId, toolName, input: short(toolInput, 4000), blockedPath: o.blockedPath || undefined });
          o.signal.addEventListener('abort', () => {
            if (s.perms.delete(requestId)) resolve({ behavior: 'deny', message: 'Cancelled.' });
          });
        }),
    },
  });
  sessions.set(chatId, s);
  pump(s).catch((e) => {
    log(`Session ${chatId} failed: ${e.message}`);
    send(chatId, { type: 'error', message: e.message });
  }).finally(() => {
    s.closed = true;
    sessions.delete(chatId);
    send(chatId, { type: 'ended' });
  });
  log(`Session ${chatId} started in ${cwd}${cmd.resume ? ' (resumed)' : ''}`);
  return s;
}

// Turns the SDK's messages into the small events the website shows.
async function pump(s) {
  const id = s.chatId;
  for await (const m of s.q) {
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') send(id, { type: 'session', sessionId: m.session_id, model: m.model, permissionMode: m.permissionMode });
        else if (m.subtype === 'status' && m.status) send(id, { type: 'status', text: m.status === 'requesting' ? '' : String(m.status) });
        else if (m.subtype === 'api_retry') send(id, { type: 'status', text: `Retrying the model (attempt ${m.attempt})…` });
        else if (m.subtype === 'compact_boundary') send(id, { type: 'status', text: 'Compacted the conversation to free up context.' });
        break;
      case 'stream_event': {
        const e = m.event;
        if (e.type === 'message_start' && e.message && e.message.id) s.current = e.message.id;
        else if (e.type === 'content_block_start' && e.content_block && (e.content_block.type === 'text' || e.content_block.type === 'thinking')) {
          s.deltas.add(s.current);
          send(id, { type: 'block_start', kind: e.content_block.type });
        } else if (e.type === 'content_block_delta' && e.delta) {
          if (e.delta.type === 'text_delta') send(id, { type: 'delta', text: e.delta.text });
          else if (e.delta.type === 'thinking_delta') send(id, { type: 'delta', text: e.delta.thinking });
        }
        break;
      }
      case 'assistant': {
        const streamed = s.deltas.has(m.message.id);
        for (const b of m.message.content || []) {
          if (b.type === 'tool_use') send(id, { type: 'tool_use', toolId: b.id, name: b.name, input: short(b.input, 4000) });
          else if (!streamed && b.type === 'text' && b.text) {
            send(id, { type: 'block_start', kind: 'text' });
            send(id, { type: 'delta', text: b.text });
          }
        }
        break;
      }
      case 'user': {
        const content = m.message && m.message.content;
        if (Array.isArray(content))
          for (const b of content)
            if (b.type === 'tool_result')
              send(id, { type: 'tool_result', toolId: b.tool_use_id, ok: !b.is_error, result: short(toolResultText(b.content), 3000) });
        break;
      }
      case 'result':
        send(id, {
          type: 'result',
          subtype: m.subtype,
          turns: m.num_turns,
          durationMs: m.duration_ms,
          isError: !!m.is_error,
          text: typeof m.result === 'string' ? short(m.result, 500) : '',
        });
        break;
    }
  }
}

async function handleCommand(cmd) {
  const id = cmd.chatId;
  try {
    switch (cmd.type) {
      case 'message': {
        let s = sessions.get(id);
        if (!s) s = await startSession(id, cmd);
        s.push(String(cmd.content || ''));
        break;
      }
      case 'permission': {
        const s = sessions.get(id);
        const p = s && s.perms.get(cmd.requestId);
        if (!p) return send(id, { type: 'permission_resolved', requestId: cmd.requestId, allow: false, stale: true });
        s.perms.delete(cmd.requestId);
        if (cmd.allow)
          p.resolve({ behavior: 'allow', updatedInput: p.input, ...(cmd.always && p.suggestions.length ? { updatedPermissions: p.suggestions } : {}) });
        else p.resolve({ behavior: 'deny', message: cmd.message || 'The user denied this from the website.' });
        send(id, { type: 'permission_resolved', requestId: cmd.requestId, allow: !!cmd.allow, always: !!cmd.always });
        break;
      }
      case 'interrupt': {
        const s = sessions.get(id);
        if (s) {
          for (const [rid, p] of s.perms) {
            p.resolve({ behavior: 'deny', message: 'Stopped by the user.', interrupt: true });
            send(id, { type: 'permission_resolved', requestId: rid, allow: false });
          }
          s.perms.clear();
          await s.q.interrupt().catch(() => {});
        } else send(id, { type: 'ended' });
        break;
      }
      case 'end': {
        const s = sessions.get(id);
        if (s) {
          s.closed = true;
          if (s.wake) s.wake();
          s.q.close?.();
        }
        break;
      }
    }
  } catch (e) {
    log(`Command ${cmd.type} for ${id} failed: ${e.message}`);
    send(id, { type: 'error', message: e.message });
  }
}

// ------------------------------------------------- connection to bridge --
async function register() {
  const r = await fetch(`${BRIDGE}/api/hosts/${HOST_ID}/register`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      name: NAME,
      os: `${os.type()} ${os.release()}`,
      platform: process.platform,
      roots: ROOTS,
      folders: folderList(),
      sessions: [...sessions.keys()],
      claude: !!CLAUDE,
      managed: opt.managed,
    }),
  });
  if (r.status === 401) throw Object.assign(new Error('The bridge rejected the access token.'), { fatal: !opt.managed });
  if (!r.ok) throw new Error('bridge returned ' + r.status);
}

async function listen() {
  const r = await fetch(`${BRIDGE}/api/hosts/${HOST_ID}/commands`, { headers: H });
  if (!r.ok) throw new Error('bridge returned ' + r.status);
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue;
        let cmd;
        try {
          cmd = JSON.parse(line.slice(5));
        } catch {
          continue;
        }
        if (cmd.type === 'ping') continue;
        handleCommand(cmd);
      }
    }
  }
}

// Started by the bridge: quit when the bridge is gone (on Windows a killed parent leaves children running).
if (opt.managed) {
  const parent = process.ppid;
  setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch {
      log('The bridge stopped; exiting.');
      process.exit(0);
    }
  }, 3000).unref();
}

async function main() {
  if (!CLAUDE) log('Warning: the `claude` command was not found. Install Claude Code, or set CLAUDE_CODE_PATH.');
  log(`claude-remote "${NAME}" -> ${BRIDGE}`);
  log(`Allowed folders: ${ROOTS.join(', ')}`);
  let delay = 1000;
  for (;;) {
    try {
      await register();
      log('Connected. Sessions can now be started from the website.');
      delay = 1000;
      await listen();
      log('Connection to the bridge closed. Reconnecting…');
    } catch (e) {
      if (e.fatal) {
        console.error(e.message + ' Run claude-local --setup, or pass --token.');
        process.exit(1);
      }
      log(`Can't reach the bridge (${e.message}). Retrying in ${Math.round(delay / 1000)} s…`);
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 30000);
  }
}

main();
