# AGENTS.md

## Project rules

This project is a Chrome Manifest V3 browser AI agent.

Follow these rules:

1. Do not hardcode API keys in extension files.
2. Keep secrets only in `server/.env` or `server/.runtime-secrets.json`.
3. Support runtime provider modes:
   - `openai_api_key`
   - `claude_api_key`
   - `openai_signin_codex`
   - `deepseek_r1_ollama`
   - `gpt_oss_20b_ollama`
4. Do not add a domain allowlist. The extension should use `<all_urls>`.
5. Ask permission once per task/action batch, not before every action.
6. Allow submit actions only when the user explicitly asks to submit/send/post/search/confirm.
7. Do not type into password, OTP, credit card, CVV/CVC, or secret fields.
8. Block high-risk irreversible actions such as payment, purchase, financial transfer, crypto transfer, account deletion, or destructive delete/remove actions.
9. Keep extension code plain JavaScript unless the user asks to add a framework.
10. Prefer minimal, readable code.
11. Test syntax before finishing:
    - `node --check server/index.js`
12. If changing Chrome permissions, explain why.
13. Preserve the MVP architecture: extension side panel + content script + local backend.
