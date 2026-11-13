#!/usr/bin/env node
/*
 * Local LLM bridge
 * ----------------
 * Sits between the public internet (via Tailscale Funnel) and LM Studio.
 *  - Requires a bearer token on every /api request.
 *  - Adds CORS headers so the GitHub Pages site can call it.
 *  - Streams chat completions from LM Studio back to the browser.
 *  - Gives the model tools to read and update CLAUDE.md, and injects the
 *    current CLAUDE.md into the system prompt on every request.
 *
 * No npm dependencies. Requires Node 18+.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ---------------------------------------------------------------- config ---

const CONFIG_PATH = path.join(__dirname, 'config.json');
const DEFAULTS = {
  port: 8787,
  host: '127.0.0.1',
  lmStudioUrl: 'http://127.0.0.1:1234',
  model: '',
  claudeMdPath: '../CLAUDE.md',
  allowedOrigins: ['*'],
  allowModelEdits: true,
  maxToolRounds: 6,
  maxBackups: 50,
  accessToken: '',
};

function loadConfig() {
  let fileCfg = {};
  if (fs.existsSync(CONFIG_PATH)) {
    fileCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  }
  const cfg = { ...DEFAULTS, ...fileCfg };
  if (!cfg.accessToken) {
    cfg.accessToken = crypto.randomBytes(24).toString('base64url');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...fileCfg, accessToken: cfg.accessToken }, null, 2));
    console.log('Generated a new access token and saved it to bridge/config.json');
  }
  // Environment overrides (handy for one-off runs)
  if (process.env.BRIDGE_PORT) cfg.port = Number(process.env.BRIDGE_PORT);
  if (process.env.LMSTUDIO_URL) cfg.lmStudioUrl = process.env.LMSTUDIO_URL;
  if (process.env.CLAUDE_MD_PATH) cfg.claudeMdPath = process.env.CLAUDE_MD_PATH;
  if (process.env.BRIDGE_MODEL) cfg.model = process.env.BRIDGE_MODEL;

  let p = cfg.claudeMdPath;
  if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
  cfg.claudeMdAbs = path.resolve(__dirname, p);
  cfg.backupDir = path.join(__dirname, 'backups');
  cfg.lmStudioUrl = cfg.lmStudioUrl.replace(/\/+$/, '');
  return cfg;
}

const cfg = loadConfig();

// ------------------------------------------------------------ CLAUDE.md ---

let writeLock = Promise.resolve();
function withWriteLock(fn) {
  const run = writeLock.then(fn, fn);
  writeLock = run.catch(() => {});
  return run;
}

async function readClaudeMd() {
  try {
    return await fsp.readFile(cfg.claudeMdAbs, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return '';
    throw e;
  }
}

async function backupClaudeMd() {
  let current;
  try {
    current = await fsp.readFile(cfg.claudeMdAbs);
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  await fsp.mkdir(cfg.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await fsp.writeFile(path.join(cfg.backupDir, `CLAUDE.md.${stamp}.bak`), current);
  const files = (await fsp.readdir(cfg.backupDir)).filter((f) => f.endsWith('.bak')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - cfg.maxBackups))) {
    await fsp.unlink(path.join(cfg.backupDir, f)).catch(() => {});
  }
}

function writeClaudeMd(content, source) {
  return withWriteLock(async () => {
    await backupClaudeMd();
    await fsp.mkdir(path.dirname(cfg.claudeMdAbs), { recursive: true });
    const tmp = cfg.claudeMdAbs + '.tmp';
    await fsp.writeFile(tmp, content, 'utf8');
    await fsp.rename(tmp, cfg.claudeMdAbs);
    log(`CLAUDE.md updated by ${source} (${content.length} chars)`);
  });
}

// ---------------------------------------------------------------- tools ---

const READ_TOOL = {
  type: 'function',
  function: {
    name: 'read_claude_md',
    description: 'Read the full current contents of CLAUDE.md, your persistent memory / instructions file.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
};
const EDIT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'append_to_claude_md',
      description: 'Append markdown text to the end of CLAUDE.md. Best for adding a new fact, preference or instruction.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Markdown text to append.' } },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'replace_in_claude_md',
      description:
        'Replace one exact snippet of CLAUDE.md with new text. old_text must match the file exactly and appear only once. Pass an empty new_text to delete the snippet.',
      parameters: {
        type: 'object',
        properties: {
          old_text: { type: 'string', description: 'Exact text currently in CLAUDE.md.' },
          new_text: { type: 'string', description: 'Replacement text.' },
        },
        required: ['old_text', 'new_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_claude_md',
      description:
        'Overwrite ALL of CLAUDE.md with new content. Only for large reorganizations; prefer append_to_claude_md or replace_in_claude_md.',
      parameters: {
        type: 'object',
        properties: { content: { type: 'string', description: 'The complete new file contents.' } },
        required: ['content'],
      },
    },
  },
];

async function runTool(name, args) {
  switch (name) {
    case 'read_claude_md': {
      const md = await readClaudeMd();
      return { ok: true, changed: false, result: md || '(CLAUDE.md is empty)' };
    }
    case 'append_to_claude_md': {
      if (typeof args.text !== 'string' || !args.text.trim()) return { ok: false, result: 'Error: text is required.' };
      const md = await readClaudeMd();
      const sep = md === '' || md.endsWith('\n\n') ? '' : md.endsWith('\n') ? '\n' : '\n\n';
      await writeClaudeMd(md + sep + args.text.replace(/\s+$/, '') + '\n', 'model (append)');
      return { ok: true, changed: true, result: 'Appended to CLAUDE.md.' };
    }
    case 'replace_in_claude_md': {
      const { old_text: oldText, new_text: newText } = args;
      if (typeof oldText !== 'string' || !oldText) return { ok: false, result: 'Error: old_text is required.' };
      if (typeof newText !== 'string') return { ok: false, result: 'Error: new_text must be a string.' };
      const md = await readClaudeMd();
      const count = md.split(oldText).length - 1;
      if (count === 0) return { ok: false, result: 'Error: old_text was not found. Call read_claude_md and copy the text exactly.' };
      if (count > 1) return { ok: false, result: `Error: old_text appears ${count} times. Include more surrounding text so it is unique.` };
      await writeClaudeMd(md.replace(oldText, () => newText), 'model (replace)');
      return { ok: true, changed: true, result: 'Replaced text in CLAUDE.md.' };
    }
    case 'write_claude_md': {
      if (typeof args.content !== 'string') return { ok: false, result: 'Error: content is required.' };
      await writeClaudeMd(args.content, 'model (overwrite)');
      return { ok: true, changed: true, result: 'CLAUDE.md overwritten.' };
    }
    default:
      return { ok: false, result: `Error: unknown tool "${name}".` };
  }
}

// -------------------------------------------------------------- prompts ---

const MAX_INLINE_MD = 24000;

function buildSystemPrompt(md, extra, allowEdits) {
  let mdBlock;
  if (!md.trim()) mdBlock = '(CLAUDE.md is currently empty.)';
  else if (md.length > MAX_INLINE_MD)
    mdBlock = md.slice(0, MAX_INLINE_MD) + '\n\n[...truncated; call read_claude_md for the full file]';
  else mdBlock = md;

  const lines = [
    "You are a helpful assistant running locally on the user's own computer through LM Studio.",
    'You have a persistent memory and instructions file called CLAUDE.md. Follow the instructions in it.',
    'Its current contents are:',
    '<claude_md>',
    mdBlock,
    '</claude_md>',
  ];
  if (allowEdits) {
    lines.push(
      'You can change CLAUDE.md with the append_to_claude_md, replace_in_claude_md and write_claude_md tools.',
      'Update it when the user asks you to remember something, change your standing instructions, or edit CLAUDE.md.',
      'Do not edit it otherwise. After an edit, briefly tell the user what you changed.'
    );
  } else {
    lines.push('CLAUDE.md is read-only in this session. If the user asks you to change it, explain that edits are turned off.');
  }
  if (extra && typeof extra === 'string' && extra.trim()) lines.push('', extra.trim());
  return lines.join('\n');
}

function stripThink(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
}

function sanitizeHistory(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.role === 'assistant' ? stripThink(m.content) : m.content }))
    .slice(-60);
}

// ------------------------------------------------------- LM Studio call ---

async function streamCompletion(payload, send, signal) {
  const r = await fetch(cfg.lmStudioUrl + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, stream: true }),
    signal,
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`LM Studio returned ${r.status}: ${t.slice(0, 400)}`);
  }

  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  const calls = [];

  const handleLine = (line) => {
    line = line.trim();
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let j;
    try {
      j = JSON.parse(data);
    } catch {
      return;
    }
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    const ch = j.choices && j.choices[0];
    if (!ch) return;
    const d = ch.delta || {};
    const reasoning = d.reasoning_content || d.reasoning;
    if (reasoning) send({ type: 'reasoning', text: reasoning });
    if (d.content) {
      content += d.content;
      send({ type: 'token', text: d.content });
    }
    if (Array.isArray(d.tool_calls)) {
      for (const t of d.tool_calls) {
        const idx = typeof t.index === 'number' ? t.index : calls.length;
        const c = calls[idx] || (calls[idx] = { id: '', name: '', args: '' });
        if (t.id) c.id = t.id;
        const fn = t.function || {};
        if (fn.name && c.name !== fn.name) c.name += fn.name;
        if (fn.arguments) c.args += fn.arguments;
      }
    }
  };

  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      handleLine(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  }
  if (buf) handleLine(buf);

  return { content, toolCalls: calls.filter((c) => c && c.name) };
}

// ------------------------------------------------------------- handlers ---

async function handleChat(req, res) {
  const body = await readJson(req);
  const allowEdits = cfg.allowModelEdits && body.allowEdits !== false;
  const tools = allowEdits ? [READ_TOOL, ...EDIT_TOOLS] : [READ_TOOL];
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (obj) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);

  try {
    const model = await resolveModel(body.model);
    const md = await readClaudeMd();
    const messages = [
      { role: 'system', content: buildSystemPrompt(md, body.system, allowEdits) },
      ...sanitizeHistory(body.messages),
    ];
    const extra = {};
    if (typeof body.temperature === 'number') extra.temperature = body.temperature;

    for (let round = 0; round <= cfg.maxToolRounds; round++) {
      const useTools = round < cfg.maxToolRounds;
      const { content, toolCalls } = await streamCompletion(
        { model, messages, ...(useTools ? { tools } : {}), ...extra },
        send,
        ac.signal
      );
      if (!toolCalls.length) break;

      messages.push({
        role: 'assistant',
        content: stripThink(content),
        tool_calls: toolCalls.map((c, i) => ({
          id: c.id || (c.id = `call_${round}_${i}`),
          type: 'function',
          function: { name: c.name, arguments: c.args || '{}' },
        })),
      });

      for (const c of toolCalls) {
        let args = {};
        let parsed = true;
        try {
          args = c.args ? JSON.parse(c.args) : {};
        } catch {
          parsed = false;
        }
        send({ type: 'tool_call', id: c.id, name: c.name, args: parsed ? args : c.args });
        let out;
        if (!parsed) out = { ok: false, result: 'Error: tool arguments were not valid JSON.' };
        else if (!tools.some((t) => t.function.name === c.name))
          out = { ok: false, result: `Error: tool "${c.name}" is not available (CLAUDE.md edits may be turned off).` };
        else {
          try {
            out = await runTool(c.name, args);
          } catch (e) {
            out = { ok: false, result: 'Error: ' + e.message };
          }
        }
        send({
          type: 'tool_result',
          id: c.id,
          name: c.name,
          ok: out.ok,
          result: out.result.length > 2000 ? out.result.slice(0, 2000) + '…' : out.result,
        });
        if (out.changed) send({ type: 'claude_md_updated' });
        messages.push({ role: 'tool', tool_call_id: c.id, content: out.result });
      }
      send({ type: 'round_end' });
    }
    send({ type: 'done' });
  } catch (e) {
    if (!ac.signal.aborted) {
      log('chat error: ' + e.message);
      send({ type: 'error', message: friendlyError(e) });
    }
  } finally {
    clearInterval(ping);
    res.end();
  }
}

async function handleStatus(res) {
  const md = await readClaudeMd();
  let lmStudio = { reachable: false, models: [] };
  try {
    lmStudio = { reachable: true, models: await listModels() };
  } catch (e) {
    lmStudio.error = friendlyError(e);
  }
  json(res, 200, {
    ok: true,
    lmStudio,
    defaultModel: cfg.model || null,
    allowModelEdits: cfg.allowModelEdits,
    claudeMd: { path: cfg.claudeMdAbs, chars: md.length },
  });
}

// Always send a concrete model id: LM Studio then loads it on demand ("JIT loading")
// if it is not already in memory, instead of failing with "No models loaded".
async function resolveModel(requested) {
  if (typeof requested === 'string' && requested) return requested;
  if (cfg.model) return cfg.model;
  try {
    const models = await listModels();
    const pick = models.find((m) => m.loaded) || models[0];
    if (pick) return pick.id;
  } catch {}
  return undefined;
}

async function listModels() {
  const ctl = AbortSignal.timeout(4000);
  // LM Studio's native REST API reports load state; fall back to the OpenAI list.
  try {
    const r = await fetch(cfg.lmStudioUrl + '/api/v0/models', { signal: ctl });
    if (r.ok) {
      const j = await r.json();
      return (j.data || [])
        .filter((m) => m.type !== 'embeddings')
        .map((m) => ({ id: m.id, loaded: m.state === 'loaded' }));
    }
  } catch (e) {
    if (e.name === 'TimeoutError') throw e;
  }
  const r = await fetch(cfg.lmStudioUrl + '/v1/models', { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`LM Studio returned ${r.status}`);
  const j = await r.json();
  return (j.data || []).filter((m) => !/embed/i.test(m.id)).map((m) => ({ id: m.id, loaded: null }));
}

function friendlyError(e) {
  const msg = String((e && e.message) || e);
  if (/ECONNREFUSED|fetch failed|TimeoutError|aborted due to timeout/i.test(msg + (e && e.cause ? e.cause.code : '')))
    return 'Cannot reach LM Studio at ' + cfg.lmStudioUrl + '. Is the LM Studio server running?';
  return msg;
}

// ------------------------------------------------------------ plumbing ---

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readJson(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (cfg.allowedOrigins.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && cfg.allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
}

// Simple brute-force protection: too many bad tokens from one address = locked out for a while.
const failures = new Map();
function clientAddr(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}
function isLockedOut(addr) {
  const f = failures.get(addr);
  return f && f.count >= 10 && Date.now() - f.first < 15 * 60 * 1000;
}
function noteFailure(addr) {
  const now = Date.now();
  const f = failures.get(addr);
  if (!f || now - f.first > 15 * 60 * 1000) failures.set(addr, { count: 1, first: now });
  else f.count++;
}
function checkAuth(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return false;
  const a = Buffer.from(m[1].trim());
  const b = Buffer.from(cfg.accessToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const server = http.createServer(async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  const url = new URL(req.url, 'http://local');
  const route = `${req.method} ${url.pathname.replace(/\/+$/, '') || '/'}`;

  if (route === 'GET /' || route === 'GET /health') {
    return json(res, 200, { ok: true, service: 'local-llm-bridge' });
  }

  const addr = clientAddr(req);
  if (isLockedOut(addr)) return json(res, 429, { error: 'Too many failed attempts. Try again later.' });
  if (!checkAuth(req)) {
    noteFailure(addr);
    return json(res, 401, { error: 'Missing or wrong access token.' });
  }
  failures.delete(addr);

  try {
    switch (route) {
      case 'GET /api/status':
        return await handleStatus(res);
      case 'POST /api/chat':
        return await handleChat(req, res);
      case 'GET /api/claude-md':
        return json(res, 200, { path: cfg.claudeMdAbs, content: await readClaudeMd() });
      case 'PUT /api/claude-md': {
        const body = await readJson(req);
        if (typeof body.content !== 'string') return json(res, 400, { error: 'content (string) is required' });
        await writeClaudeMd(body.content, 'web editor');
        return json(res, 200, { ok: true, chars: body.content.length });
      }
      default:
        return json(res, 404, { error: 'Not found' });
    }
  } catch (e) {
    log(`error on ${route}: ${e.message}`);
    if (!res.headersSent) json(res, e.status || 500, { error: e.message });
    else res.end();
  }
});

server.listen(cfg.port, cfg.host, () => {
  log(`Bridge listening on http://${cfg.host}:${cfg.port}`);
  log(`LM Studio:  ${cfg.lmStudioUrl}`);
  log(`CLAUDE.md:  ${cfg.claudeMdAbs}`);
  log(`Model edits to CLAUDE.md: ${cfg.allowModelEdits ? 'allowed' : 'disabled'}`);
});
