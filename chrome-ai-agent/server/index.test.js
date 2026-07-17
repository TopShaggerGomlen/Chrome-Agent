import assert from "node:assert/strict";
import test from "node:test";

import { normalizeScreenshot, validateVisualActions } from "./index.js";

const page = {
  imageBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  imageWidth: 1200,
  imageHeight: 800,
  viewportWidth: 600,
  viewportHeight: 400,
  url: "https://example.com/",
  title: "Example"
};

test("normalizes screenshot metadata", () => {
  const screenshot = normalizeScreenshot(page);
  assert.equal(screenshot.imageWidth, 1200);
  assert.equal(screenshot.viewportWidth, 600);
  assert.equal(screenshot.url, "https://example.com/");
});

test("rejects missing screenshot dimensions", () => {
  assert.throws(() => normalizeScreenshot({ ...page, imageWidth: 0 }), /imageWidth/);
});

test("accepts one coordinate click inside the current screenshot", () => {
  const result = validateVisualActions([
    { type: "click", x: 300, y: 200, description: "Open the visible ingress rules tab" }
  ], page, { allowSubmit: false });
  assert.equal(result.validActions.length, 1);
  assert.deepEqual(result.blockedActions, []);
});

test("rejects stale coordinates outside the screenshot", () => {
  const result = validateVisualActions([
    { type: "click", x: 1300, y: 200, description: "Click a visible button" }
  ], page, { allowSubmit: false });
  assert.equal(result.validActions.length, 0);
  assert.match(result.blockedActions[0].reason, /outside/);
});

test("requires explicit submit intent and always blocks collection writes", () => {
  const action = { type: "click", x: 300, y: 200, description: "Save the rule", submits: true };
  assert.equal(validateVisualActions([action], page, { allowSubmit: false }).validActions.length, 0);
  assert.equal(validateVisualActions([action], page, { allowSubmit: true }).validActions.length, 1);
  assert.equal(validateVisualActions([action], page, { allowSubmit: true, collection: true }).validActions.length, 0);
});

test("blocks sensitive and high-risk visual targets", () => {
  const sensitive = validateVisualActions([
    { type: "type", x: 100, y: 100, text: "123456", description: "Enter OTP" }
  ], page, { allowSubmit: false });
  const risky = validateVisualActions([
    { type: "click", x: 100, y: 100, description: "Confirm purchase" }
  ], page, { allowSubmit: true });
  assert.equal(sensitive.validActions.length, 0);
  assert.equal(risky.validActions.length, 0);
});

test("keeps only one action per screenshot", () => {
  const result = validateVisualActions([
    { type: "click", x: 100, y: 100, description: "Open menu" },
    { type: "click", x: 200, y: 200, description: "Choose item" }
  ], page, { allowSubmit: false });
  assert.equal(result.validActions.length, 1);
  assert.match(result.blockedActions[0].reason, /one visual action/);
});
