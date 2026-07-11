import {
  actionFor,
  configureTestBackend,
  expect,
  fixtureOrigin,
  observeActivePage,
  openSidePanelPage,
  readTestBackendState,
  sendExtensionMessage,
  test
} from "./fixtures.mjs";

test("the delayed model response stays bound to the tab observed before the user switches tabs", async ({ extensionContext }) => {
  await configureTestBackend({ scenario: "none", agentDelayMs: 400 });
  const pageA = await extensionContext.newPage();
  const pageB = await extensionContext.newPage();
  const panel = await openSidePanelPage(extensionContext);
  await pageA.goto(`${fixtureOrigin}/page-a`);
  await pageB.goto(`${fixtureOrigin}/page-b`);
  await pageA.bringToFront();

  await panel.evaluate(() => {
    document.querySelector("#task").value = "Run the safe fixture action after planning";
    document.querySelector("#askBtn").click();
  });
  await expect.poll(async () => (await readTestBackendState()).agentRequestStarted).toBe(1);
  await pageB.bringToFront();

  await expect(panel.locator("#runBatchBtn")).toBeVisible();
  await panel.evaluate(() => document.querySelector("#runBatchBtn").click());
  await expect(pageA.locator("#count")).toHaveText("1");
  await expect(pageB.locator("#count")).toHaveText("0");
});

test("a planned action remains bound to the observed tab after the user switches tabs", async ({ extensionContext }) => {
  const pageA = await extensionContext.newPage();
  const pageB = await extensionContext.newPage();
  const panel = await openSidePanelPage(extensionContext);
  await pageA.goto(`${fixtureOrigin}/page-a`);
  await pageB.goto(`${fixtureOrigin}/page-b`);

  await pageA.bringToFront();
  const observed = await observeActivePage(panel, "tab-lock-test");
  const action = actionFor(observed, "#do-action");

  await pageB.bringToFront();
  const result = await sendExtensionMessage(panel, { type: "RUN_PAGE_ACTION", action });

  expect(result.error).toBeFalsy();
  await expect(pageA.locator("#count")).toHaveText("1");
  await expect(pageB.locator("#count")).toHaveText("0");
});

test("a navigation commit invalidates an action planned against the previous document", async ({ extensionContext }) => {
  const target = await extensionContext.newPage();
  const panel = await openSidePanelPage(extensionContext);
  await target.goto(`${fixtureOrigin}/reload`);
  await target.bringToFront();
  const observed = await observeActivePage(panel, "stale-document-test");
  const action = actionFor(observed, "#do-action");

  await target.reload();
  const result = await sendExtensionMessage(panel, { type: "RUN_PAGE_ACTION", action });

  expect(result.error).toMatch(/document changed|stale/i);
  await expect(target.locator("#count")).toHaveText("0");
});

test("password typing and collection-mode write controls are blocked", async ({ extensionContext }) => {
  const target = await extensionContext.newPage();
  const panel = await openSidePanelPage(extensionContext);
  await target.goto(`${fixtureOrigin}/safety`);
  await target.bringToFront();
  const observed = await observeActivePage(panel, "safety-test");

  const passwordResult = await sendExtensionMessage(panel, {
    type: "RUN_PAGE_ACTION",
    action: actionFor(observed, "#account-password", "type", { text: "never-store-this" })
  });
  expect(passwordResult.error).toMatch(/blocked typing|password|sensitive/i);
  await expect(target.locator("#account-password")).toHaveValue("");

  const saveResult = await sendExtensionMessage(panel, {
    type: "RUN_PAGE_ACTION",
    collection: true,
    action: actionFor(observed, "#save-record")
  });
  expect(saveResult.error).toMatch(/blocked high-risk or write-like/i);
  await expect(target.locator("#saved")).toHaveText("not saved");
});
