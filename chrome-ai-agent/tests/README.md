# Browser integration tests

These tests load the unpacked Manifest V3 extension into Playwright Chromium. A
local fixture service provides redacted EMR/PACS pages and a deterministic mock
backend on the same loopback ports used by the extension. No provider
credentials or live model calls are used.

```powershell
npm install
npx playwright install chromium
npm run test:e2e
```

The active suite covers tab switching during delayed model planning, stale
document rejection, sensitive/write-action blocking, one-approval action
batches, stop-versus-plan races, the first-patient checkpoint, actual
reload/resume continuation, and event-based external-viewer leasing. Viewer
cases verify exact patient/report terms, wrong-patient rejection, created-tab
ownership and cleanup, reused-tab preservation, and source restoration.
