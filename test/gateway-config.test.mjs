import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  gatewayBinaryPath,
  gatewayConfigPath,
  renderGatewayConfig,
  writeGatewayConfig,
} from "../src/gateway-config.mjs";
import { MODELS, PROVIDERS, providerForModel } from "../src/model-registry.mjs";
import { PORTS, loopback } from "../src/paths.mjs";

function expectedApiBase(provider) {
  if (provider.kind === "oauth") {
    const port = provider.proxyBaseEnv === "KIMI_OAUTH_FORWARD_BASE_URL"
      ? PORTS.oauth
      : provider.proxyBaseEnv === "GROK_OAUTH_FORWARD_BASE_URL"
        ? PORTS.grokOauth
        : assert.fail(`unexpected OAuth proxy environment ${provider.proxyBaseEnv}`);
    return process.env[provider.proxyBaseEnv] || loopback(port, "/v1");
  }
  const baseEnv = provider.protocol === "anthropic"
    ? "CODEX_ROUTER_ANTHROPIC_FORWARD_BASE_URL"
    : "CODEX_ROUTER_API_FORWARD_BASE_URL";
  return process.env[baseEnv] || (
    provider.protocol === "anthropic"
      ? loopback(PORTS.api)
      : loopback(PORTS.api, "/v1")
  );
}

test("every registry model has a JSON gateway route across all protocols", () => {
  const config = renderGatewayConfig();
  assert.equal(config.models.length, MODELS.length);
  assert.deepEqual(
    config.models.map((route) => route.model_name),
    MODELS.map((model) => model.gatewayModel),
  );

  const protocols = new Set();
  for (const [index, model] of MODELS.entries()) {
    const route = config.models[index];
    const provider = providerForModel(model);
    const expectedProtocol = provider.protocol === "anthropic"
      ? "anthropic"
      : provider.protocol === "openai-responses"
        ? "openai-responses"
        : "openai";
    protocols.add(route.protocol);
    assert.deepEqual(Object.keys(route).sort(), ["api_base", "model", "model_name", "protocol"]);
    assert.equal(route.model, provider.kind === "oauth" ? model.upstreamModel : model.gatewayModel);
    assert.equal(route.protocol, expectedProtocol);
    assert.equal(route.api_base, expectedApiBase(provider));
  }
  assert.deepEqual([...protocols].sort(), ["anthropic", "openai", "openai-responses"]);
});

test("gateway config contains routing metadata only and writes atomically", () => {
  const serialized = JSON.stringify(renderGatewayConfig());
  assert.doesNotMatch(serialized, /api_key|authorization|internal.?key|provider.?key|secret/i);
  assert.match(gatewayConfigPath, /gateway\.json$/);
  assert.match(gatewayBinaryPath, /rust[\\/]gateway[\\/]target[\\/]release[\\/]codex-router-gateway/);

  const root = mkdtempSync(path.join(os.tmpdir(), "gateway-config-"));
  const target = path.join(root, "nested", "gateway.json");
  try {
    assert.equal(writeGatewayConfig(target), target);
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), renderGatewayConfig());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
