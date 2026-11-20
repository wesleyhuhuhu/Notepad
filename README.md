# Local LLM, from anywhere

Chat with a model running in LM Studio on your PC from a website hosted on GitHub Pages, and run Claude Code sessions on any of your computers from the same site.
- **Chats and sessions live on the PC.** Every device shows the same list, and replies keep going when you close the page.
- **Projects have memory.** Every project folder gets its own `CLAUDE.md`. The model reads it on every message, can read the project's code (read-only), and can write or update the `CLAUDE.md` for you.

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
| `bridge/chats.js` | Chats stored on the PC, and replies that run in the background. |
| `bridge/hosts.js` | Computers that run Claude Code sessions for the website, and those sessions. |
| `bridge/chats/` | Your chats and sessions, one folder each (messages plus attached images). Never committed. |
| `host/claude-remote.mjs` | The program that runs Claude Code sessions on a computer (uses the Claude Agent SDK). The PC starts its own copy. |
| `cli/` | `claude-local` (Claude Code in a terminal with your model) and `claude-remote` (let the website run sessions on another computer). |
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

- **Pick a project** in the menu at the top of the site. Its chats are listed on the left; **New chat** starts another one in that project.
- **New project…** in that menu creates the folder plus a starter CLAUDE.md (Overview, Tech stack, Structure, Commands, Conventions, Notes).
- **Generate CLAUDE.md from code**: the model lists the project's files, reads the README and main source files, and writes the CLAUDE.md. Use it on existing projects, and again later to refresh it.
- On every message the model gets the global CLAUDE.md plus the selected project's. Ask it to "remember" something and it decides which file it belongs in (project facts → project file, things about you → global).
- The **CLAUDE.md** button opens an editor with a project/global switch, so you can read and edit either file yourself.
- Untick **Model can edit CLAUDE.md** under the message box to make the files read-only for a chat. `"allowModelEdits": false` turns edits off entirely; `"allowCodeReading": false` stops the model reading project code.

To keep context small, the model has a **search tool** (`search_project`) that returns only matching lines, and it can read just a range of lines from a file. It's told to search first and read only what it needs, rather than whole files.

What the model can and can't touch:
- It can **read** files inside the selected project folder only. Paths outside it (`..\`, absolute paths, symlinks out) are refused.
- It can't read `.env` files, private keys, certificates or similar secret files, and it skips folders like `.git`, `node_modules`, `bin`, `obj` and `venv`.
- The only files it can **write** are CLAUDE.md files. To change code or run commands, start a **Claude Code** session instead (see below).

**Web access in chats.** Plain chats can search the web (`web_search`, through the same Exa key as Claude Code's WebSearch) and read web pages (`web_fetch`, in parts of about 12,000 characters). The model is told today's date, so it searches for current information.
- Pages on the PC itself, your home network or your tailnet are refused, so a web page can't trick the model into reaching local services.
- `"allowWebTools": false` in `bridge/config.json` turns both off. Without an Exa key, chats can still read pages but not search.
- Measured: "what's the latest Node.js LTS?" took one search and one page read, about 48 s, and the answer was correct with sources.

## Images and video

If the model can see images (LM Studio lists it as a vision model), attach them with the paperclip button, by pasting, or by dragging files onto the chat.

- **Images** are shrunk in the browser to at most 1280 px on the longest side before sending.
- **Video** is turned into still frames, about one per second, up to 8 frames, along with a note telling the model the timestamps. The model sees images, not motion, and there's no audio. The browser has to be able to play the file: MP4 and WebM work everywhere, while iPhone HEVC videos work in Safari.
- Up to 16 images per message, counting each video frame.
- Images use context: on Qwen3.8 27B, one token per 32×32 pixels, so a 1280×800 image is about 1,000 tokens and a video frame about 350. Earlier images are sent again with every message in the same chat.
- Attached images are saved on the PC with the chat (`bridge/chats/<id>/files/`), so the model can still see them after a reload or from another device.

## Context and compaction

The context meter under the message box shows how much of the model's context the chat uses (for example `12.3k / 55.3k`). It turns orange near the compaction point and red near the limit. A `~` means it's an estimate.

Compaction works like Claude Code's:

- **Automatic:** when a chat passes 70% of the context (`compactAt` in `config.json`), the bridge has the model write a structured summary of the older messages. The summary covers goal and requests, key facts and decisions, files and code, problems and fixes, current state, next steps and progress. It replaces those messages. The newest few messages are kept word for word. Thinking is switched off for the summary so it fits in the room that's left. Very long chats are summarized in parts.
- **Manual:** the **Compact** button summarizes the whole chat now, like `/compact`, with an optional "focus on…" note.
- **What happens to the chat:** compacted messages stay visible but faded, and are no longer sent. A "Context compacted" marker shows the summary, which you can expand.
- **CLAUDE.md:** CLAUDE.md files are re-read on every message, so compaction never loses them. In a project, each compaction also writes the summary's **Progress** section into that project's CLAUDE.md, so even a brand-new chat starts from it. A backup is kept, and you can untick this in the Compact dialog.

Measured on the RTX 5070 Ti: a ~40k-token chat compacted to about 2k tokens in roughly 45 seconds, and the model still answered detailed questions about it correctly.

Compaction keeps a long chat going, but it can't help a single message that's too big. A message that fills most of the context, like a 90k-token paste into 96k, leaves almost no room. Put big documents in the project folder instead; the model searches them and reads only the parts it needs.

Settings in `config.json`: `"autoCompact": false` turns automatic compaction off; `"compactAt": 0.6` compacts earlier.

## Chats live on your PC

Chats are stored by the bridge in `bridge/chats/`, not in the browser. The website is a window onto them.
- **Same chats everywhere:** the list on the left (a ☰ drawer on phones) is the same on every device. Each chat has its own link (`…/#chat=<id>`), so a chat opened on your laptop can be continued on your phone.
- **Replies run on the PC:** closing the tab, locking the phone or losing signal doesn't stop a reply. Open the chat again and it catches up, then keeps streaming. Two devices can watch the same reply live.
- **Several chats per project:** **New chat** starts another one in the selected project. Picking a project shows its chats; open, rename or delete them from the list. Deleting moves the chat to `bridge/chats/.trash/`.
- **One reply at a time:** the model runs one reply at a time. A message sent while another chat is replying waits ("Waiting for the model…") and starts after it.
- **Status dots:** pulsing = replying, green = finished since you last looked, red = ended with an error, orange = a Claude Code session waiting for your approval. If you allow notifications, the site also tells you when a reply finishes or a session needs approval while the page is in the background.
- **Stop:** works from any device. If the bridge restarts mid-reply, that reply is marked as stopped.

## Claude Code with your local model

`cli/` has launchers that start [Claude Code](https://claude.com/claude-code) using the model on your PC instead of Anthropic's servers. They work on the PC itself or on any other computer, through the public bridge address. Your normal `claude` command is unchanged; the launcher sets everything only for the session it starts.

**Install on Windows.** Copy both files next to `claude.exe`, which is already on your PATH:
```powershell
Copy-Item cli\claude-local.ps1, cli\claude-local.cmd "$env:USERPROFILE\.local\bin\"
```

**Install on macOS or Linux:**
```bash
mkdir -p ~/bin && curl -fsSL https://raw.githubusercontent.com/wesleyhuhuhu/Notepad/main/cli/claude-local.sh -o ~/bin/claude-local && chmod +x ~/bin/claude-local
```
If `~/bin` isn't on your PATH, add `export PATH="$HOME/bin:$PATH"` to `~/.zshrc`.

**Use:** run `claude-local` in a project folder. The first run asks for:
- **the bridge address:** `http://127.0.0.1:8787` on the PC itself, or your `https://…ts.net` address anywhere else;
- **the access token.**

Both are saved (Windows: `%APPDATA%\claude-local\config.json`, macOS/Linux: `~/.config/claude-local/config`, readable only by you). Any normal `claude` options pass straight through, e.g. `claude-local -p "fix the failing test"` or `claude-local --continue`.

| Option | What it does |
|---|---|
| `--all-tools` | Every Claude Code tool. By default only Read, Edit, Write, Bash, Grep, Glob, WebFetch and WebSearch are sent, which keeps the setup at ~5.3k tokens instead of ~16.5k. |
| `--max-output N` | Longest reply, thinking included (default 8192). Lower leaves more room before compaction; higher allows longer thinking. |
| `--context N` | Tell Claude Code a smaller context than the loaded model's. |
| `--setup` | Change the saved address or token. |

**How it works:**
- **The bridge's endpoint:** the bridge exposes Anthropic's API format at `/v1/messages`, protected by the access token, and forwards it to LM Studio. Claude Code puts some system messages in the middle of the conversation, and Qwen's chat template rejects those ("System message must be at the beginning"), so the bridge folds them into the neighbouring user message.
- **Settings the launcher passes:** it asks the bridge which model is loaded and its context size, then starts Claude Code with:
  - `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` pointing at the bridge;
  - every model setting set to that model;
  - **`CLAUDE_CODE_MAX_CONTEXT_TOKENS`** set to the model's real context, which is what makes Claude Code auto-compact before it overflows. (The `--autocompact` flag and `CLAUDE_CODE_AUTO_COMPACT_WINDOW` only accept 100k–1M.)
  - `CLAUDE_CODE_MAX_OUTPUT_TOKENS` set to 8192.

**Web access.**
- **WebFetch** reads a page at an address (it asks before each new site). Bash can also use `curl`, `git clone` and `gh`.
- **WebSearch** normally runs on Anthropic's servers: Claude Code sends a small request carrying Anthropic's `web_search` server tool, which LM Studio can't run. The bridge answers those requests itself with [Exa](https://exa.ai), in the same format, so the model gets titles, addresses and excerpts from each page, then reads the useful ones with WebFetch.
- **Setup:** create an Exa account, copy an API key, put it in `bridge/config.json` as `"exaApiKey": "…"` and restart the bridge. The key stays on the PC: other computers running `claude-local` search through the bridge and need nothing extra. Without a key, searches fail at once with a message saying what to add.
- **Cost:** Exa's free balance is $10 a month. With the defaults (`"webSearchType": "auto"`, 8 results, 1,500-character excerpts) a search costs about $0.007, so roughly 1,400 searches a month; `"lite"` costs about $0.004. The bridge window logs each search with its cost.
- **Other services:** `"webSearchProvider"` picks the service. `exa` is the only one so far; others can be added to `searchProviders` in `bridge/server.js`.

**Room to work.** Claude Code keeps room for one full reply plus about 13k before it compacts, so it compacts at about the context minus 21k with the launcher's 8,192 reply cap. With the current 96k context that's about **75k**. Measured earlier with a 55.3k context:

| Reply cap | Free for work | Compacts at about |
|---|---|---|
| 32,000 (Claude Code's default) | 17.3k | 22k |
| **8,192 (launcher default)** | **29.2k** | **34k** |
| 4,096 | 33.3k | 38k, but long thinking may get cut off |

**Tested:**
- **Windows:** Claude Code found and fixed two bugs in a small Python project and ran its tests, in 29 seconds.
- **macOS script:** run through the public address from another shell, it answered a question about the code.

**Limits:**
- **Smaller context:** Claude Code needs about 32k or more to be useful, and the launcher warns below that.
- **Reliability:** Claude Code is built for Claude, so expect the local model to be less reliable on long, multi-step tasks.
- **Harmless messages:** Claude Code may print `unrecognized_model` and a note about auto-mode billing because requests go through a gateway. Both can be ignored.

**Security:** commands and file edits happen on the computer where you run `claude-local`, with Claude Code's usual permission prompts. The bridge only lends that computer the model. Anyone with your token can use the model through `/v1/messages`, but can't run anything on your PC.

## Claude Code from the website

The **Claude Code** button starts a Claude Code session on one of your computers. Your local model does the work, and you watch and steer it from the website, on any device. It's like Claude Code's own Remote Control, which only works with Anthropic's servers.

- **How it runs:** a small program, `claude-remote`, runs Claude Code on that computer through the Claude Agent SDK. It connects **out** to your PC's bridge (through the Funnel address), so nothing needs to be opened on that computer. The PC starts its own copy with the bridge, for the folders in `Documents\Projects`.
- **Projects:** on the PC, a session in a project folder belongs to that project.
  - It's listed with the project's chats, tagged **Claude Code**.
  - The header shows its folder instead of the project menu, and the **CLAUDE.md** button opens that project's file.
  - Claude Code reads the project's CLAUDE.md and the global one. If the project has none, a starter CLAUDE.md is created when the session starts, for Claude Code to fill in when you ask.
  - In the dialog, the selected project's folder is picked for you, and **+ New project…** creates one (folder plus starter CLAUDE.md).
  - Sessions in other folders, or on other computers, are listed under **Claude Code sessions**.
- **Approvals:** every command and file change shows up as a card: **Allow**, **Allow for this session** or **Deny**. "Allow file changes; ask before commands" skips the cards for edits.
- **Keeps working:** the session continues while the page is closed. The chat list shows an orange dot while it waits for you.
- **Stop and resume:** **Stop** interrupts it. If that computer or the bridge restarts, the next message resumes the same session with its memory.
- **Tools:** sessions get Read, Edit, Write, Bash, Grep, Glob, WebFetch and WebSearch, with the same model settings as `claude-local`.

**Set up the PC** (once): `npm install --omit=optional` in the `host` folder, then restart the bridge. New project folders show up in the Claude Code dialog within a few seconds. The bridge window shows `Claude Code host "<name>" connected`. To turn it off, set `"codeHost": false` in `bridge/config.json`; `"codeHostName"` changes the name shown.

**Add another computer.** It needs [Node.js](https://nodejs.org) 18.14+, Claude Code, and `claude-local` set up once (that saves the bridge address and token). Then run `claude-remote` in the folder you want to allow:
- **Windows:** copy `cli\claude-remote.ps1` and `cli\claude-remote.cmd` next to `claude-local` (e.g. `%USERPROFILE%\.local\bin`).
- **macOS / Linux:**
  ```bash
  curl -fsSL https://raw.githubusercontent.com/wesleyhuhuhu/Notepad/main/cli/claude-remote.sh -o ~/bin/claude-remote && chmod +x ~/bin/claude-remote
  ```

The first run downloads `claude-remote.mjs` and installs the SDK (skipping the SDK's own copy of Claude Code: your installed `claude` is used). It stays running until you close it.

| Option | What it does |
|---|---|
| `--root <folder>` | A folder sessions may work in (repeat for more). Default: the current folder. The website offers each root and the folders directly inside it (not cache or build folders like `__pycache__` or `node_modules`), and the list updates within seconds when you add a folder. Anything else is refused. |
| `--name <name>` | How the computer appears on the website. Default: its computer name. |
| `--update` | Download the latest `claude-remote` first. |
| `--bridge <url>`, `--token <token>` | Use these instead of claude-local's saved ones. |

Measured with the PC's own host: a "create a file and run it" task took about 45 s including two approvals.

## Model loading

By default (`"contextLength": 0`) the bridge leaves loading to LM Studio, which uses the model's saved settings in **My Models**: context length, GPU offload, Flash Attention and KV cache quantization. If the model isn't loaded, LM Studio loads it on the first message with those settings.

Set the context length there to something that fits. Measured on the RTX 5070 Ti with the current model (`qwen3.8-27b-heretic-gsq-rco`) and its saved cache setting of q8_0 keys / q4_0 values:

| Context | GPU memory used in total | Generation speed |
|---|---|---|
| 64k (64,000) | 14.7 GB | ~53.5 tokens/s |
| 90k (90,000) | 15.4 GB | ~54 tokens/s, even with a browser and other apps open |
| **96k (96,000, the saved default)** | 15.4 GB | ~54.5 tokens/s with GPU-heavy apps closed; 31 with Firefox open |
| 98k (98,304) | 15.5 GB | ~34 tokens/s |
| 100k (100,000) | 15.6 GB | ~16 tokens/s, even with everything else closed |
| 112k and up | | fails to load |

Measured on 2026-11-20 with only ~0.6 GB in use before loading. An earlier measurement with less in use ran 100k–104k at ~49 tokens/s, so the limit moves with whatever else is using the card.

For comparison, the previous model (`…@iq3_m`, q8_0 cache) slowed from ~45 to ~4 tokens/s above 55k because part of it ended up in system RAM.

**96k leaves almost no spare GPU memory.** Everything else on screen shares the card's 16 GB: Windows itself, both monitors, and every open app that draws with the GPU, such as Firefox, Edge, the Claude app and LM Studio's window. When those take a few hundred MB more, part of the model moves into system RAM and speed falls from ~54 to anywhere between 1 and 30 tokens/s. Claude Code then times out and resends its requests, so a task that should take a minute takes half an hour.

**If it's slow:** close GPU-heavy apps, or turn off hardware acceleration in the browser, then reload the model:
```
lms unload --all
lms load qwen3.8-27b-heretic-gsq-rco -y
```
If you'd rather keep apps open, set the context to 90k in LM Studio's **My Models**.

**Saved settings file:** LM Studio keeps each model's settings in `%USERPROFILE%\.lmstudio\.internal\user-concrete-model-default-config\…\<file>.gguf.json`. If you edit it by hand, save it without a BOM. Windows PowerShell's `Set-Content -Encoding utf8` adds one, and LM Studio then silently ignores the file.

The limit moves with whatever else is using the GPU. If replies suddenly crawl, something else is taking GPU memory.

While gaming, start with `.\start.ps1 -ContextLength 16384`. The bridge then treats 16,384 as a cap: on the next message, if the model is loaded with a bigger context (or not loaded), it reloads it at 16,384. You can also set a permanent cap with `"contextLength"` in `config.json`. The chat shows "Loading the model…" while that happens, which takes about 20 seconds. Set `"contextLength": 0` to leave loading to LM Studio.

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

Options: `-Model <id>` picks a model, `-ContextLength <tokens>` caps the context for this run (the bridge follows it), `-NoFunnel` keeps it local-only.

To stop public access entirely: `tailscale funnel --https=443 off`.

## Model and performance notes

- **Current model:** `qwen3.8-27b-heretic-gsq-rco`, the same uncensored RVN model as before but compressed with the GSQ-RCO method. It's 11.8 GB plus the 0.63 GB vision file (12.42 GB in all, 0.79 GB less than the old IQ3_M). Its publisher measured it within 0.95% of full weights (wikitext-2 perplexity), against +2.9% for a standard IQ3_S. It's from [0bserverx/Qwen3.8-27B-Heretic-GSQ-RCO-GGUF](https://huggingface.co/0bserverx/Qwen3.8-27B-Heretic-GSQ-RCO-GGUF); the vision file is linked from the original RVN folder.
- **Speed and context:** with keys at q8_0 and values at q4_0, it runs at ~54 tokens/s with a 96k context. It thinks before answering; open **Reasoning** to see it.
- **Long-context check:** with an 87.6k-token document, it found three facts hidden at 10%, 50% and 90% depth. Reading the document took ~87 s before the first word, and replies ran at ~26 tokens/s while the context was that full.
- **Old files:** the previous `@iq3_m` and `@iq4_xs` files are still in LM Studio. The IQ4_XS won't fit on the GPU with any useful context.
- **CLAUDE.md generation:** takes about a minute for a small project. The model reads the key files, not a whole large codebase.

## Security

- Anyone with the bridge URL **and** the token can use your model, read your chats, read the code in your project folders (through the model), create project folders, and edit CLAUDE.md files.
- With Claude Code sessions they could also **ask for commands to run** on your connected computers. Those still need an approval click on the website, but the token is what protects the website. Use a long random token and keep it private. To change it, delete `accessToken` from `bridge/config.json` and restart; a new one is generated. Then enter it again on each device and run `claude-local --setup` on other computers.
- Sessions only work inside the folders each computer allows (`--root`), and `claude-remote` checks the folder again before starting.
- The bridge only listens on `127.0.0.1`; the internet reaches it only through Funnel.
- After 10 wrong tokens from one address, that address is locked out for 15 minutes.
- The token is saved in your browser's local storage for the site. Use **Settings** to clear it on shared computers.
