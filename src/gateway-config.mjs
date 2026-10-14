import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { protectPrivateFile } from "./file-security.mjs";
import { MODELS, providerForModel } from "./model-registry.mjs";
import { PORTS, SOURCE_ROOT, STATE_DIR, loopback } from "./paths.mjs";
import { assertStateOwnership } from "./state-owner.mjs";

export const gatewayConfigPath = path.join(STATE_DIR, "gateway.json");
export const gatewayBinaryPath = path.join(
  SOURCE_ROOT,
  "rust",
  "gateway",
  "target",
  "release",
  process.platform === "win32" ? "codex-router-gateway.exe" : "codex-router-gateway",
);

const OAUTH_PROXY_PORTS = Object.freeze({
  KIMI_OAUTH_FORWARD_BASE_URL: PORTS.oauth,
  GROK_OAUTH_FORWARD_BASE_URL: PORTS.grokOauth,
});

function oauthApiBase(provider) {
  const override = process.env[provider.proxyBaseEnv];
  if (override) return override;
  const port = OAUTH_PROXY_PORTS[provider.proxyBaseEnv];
  if (!port) {
    throw new Error(`Unsupported OAuth proxy base environment: ${provider.proxyBaseEnv}`);
  }
  return loopback(port, "/v1");
}

function apiBase(provider) {
  if (provider.kind === "oauth") return oauthApiBase(provider);
  const baseEnv = provider.protocol === "anthropic"
    ? "CODEX_ROUTER_ANTHROPIC_FORWARD_BASE_URL"
    : "CODEX_ROUTER_API_FORWARD_BASE_URL";
  return process.env[baseEnv] || (
    provider.protocol === "anthropic"
      ? loopback(PORTS.api)
      : loopback(PORTS.api, "/v1")
  );
}

export function renderGatewayConfig() {
  return {
    models: MODELS.map((model) => {
      const provider = providerForModel(model);
      return {
        model_name: model.gatewayModel,
        model: provider.kind === "oauth" ? model.upstreamModel : model.gatewayModel,
        protocol:
          provider.protocol === "anthropic"
            ? "anthropic"
            : provider.protocol === "openai-responses"
              ? "openai-responses"
              : "openai",
        api_base: apiBase(provider),
      };
    }),
  };
}

export function writeGatewayConfig(target = gatewayConfigPath) {
  // Tests and tooling may render to an explicit temporary file. Only the
  // managed state path needs the ownership guard.
  if (target === gatewayConfigPath) {
    assertStateOwnership("write the gateway routing config");
  }
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(renderGatewayConfig(), null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  protectPrivateFile(temporary);
  renameSync(temporary, target);
  protectPrivateFile(target);
  return target;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = writeGatewayConfig();
  process.stdout.write(`${target}\n`);
}
