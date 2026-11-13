# Local LLM, from anywhere

Chat with a model running in LM Studio on your PC from a website hosted on GitHub Pages. Every project folder gets its own `CLAUDE.md`. The model reads it on every message, can read the project's code (read-only), and can write or update the `CLAUDE.md` for you.

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
| `bridge/server.js` | Local server: checks the access token, streams chat from LM Studio, manages projects and their CLAUDE.md files, keeps the model loaded with a context that fits your GPU. No npm install needed (Node 18+). |
| `bridge/config.json` | Your settings and **secret access token**. Created on first run; never committed. |
| `bridge/backups/` | A copy of each CLAUDE.md is saved here before every change (last 50 per file). |
| `start.ps1` | Starts LM Studio's server, loads the model, turns on Funnel, runs the bridge. |

## Projects and CLAUDE.md

Projects are the folders inside `projectsRoot` (set to `Documents\Projects`). Each one's memory file is `<project folder>\CLAUDE.md`.

```
Documents\Projects\
  CLAUDE.md               ← global: applies to every chat (who you are, how you like answers)
  Car Scraper\
    CLAUDE.md             ← this project only: what it is, stack, structure, commands, notes
  Music Player\
    CLAUDE.md
```

- **Pick a project** in the menu at the top of the site. Each project keeps its own chat history in your browser.
- **New project…** in that menu creates the folder plus a starter CLAUDE.md (Overview, Tech stack, Structure, Commands, Conventions, Notes).
- **Generate CLAUDE.md from code**: the model lists the project's files, reads the README and main source files, and writes the CLAUDE.md. Use it on existing projects, and again later to refresh it.
- On every message the model gets the global CLAUDE.md plus the selected project's. Ask it to "remember" something and it decides which file it belongs in (project facts → project file, things about you → global).
- The **CLAUDE.md** button opens an editor with a project/global switch, so you can read and edit either file yourself.
- Untick **Model can edit CLAUDE.md** under the message box to make the files read-only for a chat. `"allowModelEdits": false` turns edits off entirely; `"allowCodeReading": false` stops the model reading project code.

What the model can and can't touch:
- It can **read** files inside the selected project folder only. Paths outside it (`..\`, absolute paths, symlinks out) are refused.
- It can't read `.env` files, private keys, certificates or similar secret files, and it skips folders like `.git`, `node_modules`, `bin`, `obj` and `venv`.
- The only files it can **write** are CLAUDE.md files.

## Model loading

LM Studio sometimes unloads the model when idle and then reloads it on demand with a very large context (60k on this PC). That overflows the GPU's 16 GB and slows replies to several seconds per word. To prevent that, the bridge checks before every chat. If the model isn't loaded, or is loaded with more than `contextLength` (16,384) tokens, it unloads and reloads it with that context, fully on the GPU. The chat shows "Loading the model…" while that happens, which takes about 20 seconds. Set `"contextLength": 0` to leave loading to LM Studio.

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
- Generating a CLAUDE.md for a small project takes about a minute. The 16k context means the model reads a handful of key files, not a whole large codebase.

## Security

- Anyone with the bridge URL **and** the token can use your model, read the code in your project folders (through the model), create project folders, and edit CLAUDE.md files. Keep the token private. To change it, delete `accessToken` from `bridge/config.json` and restart; a new one is generated.
- The bridge only listens on `127.0.0.1`; the internet reaches it only through Funnel.
- After 10 wrong tokens from one address, that address is locked out for 15 minutes.
- The token is saved in your browser's local storage for the site. Use **Settings** to clear it on shared computers.
