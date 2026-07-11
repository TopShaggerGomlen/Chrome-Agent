import {
  configureTestBackend,
  expect,
  fixtureOrigin,
  openSidePanelPage,
  readTestBackendState,
  test
} from "./fixtures.mjs";

test("an action returned by the mock provider waits for explicit batch approval", async ({ extensionContext }) => {
  await configureTestBackend({ scenario: "none" });
  const target = await extensionContext.newPage();
  const panel = await openSidePanelPage(extensionContext);
  await target.goto(`${fixtureOrigin}/page-a`);
  await target.bringToFront();

  await panel.evaluate(() => {
    document.querySelector("#task").value = "Run the safe fixture action";
    document.querySelector("#askBtn").click();
  });

  await expect(panel.locator("#runBatchBtn")).toBeVisible();
  await expect(target.locator("#count")).toHaveText("0");

  await panel.evaluate(() => document.querySelector("#runBatchBtn").click());
  await expect(target.locator("#count")).toHaveText("1");
  await expect(panel.locator("#agentStateTitle")).toHaveText("Completed");
});

test("one explicit approval runs a true multi-action batch", async ({ extensionContext }) => {
  await configureTestBackend({ scenario: "none", agentActionCount: 2 });
  const target = await extensionContext.newPage();
  const panel = await openSidePanelPage(extensionContext);
  await target.goto(`${fixtureOrigin}/page-a`);
  await target.bringToFront();

  await panel.evaluate(() => {
    document.querySelector("#task").value = "Run both safe fixture actions";
    document.querySelector("#askBtn").click();
  });
  await expect(panel.locator("#runBatchBtn")).toHaveText(/Run 2 approved actions/);
  await expect(target.locator("#count")).toHaveText("0");

  await panel.evaluate(() => document.querySelector("#runBatchBtn").click());
  await expect(target.locator("#count")).toHaveText("2");
  await expect(panel.locator("#agentStateTitle")).toHaveText("Completed");
});

test("a stopped workflow run is restored after the side panel reloads", async ({ extensionContext }) => {
  await configureTestBackend({ scenario: "restore-stopped" });
  const panel = await openSidePanelPage(extensionContext);
  await expect(panel.locator("#workflowStatus")).toContainText("Restored local workflow run run-redacted-001");
  await expect(panel.locator("#workflowSummary")).toContainText("Status: stopped");
  await expect(panel.locator("#workflowContinueBtn")).toHaveText("Resume Run");

  await panel.reload();
  await expect(panel.locator("#workflowStatus")).toContainText("Restored local workflow run run-redacted-001");
  await expect(panel.locator("#workflowSummary")).toContainText("Current: record-redacted-001 (laboratory)");
});

test("a restored stopped workflow actually resumes after reload", async ({ extensionContext }) => {
  await configureTestBackend({ scenario: "resume" });
  const target = await extensionContext.newPage();
  const panel = await openSidePanelPage(extensionContext);
  await target.goto(`${fixtureOrigin}/page-a`);
  await target.bringToFront();
  await expect(panel.locator("#workflowContinueBtn")).toHaveText("Resume Run");

  await panel.evaluate(() => document.querySelector("#workflowContinueBtn").click());
  await expect.poll(async () => (await readTestBackendState()).workflowContinueCalls).toBe(1);
  await expect.poll(async () => (await readTestBackendState()).workflowPlanCompleted).toBe(1);
  await expect(panel.locator("#workflowStatus")).toContainText("ready for review");

  await panel.reload();
  await expect(panel.locator("#workflowSummary")).toContainText("Status: active");
  await expect(panel.locator("#workflowSummary")).toContainText("(review)");
});

test("the first-patient checkpoint prevents planning patient two until approval", async ({ extensionContext }) => {
  await configureTestBackend({ scenario: "checkpoint" });
  const target = await extensionContext.newPage();
  const panel = await openSidePanelPage(extensionContext);
  await target.goto(`${fixtureOrigin}/page-a`);
  await target.bringToFront();

  await panel.evaluate(() => {
    document.querySelector("#workflowQueue").value = "REC-001,2026-01-15\nREC-002,2026-01-16";
    document.querySelector("#workflowStartBtn").click();
  });
  await expect(panel.locator("#workflowSummary")).toContainText("Status: awaiting_first_review");
  await expect(panel.locator("#workflowContinueBtn")).toHaveText("Approve & Continue");
  let state = await readTestBackendState();
  expect(state.workflowPlanCompleted).toBe(1);
  expect(state.workflowRun.records[1].phase).toBe("patient_search");
  expect(state.secondRecordPlannedBeforeApproval).toBe(false);

  await panel.evaluate(() => document.querySelector("#workflowContinueBtn").click());
  await expect.poll(async () => (await readTestBackendState()).workflowPlanCompleted).toBe(2);
  state = await readTestBackendState();
  expect(state.workflowContinueCalls).toBe(1);
  expect(state.workflowRun.records[1].phase).toBe("review");
  expect(state.secondRecordPlannedBeforeApproval).toBe(false);
});

test("stopping while a plan is in flight prevents the late plan from reviving the run", async ({ extensionContext }) => {
  await configureTestBackend({ scenario: "race" });
  const target = await extensionContext.newPage();
  const panel = await openSidePanelPage(extensionContext);
  await target.goto(`${fixtureOrigin}/page-a`);
  await target.bringToFront();

  await panel.evaluate(() => {
    document.querySelector("#workflowQueue").value = "REC-001,2026-01-15";
    document.querySelector("#workflowStartBtn").click();
  });
  await expect.poll(async () => (await readTestBackendState()).workflowPlanStarted).toBe(1);
  await panel.evaluate(() => document.querySelector("#workflowStopBtn").click());
  await expect.poll(async () => (await readTestBackendState()).workflowStopCalls).toBe(1);
  await expect.poll(async () => (await readTestBackendState()).latePlanRejected).toBe(true);

  const state = await readTestBackendState();
  expect(state.workflowRun.status).toBe("stopped");
  expect(state.workflowPlanCompleted).toBe(0);
  await panel.reload();
  await expect(panel.locator("#workflowSummary")).toContainText("Status: stopped");
});
