'use strict';
// Shrinks big images in model requests before they reach LM Studio.
//
// Encoding an image takes extra GPU memory on top of the model and its context: measured on the
// 27B at a 92k context, a 1577x916 screenshot needed ~340 MiB more and a 2560x1440 one needed a
// 422 MiB buffer that didn't fit (LM Studio's engine fails or crashes, and every retry re-reads
// the same image). The website already shrinks images to 1280 px, but Claude Code and Note send
// screenshots and image files at full size. So the bridge caps every image's longest side at
// MAX_SIDE. Shrunk images are cached, since each turn sends the whole conversation again.
//
// It uses Windows' own image library (System.Drawing, through PowerShell), so nothing extra
// has to be installed. On other systems, and for formats it can't read (e.g. WebP), images pass
// through unchanged.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const MAX_SIDE = 1600;
const CACHE_MAX = 300;
const cache = new Map(); // sha1 of the original -> Promise<{ mime, data } | null>

// Width and height from the file header (PNG, JPEG, GIF), or null.
function sizeOf(b) {
  try {
    if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    if (b.length > 10 && b.toString('ascii', 0, 3) === 'GIF') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const marker = b[i + 1];
        const len = b.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
        i += 2 + len;
      }
    }
  } catch {}
  return null;
}

const SCRIPT = `param($in, $out, $max, $fmt)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile($in)
try {
  $s = [Math]::Min(1.0, [double]$max / [Math]::Max($src.Width, $src.Height))
  $w = [Math]::Max(1, [int][Math]::Round($src.Width * $s)); $h = [Math]::Max(1, [int][Math]::Round($src.Height * $s))
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = 'HighQualityBicubic'; $g.SmoothingMode = 'HighQuality'; $g.PixelOffsetMode = 'HighQuality'
  if ($fmt -ne 'png') { $g.Clear([System.Drawing.Color]::White) }
  $g.DrawImage($src, 0, 0, $w, $h)
  if ($fmt -eq 'png') { $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png) }
  else {
    $enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
    $p = New-Object System.Drawing.Imaging.EncoderParameters 1
    $p.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 90L
    $bmp.Save($out, $enc, $p)
  }
  $g.Dispose(); $bmp.Dispose()
} finally { $src.Dispose() }
`;
let scriptFile = null;

function resize(buf, fmt) {
  if (!scriptFile) {
    scriptFile = path.join(os.tmpdir(), 'local-llm-shrink-image.ps1');
    fs.writeFileSync(scriptFile, SCRIPT);
  }
  const id = crypto.randomBytes(6).toString('hex');
  const inFile = path.join(os.tmpdir(), `local-llm-img-${id}.in`);
  const outFile = path.join(os.tmpdir(), `local-llm-img-${id}.${fmt}`);
  fs.writeFileSync(inFile, buf);
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile, inFile, outFile, String(MAX_SIDE), fmt],
      { windowsHide: true, timeout: 60000 },
      (err) => {
        let out = null;
        try {
          if (!err) out = fs.readFileSync(outFile);
        } catch {}
        fs.rm(inFile, { force: true }, () => {});
        fs.rm(outFile, { force: true }, () => {});
        resolve(out);
      }
    );
  });
}

// { mime, data } of the shrunk image, or null to keep the original.
function shrinkOne(mime, data) {
  if (process.platform !== 'win32' || typeof data !== 'string' || data.length < 1000) return Promise.resolve(null);
  const key = crypto.createHash('sha1').update(data).digest('hex');
  if (cache.has(key)) return cache.get(key);
  const job = (async () => {
    const buf = Buffer.from(data, 'base64');
    const size = sizeOf(buf);
    if (!size || Math.max(size.w, size.h) <= MAX_SIDE) return null;
    const fmt = /png|gif/i.test(mime) ? 'png' : 'jpeg';
    const out = await resize(buf, fmt);
    return out ? { mime: fmt === 'png' ? 'image/png' : 'image/jpeg', data: out.toString('base64'), from: size } : null;
  })().catch(() => null);
  cache.set(key, job);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return job;
}

// Walks a request's messages (Claude format: { type: 'image', source: { type: 'base64' } },
// also inside tool results; OpenAI format: { type: 'image_url', image_url: { url: 'data:…' } })
// and shrinks big images in place. Returns how many were shrunk.
async function shrinkImages(messages) {
  const jobs = [];
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 8) return;
    if (Array.isArray(node)) return node.forEach((x) => walk(x, depth + 1));
    if (node.type === 'image' && node.source && node.source.type === 'base64') {
      const src = node.source;
      jobs.push(shrinkOne(src.media_type, src.data).then((r) => { if (r) { src.media_type = r.mime; src.data = r.data; return 1; } return 0; }));
      return;
    }
    if (node.type === 'image_url' && node.image_url && typeof node.image_url.url === 'string') {
      const m = /^data:([^;,]+);base64,(.*)$/s.exec(node.image_url.url);
      if (m) jobs.push(shrinkOne(m[1], m[2]).then((r) => { if (r) { node.image_url.url = `data:${r.mime};base64,${r.data}`; return 1; } return 0; }));
      return;
    }
    for (const k of ['content', 'source']) if (node[k] && typeof node[k] === 'object') walk(node[k], depth + 1);
  };
  walk(messages, 0);
  return (await Promise.all(jobs)).reduce((a, b) => a + b, 0);
}

module.exports = { shrinkImages, MAX_SIDE };
