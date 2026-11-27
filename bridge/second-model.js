'use strict';
// A second, smaller model on its own GPU, served by llama.cpp's llama-server.
//
// LM Studio runs one GGUF engine at a time (CUDA here, for the main model on the NVIDIA card),
// so a model on the other card (the AMD one) gets its own llama-server with the Vulkan build.
// The bridge starts it, restarts it if it stops, and sends requests for its model id to it
// instead of LM Studio. Set it up with "secondModel" in config.json (see config.example.json).
//
// Loading and unloading (website, `second-model.ps1`, or /api/second-model):
//   on    loaded, and started again if it stops
//   off   unloaded until someone loads it; messages to it get an error that says so
//   idle  unloaded after `idleMinutes` without use; the next message loads it (~10-20 s)
// The choice is saved in bridge/second-model-state.json, so it survives bridge restarts.

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const OFF = {
  enabled: false, id: '', url: '', has: () => false, ready: () => false, models: async () => [], context: async () => null,
  status: async () => null, load: async () => { throw new Error('No second model is set up.'); }, unload: async () => null,
  setIdle: () => null, ensureReady: async () => false, start() {},
};

module.exports = function secondModel(cfg, log) {
  const c = cfg.secondModel;
  if (!c || c.enabled === false || !c.id || !c.server || !c.model) return OFF;
  const port = Number(c.port) || 1235;
  const url = `http://127.0.0.1:${port}`;
  const abs = (p) => path.resolve(__dirname, p.startsWith('~') ? path.join(require('os').homedir(), p.slice(1)) : p);
  const server = abs(c.server);
  const modelFile = abs(c.model);
  const STATE_FILE = path.join(__dirname, 'second-model-state.json');

  // Saved choices: mode (on/off/idle), idle timeout in minutes (null = config), and the pid of
  // the server this bridge started (so a restarted bridge can stop one it left running).
  let state = { mode: c.startUnloaded ? 'off' : 'on', idleMinutes: null, pid: null };
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
  } catch {}
  const save = () => {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (e) {
      log('Second model: could not save its state: ' + e.message);
    }
  };
  const idleMinutes = () => Math.max(0, Number(state.idleMinutes ?? c.idleUnloadMinutes ?? 0) || 0);

  let child = null; // the llama-server this bridge started (null if adopted or stopped)
  let up = false;
  let context = null;
  let quickExits = 0;
  let pausedUntil = 0;
  let lastUsed = Date.now();
  let lastError = '';

  async function probe() {
    try {
      const r = await fetch(url + '/props', { signal: AbortSignal.timeout(2000) });
      if (!r.ok) throw new Error(String(r.status)); // 503 while the model loads
      const j = await r.json();
      context = (j.default_generation_settings && j.default_generation_settings.n_ctx) || Number(c.context) || null;
      up = true;
    } catch {
      up = false;
    }
    return up;
  }

  async function busy() {
    try {
      const r = await fetch(url + '/slots', { signal: AbortSignal.timeout(2000) });
      if (!r.ok) return false;
      return (await r.json()).some((s) => s.is_processing);
    } catch {
      return false;
    }
  }

  // Device numbers can change (drivers, a card added or removed), so the card is found by name.
  function findDevice() {
    if (!c.gpu) return Promise.resolve(c.device || null);
    return new Promise((resolve) => {
      execFile(server, ['--list-devices'], { timeout: 60000, windowsHide: true }, (err, stdout, stderr) => {
        const text = String(stdout || '') + String(stderr || '');
        const line = text.split(/\r?\n/).find((l) => /^\s*\S+:\s/.test(l) && l.toLowerCase().includes(String(c.gpu).toLowerCase()));
        resolve(line ? line.trim().split(':')[0] : null);
      });
    });
  }

  let launching = null;
  function launch() {
    if (launching) return launching;
    launching = (async () => {
      if (!fs.existsSync(server)) throw new Error(`llama-server not found at ${server}`);
      if (!fs.existsSync(modelFile)) throw new Error(`model file not found at ${modelFile}`);
      const device = await findDevice();
      if (c.gpu && !device) throw new Error(`no GPU named "${c.gpu}" found`);
      if (state.mode !== 'on') return; // unloaded while this was starting
      const args = [
        '-m', modelFile,
        '--alias', c.id,
        '--host', '127.0.0.1',
        '--port', String(port),
        '-ngl', '999',
        '-c', String(Number(c.context) || 32768),
        // Measured on an RX 6800 XT (Vulkan), 9B at ~23k tokens: flash attention or a q8_0 KV cache
        // drops prefill from ~800 to 100-250 tokens/s, so both are off unless the config says so.
        '-fa', c.flashAttention || 'off',
        ...(c.cacheTypeK ? ['-ctk', c.cacheTypeK] : []),
        ...(c.cacheTypeV ? ['-ctv', c.cacheTypeV] : []),
        // A 256-token batch saves ~1 GB of VRAM at 64k context for ~7% slower prefill.
        '-ub', String(Number(c.batch) || 256),
        '-np', '1',
        '--no-webui',
        ...(device ? ['-dev', device] : []),
        ...(Array.isArray(c.args) ? c.args.map(String) : []),
      ];
      const logDir = path.join(__dirname, 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      const out = fs.openSync(path.join(logDir, 'second-model.log'), 'a');
      log(`Second model: starting ${c.id} on ${device || 'the default GPU'} (port ${port}, context ${Number(c.context) || 32768})`);
      const started = Date.now();
      const proc = spawn(server, args, { windowsHide: true, stdio: ['ignore', out, out] });
      fs.closeSync(out);
      child = proc;
      state.pid = proc.pid;
      save();
      proc.on('error', (e) => log('Second model: ' + e.message));
      proc.on('exit', (code) => {
        if (child === proc) child = null;
        up = false;
        if (proc.stopping) return log('Second model: unloaded.');
        log(`Second model: llama-server exited (code ${code}).`);
        // A server that keeps dying right away (bad file, out of memory) is retried less often.
        quickExits = Date.now() - started < 120000 ? quickExits + 1 : 0;
        if (quickExits >= 3) {
          pausedUntil = Date.now() + 10 * 60000;
          lastError = 'It stopped 3 times in a row right after starting; see bridge/logs/second-model.log.';
          log('Second model: it stopped 3 times in a row; trying again in 10 minutes. See bridge/logs/second-model.log');
        }
      });
    })()
      .catch((e) => {
        lastError = e.message;
        log('Second model: ' + e.message);
      })
      .finally(() => {
        launching = null;
      });
    return launching;
  }

  // Stops the server: the one this bridge started, or one an earlier bridge left (by its saved
  // pid, checked to be llama-server first).
  async function stopServer() {
    if (child) {
      child.stopping = true;
      child.kill();
      const proc = child;
      await new Promise((r) => (proc.exitCode !== null ? r() : proc.once('exit', r)));
    } else if (state.pid && (await probe())) {
      const isLlama = await new Promise((resolve) =>
        execFile('tasklist', ['/FI', `PID eq ${state.pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true }, (e, out) => resolve(/llama-server/i.test(String(out || ''))))
      );
      if (isLlama) {
        try {
          process.kill(state.pid);
        } catch {}
      }
    }
    for (let i = 0; i < 20 && (await probe()); i++) await new Promise((r) => setTimeout(r, 250));
    up = false;
  }

  async function waitUp(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await probe()) return true;
      if (!child && !launching) return false; // it exited while loading
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  async function load() {
    state.mode = 'on';
    save();
    lastUsed = Date.now();
    pausedUntil = 0;
    quickExits = 0;
    lastError = '';
    if (stopping) await stopping; // an unload still in progress: let it finish first
    if (await probe()) return status();
    if (!child) await launch();
    if (!(await waitUp(180000))) throw new Error(`The ${c.id} model didn't load${lastError ? ': ' + lastError : ''}.`);
    log('Second model: loaded.');
    return status();
  }

  let stopping = null;
  async function unload(mode = 'off') {
    state.mode = mode;
    save();
    if (!stopping) stopping = stopServer().finally(() => (stopping = null));
    await stopping;
    return status();
  }

  async function status() {
    await probe();
    return {
      id: c.id,
      gpu: c.gpu || null,
      mode: state.mode,
      state: stopping ? 'unloading' : up ? 'loaded' : child || launching ? 'loading' : state.mode === 'off' ? 'unloaded' : state.mode === 'idle' ? 'idle' : 'stopped',
      context: up ? context : Number(c.context) || null,
      idleMinutes: idleMinutes(),
      lastUsed,
      error: lastError || undefined,
    };
  }

  // Every 30 s: keep it running while it's on (a server left by an earlier bridge is used),
  // and unload it after the idle timeout.
  async function tick() {
    if (stopping) return;
    if (await probe()) {
      if (state.mode !== 'on') {
        // Running although it's set to unloaded (e.g. started by hand): leave it be, but note it.
        state.mode = 'on';
        save();
      }
      const idle = idleMinutes();
      if (idle && (await busy())) lastUsed = Date.now();
      else if (idle && Date.now() - lastUsed > idle * 60000) {
        log(`Second model: unused for ${idle} min; unloading it (the next message loads it again).`);
        await unload('idle');
      }
      return;
    }
    if (state.mode !== 'on' || child || launching || Date.now() < pausedUntil) return;
    await launch();
  }

  return {
    enabled: true,
    id: c.id,
    url,
    has: (model) => model === c.id,
    ready: () => up,
    async models() {
      await probe();
      return [{ id: c.id, loaded: up, vision: false, context: up ? context : null, gpu: c.gpu || null, second: state.mode }];
    },
    async context() {
      if (!up) await probe();
      return up ? context : Number(c.context) || null;
    },
    status,
    load,
    unload: () => unload('off'),
    setIdle(minutes) {
      const n = Number(minutes);
      if (!Number.isFinite(n) || n < 0 || n > 24 * 60) throw new Error('The idle time must be 0 (never) to 1440 minutes.');
      state.idleMinutes = Math.round(n);
      save();
      lastUsed = Date.now();
      return status();
    },
    // Before a request to this model: loads it if it was unloaded for being idle, and refuses
    // with a clear message if someone unloaded it. Returns true if it had to load.
    async ensureReady(onLoading) {
      lastUsed = Date.now();
      if (up || (await probe())) return false;
      if (state.mode === 'off')
        throw Object.assign(new Error(`${c.id} is unloaded. Load it on the website (Load, next to the Model menu, or in Settings), or run .\\second-model.ps1 on`), { status: 409 });
      if (onLoading) onLoading(`Loading ${c.id}…`);
      await load();
      return true;
    },
    start() {
      tick();
      setInterval(tick, 30000).unref();
    },
  };
};
