import {
  expect,
  fixtureOrigin,
  observeActivePage,
  openSidePanelPage,
  sendExtensionMessage,
  test
} from "./fixtures.mjs";

test("the PACS fixture exposes opener and redacted record/study identity for lease verification", async ({ extensionContext }) => {
  const emr = await extensionContext.newPage();
  await emr.goto(`${fixtureOrigin}/emr`);
  const [viewer] = await Promise.all([
    extensionContext.waitForEvent("page"),
    emr.locator("#open-report").click()
  ]);
  await viewer.waitForLoadState();

  expect(await viewer.opener()).toBe(emr);
  await expect(viewer.locator("#record")).toHaveText("REC-001");
  await expect(viewer.locator("#study")).toHaveText("STUDY-007");
});

test("the extension leases only the PACS tab created by the originating radiology action", async ({ extensionContext }) => {
  const emr = await extensionContext.newPage();
  const panel = await openSidePanelPage(extensionContext);
  await emr.goto(`${fixtureOrigin}/emr`);
  await emr.bringToFront();
  const observed = await observeActivePage(panel, "created-pacs-lease");

  const begin = await sendExtensionMessage(panel, {
    type: "BEGIN_EXTERNAL_VIEWER_OPEN",
    runId: "run-redacted-001",
    recordId: "record-redacted-001",
    actionId: "radiology-action-created",
    sourceTarget: observed.page.target,
    expectedViewer: {
      kind: "pacs",
      urlIncludes: ["/pacs"],
      titleIncludes: ["pacs"]
    },
    requireVerification: true
  });
  expect(begin.error).toBeFalsy();

  const [viewer] = await Promise.all([
    extensionContext.waitForEvent("page"),
    emr.locator("#open-report").click()
  ]);
  await viewer.waitForLoadState();

  const resolved = await sendExtensionMessage(panel, {
    type: "RESOLVE_EXTERNAL_VIEWER",
    leaseId: begin.leaseId,
    waitMs: 100,
    verification: {
      identityTerms: ["REC-001"],
      reportTerms: ["STUDY-007"]
    }
  });
  expect(resolved.error).toBeFalsy();
  expect(resolved.lease).toMatchObject({
    runId: "run-redacted-001",
    recordId: "record-redacted-001",
    actionId: "radiology-action-created",
    ownership: "created",
    verified: true,
    identityVerified: true,
    reportVerified: true
  });
  expect(resolved.lease.viewerTarget.url).toContain("/pacs");

  const closed = viewer.waitForEvent("close");
  const released = await sendExtensionMessage(panel, {
    type: "RELEASE_EXTERNAL_VIEWER",
    leaseId: begin.leaseId,
    closeCreated: true,
    restoreSource: true
  });
  await closed;
  expect(released).toMatchObject({ ok: true, viewerClosed: true, sourceRestored: true });
  expect(viewer.isClosed()).toBe(true);

  const activeUrl = await panel.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.url || "";
  });
  expect(activeUrl).toContain("/emr");
});

test("a reused PACS tab is released but never closed, and an unrelated viewer is ignored", async ({ extensionContext }) => {
  const emr = await extensionContext.newPage();
  const reusedViewer = await extensionContext.newPage();
  const unrelatedViewer = await extensionContext.newPage();
  const panel = await openSidePanelPage(extensionContext);
  await emr.goto(`${fixtureOrigin}/emr`);
  await reusedViewer.goto(`${fixtureOrigin}/pacs?record=REC-001&study=STUDY-007`);
  await unrelatedViewer.goto(`${fixtureOrigin}/pacs?record=REC-999&study=OTHER-STUDY`);
  await emr.bringToFront();
  const observed = await observeActivePage(panel, "reused-pacs-lease");

  const begin = await sendExtensionMessage(panel, {
    type: "BEGIN_EXTERNAL_VIEWER_OPEN",
    runId: "run-redacted-002",
    recordId: "record-redacted-002",
    actionId: "radiology-action-reused",
    sourceTarget: observed.page.target,
    expectedViewer: {
      kind: "pacs",
      urlIncludes: ["record=rec-001"],
      titleIncludes: ["pacs"]
    },
    requireVerification: true
  });
  expect(begin.error).toBeFalsy();

  // A pre-existing tab becomes eligible only through an action-associated
  // activation/navigation event. The unrelated viewer remains untouched.
  await reusedViewer.bringToFront();
  const resolved = await sendExtensionMessage(panel, {
    type: "RESOLVE_EXTERNAL_VIEWER",
    leaseId: begin.leaseId,
    waitMs: 100,
    verification: {
      identityTerms: ["REC-001"],
      reportTerms: ["STUDY-007"]
    }
  });
  expect(resolved.error).toBeFalsy();
  expect(resolved.lease.ownership).toBe("reused");
  expect(resolved.lease.viewerTarget.url).toContain("record=REC-001");
  expect(resolved.lease.viewerTarget.url).not.toContain("REC-999");

  const released = await sendExtensionMessage(panel, {
    type: "RELEASE_EXTERNAL_VIEWER",
    leaseId: begin.leaseId,
    closeCreated: true,
    restoreSource: true
  });
  expect(released).toMatchObject({ ok: true, viewerClosed: false, sourceRestored: true });
  expect(reusedViewer.isClosed()).toBe(false);
  expect(unrelatedViewer.isClosed()).toBe(false);
  await expect(reusedViewer.locator("#record")).toHaveText("REC-001");
  await expect(unrelatedViewer.locator("#record")).toHaveText("REC-999");
});

test("an action-associated viewer for the wrong patient fails closed", async ({ extensionContext }) => {
  const emr = await extensionContext.newPage();
  const panel = await openSidePanelPage(extensionContext);
  await emr.goto(`${fixtureOrigin}/emr`);
  await emr.bringToFront();
  const observed = await observeActivePage(panel, "wrong-patient-pacs-lease");
  const begin = await sendExtensionMessage(panel, {
    type: "BEGIN_EXTERNAL_VIEWER_OPEN",
    runId: "run-redacted-wrong-patient",
    recordId: "record-redacted-expected",
    actionId: "radiology-action-wrong-patient",
    sourceTarget: observed.page.target,
    expectedViewer: { kind: "pacs" },
    requireVerification: true
  });

  const [viewer] = await Promise.all([
    extensionContext.waitForEvent("page"),
    emr.evaluate(() => window.open("/pacs?record=REC-0019&study=STUDY-007", "_blank"))
  ]);
  await viewer.waitForLoadState();
  const resolved = await sendExtensionMessage(panel, {
    type: "RESOLVE_EXTERNAL_VIEWER",
    leaseId: begin.leaseId,
    waitMs: 100,
    verification: { identityTerms: ["REC-001"], reportTerms: ["STUDY-007"] }
  });
  expect(resolved.code).toBe("viewer_verification_mismatch");
  expect(resolved.lease).toBeUndefined();

  const closed = viewer.waitForEvent("close");
  const released = await sendExtensionMessage(panel, {
    type: "RELEASE_EXTERNAL_VIEWER",
    leaseId: begin.leaseId,
    closeCreated: true,
    restoreSource: true
  });
  await closed;
  expect(released).toMatchObject({ ok: true, viewerClosed: true, sourceRestored: true });
});
