import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { STATE_DIR } from "./paths.mjs";

export const TOOL_RESULT_AGING_STATE_PATH =
  process.env.MODEL_ROUTER_TOOL_RESULT_AGING_STATE ||
  path.join(STATE_DIR, "tool-result-aging.json");

function disabledSettings(extra = {}) {
  return {
    version: 1,
    enabled: false,
    scope: "routed-external",
    ...extra,
  };
}

export function readToolResultAgingSettings() {
  if (!existsSync(TOOL_RESULT_AGING_STATE_PATH)) {
    return disabledSettings({ defaulted: true });
  }
  try {
    const parsed = JSON.parse(readFileSync(TOOL_RESULT_AGING_STATE_PATH, "utf8"));
    if (
      parsed?.version !== 1 ||
      parsed?.scope !== "routed-external" ||
      typeof parsed?.enabled !== "boolean"
    ) {
      return disabledSettings();
    }
    return disabledSettings({ enabled: parsed.enabled });
  } catch {
    return disabledSettings();
  }
}

function writeSettings(settings) {
  const stateDir = path.dirname(TOOL_RESULT_AGING_STATE_PATH);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const temporary = `${TOOL_RESULT_AGING_STATE_PATH}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, TOOL_RESULT_AGING_STATE_PATH);
  chmodSync(TOOL_RESULT_AGING_STATE_PATH, 0o600);
  return settings;
}

export function setToolResultAgingEnabled(enabled) {
  return writeSettings(disabledSettings({ enabled: enabled === true }));
}

export function toolResultAgingEnabled() {
  if (process.env.CODEX_ROUTER_TOOL_RESULT_AGING === "0") return false;
  return readToolResultAgingSettings().enabled;
}

export function toolResultAgingSnapshot() {
  const settings = readToolResultAgingSettings();
  const environmentOverride = process.env.CODEX_ROUTER_TOOL_RESULT_AGING === "0";
  const { defaulted: _defaulted, ...persisted } = settings;
  return {
    ...persisted,
    enabled: environmentOverride ? false : persisted.enabled,
    nativeEnabled: false,
    configured: existsSync(TOOL_RESULT_AGING_STATE_PATH),
    environmentOverride,
    path: TOOL_RESULT_AGING_STATE_PATH,
  };
}
