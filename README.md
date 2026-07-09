# Chrome AI Agent

A local Chrome extension that opens in the side panel, reads the current page with bounded browser context, returns structured AI plans through a local backend, and runs approved task batches.

## Features

- Chrome side panel UI
- Returns one schema-validated Ask response containing the reply and proposed actions
- Reads visible page text, page chunks, forms, and interactive elements
- Aggregates accessible iframes and routes actions to the correct frame
- Extracts open shadow DOM content and reports inaccessible closed shadow roots
- Uses bounded lightweight context by default and accessibility data only when explicitly needed
- Supports opt-in visible-tab screenshot context
- Sends page context to a local Node backend
- Supports OpenAI API key mode
- Supports Claude API key mode
- Supports experimental OpenAI sign-in mode through local Codex CLI
- Supports self-hosted DeepSeek-R1 through Ollama
- Supports self-hosted gpt-oss-20b through Ollama
- Supports text file attachments from the side-panel composer
- Preserves the last task draft, auto-resizes the prompt box, sends with `Enter`, and inserts new lines with `Shift+Enter`
- Shows clearer attachment and screenshot states in the composer
- Supports playbook-driven Collection Mode for longer website extraction runs
- Exports collected rows as Markdown
- Proposes click/type/submit/extract actions
- Previews click/type/submit targets by scrolling/highlighting the element before execution
- Requires one explicit approval for each proposed browser action batch
- Retries selector failures after short DOM-settle backoff windows, rereads the page, rematches by label/text/role, and retries once
- Applies preview, rematch, and retry recovery to Collection Mode click/type actions
- Shows a clean action history for proposed, blocked, retrying, executed, failed, and stopped actions
- Exports action history as Markdown or JSON for debugging
- Shows `safe`, `caution`, and `blocked` risk labels for proposed actions
- Provides a global **Stop** button for requests, action batches, collection runs, and workflow runs
- Allows ordinary form submit when the user explicitly asks for submit
- Blocks password, OTP, card, payment, purchase, transfer, crypto, account deletion, and destructive actions
- Includes first-run permission and safety onboarding in the side panel
- No domain allowlist; uses `<all_urls>` for all normal websites

## Requirements

- Chrome or Chromium browser, version 125 or newer
- Node.js LTS or newer
- npm
- One of:
  - OpenAI API key
  - Claude API key
  - Codex CLI installed and signed in with ChatGPT
  - Ollama with `deepseek-r1` or `gpt-oss:20b` pulled locally

## Setup

### 1. Install backend dependencies

```bash
cd chrome-ai-agent/server
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

For DeepSeek-R1 through Ollama:

```bash
ollama pull deepseek-r1
```

```env
RUNTIME_PROVIDER=deepseek_r1_ollama
OLLAMA_BASE_URL=http://localhost:11434/v1
OLLAMA_API_KEY=ollama
DEEPSEEK_R1_MODEL=deepseek-r1
```

For gpt-oss-20b through Ollama:

```bash
ollama pull gpt-oss:20b
```

```env
RUNTIME_PROVIDER=gpt_oss_20b_ollama
OLLAMA_BASE_URL=http://localhost:11434/v1
OLLAMA_API_KEY=ollama
GPT_OSS_20B_MODEL=gpt-oss:20b
```

### 3. Start backend

```bash
npm run dev
```

Check health:

```bash
curl http://127.0.0.1:3000/health
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
6. Accept the extension permissions, including `<all_urls>`, `storage`, and the debugger permission used for accessibility-tree extraction.
7. Open any normal website.
8. Click the extension icon.
9. The side panel should open.
10. On first connection, copy the one-time pairing code printed by the local backend into **Backend pairing code** and save the provider settings. The backend then accepts requests only from that extension.

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

Enable **Screenshot** in the composer when you want the current visible tab image included as extra context. Screenshots are opt-in per request. OpenAI and Claude API-key modes can receive screenshot image input; OpenAI sign-in through Codex CLI and Ollama self-hosted modes omit screenshot image input and use the text/accessibility context instead.

Use **Stop** to cancel an in-flight request, stop before the next action in a running batch, or request that Collection Mode or Workflow Mode stop after the current step.

The prompt box auto-resizes as you type. Press `Enter` to ask without clicking the button, or `Shift+Enter` to insert a new line. The side panel preserves the last task draft locally so accidental panel closes do not erase the prompt.

After the model proposes browser actions, the **Action History** panel shows the lifecycle of each action: proposed, blocked, retrying, executed, failed, or stopped. Use **Export .md** for a readable debugging timeline or **Export .json** for the raw retained history data.

## Collection Mode

Collection Mode is for longer website navigation and extraction workflows. Enter a collection task, optionally provide comma-separated fields, and optionally paste or upload a Markdown playbook with site-specific instructions. The default limits are 250 planning steps, 500 rows, 100 visited URLs, 10 no-progress steps, and 30 minutes.

When you press **Start Collection**, it loops through deep page snapshots, backend planning, validated browser actions, and row capture until it finishes, reaches a limit, is blocked by safety validation, or you press **Stop**. By default it pauses after the first captured record so you can review it before continuing.

Collection snapshots use bounded lightweight DOM context by default. The debugger accessibility tree is an on-demand fallback; screenshots are opt-in for ordinary tasks and omitted in sensitive workflows.

Collection click/type actions use the same target preview, selector rematch, retry backoff, and action history recording as normal task batches. Longer extraction workflows therefore recover from async page rendering and selector drift instead of failing immediately when a page layout changes.

Use **Download .md** to export the collected rows, warnings, run summary, and source URLs as a Markdown file. Collection Mode is Markdown-first; Excel writing is not implemented in this version.

## Workflow Mode

Workflow Mode is the resumable, evidence-backed path for structured records. Its first profile is the Urolithiasis extraction workflow. Paste one patient per line as `MRN,YYYY-MM-DD[,externalId]`, then choose **Run First Patient**. The first record pauses only when it is ready for review; unresolved fields remain flagged with their reason. **Approve & Continue** runs the remaining queue, and **Stop** saves the local run after the current action.

Workflow runs persist locally under `server/.workflow-runs/` until deleted from the side panel. CSV and Markdown exports include typed values and evidence audit. Direct Excel reading/writing and workbook sync are intentionally deferred.

Sensitive workflow profiles minimize cloud context: screenshots are disabled, identifiers are redacted from planner prompts, and a saved approval is required for each workflow/profile/provider/model combination. Local run files are not encrypted in this version; use a device and account appropriate for the records you handle.

## Action behavior

The extension displays proposed actions and requires **Run action batch** once before normal click/type/submit/extract actions execute. Workflow Mode treats **Run First Patient** and **Approve & Continue** as the corresponding run-level approvals.

Risk labels:

- `safe`: low-risk read or navigation-like action.
- `caution`: executable action that may change page state, such as typing or ordinary submit.
- `blocked`: shown with a reason, but not executable.

Before click/type/submit actions run, the extension briefly previews the target by scrolling to it and highlighting it. It verifies the planned tab, frame, URL, document identity, and target fingerprint before execution. Use **Stop** to stop before the next action and mark remaining executable actions as stopped.

If a selector fails because the page changed or rendered asynchronously, the extension waits through short backoff windows, rereads the page, rematches the target using stable label/text/role evidence, previews the rematched target, and retries the action once. Safety blocks, sensitive fields, disabled controls, and high-risk actions are not retried.

Chrome may still show install or update permission prompts for extension capabilities such as `<all_urls>`, `debugger`, `tabs`, and `storage`. Those browser-level prompts are separate from in-app task approvals.

## Permission and privacy onboarding

On first run, the side panel explains why the extension requests broad browser permissions:

- `<all_urls>` lets the side panel read and act on normal websites instead of a fixed allowlist.
- `debugger` is used briefly to request a bounded accessibility tree from the active tab, then detached.
- `storage` keeps local settings, the last task draft, provider preferences, and action history.

Page context and attachments are sent to the local backend and selected provider only when you ask a task. API keys, backend pairing tokens, and saved state stay local. The agent blocks password, OTP, card, payment, transfer, crypto, account deletion, and destructive actions. Sensitive workflows add profile-specific minimization and saved cloud-consent controls.

Open the Provider section and click **Permissions & Safety** to view the onboarding explanation again.

## Submit behavior

The agent may submit ordinary forms when the user explicitly asks it to submit/send/post/search/confirm.

The agent should not submit payments, purchases, transfers, crypto actions, account deletion, or destructive actions.

## Provider behavior

### OpenAI API key

Uses `OPENAI_API_KEY` from `.env` or a key saved from the side panel to the local backend.

Ask replies return as one schema-validated plan so the displayed reply and actions stay consistent. Opt-in screenshot context is sent as image input.

### Claude API key

Uses `ANTHROPIC_API_KEY` from `.env` or a key saved from the side panel to the local backend.

Ask replies return as one schema-validated plan. Opt-in screenshot context is sent as image input.

### OpenAI sign-in through Codex CLI

Uses the local Codex CLI. The backend includes the npm `@openai/codex` CLI dependency and prefers that local project copy before falling back to a `codex` command on PATH. This mode is experimental and local-only.

The side panel also includes **Open OpenAI Sign-In** when this provider is selected. That button asks the backend to start `codex login --device-auth`, opens a sign-in helper tab, and shows a confirmation message after the Codex CLI login is complete. Use **Check Sign-In** if you finished the browser flow and want to verify the CLI can run.

Codex CLI mode emits progress/status events and then a final response. It does not stream model tokens through the side panel, and screenshot image input is omitted.

### DeepSeek-R1 through Ollama

Uses Ollama's local OpenAI-compatible Chat Completions API at `OLLAMA_BASE_URL`, defaulting to `http://localhost:11434/v1`. Pull the model with `ollama pull deepseek-r1`, then select **DeepSeek-R1 via Ollama** in the side panel or set `RUNTIME_PROVIDER=deepseek_r1_ollama`.

Ask replies return as one schema-validated plan. Screenshot image input is omitted for this text-only provider.

### gpt-oss-20b through Ollama

Uses Ollama's local OpenAI-compatible Chat Completions API at `OLLAMA_BASE_URL`, defaulting to `http://localhost:11434/v1`. Pull the model with `ollama pull gpt-oss:20b`, then select **gpt-oss-20b via Ollama** in the side panel or set `RUNTIME_PROVIDER=gpt_oss_20b_ollama`.

Ask replies return as one schema-validated plan. Screenshot image input is omitted for this text-only provider.

## Known limitations

- Chrome internal pages such as `chrome://extensions` are not accessible to content scripts.
- Some websites block automation, frame access, screenshot capture, or debugger accessibility extraction.
- Closed shadow roots cannot be inspected; the extension reports them as inaccessible when detected.
- Cross-origin iframes are included only when Chrome permits content script access.
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
cd chrome-ai-agent/server
npm run dev
```

Then check:

```bash
curl http://127.0.0.1:3000/health
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

Ollama providers do not usually need a real API key. Keep `OLLAMA_API_KEY=ollama` unless your local Ollama-compatible server requires a different bearer token.

### OpenAI sign-in mode fails

Run:

```bash
codex login
codex doctor
```

Then restart the backend.

If the side panel sign-in button cannot start Codex, set `CODEX_CLI_COMMAND` in `server/.env` to the full path of a Codex CLI executable that can run from a normal terminal.

### Debugger permission warning

Chrome shows a debugger permission warning because the extension uses `chrome.debugger` to request a bounded accessibility tree from the current tab. The debugger is attached only during context collection and is detached immediately afterward.

### Model returned invalid JSON

The server validates model JSON against the action schema. OpenAI uses native structured output; other providers use bounded JSON extraction and report invalid plans as warnings.

### Action failed because the selector changed

The side panel automatically waits briefly, rereads the page, rematches by label/text/role, previews the rematched target, and retries once for selector-like failures. If the action still fails, export **Action History** as Markdown or JSON and inspect the failed entry, rematch note, selector, frame, and page URL.

### Stop an approved action batch

Use **Stop** during an action run to stop before the next action. The current browser action may finish if it is already in progress, and remaining executable actions are marked as stopped in Action History.

