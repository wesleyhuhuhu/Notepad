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

// Changes every time this program starts, so the bridge can tell a restart from a re-register.
const BOOT_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const log = (msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };

// Folders the website may pick: each root and the folders directly inside it (not build or
// cache folders). The list is sent again whenever a root's contents change.
const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'venv', 'env', 'dist', 'build', 'out', 'bin', 'obj', 'target', 'coverage']);
function folderList() {
  const out = [];
  for (const root of ROOTS) {
    out.push(root);
    try {
      const dirs = fs.readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$') && !SKIP_DIRS.has(e.name.toLowerCase()))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
      for (const name of dirs.slice(0, 300)) out.push(path.join(root, name));
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

  const s = { chatId, cwd, ctx, inbox: [], wake: null, perms: new Map(), q: null, closed: false, deltas: new Set() };
  async function* input() {
    while (!s.closed) {
      while (s.inbox.length) yield s.inbox.shift();
      await new Promise((r) => (s.wake = r));
      s.wake = null;
    }
  }
  s.push = (content) => {
    s.inbox.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null });
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
      // default: ask before file changes and commands. acceptEdits: file changes in the folder are
      // automatic. allowAll: commands too. Web searches and page reads never ask. Anything outside
      // the session's folder still asks.
      permissionMode: cmd.permissionMode === 'acceptEdits' || cmd.permissionMode === 'allowAll' ? 'acceptEdits' : 'default',
      allowedTools: ['WebSearch', 'WebFetch', ...(cmd.permissionMode === 'allowAll' ? ['Bash'] : [])],
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

// Live progress for one model call: reading the prompt, then thinking or writing, with tokens/s.
function genStart(s) {
  genEnd(s);
  s.g = { phase: 'reading', t0: Date.now(), tFirst: 0, tLast: 0, n: 0, thinking: 0, last: 0 };
  genSend(s, true);
  s.g.timer = setInterval(() => { if (s.g && !s.g.tFirst) genSend(s, true); }, 1000);
}
function genToken(s, thinking) {
  if (!s.g) genStart(s);
  const g = s.g;
  g.tLast = Date.now();
  if (!g.tFirst) g.tFirst = g.tLast;
  g.n++;
  if (thinking) g.thinking++;
  g.phase = thinking ? 'thinking' : 'writing';
  genSend(s);
}
function genSend(s, force) {
  const g = s.g;
  const now = Date.now();
  if (!g || (!force && now - g.last < 500)) return;
  g.last = now;
  const secs = g.tFirst ? (now - g.tFirst) / 1000 : 0;
  send(s.chatId, {
    type: 'gen',
    phase: g.phase,
    tokens: g.n,
    thinking: g.thinking,
    tps: secs > 0.5 ? Math.round((g.n / secs) * 10) / 10 : 0,
    waited: Math.round((now - g.t0) / 100) / 10,
  });
}
function genEnd(s) {
  const g = s.g;
  if (!g) return;
  clearInterval(g.timer);
  s.g = null;
  const t = s.turn || (s.turn = { tokens: 0, thinking: 0, genSeconds: 0, ttft: null, calls: 0 });
  t.calls++;
  t.tokens += g.n;
  t.thinking += g.thinking;
  if (g.tFirst) {
    t.genSeconds += Math.max(0.001, (g.tLast - g.tFirst) / 1000);
    if (t.ttft === null) t.ttft = (g.tFirst - g.t0) / 1000;
  }
}

// Turns the SDK's messages into the small events the website shows.
async function pump(s) {
  const id = s.chatId;
  for await (const m of s.q) {
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') send(id, { type: 'session', sessionId: m.session_id, model: m.model, permissionMode: m.permissionMode });
        else if (m.subtype === 'status' && m.status === 'requesting') {
          send(id, { type: 'status', text: '' });
          genStart(s);
        } else if (m.subtype === 'status' && m.status) send(id, { type: 'status', text: String(m.status) });
        else if (m.subtype === 'api_retry') send(id, { type: 'status', text: `Retrying the model (attempt ${m.attempt})…` });
        else if (m.subtype === 'compact_boundary') send(id, { type: 'status', text: 'Compacted the conversation to free up context.' });
        break;
      case 'stream_event': {
        const e = m.event;
        if (e.type === 'message_start' && e.message && e.message.id) {
          s.current = e.message.id;
          const u = e.message.usage || {};
          s.promptTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          if (s.promptTokens) send(id, { type: 'ctx_usage', used: s.promptTokens, context: s.ctx });
        } else if (e.type === 'message_delta' && e.usage && s.promptTokens) {
          send(id, { type: 'ctx_usage', used: s.promptTokens + (e.usage.output_tokens || 0), context: s.ctx });
        }
        else if (e.type === 'content_block_start' && e.content_block && (e.content_block.type === 'text' || e.content_block.type === 'thinking')) {
          s.deltas.add(s.current);
          send(id, { type: 'block_start', kind: e.content_block.type });
        } else if (e.type === 'content_block_delta' && e.delta) {
          if (e.delta.type === 'text_delta') {
            send(id, { type: 'delta', text: e.delta.text });
            genToken(s, false);
          } else if (e.delta.type === 'thinking_delta') {
            send(id, { type: 'delta', text: e.delta.thinking });
            genToken(s, true);
          } else if (e.delta.type === 'input_json_delta') genToken(s, false);
        } else if (e.type === 'message_stop') genEnd(s);
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
      case 'result': {
        genEnd(s);
        const t = s.turn || { tokens: 0, thinking: 0, genSeconds: 0, ttft: null, calls: 0 };
        s.turn = null;
        const u = m.usage || {};
        const tokens = u.output_tokens || t.tokens;
        send(id, {
          type: 'result',
          subtype: m.subtype,
          turns: m.num_turns,
          durationMs: m.duration_ms,
          isError: !!m.is_error,
          text: typeof m.result === 'string' ? short(m.result, 500) : '',
          stats: {
            tokens,
            thinking: t.thinking,
            tps: t.genSeconds > 0 ? Math.round((tokens / t.genSeconds) * 10) / 10 : 0,
            ttft: t.ttft,
            calls: t.calls,
            prompt: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) || undefined,
          },
        });
        break;
      }
    }
  }
}

// Attached files are saved in <session folder>/uploads/ (never overwriting); images are shown
// to the model directly. Returns the message content for the SDK.
function saveUpload(cwd, f) {
  const dir = path.join(cwd, 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  const clean = String(f.name || 'file').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file';
  const ext = path.extname(clean);
  const stem = clean.slice(0, clean.length - ext.length);
  let name = clean;
  for (let i = 1; fs.existsSync(path.join(dir, name)); i++) name = `${stem} (${i})${ext}`;
  fs.writeFileSync(path.join(dir, name), Buffer.from(String(f.data || ''), 'base64'));
  return 'uploads/' + name;
}

function messageContent(s, cmd) {
  let text = String(cmd.content || '');
  const saved = (cmd.files || []).map((f) => saveUpload(s.cwd, f));
  const notes = (cmd.notes || []).filter(Boolean);
  if (notes.length) text = [text, ...notes].filter(Boolean).join('\n\n');
  if (saved.length) text = [text, saved.map((p) => `[Attached file, saved in this folder as ${p}]`).join('\n')].filter(Boolean).join('\n\n');
  const images = (cmd.images || [])
    .map((url) => /^data:(image\/[a-z+]+);base64,(.+)$/.exec(String(url)))
    .filter(Boolean)
    .map((m) => ({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }));
  if (!images.length) return text || '(see attached)';
  return [...images, { type: 'text', text: text || (images.length > 1 ? 'Here are some images.' : 'Here is an image.') }];
}

async function handleCommand(cmd) {
  const id = cmd.chatId;
  try {
    switch (cmd.type) {
      case 'message': {
        let s = sessions.get(id);
        if (!s) s = await startSession(id, cmd);
        s.push(messageContent(s, cmd));
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
  const folders = folderList();
  lastFolders = JSON.stringify(folders);
  const r = await fetch(`${BRIDGE}/api/hosts/${HOST_ID}/register`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      name: NAME,
      os: `${os.type()} ${os.release()}`,
      platform: process.platform,
      roots: ROOTS,
      folders,
      sessions: [...sessions.keys()],
      bootId: BOOT_ID,
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

// Re-register when folders are added, removed or renamed in a root, so the website's list is current.
let lastFolders = '';
let refreshTimer = null;
function refreshFolders() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    const now = JSON.stringify(folderList());
    if (now === lastFolders) return;
    try {
      await register();
      log('Folder list updated.');
    } catch {}
  }, 1500);
}
for (const root of ROOTS) {
  try {
    fs.watch(root, { persistent: false }, refreshFolders);
  } catch {}
}
setInterval(refreshFolders, 60000).unref();

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
