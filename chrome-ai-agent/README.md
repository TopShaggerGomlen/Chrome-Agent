# Chrome AI Agent

Manifest V3 side-panel agent with a paired local Express backend. The
extension owns browser extraction and the backend owns provider calls,
workflow persistence, and (when explicitly configured) validated Excel I/O.

## Setup

```powershell
npm install
npx playwright install chromium
Copy-Item server/.env.example server/.env
```

Keep credentials only in `server/.env` or `server/.runtime-secrets.json`; never
commit either file. Start the backend using the server's documented command
and load the unpacked `extension/` directory in Chrome:

```powershell
npm --prefix server run dev
```

Excel support is disabled until `WORKBOOK_PATH_ALIASES` and
`WORKBOOK_ALLOWED_ROOTS` are configured. The complete one-time setup, approval
gate, lock/conflict states, recovery, retention, limitations, and pilot gates
are in [docs/excel-support.md](docs/excel-support.md).

## Checks

```powershell
node --check server/index.js
npm --prefix server test
npm run test:e2e
```

The end-to-end suite uses local deterministic fixtures and does not require
provider credentials or live model calls.
