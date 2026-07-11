import { test, expect, configureTestBackend, readTestBackendState, openSidePanelPage } from "./fixtures.mjs";

async function openWorkbook(panel) {
  await panel.locator("#workflowDisclosure").evaluate(el => { el.open = true; });
  await panel.locator("#workbookAlias").fill("demo");
  await panel.locator("#workbookOpenBtn").click();
  await expect(panel.locator("#workbookPatientSelect")).toBeEnabled();
  await panel.locator("#workbookPatientSelect").selectOption("1");
}

async function startWorkbookReview(panel) {
  await openWorkbook(panel);
  await panel.locator("#workflowQueue").fill("SYN-1001,2026-01-15");
  await panel.locator("#workflowStartBtn").click();
  await expect(panel.locator("#workbookPreview")).toContainText("K4");
}

test("preview is visible before approval and does not write", async ({ extensionContext: context }) => {
  await configureTestBackend({ scenario: "preview" });
  const panel = await openSidePanelPage(context);
  await openWorkbook(panel);
  await expect(panel.locator("#workbookPreview")).toContainText("K4");
  expect((await readTestBackendState()).workbookWrites).toBe(0);
});

test("approve writes with token and diff hash, then continue", async ({ extensionContext: context }) => {
  await configureTestBackend({ scenario: "checkpoint" });
  const panel = await openSidePanelPage(context);
  await startWorkbookReview(panel);
  await panel.locator("#workbookApproveBtn").click();
  await expect.poll(async () => (await readTestBackendState()).workbookWrites).toBe(1);
  await expect(panel.locator("#workbookContinueBtn")).toBeVisible();
  await panel.locator("#workbookContinueBtn").click();
  await expect.poll(async () => (await readTestBackendState()).workflowContinueCalls).toBe(1);
});

for (const scenario of ["conflict", "locked"]) {
  test(`${scenario} pauses safely`, async ({ extensionContext: context }) => {
    await configureTestBackend({ scenario });
    const panel = await openSidePanelPage(context);
    await startWorkbookReview(panel);
    await panel.locator("#workbookApproveBtn").click();
    await expect(panel.locator("#workbookRecovery")).toBeVisible();
  });
}

test("sync pending exposes recovery and recover transitions to synced", async ({ extensionContext: context }) => {
  await configureTestBackend({ scenario: "sync_pending" });
  const panel = await openSidePanelPage(context);
  await startWorkbookReview(panel);
  await panel.locator("#workbookApproveBtn").click();
  await expect(panel.locator("#workbookRecovery")).toBeVisible();
  await panel.locator("#workbookRecoverBtn").click();
  await expect(panel.locator("#workbookStatusText")).toContainText("synced");
});

test("restores a stopped run", async ({ extensionContext: context }) => {
  await configureTestBackend({ scenario: "restore-stopped" });
  const panel = await openSidePanelPage(context);
  await expect(panel.locator("#workflowStatus")).toContainText("Restored local workflow run");
  await panel.locator("#workflowDisclosure").evaluate(el => { el.open = true; });
  await expect(panel.locator("#workflowContinueBtn")).toBeVisible();
});

test("later workbook row is written automatically after continuation", async ({ extensionContext: context }) => {
  await configureTestBackend({ scenario: "checkpoint" });
  const panel = await openSidePanelPage(context);
  await startWorkbookReview(panel);
  await panel.locator("#workbookApproveBtn").click();
  await panel.locator("#workbookContinueBtn").click();
  await expect.poll(async () => (await readTestBackendState()).workflowContinueCalls).toBe(1);
});
