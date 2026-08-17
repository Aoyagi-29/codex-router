import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const stateDir = mkdtempSync(path.join("/tmp", "routed-tool-aging-state-"));
process.env.MODEL_ROUTER_STATE_DIR = stateDir;

const {
  TOOL_RESULT_AGING_STATE_PATH,
  readToolResultAgingSettings,
  setToolResultAgingEnabled,
  toolResultAgingEnabled,
  toolResultAgingSnapshot,
} = await import("../src/tool-result-aging-state.mjs");

test("the persisted switch is routed-only, defaults off, and fails closed", () => {
  rmSync(TOOL_RESULT_AGING_STATE_PATH, { force: true });
  delete process.env.CODEX_ROUTER_TOOL_RESULT_AGING;
  assert.equal(toolResultAgingEnabled(), false);
  assert.deepEqual(readToolResultAgingSettings(), {
    version: 1,
    enabled: false,
    scope: "routed-external",
    defaulted: true,
  });

  setToolResultAgingEnabled(true);
  assert.equal(toolResultAgingEnabled(), true);
  assert.equal(statSync(TOOL_RESULT_AGING_STATE_PATH).mode & 0o777, 0o600);
  assert.deepEqual(toolResultAgingSnapshot(), {
    version: 1,
    enabled: true,
    scope: "routed-external",
    nativeEnabled: false,
    configured: true,
    environmentOverride: false,
    path: TOOL_RESULT_AGING_STATE_PATH,
  });

  process.env.CODEX_ROUTER_TOOL_RESULT_AGING = "0";
  assert.equal(toolResultAgingEnabled(), false);
  assert.equal(toolResultAgingSnapshot().environmentOverride, true);
  delete process.env.CODEX_ROUTER_TOOL_RESULT_AGING;

  writeFileSync(TOOL_RESULT_AGING_STATE_PATH, "{not json", "utf8");
  assert.equal(toolResultAgingEnabled(), false);
  assert.equal(toolResultAgingSnapshot().nativeEnabled, false);
});
