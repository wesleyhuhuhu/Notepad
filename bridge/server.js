#!/usr/bin/env node
/*
 * Local LLM bridge
 * ----------------
 * Sits between the public internet (via Tailscale Funnel) and LM Studio.
 *  - Requires a bearer token on every /api request.
 *  - Adds CORS headers so the GitHub Pages site can call it.
 *  - Streams chat completions from LM Studio back to the browser.
 *  - Projects: every folder in `projectsRoot` is a project with its own CLAUDE.md.
 *    The model sees the global CLAUDE.md plus the selected project's CLAUDE.md,
 *    can update either with tools, and can read (never write) the project's code.
 *
 * No npm dependencies. Requires Node 18+.
 */
'use strict';

const http = require('http');
const { execFile } = require('child_process');
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
  projectsRoot: '',
  allowedOrigins: ['*'],
  allowModelEdits: true,
  allowCodeReading: true,
  maxToolRounds: 12,
  maxBackups: 50,
  // 0 = leave model loading to LM Studio (it uses the model's saved settings in My Models).
  // A number = an upper limit: if the model is loaded with a bigger context, or not loaded,
  // the bridge loads it with this context instead (e.g. 16384 while a game uses the GPU).
  contextLength: 0,
  accessToken: '',
};

function expandPath(p) {
  if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(__dirname, p);
}

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
  if (process.env.PROJECTS_ROOT) cfg.projectsRoot = process.env.PROJECTS_ROOT;
  if (process.env.BRIDGE_MODEL) cfg.model = process.env.BRIDGE_MODEL;
  if (process.env.BRIDGE_CONTEXT_LENGTH) cfg.contextLength = Number(process.env.BRIDGE_CONTEXT_LENGTH);

  cfg.claudeMdAbs = expandPath(cfg.claudeMdPath);
  cfg.projectsRootAbs = cfg.projectsRoot ? expandPath(cfg.projectsRoot) : '';
  cfg.backupDir = path.join(__dirname, 'backups');
  cfg.lmStudioUrl = cfg.lmStudioUrl.replace(/\/+$/, '');
  return cfg;
}

const cfg = loadConfig();

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// ------------------------------------------------------------- projects ---

const IGNORED_DIRS = new Set([
  '.git', '.svn', '.hg', 'node_modules', '__pycache__', '.vs', '.vscode', '.idea', 'bin', 'obj',
  'dist', 'build', 'out', 'target', 'venv', '.venv', '.next', '.cache', 'coverage', '.pytest_cache',
  '.mypy_cache', '.gradle', 'packages',
]);
// Files the model is never allowed to read, even inside a project.
const SECRET_FILE_RE =
  /^\.env(\..*)?$|\.(pem|key|pfx|p12|keystore|jks|kdbx|publishsettings)$|^id_(rsa|dsa|ecdsa|ed25519)|^credentials(\.json)?$|^secrets?\.(json|ya?ml|toml|ini)$|^\.npmrc$|^\.pypirc$|^\.netrc$/i;
const RESERVED_WIN = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

function validProjectName(name) {
  return (
    typeof name === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9 _.\-()]{0,79}$/.test(name) &&
    !/[. ]$/.test(name) &&
    !RESERVED_WIN.test(name)
  );
}

function requireProjectsRoot() {
  if (!cfg.projectsRootAbs) throw httpError(400, 'No projectsRoot is set in bridge/config.json.');
}

async function listProjects() {
  requireProjectsRoot();
  await fsp.mkdir(cfg.projectsRootAbs, { recursive: true });
  const entries = await fsp.readdir(cfg.projectsRootAbs, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || !validProjectName(e.name) || IGNORED_DIRS.has(e.name)) continue;
    const md = path.join(cfg.projectsRootAbs, e.name, 'CLAUDE.md');
    const st = await fsp.stat(md).catch(() => null);
    out.push({ name: e.name, hasClaudeMd: !!st, claudeMdModified: st ? st.mtime.toISOString() : null });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

async function getProjectDir(name) {
  requireProjectsRoot();
  if (!validProjectName(name)) throw httpError(400, 'Invalid project name.');
  const dir = path.join(cfg.projectsRootAbs, name);
  const st = await fsp.stat(dir).catch(() => null);
  if (!st || !st.isDirectory()) throw httpError(404, `Project "${name}" not found.`);
  return dir;
}

function projectTemplate(name, description) {
  return [
    `# ${name}`,
    '',
    '## Overview',
    description && description.trim() ? description.trim() : '_What this project is and what it is for._',
    '',
    '## Tech stack',
    '',
    '## Structure',
    '',
    '## Commands',
    '_How to build, run and test._',
    '',
    '## Conventions',
    '',
    '## Notes',
    '',
  ].join('\n');
}

async function createProject(name, description) {
  requireProjectsRoot();
  if (!validProjectName(name))
    throw httpError(400, 'Use letters, numbers, spaces, dots, dashes, underscores or parentheses (max 80 characters).');
  const dir = path.join(cfg.projectsRootAbs, name);
  if (await fsp.stat(dir).catch(() => null)) throw httpError(409, `A folder named "${name}" already exists.`);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'CLAUDE.md'), projectTemplate(name, description), 'utf8');
  log(`Created project "${name}"`);
  return { name, path: dir };
}

// Resolve a path inside a project, refusing anything that escapes it (including via symlinks).
async function resolveInProject(dir, rel) {
  if (typeof rel !== 'string') rel = '';
  rel = rel.replace(/^[\\/]+/, '');
  const realBase = await fsp.realpath(dir);
  let real;
  try {
    real = await fsp.realpath(path.resolve(realBase, rel || '.'));
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`"${rel}" does not exist in the project.`);
    throw e;
  }
  if (real !== realBase && !real.startsWith(realBase + path.sep)) throw new Error('That path is outside the project.');
  return { real, base: realBase };
}

function fmtSize(n) {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}

async function listProjectFiles(dir, sub) {
  const { real, base } = await resolveInProject(dir, sub);
  const lines = [];
  const LIMIT = 250;
  let truncated = false;
  async function walk(abs, depth) {
    if (truncated) return;
    let entries = await fsp.readdir(abs, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    for (const e of entries) {
      if (lines.length >= LIMIT) {
        truncated = true;
        return;
      }
      const rel = path.relative(base, path.join(abs, e.name)).split(path.sep).join('/');
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) {
          lines.push(`${rel}/ (skipped)`);
          continue;
        }
        lines.push(`${rel}/`);
        if (depth < 4) await walk(path.join(abs, e.name), depth + 1);
      } else if (e.isFile()) {
        const st = await fsp.stat(path.join(abs, e.name)).catch(() => null);
        lines.push(`${rel}${st ? ` (${fmtSize(st.size)})` : ''}${SECRET_FILE_RE.test(e.name) ? ' [secret, not readable]' : ''}`);
      }
    }
  }
  await walk(real, 0);
  if (!lines.length) return '(empty folder)';
  return lines.join('\n') + (truncated ? `\n[...stopped at ${LIMIT} entries; list a subfolder to see more]` : '');
}

const READ_CHARS = 6000;

async function readProjectFile(dir, rel, startLine) {
  if (!rel) throw new Error('path is required.');
  const { real } = await resolveInProject(dir, rel);
  if (SECRET_FILE_RE.test(path.basename(real))) throw new Error('That file may contain secrets and cannot be read.');
  const st = await fsp.stat(real);
  if (st.isDirectory()) throw new Error('That is a folder. Use list_project_files.');
  if (st.size > 2 * 1024 * 1024) throw new Error(`File is too large to read (${fmtSize(st.size)}).`);
  const buf = await fsp.readFile(real);
  if (buf.subarray(0, 8000).includes(0)) return `(binary file, ${fmtSize(st.size)})`;
  const all = buf.toString('utf8').split(/\r?\n/);
  const start = Math.max(1, Number.isInteger(startLine) ? startLine : 1);
  let out = '';
  let i = start - 1;
  for (; i < all.length; i++) {
    const line = `${i + 1}: ${all[i]}\n`;
    if (out.length + line.length > READ_CHARS && out) break;
    out += line;
  }
  if (i < all.length) out += `[...file continues, ${all.length} lines total; call again with start_line=${i + 1}]`;
  return out || '(empty file)';
}

// ------------------------------------------------------------ CLAUDE.md ---

// A "target" is one CLAUDE.md file: the global one, or a project's.
async function mdTarget(project) {
  if (!project) return { file: cfg.claudeMdAbs, label: 'global', name: 'global CLAUDE.md' };
  const dir = await getProjectDir(project);
  return {
    file: path.join(dir, 'CLAUDE.md'),
    label: 'project-' + project.replace(/[^A-Za-z0-9_.-]/g, '_'),
    name: `CLAUDE.md for project "${project}"`,
  };
}

let writeLock = Promise.resolve();
function withWriteLock(fn) {
  const run = writeLock.then(fn, fn);
  writeLock = run.catch(() => {});
  return run;
}

async function readMd(target) {
  try {
    return await fsp.readFile(target.file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function backupMd(target) {
  let current;
  try {
    current = await fsp.readFile(target.file);
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  const dir = path.join(cfg.backupDir, target.label);
  await fsp.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await fsp.writeFile(path.join(dir, `CLAUDE.md.${stamp}.bak`), current);
  const files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.bak')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - cfg.maxBackups))) {
    await fsp.unlink(path.join(dir, f)).catch(() => {});
  }
}

function writeMd(target, content, source) {
  return withWriteLock(async () => {
    await backupMd(target);
    await fsp.mkdir(path.dirname(target.file), { recursive: true });
    const tmp = target.file + '.tmp';
    await fsp.writeFile(tmp, content, 'utf8');
    await fsp.rename(tmp, target.file);
    log(`${target.name} updated by ${source} (${content.length} chars)`);
  });
}

// ---------------------------------------------------------------- tools ---

function fn(name, description, properties = {}, required = []) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

function buildTools({ project, allowEdits, allowCode }) {
  const scope = project
    ? {
        scope: {
          type: 'string',
          enum: ['project', 'global'],
          description: `"project" (default) = the CLAUDE.md of project "${project}". "global" = the CLAUDE.md that applies to every chat.`,
        },
      }
    : {};
  const tools = [fn('read_claude_md', 'Read the full current contents of a CLAUDE.md file.', { ...scope })];
  if (allowEdits) {
    tools.push(
      fn('append_to_claude_md', 'Append markdown to the end of a CLAUDE.md. Best for adding one new fact, preference or instruction.', {
        ...scope,
        text: { type: 'string', description: 'Markdown text to append.' },
      }, ['text']),
      fn(
        'replace_in_claude_md',
        'Replace one exact snippet of a CLAUDE.md with new text. old_text must match exactly and appear once. Empty new_text deletes it.',
        {
          ...scope,
          old_text: { type: 'string', description: 'Exact text currently in the file.' },
          new_text: { type: 'string', description: 'Replacement text.' },
        },
        ['old_text', 'new_text']
      ),
      fn('write_claude_md', 'Overwrite an entire CLAUDE.md (creating it if missing). Use when writing it for the first time or reorganizing it.', {
        ...scope,
        content: { type: 'string', description: 'The complete new file contents.' },
      }, ['content'])
    );
  }
  if (project && allowCode) {
    tools.push(
      fn('list_project_files', `List files and folders in project "${project}" (read-only).`, {
        path: { type: 'string', description: 'Subfolder relative to the project root. Omit for the whole project.' },
      }),
      fn('read_project_file', `Read a text file in project "${project}" (read-only). Returns numbered lines.`, {
        path: { type: 'string', description: 'File path relative to the project root, e.g. "src/main.py".' },
        start_line: { type: 'integer', description: 'Line to start from, for long files. Default 1.' },
      }, ['path'])
    );
  }
  return tools;
}

async function runTool(name, args, ctx) {
  const target = async () => (ctx.project && args.scope !== 'global' ? ctx.projectTarget : ctx.globalTarget);
  switch (name) {
    case 'read_claude_md': {
      const t = await target();
      const md = await readMd(t);
      return { ok: true, result: md === null ? `(${t.name} does not exist yet)` : md || `(${t.name} is empty)` };
    }
    case 'append_to_claude_md': {
      if (typeof args.text !== 'string' || !args.text.trim()) return { ok: false, result: 'Error: text is required.' };
      const t = await target();
      const md = (await readMd(t)) || '';
      const sep = md === '' || md.endsWith('\n\n') ? '' : md.endsWith('\n') ? '\n' : '\n\n';
      await writeMd(t, md + sep + args.text.replace(/\s+$/, '') + '\n', 'model (append)');
      return { ok: true, changed: t, result: `Appended to ${t.name}.` };
    }
    case 'replace_in_claude_md': {
      const { old_text: oldText, new_text: newText } = args;
      if (typeof oldText !== 'string' || !oldText) return { ok: false, result: 'Error: old_text is required.' };
      if (typeof newText !== 'string') return { ok: false, result: 'Error: new_text must be a string.' };
      const t = await target();
      const md = (await readMd(t)) || '';
      const count = md.split(oldText).length - 1;
      if (count === 0) return { ok: false, result: 'Error: old_text was not found. Call read_claude_md and copy the text exactly.' };
      if (count > 1) return { ok: false, result: `Error: old_text appears ${count} times. Include more surrounding text.` };
      await writeMd(t, md.replace(oldText, () => newText), 'model (replace)');
      return { ok: true, changed: t, result: `Replaced text in ${t.name}.` };
    }
    case 'write_claude_md': {
      if (typeof args.content !== 'string' || !args.content.trim()) return { ok: false, result: 'Error: content is required.' };
      const t = await target();
      await writeMd(t, args.content.replace(/\s+$/, '') + '\n', 'model (write)');
      return { ok: true, changed: t, result: `Wrote ${t.name}.` };
    }
    case 'list_project_files':
      return { ok: true, result: await listProjectFiles(ctx.projectDir, args.path) };
    case 'read_project_file':
      return { ok: true, result: await readProjectFile(ctx.projectDir, args.path, args.start_line) };
    default:
      return { ok: false, result: `Error: unknown tool "${name}".` };
  }
}

// -------------------------------------------------------------- prompts ---

function inline(md, max, missing) {
  if (md === null) return missing;
  if (!md.trim()) return '(empty)';
  if (md.length > max) return md.slice(0, max) + '\n\n[...truncated; call read_claude_md for the full file]';
  return md;
}

function buildSystemPrompt({ globalMd, project, projectDir, projectMd, allowEdits, allowCode, extra }) {
  const L = [
    "You are a helpful assistant running locally on the user's own computer through LM Studio.",
    'You have memory files called CLAUDE.md. Follow the instructions in them.',
    '',
    'Global CLAUDE.md (applies to every chat):',
    '<global_claude_md>',
    inline(globalMd, 6000, '(does not exist yet)'),
    '</global_claude_md>',
  ];
  if (project) {
    L.push(
      '',
      `The user is working on the project "${project}" (folder: ${projectDir}).`,
      'Project CLAUDE.md (what this project is, how it is built, conventions, notes):',
      '<project_claude_md>',
      inline(projectMd, 10000, '(This project has no CLAUDE.md yet.)'),
      '</project_claude_md>'
    );
    if (allowCode)
      L.push('You can look at the project with list_project_files and read_project_file. You cannot change project files other than CLAUDE.md.');
  }
  L.push('');
  if (allowEdits) {
    L.push(
      'You can change CLAUDE.md files with append_to_claude_md, replace_in_claude_md and write_claude_md.',
      project
        ? 'Facts about this project go in the project CLAUDE.md (scope "project"). Facts about the user or instructions for every chat go in the global one (scope "global").'
        : 'No project is selected, so edits go to the global CLAUDE.md.',
      'Update a CLAUDE.md when the user asks you to remember something, change standing instructions, or create/update a CLAUDE.md. Do not edit otherwise. After an edit, briefly say what you changed.'
    );
    if (project && allowCode)
      L.push(
        'When asked to create or refresh the project CLAUDE.md: list the files, read the README and key source/config files, then write a concise CLAUDE.md with sections: Overview, Tech stack, Structure, Commands (build/run/test), Conventions, Notes. Only state what the files support.'
      );
  } else {
    L.push('CLAUDE.md files are read-only in this chat. If asked to change one, explain that edits are turned off.');
  }
  if (extra && typeof extra === 'string' && extra.trim()) L.push('', extra.trim());
  return L.join('\n');
}

function stripThink(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
}

const IMAGE_DATA_URL = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+=*$/;
const MAX_IMAGES_PER_MESSAGE = 24;

// User messages may carry images in the OpenAI format: an array of
// { type: 'text', text } and { type: 'image_url', image_url: { url: 'data:image/...' } }.
// Only inline base64 images are passed on (never remote URLs).
function sanitizeParts(parts) {
  const out = [];
  let images = 0;
  for (const p of parts) {
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'text' && typeof p.text === 'string') out.push({ type: 'text', text: p.text });
    else if (
      p.type === 'image_url' &&
      p.image_url &&
      typeof p.image_url.url === 'string' &&
      images < MAX_IMAGES_PER_MESSAGE &&
      IMAGE_DATA_URL.test(p.image_url.url)
    ) {
      out.push({ type: 'image_url', image_url: { url: p.image_url.url } });
      images++;
    }
  }
  if (!out.some((p) => p.type === 'text')) out.unshift({ type: 'text', text: '' });
  return out;
}

function sanitizeHistory(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter(
      (m) =>
        m &&
        (m.role === 'user' || m.role === 'assistant') &&
        (typeof m.content === 'string' || (m.role === 'user' && Array.isArray(m.content)))
    )
    .map((m) => {
      if (Array.isArray(m.content)) return { role: 'user', content: sanitizeParts(m.content) };
      return { role: m.role, content: m.role === 'assistant' ? stripThink(m.content) : m.content };
    })
    .slice(-40);
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
        const f = t.function || {};
        if (f.name && c.name !== f.name) c.name += f.name;
        if (f.arguments) c.args += f.arguments;
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
  // Larger limit than other routes: messages can carry images.
  const body = await readJson(req, 64 * 1024 * 1024);
  const allowEdits = cfg.allowModelEdits && body.allowEdits !== false;
  const project = typeof body.project === 'string' && body.project ? body.project : null;
  const allowCode = cfg.allowCodeReading && !!project;

  // Validate the project before switching to a streaming response.
  let projectDir = null;
  let projectTarget = null;
  if (project) {
    projectDir = await getProjectDir(project);
    projectTarget = await mdTarget(project);
  }
  const globalTarget = await mdTarget(null);
  const tools = buildTools({ project, allowEdits, allowCode });
  const ctx = { project, projectDir, projectTarget, globalTarget };

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
    try {
      if (await ensureModelLoaded(model, (text) => send({ type: 'status', text }))) send({ type: 'status', text: '' });
    } catch (e) {
      log('model load: ' + e.message);
      send({ type: 'status', text: '' });
    }
    const messages = [
      {
        role: 'system',
        content: buildSystemPrompt({
          globalMd: await readMd(globalTarget),
          project,
          projectDir,
          projectMd: projectTarget ? await readMd(projectTarget) : null,
          allowEdits,
          allowCode,
          extra: body.system,
        }),
      },
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
          if (!args || typeof args !== 'object') args = {};
        } catch {
          parsed = false;
        }
        send({ type: 'tool_call', id: c.id, name: c.name, args: parsed ? summarizeArgs(args) : {} });
        let out;
        if (!parsed) out = { ok: false, result: 'Error: tool arguments were not valid JSON.' };
        else if (!tools.some((t) => t.function.name === c.name))
          out = { ok: false, result: `Error: tool "${c.name}" is not available in this chat.` };
        else {
          try {
            out = await runTool(c.name, args, ctx);
          } catch (e) {
            out = { ok: false, result: 'Error: ' + e.message };
          }
        }
        send({
          type: 'tool_result',
          id: c.id,
          name: c.name,
          ok: out.ok,
          result: out.result.length > 1500 ? out.result.slice(0, 1500) + '…' : out.result,
        });
        if (out.changed)
          send({ type: 'claude_md_updated', scope: out.changed === projectTarget ? 'project' : 'global', project });
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

// Only short, non-content args go back to the browser (for the tool chips).
function summarizeArgs(args) {
  const out = {};
  if (typeof args.scope === 'string') out.scope = args.scope;
  if (typeof args.path === 'string') out.path = args.path.slice(0, 200);
  if (Number.isInteger(args.start_line)) out.start_line = args.start_line;
  return out;
}

async function handleStatus(res) {
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
    allowCodeReading: cfg.allowCodeReading,
    projectsRoot: cfg.projectsRootAbs || null,
    globalClaudeMd: cfg.claudeMdAbs,
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

// ------------------------------------------------------- model loading ---

const LMS_BIN = (() => {
  const p = path.join(os.homedir(), '.lmstudio', 'bin', process.platform === 'win32' ? 'lms.exe' : 'lms');
  return fs.existsSync(p) ? p : 'lms';
})();

function lms(args, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    execFile(LMS_BIN, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(`lms ${args[0]} failed: ${(stderr || stdout || err.message).toString().trim().slice(-300)}`));
      else resolve(String(stdout));
    });
  });
}

let loadLock = Promise.resolve();

// Make sure `model` is in memory with a context that fits on the GPU. Returns true if it (re)loaded.
function ensureModelLoaded(model, onLoading) {
  if (!cfg.contextLength || !model) return Promise.resolve(false);
  const run = loadLock.then(async () => {
    const r = await fetch(cfg.lmStudioUrl + '/api/v0/models', { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return false;
    const all = (await r.json()).data || [];
    const m = all.find((x) => x.id === model);
    if (!m) return false; // unknown id: let LM Studio report the error
    const okCtx = m.loaded_context_length && m.loaded_context_length <= cfg.contextLength;
    if (m.state === 'loaded' && okCtx) return false;

    onLoading(m.state === 'loaded' ? 'Reloading the model with a smaller context…' : 'Loading the model into memory…');
    // One GPU: unload every other LLM so they don't compete for memory.
    if (all.some((x) => x.state === 'loaded' && x.type !== 'embeddings')) await lms(['unload', '--all'], 60000);
    log(`Loading ${model} with context ${cfg.contextLength}`);
    // GPU offload, KV cache type etc. come from the model's saved LM Studio settings.
    await lms(['load', model, '-y', '--context-length', String(cfg.contextLength)]);
    return true;
  });
  loadLock = run.catch(() => {});
  return run;
}

async function listModels() {
  // LM Studio's native REST API reports load state; fall back to the OpenAI list.
  try {
    const r = await fetch(cfg.lmStudioUrl + '/api/v0/models', { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const j = await r.json();
      return (j.data || [])
        .filter((m) => m.type !== 'embeddings')
        .map((m) => ({ id: m.id, loaded: m.state === 'loaded', vision: m.type === 'vlm' }));
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
  if (/context|n_ctx|too long|exceeds/i.test(msg) && /token|context/i.test(msg))
    return 'The conversation no longer fits in the model\'s context window. Start a new chat, or load the model with a larger context.';
  return msg;
}

// ------------------------------------------------------------ plumbing ---

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readJson(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(httpError(413, 'Request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(httpError(400, 'Invalid JSON body'));
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
    const project = url.searchParams.get('project') || null;
    switch (route) {
      case 'GET /api/status':
        return await handleStatus(res);
      case 'POST /api/chat':
        return await handleChat(req, res);
      case 'GET /api/projects':
        return json(res, 200, { root: cfg.projectsRootAbs || null, projects: await listProjects() });
      case 'POST /api/projects': {
        const body = await readJson(req);
        return json(res, 201, await createProject(String(body.name || '').trim(), body.description));
      }
      case 'GET /api/claude-md': {
        const t = await mdTarget(project);
        const content = await readMd(t);
        return json(res, 200, { path: t.file, exists: content !== null, content: content || '' });
      }
      case 'PUT /api/claude-md': {
        const body = await readJson(req);
        if (typeof body.content !== 'string') return json(res, 400, { error: 'content (string) is required' });
        const t = await mdTarget(project);
        await writeMd(t, body.content, 'web editor');
        return json(res, 200, { ok: true, chars: body.content.length });
      }
      default:
        return json(res, 404, { error: 'Not found' });
    }
  } catch (e) {
    if (!e.status) log(`error on ${route}: ${e.message}`);
    if (!res.headersSent) json(res, e.status || 500, { error: e.message });
    else res.end();
  }
});

module.exports = { listProjectFiles, readProjectFile, getProjectDir, validProjectName };

if (require.main === module) server.listen(cfg.port, cfg.host, () => {
  log(`Bridge listening on http://${cfg.host}:${cfg.port}`);
  log(`LM Studio:        ${cfg.lmStudioUrl}`);
  log(`Global CLAUDE.md: ${cfg.claudeMdAbs}`);
  log(`Projects folder:  ${cfg.projectsRootAbs || '(not set)'}`);
  log(`Model edits to CLAUDE.md: ${cfg.allowModelEdits ? 'allowed' : 'disabled'}; code reading: ${cfg.allowCodeReading ? 'allowed' : 'disabled'}`);
});
