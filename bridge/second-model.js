'use strict';
// A second, smaller model on its own GPU, served by llama.cpp's llama-server.
//
// LM Studio runs one GGUF engine at a time (CUDA here, for the main model on the NVIDIA card),
// so a model on the other card (the AMD one) gets its own llama-server with the Vulkan build.
// The bridge starts it, restarts it if it stops, and sends requests for its model id to it
// instead of LM Studio. Set it up with "secondModel" in config.json (see config.example.json).

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const OFF = { enabled: false, id: '', url: '', has: () => false, ready: () => false, models: async () => [], context: async () => null, start() {} };

module.exports = function secondModel(cfg, log) {
  const c = cfg.secondModel;
  if (!c || c.enabled === false || !c.id || !c.server || !c.model) return OFF;
  const port = Number(c.port) || 1235;
  const url = `http://127.0.0.1:${port}`;
  const abs = (p) => path.resolve(__dirname, p.startsWith('~') ? path.join(require('os').homedir(), p.slice(1)) : p);
  const server = abs(c.server);
  const modelFile = abs(c.model);

  let child = null; // the llama-server this bridge started (null if adopted or stopped)
  let up = false;
  let context = null;
  let quickExits = 0;
  let pausedUntil = 0;

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

  async function launch() {
    if (!fs.existsSync(server)) return log(`Second model: llama-server not found at ${server}`);
    if (!fs.existsSync(modelFile)) return log(`Second model: model file not found at ${modelFile}`);
    const device = await findDevice();
    if (c.gpu && !device) return log(`Second model: no GPU named "${c.gpu}" found; not starting it.`);
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
    child = spawn(server, args, { windowsHide: true, stdio: ['ignore', out, out] });
    fs.closeSync(out);
    child.on('error', (e) => log('Second model: ' + e.message));
    child.on('exit', (code) => {
      child = null;
      up = false;
      log(`Second model: llama-server exited (code ${code}).`);
      // A server that keeps dying right away (bad file, out of memory) is retried less often.
      quickExits = Date.now() - started < 120000 ? quickExits + 1 : 0;
      if (quickExits >= 3) {
        pausedUntil = Date.now() + 10 * 60000;
        log('Second model: it stopped 3 times in a row; trying again in 10 minutes. See bridge/logs/second-model.log');
      }
    });
  }

  // Every 30 s: if the server isn't answering and none is starting, start it. A server left
  // running by an earlier bridge (the bridge was restarted) is simply used.
  async function tick() {
    if (await probe()) return;
    if (child || Date.now() < pausedUntil) return;
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
      return [{ id: c.id, loaded: up, vision: false, context: up ? context : null, gpu: c.gpu || null }];
    },
    async context() {
      if (!up) await probe();
      return up ? context : Number(c.context) || null;
    },
    start() {
      tick();
      setInterval(tick, 30000).unref();
    },
  };
};
