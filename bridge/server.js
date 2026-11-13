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
  // Compaction: when a chat passes this share of the model's context, the older part is
  // summarized (like Claude Code's auto-compact) so the chat can keep going.
  autoCompact: true,
  compactAt: 0.7,
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

const READ_CHARS = 12000;

async function readProjectFile(dir, rel, startLine, endLine) {
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
  const end = Math.min(all.length, Number.isInteger(endLine) && endLine >= start ? endLine : all.length);
  if (start > all.length) return `(the file has only ${all.length} lines)`;
  let out = '';
  let i = start - 1;
  for (; i < end; i++) {
    const line = `${i + 1}: ${all[i]}\n`;
    if (out.length + line.length > READ_CHARS && out) break;
    out += line;
  }
  if (i < end) out += `[...stopped at line ${i} to save space; ${all.length} lines total. Call again with start_line=${i + 1}]`;
  else if (end < all.length) out += `[${all.length} lines total]`;
  return out || '(empty file)';
}

// Search text files in a project for a word or phrase (or a regular expression).
async function searchProject(dir, query, sub, isRegex, maxResults) {
  if (typeof query !== 'string' || !query.trim()) throw new Error('query is required.');
  let re;
  try {
    re = isRegex ? new RegExp(query, 'i') : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  } catch (e) {
    throw new Error('Invalid regular expression: ' + e.message);
  }
  const { real, base } = await resolveInProject(dir, sub);
  const limit = Math.min(Math.max(Number.isInteger(maxResults) ? maxResults : 50, 1), 150);
  const hits = [];
  const filesWithHits = new Set();
  let total = 0;
  let filesScanned = 0;
  async function scanFile(abs) {
    const st = await fsp.stat(abs).catch(() => null);
    if (!st || st.size > 1024 * 1024) return;
    const buf = await fsp.readFile(abs).catch(() => null);
    if (!buf || buf.subarray(0, 8000).includes(0)) return;
    filesScanned++;
    const rel = path.relative(base, abs).split(path.sep).join('/');
    const lines = buf.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].length > 2000 ? lines[i].slice(0, 2000) : lines[i];
      if (!re.test(line)) continue;
      total++;
      filesWithHits.add(rel);
      if (hits.length < limit) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
    }
  }
  async function walk(abs, depth) {
    if (filesScanned > 3000) return;
    const st = await fsp.stat(abs).catch(() => null);
    if (!st) return;
    if (st.isFile()) {
      if (!SECRET_FILE_RE.test(path.basename(abs))) await scanFile(abs);
      return;
    }
    const entries = await fsp.readdir(abs, { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const p = path.join(abs, e.name);
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name) && depth < 10) await walk(p, depth + 1);
      } else if (e.isFile() && !SECRET_FILE_RE.test(e.name)) await scanFile(p);
    }
  }
  await walk(real, 0);
  if (!total) return `No matches for "${query}" (${filesScanned} files searched).`;
  return (
    `${total} match${total === 1 ? '' : 'es'} in ${filesWithHits.size} file${filesWithHits.size === 1 ? '' : 's'}` +
    (total > hits.length ? ` (showing the first ${hits.length}; narrow the search or set path)` : '') +
    ':\n' +
    hits.join('\n')
  );
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
      fn(
        'search_project',
        `Search the text files of project "${project}" for a word or phrase (case-insensitive). Returns matching lines as path:line: text. ` +
          'Use it to find where something is defined or discussed before reading files, so you only read the parts you need.',
        {
          query: { type: 'string', description: 'Text to look for, e.g. "def login" or "database schema".' },
          path: { type: 'string', description: 'Only search this subfolder or file. Omit to search the whole project.' },
          regex: { type: 'boolean', description: 'Treat query as a regular expression. Default false.' },
          max_results: { type: 'integer', description: 'Maximum matching lines to return (default 50, max 150).' },
        },
        ['query']
      ),
      fn(
        'read_project_file',
        `Read a text file in project "${project}" (read-only). Returns numbered lines. For long files, read only the lines you need ` +
          '(use search_project to find them).',
        {
          path: { type: 'string', description: 'File path relative to the project root, e.g. "src/main.py".' },
          start_line: { type: 'integer', description: 'First line to read. Default 1.' },
          end_line: { type: 'integer', description: 'Last line to read. Default: as far as fits.' },
        },
        ['path']
      )
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
      return { ok: true, result: await readProjectFile(ctx.projectDir, args.path, args.start_line, args.end_line) };
    case 'search_project':
      return { ok: true, result: await searchProject(ctx.projectDir, args.query, args.path, args.regex === true, args.max_results) };
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

function buildSystemPrompt({ globalMd, project, projectDir, projectMd, allowEdits, allowCode, extra, summary }) {
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
      L.push(
        'You can look at the project with list_project_files, search_project and read_project_file. You cannot change project files other than CLAUDE.md.',
        'Your context window is limited: use search_project to find what you need and read only those lines, instead of reading whole large files.'
      );
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
  if (summary)
    L.push(
      '',
      'Earlier parts of this conversation were compacted to save space. This summary covers everything before the messages that follow:',
      '<conversation_summary>',
      summary,
      '</conversation_summary>',
      'Continue from where the conversation left off, using the summary as if you remembered it.'
    );
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
    });
}

// The browser sends the latest compaction summary as a { role: 'summary' } message.
function lastSummary(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'summary' && typeof m.content === 'string') return m.content;
  }
  return '';
}

// ------------------------------------------------------- token estimates ---
// LM Studio only reports exact counts after a request, so before one the bridge estimates
// from text length, and recalibrates the ratio from the real counts it gets back.

let tokensPerChar = 0.3;
const PER_MESSAGE_TOKENS = 8;

// Width/height from a base64 JPEG or PNG data URL (the browser sends JPEGs).
function imageSize(dataUrl) {
  try {
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1, dataUrl.indexOf(',') + 1 + 65536);
    const b = Buffer.from(b64.slice(0, b64.length - (b64.length % 4)), 'base64');
    if (b[0] === 0x89 && b[1] === 0x50) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const marker = b[i + 1];
        const len = b.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
          return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
        i += 2 + len;
      }
    }
  } catch {}
  return { w: 1024, h: 1024 };
}

// Measured on Qwen3.8 27B in LM Studio: one token per ~32x32 pixels (1280x800 = ~1,000 tokens).
const pixelsPerImageToken = 32 * 32;
const imageTokens = (url) => {
  const { w, h } = imageSize(url);
  return Math.ceil((w * h) / pixelsPerImageToken) + 4;
};

// Returns { chars, images } for one chat message (text characters and image tokens).
function messageWeight(m) {
  if (typeof m.content === 'string') return { chars: m.content.length, images: 0 };
  let chars = 0;
  let images = 0;
  for (const p of m.content || []) {
    if (p.type === 'text') chars += p.text.length;
    else if (p.type === 'image_url') images += imageTokens(p.image_url.url);
  }
  return { chars, images };
}

function estimate(messages, tools) {
  let chars = tools ? JSON.stringify(tools).length : 0;
  let images = 0;
  for (const m of messages) {
    const w = messageWeight(m);
    chars += w.chars;
    images += w.images;
  }
  const tokens = Math.round(chars * tokensPerChar + images + messages.length * PER_MESSAGE_TOKENS);
  return { tokens, chars, images, count: messages.length };
}

const estimateMessage = (m) => estimate([m]).tokens;

// After a real request: nudge the ratio toward what LM Studio actually counted.
function calibrate(est, promptTokens) {
  if (!promptTokens || est.chars < 3000) return;
  const textTokens = promptTokens - est.images - est.count * PER_MESSAGE_TOKENS;
  const ratio = textTokens / est.chars;
  if (ratio > 0.12 && ratio < 0.7) tokensPerChar = tokensPerChar * 0.5 + ratio * 0.5;
}

async function loadedContext(model) {
  try {
    const r = await fetch(cfg.lmStudioUrl + '/api/v0/models', { signal: AbortSignal.timeout(5000) });
    const m = ((await r.json()).data || []).find((x) => x.id === model);
    if (m && m.state === 'loaded' && m.loaded_context_length) return m.loaded_context_length;
  } catch {}
  return cfg.contextLength || null;
}

// ------------------------------------------------------------ compaction ---
// Like Claude Code's compaction: the model writes a structured summary of the older part of
// the chat, and the summary replaces it. CLAUDE.md files are re-read on every message, so
// nothing in them is lost; the summary's Progress section can also be saved to CLAUDE.md.

const SUMMARY_MAX_TOKENS = 3500;

const SUMMARY_SYSTEM = [
  'You compact long conversations between a user and an AI assistant so the work can continue in a fresh context window.',
  'Write a summary that lets the assistant carry on as if it had read the whole conversation.',
  'Be specific: keep names, numbers, file paths, commands, error messages, decisions and the reasons for them, and the user\'s preferences.',
  'Leave out greetings, filler, and finished detours that do not matter for what comes next. Do not invent anything.',
  '',
  'Use exactly these markdown sections:',
  '## Goal and requests',
  '(what the user is trying to achieve, and every request they made, including the latest one)',
  '## Key facts and decisions',
  '## Files and code',
  '(file paths, what was read or changed, short code snippets only when essential)',
  '## Problems and fixes',
  '## Current state',
  '(exactly what was being worked on when the conversation was compacted)',
  '## Next steps',
  '## Progress',
  '(a status note of at most 120 words: what is done, what is in progress, what is next. It is saved in the project\'s CLAUDE.md)',
  '',
  'Write at most about 1,500 words. Output only the summary, starting with "## Goal and requests".',
].join('\n');

function transcriptOf(m) {
  if (typeof m.content === 'string') return `[${m.role === 'user' ? 'User' : 'Assistant'}]\n${m.content}`;
  const text = (m.content || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  const n = (m.content || []).filter((p) => p.type === 'image_url').length;
  return `[User]\n${text}${n ? `\n[${n} image${n === 1 ? '' : 's'} attached; you can no longer see them]` : ''}`;
}

async function summaryCall(model, userPrompt, signal) {
  const r = await fetch(cfg.lmStudioUrl + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      // No thinking: it would use thousands of tokens of the little room that is left.
      reasoning_effort: 'none',
      temperature: 0.3,
      max_tokens: SUMMARY_MAX_TOKENS,
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user', content: userPrompt },
      ],
    }),
    signal,
  });
  if (!r.ok) throw new Error(`LM Studio returned ${r.status} while summarizing: ${(await r.text().catch(() => '')).slice(0, 300)}`);
  const j = await r.json();
  const text = stripThink((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '');
  if (!text) throw new Error('The model returned an empty summary.');
  return text;
}

// Summarizes `messages` (plus an earlier summary, if any). Long transcripts are summarized in
// pieces, each piece folded into the running summary, so it works even near the context limit.
async function summarize({ messages, previous, instructions, model, ctxLen, signal, onStatus }) {
  const budgetTokens = Math.max(4000, ctxLen - SUMMARY_MAX_TOKENS - 1500 - (previous ? estimateMessage({ content: previous }) : 0) - 1000);
  const budgetChars = Math.floor(budgetTokens / tokensPerChar);
  const pieces = [];
  let cur = '';
  for (const m of messages) {
    let t = transcriptOf(m) + '\n\n';
    while (t.length > budgetChars) {
      if (cur) { pieces.push(cur); cur = ''; }
      pieces.push(t.slice(0, budgetChars));
      t = t.slice(budgetChars);
    }
    if (cur.length + t.length > budgetChars) { pieces.push(cur); cur = ''; }
    cur += t;
  }
  if (cur) pieces.push(cur);

  let summary = previous || '';
  for (let i = 0; i < pieces.length; i++) {
    onStatus(pieces.length > 1 ? `Compacting the conversation (part ${i + 1} of ${pieces.length})…` : 'Compacting the conversation to free up context…');
    const prompt = [
      summary
        ? `Summary of the conversation so far:\n<summary>\n${summary}\n</summary>\n\nThe conversation then continued:`
        : 'The conversation:',
      '<conversation>',
      pieces[i].trim(),
      '</conversation>',
      instructions ? `\nWhen summarizing, pay special attention to: ${instructions}` : '',
      summary
        ? '\nWrite one updated summary that merges the earlier summary with the new part.'
        : '\nWrite the summary.',
    ].join('\n');
    summary = await summaryCall(model, prompt, signal);
  }
  return summary;
}

// Puts the summary's Progress section into a CLAUDE.md, replacing any earlier one.
async function saveProgress(target, summary) {
  const lines = summary.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Progress\b/i.test(l));
  if (start < 0) return false;
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end).join('\n').trim();
  if (!body) return false;
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const section = `## Progress\n_Saved ${stamp} when a chat was compacted._\n\n${body}\n`;

  const md = (await readMd(target)) || '';
  const mdLines = md.split(/\r?\n/);
  const s = mdLines.findIndex((l) => /^##\s+Progress\b/i.test(l));
  let next;
  if (s >= 0) {
    let e = mdLines.findIndex((l, i) => i > s && /^##\s/.test(l));
    if (e < 0) e = mdLines.length;
    next = [...mdLines.slice(0, s), ...section.trimEnd().split('\n'), '', ...mdLines.slice(e)].join('\n');
  } else {
    next = md.replace(/\s*$/, '') + (md.trim() ? '\n\n' : '') + section;
  }
  await writeMd(target, next.replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '') + '\n', 'compaction (progress)');
  return true;
}

// ------------------------------------------------------- LM Studio call ---

async function streamCompletion(payload, send, signal) {
  const r = await fetch(cfg.lmStudioUrl + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, stream: true, stream_options: { include_usage: true } }),
    signal,
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`LM Studio returned ${r.status}: ${t.slice(0, 400)}`);
  }

  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  let usage = null;
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
    if (j.usage) usage = j.usage;
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

  return { content, usage, toolCalls: calls.filter((c) => c && c.name) };
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

  const { send, ac, finish } = openEventStream(res);

  try {
    const model = await resolveModel(body.model);
    try {
      if (await ensureModelLoaded(model, (text) => send({ type: 'status', text }))) send({ type: 'status', text: '' });
    } catch (e) {
      log('model load: ' + e.message);
      send({ type: 'status', text: '' });
    }
    const ctxLen = await loadedContext(model);
    const globalMd = await readMd(globalTarget);
    const projectMd = projectTarget ? await readMd(projectTarget) : null;
    const systemFor = (summary) =>
      buildSystemPrompt({ globalMd, project, projectDir, projectMd, allowEdits, allowCode, extra: body.system, summary });

    let summary = lastSummary(body.messages);
    let history = sanitizeHistory(body.messages);
    let est = estimate([{ role: 'system', content: systemFor(summary) }, ...history], tools);

    // Auto-compaction: summarize the older part of the chat once it passes compactAt of the context.
    if (cfg.autoCompact && ctxLen && history.length >= 2 && est.tokens > ctxLen * cfg.compactAt) {
      // Keep the newest messages word for word: always the new user message, plus up to three
      // more while they fit in a fifth of the context. The kept part starts with a user message.
      let keep = 1;
      let kept = estimateMessage(history[history.length - 1]);
      while (keep < 4 && keep < history.length - 1) {
        const t = estimateMessage(history[history.length - 1 - keep]);
        if (kept + t > ctxLen * 0.2) break;
        kept += t;
        keep++;
      }
      while (keep > 1 && history[history.length - keep].role !== 'user') keep--;
      const count = history.length - keep;
      if (count > 0) {
        const before = est.tokens;
        const status = (text) => send({ type: 'status', text });
        summary = await summarize({ messages: history.slice(0, count), previous: summary, model, ctxLen, signal: ac.signal, onStatus: status });
        history = history.slice(count);
        est = estimate([{ role: 'system', content: systemFor(summary) }, ...history], tools);
        const progressSaved = !!(projectTarget && allowEdits && body.saveProgress !== false && (await saveProgress(projectTarget, summary)));
        if (progressSaved) send({ type: 'claude_md_updated', scope: 'project', project });
        send({ type: 'compacted', summary, count, tokensBefore: before, tokensAfter: est.tokens, context: ctxLen, auto: true, progressSaved });
        send({ type: 'status', text: '' });
        log(`Compacted ${count} messages: ~${before} -> ~${est.tokens} tokens${progressSaved ? ' (progress saved)' : ''}`);
      }
    }
    send({ type: 'context', estimate: est.tokens, context: ctxLen });

    const messages = [{ role: 'system', content: systemFor(summary) }, ...history];
    const extra = {};
    if (typeof body.temperature === 'number') extra.temperature = body.temperature;

    for (let round = 0; round <= cfg.maxToolRounds; round++) {
      const useTools = round < cfg.maxToolRounds;
      const roundEst = round === 0 ? estimate(messages, useTools ? tools : null) : null;
      const { content, toolCalls, usage } = await streamCompletion(
        { model, messages, ...(useTools ? { tools } : {}), ...extra },
        send,
        ac.signal
      );
      if (usage) {
        if (roundEst) calibrate(roundEst, usage.prompt_tokens);
        const reasoning = (usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens) || 0;
        send({ type: 'usage', prompt: usage.prompt_tokens, completion: usage.completion_tokens, reasoning, context: ctxLen });
      }
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
    finish();
  }
}

function openEventStream(res) {
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
  const finish = () => {
    clearInterval(ping);
    res.end();
  };
  return { send, ac, finish };
}

// Manual compaction (the site's Compact button, like Claude Code's /compact): summarizes the
// whole chat so far, optionally focusing on what the user asks for.
async function handleCompact(req, res) {
  const body = await readJson(req, 64 * 1024 * 1024);
  const project = typeof body.project === 'string' && body.project ? body.project : null;
  const projectTarget = project ? await mdTarget(project) : null;
  const allowEdits = cfg.allowModelEdits && body.allowEdits !== false;
  const previous = lastSummary(body.messages);
  const history = sanitizeHistory(body.messages);
  if (!history.length) throw httpError(400, previous ? 'Nothing new to compact since the last summary.' : 'This chat is empty.');
  const instructions = typeof body.instructions === 'string' ? body.instructions.trim().slice(0, 2000) : '';

  const { send, ac, finish } = openEventStream(res);
  try {
    const model = await resolveModel(body.model);
    try {
      if (await ensureModelLoaded(model, (text) => send({ type: 'status', text }))) send({ type: 'status', text: '' });
    } catch {}
    const ctxLen = (await loadedContext(model)) || 16384;
    const before = estimate([...(previous ? [{ content: previous }] : []), ...history]).tokens;
    const summary = await summarize({
      messages: history,
      previous,
      instructions,
      model,
      ctxLen,
      signal: ac.signal,
      onStatus: (text) => send({ type: 'status', text }),
    });
    const progressSaved = !!(projectTarget && allowEdits && body.saveProgress !== false && (await saveProgress(projectTarget, summary)));
    if (progressSaved) send({ type: 'claude_md_updated', scope: 'project', project });
    const after = estimateMessage({ content: summary });
    send({ type: 'compacted', summary, count: history.length, tokensBefore: before, tokensAfter: after, context: ctxLen, auto: false, progressSaved });
    log(`Compacted ${history.length} messages on request: ~${before} -> ~${after} tokens${progressSaved ? ' (progress saved)' : ''}`);
    send({ type: 'done' });
  } catch (e) {
    if (!ac.signal.aborted) {
      log('compact error: ' + e.message);
      send({ type: 'error', message: friendlyError(e) });
    }
  } finally {
    finish();
  }
}

// Only short, non-content args go back to the browser (for the tool chips).
function summarizeArgs(args) {
  const out = {};
  if (typeof args.scope === 'string') out.scope = args.scope;
  if (typeof args.path === 'string') out.path = args.path.slice(0, 200);
  if (Number.isInteger(args.start_line)) out.start_line = args.start_line;
  if (Number.isInteger(args.end_line)) out.end_line = args.end_line;
  if (typeof args.query === 'string') out.query = args.query.slice(0, 120);
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
    autoCompact: cfg.autoCompact,
    compactAt: cfg.compactAt,
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
        .map((m) => ({
          id: m.id,
          loaded: m.state === 'loaded',
          vision: m.type === 'vlm',
          context: m.state === 'loaded' ? m.loaded_context_length || null : null,
        }));
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
      case 'POST /api/compact':
        return await handleCompact(req, res);
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

module.exports = { listProjectFiles, readProjectFile, searchProject, getProjectDir, validProjectName, saveProgress, imageSize };

if (require.main === module) server.listen(cfg.port, cfg.host, () => {
  log(`Bridge listening on http://${cfg.host}:${cfg.port}`);
  log(`LM Studio:        ${cfg.lmStudioUrl}`);
  log(`Global CLAUDE.md: ${cfg.claudeMdAbs}`);
  log(`Projects folder:  ${cfg.projectsRootAbs || '(not set)'}`);
  log(`Model edits to CLAUDE.md: ${cfg.allowModelEdits ? 'allowed' : 'disabled'}; code reading: ${cfg.allowCodeReading ? 'allowed' : 'disabled'}`);
});
