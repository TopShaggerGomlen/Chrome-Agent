import { test as base, chromium, expect } from "@playwright/test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const extensionPath = path.resolve(here, "../../extension");
export const fixtureOrigin = "http://127.0.0.1:4173";
export const backendOrigin = "http://127.0.0.1:3000";

export async function configureTestBackend(configuration = {}) {
  const response = await fetch(`${backendOrigin}/__test/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(configuration)
  });
  expect(response.ok).toBeTruthy();
  return response.json();
}

export async function readTestBackendState() {
  const response = await fetch(`${backendOrigin}/__test/state`);
  expect(response.ok).toBeTruthy();
  return response.json();
}

export const test = base.extend({
  extensionContext: async ({}, use) => {
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-ai-agent-e2e-"));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`
      ]
    });

    try {
      await use(context);
    } finally {
      await context.close();
      await fs.rm(userDataDir, { recursive: true, force: true });
    }
  }
});

export { expect };

export async function extensionId(context) {
  let worker = context.serviceWorkers()[0];
  if (!worker) {
    try {
      worker = await context.waitForEvent("serviceworker", { timeout: 10000 });
    } catch (error) {
      throw new Error(`Extension service worker did not start: ${error.message}`);
    }
  }
  return new URL(worker.url()).host;
}

export async function openSidePanelPage(context) {
  // Creating a regular tab prompts Chromium to initialize the MV3 worker
  // deterministically (headless startup can otherwise defer it indefinitely).
  if (!context.pages().length) await context.newPage();
  const id = await extensionId(context);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await panel.waitForFunction(() => document.readyState === "complete");
  await panel.evaluate(async () => {
    await chrome.storage.local.set({ chromeAiAgentPermissionOnboardingAck: true });
    document.querySelector("#permissionOnboarding")?.setAttribute("hidden", "");
  });
  return panel;
}

export async function sendExtensionMessage(panel, message) {
  return panel.evaluate(payload => new Promise(resolve => {
    chrome.runtime.sendMessage(payload, response => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response);
    });
  }), message);
}

export async function observeActivePage(panel, taskId) {
  const result = await sendExtensionMessage(panel, {
    type: "GET_LIGHT_PAGE_CONTEXT",
    taskId
  });
  expect(result?.error, result?.error).toBeFalsy();
  expect(result?.page?.target?.tabId).toEqual(expect.any(Number));
  return result;
}

export function actionFor(result, selector, type = "click", extra = {}) {
  const element = result.page.elements.find(candidate => candidate.selector === selector);
  return {
    type,
    selector,
    frameId: element?.frameId ?? 0,
    targetFingerprint: element?.targetFingerprint,
    expectedDocumentIdentity: result.page.accessibleFrames.find(frame => frame.frameId === (element?.frameId ?? 0))?.documentIdentity,
    expectedUrl: result.page.target.url,
    target: result.page.target,
    contextId: result.page.target.contextId,
    taskId: result.page.target.taskId,
    ...extra
  };
}
