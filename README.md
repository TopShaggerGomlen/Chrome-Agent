# Chrome AI Agent

A local MVP Chrome extension that opens in the Chrome side panel, reads the current page, sends context to a local AI backend, and runs approved task batches.

## Features

- Chrome side panel UI
- Reads visible page text
- Lists visible interactive elements
- Sends page context to a local Node backend
- Supports OpenAI API key mode
- Supports Claude API key mode
- Supports experimental OpenAI sign-in mode through local Codex CLI
- Supports text file attachments from the side-panel composer
- Supports playbook-driven Collection Mode for longer website extraction runs
- Exports collected rows as Markdown
- Proposes click/type/submit/extract actions
- Asks permission once per task/action batch
- Allows ordinary form submit when the user explicitly asks for submit
- Blocks password, OTP, card, payment, purchase, transfer, crypto, account deletion, and destructive actions
- No domain allowlist; uses `<all_urls>` for all normal websites

## Requirements

- Chrome or Chromium browser
- Node.js LTS or newer
- npm
- One of:
  - OpenAI API key
  - Claude API key
  - Codex CLI installed and signed in with ChatGPT

## Setup

### 1. Install backend dependencies

```bash
cd server
npm install
```

### 2. Create environment file

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Edit `.env` depending on your provider.

For OpenAI API key mode:

```env
RUNTIME_PROVIDER=openai_api_key
OPENAI_API_KEY=your_openai_key_here
OPENAI_MODEL=gpt-5.5
```

For Claude API key mode:

```env
RUNTIME_PROVIDER=claude_api_key
ANTHROPIC_API_KEY=your_claude_key_here
ANTHROPIC_MODEL=claude-sonnet-4-5
```

For OpenAI sign-in through Codex CLI mode:

```bash
codex login
```

Then use:

```env
RUNTIME_PROVIDER=openai_signin_codex
CODEX_CLI_COMMAND=codex
CODEX_MODEL=gpt-5.5
```

### 3. Start backend

```bash
npm run dev
```

Check health:

```bash
curl http://localhost:3000/health
```

Expected:

```json
{"ok":true}
```

### 4. Load Chrome extension

1. Open Chrome.
2. Go to `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the `chrome-ai-agent/extension` folder.
6. Open any normal website.
7. Click the extension icon.
8. The side panel should open.

## Test prompts

Try:

```text
Summarize this page in 5 bullet points.
```

```text
Find the main search box on this page.
```

```text
Click the search box and type wireless headphones.
```

```text
Fill the contact form with "Hello, I am interested in your service" and submit it.
```

You can also attach text-based files from the composer, such as `.txt`, `.md`, `.json`, `.csv`, source files, or logs. The MVP sends bounded text excerpts to the backend as extra context; binary files such as PDFs or images are not parsed.

## Collection Mode

Collection Mode is for longer website navigation and extraction workflows. Enter a collection task, optionally provide comma-separated fields, and optionally paste or upload a Markdown playbook with site-specific instructions. The default limits are 250 planning steps, 500 rows, 100 visited URLs, 10 no-progress steps, and 30 minutes.

The run asks permission once when you press **Start Collection**. It then loops through page snapshots, backend planning, validated browser actions, and row capture until it finishes, reaches a limit, is blocked by safety validation, or you press **Stop**. By default it pauses after the first captured record so you can review it before continuing.

Use **Download .md** to export the collected rows, warnings, run summary, and source URLs as a Markdown file. Collection Mode is Markdown-first; Excel writing is not implemented in this version.

## Permission behavior

The extension shows the proposed action batch. The user clicks **Grant Permission and Run Batch** once. After that, the extension runs the validated batch without asking again for every individual click/type/submit action.

The permission resets when the user starts a new task.

## Submit behavior

The agent may submit ordinary forms when the user explicitly asks it to submit/send/post/search/confirm.

The agent should not submit payments, purchases, transfers, crypto actions, account deletion, or destructive actions.

## Provider behavior

### OpenAI API key

Uses `OPENAI_API_KEY` from `.env` or a key saved from the side panel to the local backend.

### Claude API key

Uses `ANTHROPIC_API_KEY` from `.env` or a key saved from the side panel to the local backend.

### OpenAI sign-in through Codex CLI

Uses the local Codex CLI. The backend includes the npm `@openai/codex` CLI dependency and prefers that local project copy before falling back to a `codex` command on PATH. This mode is experimental and local-only.

The side panel also includes **Open OpenAI Sign-In** when this provider is selected. That button asks the backend to start `codex login --device-auth`, opens a sign-in helper tab, and shows a confirmation message after the Codex CLI login is complete. Use **Check Sign-In** if you finished the browser flow and want to verify the CLI can run.

## Known limitations

- Chrome internal pages such as `chrome://extensions` are not accessible to content scripts.
- Some websites block automation or use complex shadow DOM/iframes.
- Codex CLI sign-in mode may be slower than direct API key modes.
- This is a local MVP, not a production SaaS.

## Troubleshooting

### Side panel says it cannot talk to the current page

Try:

1. Refresh the tab.
2. Use a normal website, not `chrome://`, `edge://`, or the Chrome Web Store.
3. Reload the extension from `chrome://extensions`.

### Backend cannot be reached

Make sure the server is running:

```bash
cd server
npm run dev
```

Then check:

```bash
curl http://localhost:3000/health
```

### Missing API key

Use either `.env` or the side panel Provider section.

OpenAI:

```env
RUNTIME_PROVIDER=openai_api_key
OPENAI_API_KEY=your_key
```

Claude:

```env
RUNTIME_PROVIDER=claude_api_key
ANTHROPIC_API_KEY=your_key
```

### OpenAI sign-in mode fails

Run:

```bash
codex login
codex doctor
```

Then restart the backend.

If the side panel sign-in button cannot start Codex, set `CODEX_CLI_COMMAND` in `server/.env` to the full path of a Codex CLI executable that can run from a normal terminal.

### Model returned invalid JSON

The server tries to recover JSON from the model output. If it happens often, implement structured outputs for OpenAI mode and stricter JSON repair for Claude/Codex modes.

## Future upgrades

- Add structured outputs with JSON schema for OpenAI mode.
- Add better JSON repair for Claude/Codex modes.
- Add unit tests for action validation.
- Add better selector generation.
- Add retry logic.
- Add streaming replies.
- Add a visible action history.
- Add risk labels and a stop button.
- Add screenshot capture, accessibility tree extraction, iframe support, shadow DOM support, and page chunking.
