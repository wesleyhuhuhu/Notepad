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
| `install-autostart.ps1`, `autostart.ps1`, `stop-bridge.ps1` | Start all of that automatically at login (a Windows task), and stop it. |

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

- **Automatic:** when a chat passes 80% of the context (`compactAt` in `config.json`), the bridge has the model write a structured summary of the older messages. The summary covers goal and requests, key facts and decisions, files and code, problems and fixes, current state, next steps and progress. It replaces those messages. The newest few messages are kept word for word. Thinking is switched off for the summary so it fits in the room that's left. Very long chats are summarized in parts.
- **Manual:** the **Compact** button summarizes the whole chat now, like `/compact`, with an optional "focus on…" note.
- **What happens to the chat:** compacted messages stay visible but faded, and are no longer sent. A "Context compacted" marker shows the summary, which you can expand.
- **CLAUDE.md:** CLAUDE.md files are re-read on every message, so compaction never loses them. In a project, each compaction also writes the summary's **Progress** section into that project's CLAUDE.md, so even a brand-new chat starts from it. A backup is kept, and you can untick this in the Compact dialog.

Measured on the RTX 5070 Ti: a ~40k-token chat compacted to about 2k tokens in roughly 45 seconds, and the model still answered detailed questions about it correctly.

Compaction keeps a long chat going, but it can't help a single message that's too big. A message that fills most of the context, like a 90k-token paste into 96k, leaves almost no room. Put big documents in the project folder instead; the model searches them and reads only the parts it needs.

Settings in `config.json`: `"autoCompact": false` turns automatic compaction off; `"compactAt": 0.7` compacts earlier.

## Chats live on your PC

Chats are stored by the bridge in `bridge/chats/`, not in the browser. The website is a window onto them.
- **Same chats everywhere:** the list on the left (on phones, a drawer: tap ☰ or swipe right; swipe left to close it) is the same on every device. Each chat has its own link (`…/#chat=<id>`), so a chat opened on your laptop can be continued on your phone.
- **Replies run on the PC:** closing the tab, locking the phone or losing signal doesn't stop a reply. Open the chat again and it catches up, then keeps streaming. Two devices can watch the same reply live.
- **Several chats per project:** **New chat** starts another one in the selected project. Picking a project shows its chats; open, rename or delete them from the list. Deleting moves the chat to `bridge/chats/.trash/`.
- **One reply at a time:** the model runs one reply at a time. A message sent while another chat is replying waits ("Waiting for the model…") and starts after it.
- **Status dots:** pulsing = replying, green = finished since you last looked, red = ended with an error, orange = a Claude Code session waiting for your approval. If you allow notifications, the site also tells you when a reply finishes or a session needs approval while the page is in the background.
- **Stop:** works from any device. If the bridge restarts mid-reply, that reply is marked as stopped.
- **Generation status:** while a reply or Claude Code session works, a line under it shows what the model is doing, like LM Studio: *Reading the prompt (~12k tokens) · 4 s*, then *Thinking · 512 tokens · 54 tok/s*, then *Writing*. A finished reply shows its stats: tokens (and how many were thinking), tokens per second, time to first token and prompt size. A low tokens/s (below ~40) usually means the model has spilled out of GPU memory (see Model loading).

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
| `--max-output N` | Longest reply, thinking included (default 16384). Lower leaves more room before compaction; higher allows longer thinking. |
| `--context N` | Tell Claude Code a smaller context than the loaded model's. |
| `--reserve N` | Tokens kept free before Claude Code auto-compacts, beyond room for one full reply (default 3000). Lower compacts later. But if a turn overflows the real context, LM Studio silently cuts the middle of the conversation, so don't go much lower. |
| `--setup` | Change the saved address or token. |

**How it works:**
- **The bridge's endpoint:** the bridge exposes Anthropic's API format at `/v1/messages`, protected by the access token, and forwards it to LM Studio. Claude Code puts some system messages in the middle of the conversation, and Qwen's chat template rejects those ("System message must be at the beginning"), so the bridge folds them into the neighbouring user message.
- **Settings the launcher passes:** it asks the bridge which model is loaded and its context size, then starts Claude Code with:
  - `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` pointing at the bridge;
  - every model setting set to that model;
  - **`CLAUDE_CODE_MAX_CONTEXT_TOKENS`** set to the model's real context, which is what makes Claude Code auto-compact before it overflows. (The `--autocompact` flag and `CLAUDE_CODE_AUTO_COMPACT_WINDOW` only accept 100k–1M.)
  - `CLAUDE_CODE_MAX_OUTPUT_TOKENS` set to 16384.

**Web access.**
- **WebFetch** reads a page at an address (it asks before each new site). Bash can also use `curl`, `git clone` and `gh`.
- **WebSearch** normally runs on Anthropic's servers: Claude Code sends a small request carrying Anthropic's `web_search` server tool, which LM Studio can't run. The bridge answers those requests itself with [Exa](https://exa.ai), in the same format, so the model gets titles, addresses and excerpts from each page, then reads the useful ones with WebFetch.
- **Setup:** create an Exa account, copy an API key, put it in `bridge/config.json` as `"exaApiKey": "…"` and restart the bridge. The key stays on the PC: other computers running `claude-local` search through the bridge and need nothing extra. Without a key, searches fail at once with a message saying what to add.
- **Cost:** Exa's free balance is $10 a month. With the defaults (`"webSearchType": "auto"`, 8 results, 1,500-character excerpts) a search costs about $0.007, so roughly 1,400 searches a month; `"lite"` costs about $0.004. The bridge window logs each search with its cost.
- **Other services:** `"webSearchProvider"` picks the service. `exa` is the only one so far; others can be added to `searchProviders` in `bridge/server.js`.

**Room to work.** Claude Code compacts once the next request would pass its declared context minus its reply cap (16,384) minus ~13k of its own margin. The launchers and website sessions declare the real context plus 10k, which leaves a ~3k reserve. With the current 88k context, sessions compact at about **68.7k**: the size of the next request, conversation plus new tool results. The website's meter shows only the last call's prompt, so it reads a few thousand lower.
- Worst case: 68.7k sent + a full 16,384-token reply = ~85k, inside the real 88,064. Until 2026-11-27 the reserve was 7k, which compacted at ~64.7k (the meter showed ~60k).
- Later than this isn't safe without a smaller reply cap. A turn that overflows doesn't fail: LM Studio silently cuts the middle of the conversation ("truncateMiddle"). Replies in a real session reached 11.9k tokens.

**Token counts from LM Studio are corrected.** LM Studio reports the whole prompt as `input_tokens` and repeats the part it reused from its cache as `cache_read_input_tokens`. Claude Code adds them up, so before 2026-11-26 it saw sessions at nearly twice their size: 74,305 "used" for a 40,226-token prompt. It compacted at about half the real limit, and right after each compaction the next call looked full again, so it compacted every few calls (14 times in one session). The bridge now subtracts the reused part before passing the numbers on (`fixAnthropicUsage` in `bridge/server.js`). Checked: the same 6,524-token prompt sent again now reports 256 + 6,268 cached = 6,524, where it used to report 12,792. The website's context meter, which used the same numbers, is right too.

The reply cap covers thinking too. At 8,192 a long think, for example while weighing several pages of web search results, could hit it ("API Error: Claude's response exceeded the 8192 output token maximum"), so the default is now 16,384. Measured earlier with a 55.3k context:

| Reply cap | Free for work | Compacts at about |
|---|---|---|
| 32,000 (Claude Code's default) | 17.3k | 22k |
| **16,384 (launcher default)** | about 21k | about 26k |
| 8,192 | 29.2k | 34k, but long thinking can hit the cap |
| 4,096 | 33.3k | 38k, but long thinking may get cut off |

**Thinking amount.** Through LM Studio this model only reliably supports thinking on or off. `reasoning_effort` (low/medium/high) and Claude-style thinking budgets made no consistent difference in tests. Turning thinking off is faster but got a simple arithmetic question wrong, so it's left on.

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
- **Approvals:** each session has one of three modes, picked when you start it:
  - **Ask before every file change and command** (default): each one shows a card with **Allow**, **Allow for this session** or **Deny**.
  - **Allow file changes; ask before commands.**
  - **Allow file changes and commands (no approvals):** it works on its own. Use it in folders you don't mind it changing.
  - In every mode, web searches and page reads never ask, reading files never asks, and anything outside the session's folder still asks.
- **Attachments:** the paperclip (or paste or drag) takes images, videos and any other file, up to 10 MB each and 25 MB per message. Images and video frames go to the model directly. Other files are saved in the session's folder under `uploads/` (never overwriting) and Claude Code is told where they are.
- **Context meter:** shows how much of the context the session's last model call used. Claude Code compacts the session by itself about 19k tokens before the end: its 16,384-token reply cap plus a ~3k reserve (~68.7k at an 88k context). The reserve is set by telling Claude Code the window is a little larger than the model's real context (`CLAUDE_REMOTE_RESERVE_TOKENS`, default 3000). Lowering the reserve compacts later, but risks a turn overflowing the real context, which LM Studio handles by silently cutting the middle of the conversation.
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

**Current setting: 88k (88,000), the MTP model with the 5070 Ti doing nothing but the LLM.** Text alone fits at 96k, but reading an image needs extra GPU memory. At 96k there was only ~300 MB to spare, and even a 360×360 screenshot crashed LM Studio's engine ("CUDA error: out of memory"). The crash repeated on every retry, because each turn re-reads every image in the conversation. Measured on 2026-11-26 (ceiling ~15.7 GB used):

| Context | After loading | Results with images |
|---|---|---|
| 96k | 15,444 MiB | a 360×360 image crashes it |
| 94k | 15,390 MiB | 360×360 works; 1577×916 crashes it |
| 92k | 15,328 MiB | 1577×916 works; 2560×1440 fails (its encoder needs a 422 MiB buffer) |
| 90k | 15,270 MiB | images up to 1600 px work, peaking at 15,608 MiB |
| **88k** | 15,208 MiB | images up to 1600 px work, peaking at 15,546 MiB; also at the end of an 87k-token prompt, and with 3 images in one message |

**Sampling (saved in the same LM Studio settings file, under `operation`):** Qwen's values for thinking are temperature 0.6, top-k 20, top-p 0.95, min-p 0 and repeat penalty off, plus a **presence penalty of 1.5** (`llm.prediction.llama.presencePenalty`, added 2026-11-27). The penalty makes words already used less likely, which stops long thinking from looping on the same list. A Claude Code turn did exactly that, repeating the same list of names for thousands of tokens. Claude Code sends no sampling settings, so these saved ones apply. LM Studio ignores a `presence_penalty` sent in a Claude-format request, though it honors one in OpenAI format.
- Checked with "write *apple* 60 times" at temperature 0: 61 → 56 with the saved penalty (at 2.0), so it applies to Claude-format requests.
- At 1.5 the 27B still passed the same 8 of 9 checks, and wrote working code with thinking on.

The bridge shrinks bigger images to 1600 px on the long side before they reach the model (`bridge/images.js`, using Windows' own image library). The website already sends them at 1280 px or less. So 88k is safe for screenshots of any size, with ~150 MiB to spare.

Older measurements, from before the 6800 XT took over the display, with the earlier model (`qwen3.8-27b-heretic-gsq-rco`) and a q8_0 key / q4_0 value cache:

| Context | GPU memory used in total | Generation speed |
|---|---|---|
| 64k (64,000) | 14.7 GB | ~53.5 tokens/s |
| 90k (90,000) | 15.4 GB | ~54 tokens/s, even with a browser and other apps open. Load it like this when 96k is slow: `lms load qwen3.8-27b-heretic-gsq-rco -y --context-length 90000` |
| 92k (92,000) | 15.5 GB | ~34 tokens/s with the Claude app and a browser open; full speed with fewer apps open |
| **96k (96,000, the saved default)** | 15.4 GB | ~54.5 tokens/s with GPU-heavy apps closed; 18–31 with apps open |
| 98k (98,304) | 15.5 GB | ~34 tokens/s |
| 100k (100,000) | 15.6 GB | ~16 tokens/s, even with everything else closed |
| 112k and up | | fails to load |

Measured on 2026-11-20 with only ~0.6 GB in use before loading. An earlier measurement with less in use ran 100k–104k at ~49 tokens/s, so the limit moves with whatever else is using the card.

For comparison, the previous model (`…@iq3_m`, q8_0 cache) slowed from ~45 to ~4 tokens/s above 55k because part of it ended up in system RAM.

**92k–96k leave almost no spare GPU memory.** Everything else on screen shares the card's 16 GB: Windows itself, both monitors, and every open app that draws with the GPU, such as Firefox, Edge, the Claude app and LM Studio's window. When those take a few hundred MB more, part of the model moves into system RAM and speed falls from ~54 to anywhere between 1 and 34 tokens/s. The stats under each reply show it (tok/s). Claude Code then times out and resends its requests, so a task that should take a minute takes half an hour.

**If it's slow:** close GPU-heavy apps, or turn off hardware acceleration in the browser, then reload the model:
```
lms unload --all
lms load qwen3.8-27b-heretic-gsq-rco -y
```
If you'd rather keep apps open, set the context to 90k in LM Studio's **My Models**.

**Saved settings file:** LM Studio keeps each model's settings in `%USERPROFILE%\.lmstudio\.internal\user-concrete-model-default-config\…\<file>.gguf.json`. If you edit it by hand, save it without a BOM. Windows PowerShell's `Set-Content -Encoding utf8` adds one, and LM Studio then silently ignores the file.

The limit moves with whatever else is using the GPU. If replies suddenly crawl, something else is taking GPU memory.

While gaming, start with `.\start.ps1 -ContextLength 16384`. The bridge then treats 16,384 as a cap: on the next message, if the model is loaded with a bigger context (or not loaded), it reloads it at 16,384. You can also set a permanent cap with `"contextLength"` in `config.json`. The chat shows "Loading the model…" while that happens, which takes about 20 seconds. Set `"contextLength": 0` to leave loading to LM Studio.

## A second model on the other GPU

The RTX 5070 Ti runs the 27B in LM Studio; the RX 6800 XT (which drives the screens and games) runs a smaller model at the same time, with room left for a game.

- **What runs:** `Qwen3.8-9B-heretic-uncensored` Q4_K_M ([mradermacher's GGUF](https://huggingface.co/mradermacher/Qwen3.8-9B-heretic-uncensored-GGUF), 5.24 GB) with a 64k context, in llama.cpp's own `llama-server` (Vulkan build). LM Studio can't serve it: it runs one GGUF engine at a time, and that one is CUDA, which only sees the NVIDIA card.
- **Where:** `amd\llama.cpp\` (the [llama.cpp release](https://github.com/ggml-org/llama.cpp/releases) `llama-bXXXXX-bin-win-vulkan-x64.zip`, unzipped) and `amd\models\`. The `amd` folder isn't in git.
- **How it starts:** the bridge starts it (hidden, port 1235, local only) and checks it every 30 s, starting it again if it stops. Restarting the bridge restarts it too (~20 s to load); one that's already running is reused. Its output goes to `bridge\logs\second-model.log`. The card is found by name (`"gpu": "6800 XT"`), so device numbering doesn't matter.
- **Loading and unloading:** it isn't in LM Studio, so LM Studio's eject button doesn't apply. Instead:
  - **Website:** the **Load / Unload** button next to the Model menu shows its state. **Settings** has the same button, plus **auto-unload** after 10 min, 30 min, 1 hour or 2 hours unused.
  - **On the PC:**
    - `.\second-model.ps1` shows its state.
    - `.\second-model.ps1 off` unloads it, e.g. before a game.
    - `.\second-model.ps1 on` loads it (10–20 s).
    - `.\second-model.ps1 -Idle 30` sets auto-unload; `-Idle 0` turns it off.
  - **Unloaded by you:** it stays off, also through bridge restarts and reboots, until you load it. Messages to it get "unloaded, load it…" instead of an answer.
  - **Unloaded after being unused:** the next message to it loads it again, then answers.
  - The choice is saved in `bridge\second-model-state.json`. The bridge never unloads it in the middle of a reply.
- **Using it:**
  - **Website:** pick `qwen3.8-9b-heretic` in **Model**. Chats on the two models run at the same time; chats on the same model take turns.
  - **Note:** `note setup` (version 0.28.5 or newer) adds a second model, **Lite**; switch with `/model`. Note calls it `note-lite` and never sees the real name.
  - **Claude Code sessions on the website:** pick the model in the session bar, next to the permission mode, or type `/model 9b` (`/model default` goes back). Claude Code fixes its model and context size when it starts, so the switch restarts the session's Claude Code on the new model with your next message and resumes the same conversation. If the conversation is past the point where Claude Code would compact on the new model (its context − ~23k), it's compacted first on the current model, shown as a `/compact` turn, and the switch happens when that finishes. For the 9B that point is ~42k tokens. To know the conversation's real size, each session tags its model calls (an `x-local-llm-chat` header) and the bridge records the size of the last one. `claude-local` in a terminal keeps using the 27B.
  - It can't see images (no vision file).
- **Measured on the 6800 XT:**
  - **Q6_K vs Q4_K_M** (measured 2026-11-26 with the game closed; the same 9 checks: math, a fact, JSON, a bug, logic, working code, a tool call, a code word hidden in ~20k tokens):

    | | VRAM | Short reply | At ~20k tokens | Reading the prompt | Checks passed |
    |---|---|---|---|---|---|
    | Q6_K, 64k (before) | 9.5 GB | 60 tok/s | 47 tok/s | 793 tok/s | 8/9 |
    | **Q4_K_M, 64k (now)** | **8.1 GB** | | | | |
    | Q4_K_M, 32k | 6.5 GB | 74 tok/s | 56 tok/s | 940 tok/s | 8/9 |

    Both missed the same arithmetic question. Q4_K_M at 64k has the same weights as at 32k, so it should run at about the same speed; only the memory differs.
  - **Next to CS2:** the Q6_K didn't fit. Measured in a match: CS2 6.1 GB, the ProtonVPN app 1.7 GB, Discord 0.9 GB. Windows gave the 9B only 6.6 GB and moved the other 3.3 GB into system RAM, which the card reads over the riser's PCIe 3.0 x8 link, far slower than VRAM. Q4_K_M at 64k (8.1 GB) is still tight with all of those open. Closing the ProtonVPN window and turning off Discord's hardware acceleration frees ~2.6 GB. Check with Task Manager → Performance → the 6800 XT: "Shared GPU memory" rising means it's spilling.
  - **Freezes:** on 2026-11-26 the PC froze twice when alt-tabbing out of CS2 while the Q6_K was loaded. The screen froze but audio kept playing, and it needed a hard restart. Windows recorded GPU timeouts (LiveKernelEvent 141) and an AMD driver hang report at both times. The likely cause is the overfilled card plus an AMD driver that fails to recover. **Unload the 9B before playing** (`.\second-model.ps1 off`).
  - **While a game runs on the same card, they compete.** Measured with CS2 open: the 9B read a long prompt at only 80–130 tokens/s, and the game loses frames while the 9B works. Short replies are fine; leave long prompts for when you're not playing. Capping the game's FPS leaves more room.
- **Settings found by testing:**
  - Flash attention and a q8_0 KV cache both cut prompt reading on this card to 100–250 tokens/s at 20k+ tokens, so both are off.
  - A 256-token batch saves ~1 GB at 64k for ~7% slower prompt reading.
  - Change them with `"flashAttention"`, `"cacheTypeK"`, `"cacheTypeV"`, `"batch"`, `"context"` or extra `"args"` under `"secondModel"` in `bridge\config.json`. `"enabled": false` turns it off. The bridge needs a restart to pick up changes, and the running `llama-server` has to be stopped as well (`Stop-Process -Name llama-server` also stops LM Studio's, so pick it by path).

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

**Automatic (set up on this PC).** The **Local LLM bridge** task starts everything when you log in to Windows. It starts LM Studio's server and the model, turns on Funnel, and runs the bridge hidden, restarting it within about 10 seconds if it ever stops. It runs on its own, so closing other apps doesn't stop it.
- **Recovers by itself:**
  - **LM Studio:** the bridge checks it every minute. If its server is down for over a minute, the bridge starts it again and, if the model was unloaded, loads it again at the same context. Measured: back about a minute after it stopped. `"watchLmStudio": false` in `bridge/config.json` turns this off.
  - **The bridge:** the task also runs every 5 minutes. While the bridge runs, those runs are skipped; if the bridge has ended for any reason, the next one starts it again. Measured: back 40 s after a full stop.
- **Log:** `bridge\logs\bridge-<date>.log` has the bridge window's output, without the access token. Logs older than 14 days are deleted.
- **Stop it:** `.\stop-bridge.ps1`. The task's 5-minute check starts it again; to keep it off, remove the task (below).
- **Remove it:** `.\install-autostart.ps1 -Remove`. Running `.\install-autostart.ps1` sets it up again (no administrator rights needed).
- **Context at login:** the task loads the model with LM Studio's saved settings (88k; see "Model loading" for why not more).

**By hand:**

```powershell
.\start.ps1
```

It prints your **public bridge URL** and **access token**. Open the GitHub Pages site, click **Settings**, paste both, and **Test connection**. The browser remembers them. (If `siteUrl` is set, just open the printed one-click link instead.)

Options: `-Model <id>` picks a model, `-ContextLength <tokens>` caps the context for this run (the bridge follows it), `-NoFunnel` keeps it local-only.

To stop public access entirely: `tailscale funnel --https=443 off`.

## Model and performance notes

- **Current model:** `qwen3.8-27b-heretic-gsq-rco`, the same uncensored RVN model as before but compressed with the GSQ-RCO method. It's 11.8 GB plus the 0.63 GB vision file (12.42 GB in all, 0.79 GB less than the old IQ3_M). Its publisher measured it within 0.95% of full weights (wikitext-2 perplexity), against +2.9% for a standard IQ3_S. It's from [0bserverx/Qwen3.8-27B-Heretic-GSQ-RCO-GGUF](https://huggingface.co/0bserverx/Qwen3.8-27B-Heretic-GSQ-RCO-GGUF); the vision file is linked from the original RVN folder.
- **Speed and context:** with keys at q8_0 and values at q4_0, it runs at ~54 tokens/s with a 90k context, less at 92k–96k when other apps use the GPU. It thinks before answering; open **Reasoning** to see it.
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
