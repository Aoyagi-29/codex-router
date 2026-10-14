import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rustBinary = path.join(root, "rust", "gateway", "target", "release", "codex-router-gateway");
const litellmBinary = path.join(root, ".venv", "bin", "litellm");
const KEY = "fixture-internal-key";
const MODEL = "fixture-chat";
const REPLY = "fixture reply";
const REQUESTS = 30;
const REQUEST_TIMEOUT_MS = 3_000;
const TEMP_PREFIX = "codex-router-benchmark-";

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  server.close();
  await once(server, "close");
  return port;
}

async function portIsFree(port) {
  const server = net.createServer();
  try {
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
    server.close();
    await once(server, "close");
    return true;
  } catch {
    server.close();
    return false;
  }
}

async function benchmarkTempFingerprint() {
  const names = (await readdir(os.tmpdir())).filter((name) => name.startsWith(TEMP_PREFIX)).sort();
  return {
    count: names.length,
    names,
    fingerprint: createHash("sha256").update(names.join("\n")).digest("hex"),
  };
}

async function makeUpstream() {
  let requestCount = 0;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "invalid fixture request" }));
      return;
    }
    requestCount += 1;
    if (request.url !== "/v1/chat/completions" || request.method !== "POST") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unexpected fixture route" }));
      return;
    }
    const forced = Boolean(body.tool_choice) && Array.isArray(body.tools) && body.tools.length > 0;
    const completion = forced
      ? {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_fixture",
              type: "function",
              function: { name: "fixture_tool", arguments: "{\"value\":\"ok\"}" },
            },
          ],
        }
      : { role: "assistant", content: REPLY };
    const result = {
      id: "chatcmpl_fixture_benchmark",
      object: "chat.completion",
      model: "fixture-chat",
      choices: [
        {
          index: 0,
          message: completion,
          finish_reason: forced ? "tool_calls" : "stop",
        },
      ],
      usage: { prompt_tokens: 16, completion_tokens: 4, total_tokens: 20 },
    };
    const raw = Buffer.from(JSON.stringify(result));
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(raw.length),
    });
    response.end(raw);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    server,
    port: server.address().port,
    get requestCount() {
      return requestCount;
    },
    async close() {
      if (!server.listening) return;
      server.close();
      await Promise.race([once(server, "close"), sleep(1_000)]);
    },
  };
}

async function writeRustConfig(directory, port) {
  const configPath = path.join(directory, "rust-config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      models: [
        {
          model_name: MODEL,
          model: MODEL,
          protocol: "openai",
          api_base: "http://127.0.0.1:" + String(port) + "/v1",
        },
      ],
    }),
    { mode: 0o600 },
  );
  return configPath;
}

async function writeLiteLLMConfig(directory, port) {
  const configPath = path.join(directory, "litellm-config.yaml");
  const yaml = [
    "model_list:",
    "  - model_name: fixture-chat",
    "    litellm_params:",
    "      model: openai/fixture-chat",
    "      api_base: http://127.0.0.1:" + String(port) + "/v1",
    "      api_key: fixture-internal-key",
    "      use_chat_completions_api: true",
    "general_settings:",
    "  master_key: fixture-internal-key",
    "  disable_spend_logs: true",
    "",
  ].join("\n");
  await writeFile(configPath, yaml, { mode: 0o600 });
  return configPath;
}

function childEnvironment() {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key === "DATABASE_URL" || key.startsWith("SUPABASE")) delete environment[key];
  }
  environment.CODEX_ROUTER_INTERNAL_KEY = KEY;
  environment.LITELLM_LOCAL_MODEL_COST_MAP = "true";
  environment.DO_NOT_TRACK = "true";
  environment.NO_TELEMETRY = "1";
  environment.NO_PROXY = "127.0.0.1,localhost";
  environment.no_proxy = "127.0.0.1,localhost";
  return environment;
}

function readProcStartTime(pid) {
  try {
    const raw = readFileSync("/proc/" + String(pid) + "/stat", "utf8");
    const rest = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
    return rest[19] || null;
  } catch {
    return null;
  }
}

function readProcStatus(pid) {
  try {
    const raw = readFileSync("/proc/" + String(pid) + "/status", "utf8");
    const match = raw.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function readProcIo(pid) {
  try {
    const raw = readFileSync("/proc/" + String(pid) + "/io", "utf8");
    const values = {};
    for (const line of raw.split("\n")) {
      const match = line.match(/^(rchar|read_bytes|write_bytes):\s+(\d+)$/);
      if (match) values[match[1]] = Number(match[2]);
    }
    return values.rchar === undefined || values.read_bytes === undefined || values.write_bytes === undefined
      ? null
      : values;
  } catch {
    return null;
  }
}

async function stopChild(child) {
  if (!child || (child.exitCode !== null && child.signalCode !== null)) return;
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await Promise.race([exited, sleep(3_000)]);
  }
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await Promise.race([exited, sleep(500)]);
  }
}

async function waitForHealth(child, port, timeoutMs) {
  const start = performance.now();
  const deadline = start + timeoutMs;
  while (performance.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("startup failed");
    for (const route of ["/health", "/health/liveliness"]) {
      try {
        const response = await fetch("http://127.0.0.1:" + String(port) + route, {
          headers: { authorization: "Bearer " + KEY },
          signal: AbortSignal.timeout(1_000),
        });
        if (response.status === 200) return performance.now() - start;
      } catch {
        // The local process is still starting.
      }
    }
    await sleep(100);
  }
  throw new Error("health timeout");
}

function normalizeResponse(body, status) {
  const output = Array.isArray(body?.output) ? body.output : [];
  const text = output
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((part) => part.type === "output_text")
    .map((part) => part.text || "")
    .join("") || (typeof body?.output_text === "string" ? body.output_text : "");
  const usage = body?.usage || {};
  return {
    status,
    complete: body?.status === "completed" || body?.choices?.[0]?.finish_reason === "stop",
    text,
    input_tokens: usage.input_tokens ?? usage.prompt_tokens ?? null,
    output_tokens: usage.output_tokens ?? usage.completion_tokens ?? null,
    total_tokens: usage.total_tokens ?? null,
    tool_call: output.some((item) => item.type === "function_call") ||
      Boolean(body?.choices?.[0]?.message?.tool_calls),
  };
}

async function sendRequest(port, body) {
  const started = performance.now();
  try {
    const response = await fetch("http://127.0.0.1:" + String(port) + "/v1/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer " + KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const raw = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {};
    }
    return { latency_ms: performance.now() - started, ...normalizeResponse(parsed, response.status) };
  } catch {
    return {
      latency_ms: performance.now() - started,
      status: null,
      complete: false,
      text: "",
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      tool_call: false,
      error: "request failed",
    };
  }
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return Number(sorted[index].toFixed(3));
}

function summarizeRequests(results) {
  const latencies = results.map((result) => result.latency_ms);
  const usageMatches = results.filter(
    (result) => result.input_tokens === 16 && result.output_tokens === 4 && result.total_tokens === 20,
  ).length;
  const texts = results.filter((result) => result.text === REPLY).length;
  const statuses = {};
  for (const result of results) {
    const key = result.status === null ? "error" : String(result.status);
    statuses[key] = (statuses[key] || 0) + 1;
  }
  return {
    requests: results.length,
    completed: results.filter((result) => result.complete).length,
    text_matches: texts,
    usage_matches: usageMatches,
    statuses,
    latency_ms: {
      median: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
    },
  };
}

async function runRunner(name, command, args, startupTimeoutMs, directory, upstreamPort) {
  const port = await freePort();
  const child = spawn(command, args.concat(["--host", "127.0.0.1", "--port", String(port)]), {
    cwd: root,
    env: childEnvironment(),
    stdio: ["ignore", "ignore", "ignore"],
  });
  const metadata = {
    name,
    pid: child.pid || null,
    command_basename: path.basename(command),
    starttime: child.pid ? readProcStartTime(child.pid) : null,
  };
  let startupMs;
  let results = [];
  let forced;
  let ioAtSpawn = child.pid ? readProcIo(child.pid) : null;
  let ioAtSettle = null;
  let ioAtIdleEnd = null;
  let rssAfterSettle = null;
  let portClosed = false;
  try {
    startupMs = await waitForHealth(child, port, startupTimeoutMs);
    await sleep(1_000);
    ioAtSpawn = ioAtSpawn || (child.pid ? readProcIo(child.pid) : null);
    ioAtSettle = child.pid ? readProcIo(child.pid) : null;
    rssAfterSettle = child.pid ? readProcStatus(child.pid) : null;
    await sleep(3_000);
    ioAtIdleEnd = child.pid ? readProcIo(child.pid) : null;
    for (let index = 0; index < REQUESTS; index += 1) {
      results.push(
        await sendRequest(port, {
          model: MODEL,
          input: "benchmark fixture",
          max_output_tokens: 32,
          stream: false,
        }),
      );
    }
    forced = await sendRequest(port, {
      model: MODEL,
      input: "benchmark forced tool fixture",
      tools: [
        {
          type: "function",
          name: "fixture_tool",
          description: "Return the fixture tool marker.",
          parameters: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
        },
      ],
      tool_choice: { type: "function", name: "fixture_tool" },
      stream: false,
    });
  } finally {
    await stopChild(child);
    portClosed = await portIsFree(port);
  }
  const ioDelta = (from, to) => {
    if (!from || !to) return null;
    return {
      rchar: to.rchar - from.rchar,
      read_bytes: to.read_bytes - from.read_bytes,
      write_bytes: to.write_bytes - from.write_bytes,
    };
  };
  return {
    ...metadata,
    startup_ms: startupMs === undefined ? null : Number(startupMs.toFixed(3)),
    rss_kb_after_health_plus_1s: rssAfterSettle,
    io_startup_delta: ioDelta(ioAtSpawn, ioAtSettle),
    io_idle_3s_delta: ioDelta(ioAtSettle, ioAtIdleEnd),
    requests: summarizeRequests(results),
    forced_tool: forced
      ? {
          status: forced.status,
          complete: forced.complete,
          tool_call: forced.tool_call,
          usage: {
            input_tokens: forced.input_tokens,
            output_tokens: forced.output_tokens,
            total_tokens: forced.total_tokens,
          },
        }
      : null,
    port_closed: portClosed,
    upstream_port: upstreamPort,
    config_directory: path.basename(directory),
  };
}

function parity(runners) {
  if (runners.length !== 2 || runners.some((runner) => !runner.requests)) return false;
  const first = runners[0].requests;
  return runners.every((runner) => {
    const current = runner.requests;
    return current.requests === first.requests &&
      current.completed === first.completed &&
      current.text_matches === first.text_matches &&
      current.usage_matches === first.usage_matches;
  });
}

async function main() {
  if (!process.argv.includes("--run")) {
    console.log(JSON.stringify({
      run: false,
      local_only: true,
      usage: "pass --run to compare the local Rust gateway and local LiteLLM stub benchmark",
    }));
    return;
  }
  if (!existsSync(rustBinary) || !existsSync(litellmBinary)) {
    console.log(JSON.stringify({ run: true, ok: false, error: "required local runtime missing" }));
    process.exitCode = 1;
    return;
  }
  const baseline = await benchmarkTempFingerprint();
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX));
  const upstream = await makeUpstream();
  const runners = [];
  try {
    const rustConfig = await writeRustConfig(temporaryDirectory, upstream.port);
    const litellmConfig = await writeLiteLLMConfig(temporaryDirectory, upstream.port);
    runners.push(
      await runRunner(
        "rust",
        rustBinary,
        ["--config", rustConfig],
        45_000,
        temporaryDirectory,
        upstream.port,
      ),
    );
    runners.push(
      await runRunner(
        "litellm",
        litellmBinary,
        ["--config", litellmConfig, "--telemetry", "false"],
        90_000,
        temporaryDirectory,
        upstream.port,
      ),
    );
  } catch {
    runners.push({ name: "benchmark", error: "runner did not complete", port_closed: false });
  } finally {
    await upstream.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  const after = await benchmarkTempFingerprint();
  const ok = runners.length === 2 &&
    runners.every((runner) => runner.error === undefined && runner.port_closed === true) &&
    parity(runners);
  console.log(JSON.stringify({
    run: true,
    ok,
    local_only: true,
    warm_cache: true,
    cache_note: "Filesystem and page cache were not flushed; startup read counters are logical reads and cache-dependent.",
    request_contract: {
      count: REQUESTS,
      stream: false,
      timeout_ms: REQUEST_TIMEOUT_MS,
      upstream_reply: REPLY,
      usage: { prompt_tokens: 16, completion_tokens: 4, total_tokens: 20 },
    },
    upstream_requests: upstream.requestCount,
    parity: parity(runners),
    runners,
    temp_baseline: { count: baseline.count, fingerprint: baseline.fingerprint },
    temp_after: { count: after.count, fingerprint: after.fingerprint, restored: after.fingerprint === baseline.fingerprint },
  }));
  if (!ok) process.exitCode = 1;
}

await main();
