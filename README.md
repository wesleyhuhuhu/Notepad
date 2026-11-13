# Local LLM, from anywhere

Chat with a model running in LM Studio on your PC from a website hosted on GitHub Pages. The model reads `CLAUDE.md` on every message and can update it when you ask it to remember something.

```
Phone / laptop browser
   │  https://<you>.github.io/<repo>/      (static page, GitHub Pages)
   │
   ▼  https://<pc-name>.<tailnet>.ts.net   (Tailscale Funnel, public HTTPS)
bridge/server.js  on your PC, port 8787    (token check, CORS, CLAUDE.md tools)
   │
   ▼  http://127.0.0.1:1234                (LM Studio local server)
LM Studio  ──  your model on the GPU
```

GitHub Pages only serves static files, so the page can't run the model itself. It sends your messages to the **bridge** on your PC, which Tailscale Funnel makes reachable over the internet. Your PC has to be on with the bridge running.

## What's in here

| Path | What it does |
|---|---|
| `docs/index.html` | The website. GitHub Pages serves this folder. |
| `bridge/server.js` | Local server: checks the access token, streams chat from LM Studio, runs the CLAUDE.md tools. No npm install needed (Node 18+). |
| `bridge/config.json` | Your settings and **secret access token**. Created on first run; never committed. |
| `bridge/backups/` | A copy of `CLAUDE.md` is saved here before every change (last 50 kept). |
| `CLAUDE.md` | The memory / instructions file. Not committed (it stays on your PC). |
| `start.ps1` | Starts LM Studio's server, loads the model, turns on Funnel, runs the bridge. |

## How CLAUDE.md works

- Every message, the bridge reads `CLAUDE.md` and puts it in the system prompt.
- The model has four tools: `read_claude_md`, `append_to_claude_md`, `replace_in_claude_md`, `write_claude_md`. It's told to use them only when you ask it to remember or change something.
- The website's **CLAUDE.md** button opens an editor so you can read and edit it yourself.
- Untick **Model can edit CLAUDE.md** under the message box to make it read-only for a chat, or set `"allowModelEdits": false` in `bridge/config.json` to turn edits off entirely.
- To use a different file (for example Claude Code's global one), set `"claudeMdPath": "~/.claude/CLAUDE.md"` in `bridge/config.json`.

## One-time setup

### 1. Turn on Tailscale Funnel
Tailscale is already installed and signed in on this PC. Funnel has to be allowed once for your tailnet:

```powershell
tailscale funnel 8787
```

If it prints a link saying Funnel isn't enabled, open it, approve, then press Ctrl+C. (`start.ps1` runs Funnel in the background from then on.)

### 2. Put the site on GitHub Pages
1. Create a new repository on github.com (for example `local-llm`). Free accounts need it to be **public**; that's fine, because the token, config and `CLAUDE.md` are in `.gitignore` and never uploaded.
2. Push this folder:
   ```powershell
   git init
   git add .
   git commit -m "Local LLM web chat"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<repo>.git
   git push -u origin main
   ```
3. On GitHub: **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `/docs` → Save**. After a minute the site is at `https://<your-username>.github.io/<repo>/`.
4. Optional: put that address in `"siteUrl"` in `bridge/config.json`, and `start.ps1` will print a one-click setup link.

### 3. Lock CORS to your site (recommended)
In `bridge/config.json`, change `"allowedOrigins": ["*"]` to `["https://<your-username>.github.io"]`.

## Every day

```powershell
.\start.ps1
```

It prints your **public bridge URL** and **access token**. Open the GitHub Pages site, click **Settings**, paste both, and **Test connection**. The browser remembers them. (If `siteUrl` is set, just open the printed one-click link instead.)

Options: `-Model <id>` picks a model, `-ContextLength 16384` sets context, `-NoFunnel` keeps it local-only.

To stop public access entirely: `tailscale funnel --https=443 off`.

## Model and performance notes

- On the RTX 5070 Ti (16 GB), `qwen3.8-27b-…@iq3_m` with a 16k context fits on the GPU and answers in roughly 10–25 seconds (it thinks first; open **Reasoning** to see it).
- The `@iq4_xs` file (15.8 GB) won't fit on the GPU with context, so it spills into system RAM and gets very slow.
- If LM Studio loads a model on its own (just-in-time loading), it may pick a huge context that overflows VRAM and makes replies crawl. Load with `start.ps1` (or `lms load <model> -c 16384`) to avoid that.

## Security

- Anyone with the bridge URL **and** the token can use your model and edit `CLAUDE.md`. Keep the token private. To change it, delete `accessToken` from `bridge/config.json` and restart; a new one is generated.
- The bridge only listens on `127.0.0.1`; the internet reaches it only through Funnel.
- After 10 wrong tokens from one address, that address is locked out for 15 minutes.
- The token is saved in your browser's local storage for the site. Use **Settings** to clear it on shared computers.
