import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gatewayBinary = path.resolve(
  process.env.CODEX_ROUTER_GATEWAY_BIN ||
    path.join(root, "rust", "gateway", "target", "release", "codex-router-gateway"),
);
const gatewayReady = existsSync(gatewayBinary);
const INTERNAL_KEY = "fixture-internal-key";

function integrationTest(name, fn) {
  test(name, { timeout: 20_000, skip: gatewayReady ? false : "Rust gateway release binary is not built" }, fn);
}

function delay(milliseconds) {
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

function parseJson(raw) {
  if (!raw.length) return undefined;
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    return undefined;
  }
}

async function createUpstream(handler) {
  const requests = [];
  let resolveAnyResponseClose;
  const anyResponseClose = new Promise((resolve) => {
    resolveAnyResponseClose = resolve;
  });
  const server = http.createServer((request, response) => {
    const chunks = [];
    let ended = false;
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("aborted", () => {
      request.fixtureAborted = true;
    });
    request.on("end", async () => {
      ended = true;
      const rawBody = Buffer.concat(chunks);
      const item = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        rawBody,
        body: parseJson(rawBody),
        response,
        request,
        responseClosed: false,
      };
      requests.push(item);
      response.once("close", () => {
        item.responseClosed = !response.writableEnded;
        resolveAnyResponseClose(item);
      });
      try {
        await handler(item, response);
      } catch {
        if (!response.headersSent) {
          response.writeHead(500, { "content-type": "application/json" });
        }
        if (!response.writableEnded) response.end(JSON.stringify({ error: "fixture failure" }));
      }
    });
    request.on("close", () => {
      if (!ended) request.fixtureAborted = true;
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    server,
    port: server.address().port,
    requests,
    anyResponseClose,
    async close() {
      server.closeAllConnections?.();
      server.closeIdleConnections?.();
      if (server.listening) {
        server.close();
        await Promise.race([once(server, "close"), delay(1_000)]);
      }
    },
  };
}

function sendJson(response, status, body, headers = {}) {
  const raw = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(raw.length),
    ...headers,
  });
  response.end(raw);
}

function sendSse(response, chunks, headers = {}) {
  response.writeHead(200, { "content-type": "text/event-stream", ...headers });
  for (const chunk of chunks) response.write(chunk);
  response.end();
}

function configFor(port) {
  const base = "http://127.0.0.1:" + String(port);
  return {
    models: [
      {
        model_name: "fixture-chat",
        model: "upstream-chat",
        protocol: "openai",
        api_base: base + "/v1",
      },
      {
        model_name: "anthropicfixture",
        model: "upstream-anthropic",
        protocol: "anthropic",
        api_base: base,
      },
      {
        model_name: "responsesfixture",
        model: "upstream-responses",
        protocol: "openai-responses",
        api_base: base + "/v1",
      },
    ],
  };
}

function signedAnthropicConfig(port) {
  const config = configFor(port);
  return {
    ...config,
    models: config.models.map((route) =>
      route.model_name === "anthropicfixture"
        ? { ...route, model_name: "fixture-anthropic" }
        : route,
    ),
  };
}

async function waitForGateway(port, child) {
  const url = "http://127.0.0.1:" + String(port) + "/health";
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Rust gateway exited before readiness");
    }
    try {
      const response = await fetch(url, {
        headers: { authorization: "Bearer " + INTERNAL_KEY },
        signal: AbortSignal.timeout(500),
      });
      if (response.status < 500) return;
    } catch {
      // The listener is still starting.
    }
    await delay(80);
  }
  throw new Error("Timed out waiting for Rust gateway");
}

async function stopGateway(child) {
  if (!child || (child.exitCode !== null && child.signalCode !== null)) return;
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), delay(3_000)]);
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([once(child, "exit"), delay(500)]);
  }
}

async function withGateway(handler, callback, configFactory = configFor) {
  const upstream = await createUpstream(handler);
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "codex-router-rust-gateway-"));
  let child;
  try {
    const configPath = path.join(temporaryDirectory, "config.json");
    await writeFile(configPath, JSON.stringify(configFactory(upstream.port)), { mode: 0o600 });
    const gatewayPort = await freePort();
    child = spawn(
      gatewayBinary,
      ["--config", configPath, "--host", "127.0.0.1", "--port", String(gatewayPort)],
      {
        cwd: root,
        env: { ...process.env, CODEX_ROUTER_INTERNAL_KEY: INTERNAL_KEY },
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    await waitForGateway(gatewayPort, child);
    await callback({
      baseUrl: "http://127.0.0.1:" + String(gatewayPort),
      upstream,
    });
  } finally {
    await stopGateway(child);
    await upstream.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function gatewayRequest(baseUrl, route, body, options = {}) {
  const headers = { ...options.headers };
  if (options.key !== null) {
    headers.authorization = "Bearer " + (options.key === undefined ? INTERNAL_KEY : options.key);
  }
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(baseUrl + route, {
    method: options.method || (body === undefined ? "GET" : "POST"),
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: options.signal,
  });
}

async function responseJson(response) {
  const raw = await response.text();
  assert.notEqual(raw, "", "gateway returned an empty response");
  return JSON.parse(raw);
}

function parseSse(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  const events = [];
  let eventName = "";
  let data = [];
  const flush = () => {
    if (eventName || data.length) {
      events.push({ event: eventName, data: data.join("\n") });
    }
    eventName = "";
    data = [];
  };
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    if (field === "data") data.push(value);
  }
  flush();
  return events
    .filter((entry) => entry.data !== "[DONE]")
    .map((entry) => ({ ...entry, json: JSON.parse(entry.data) }));
}

function assertUpstreamRequest(request, model, url) {
  assert.equal(request.method, "POST");
  assert.equal(request.url, url);
  assert.equal(request.headers.authorization, "Bearer " + INTERNAL_KEY);
  assert.equal(request.body.model, model);
}

function responseText(body) {
  const output = Array.isArray(body.output) ? body.output : [];
  return output
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((part) => part.type === "output_text")
    .map((part) => part.text)
    .join("");
}

function outputItem(body, type) {
  return (body.output || []).find((item) => item.type === type);
}

integrationTest("protected health, models, and responses routes reject missing and bad bearer keys", async () => {
  await withGateway(async () => {}, async ({ baseUrl }) => {
    const protectedRoutes = [
      { route: "/health", method: "GET" },
      { route: "/health/liveliness", method: "GET" },
      { route: "/v1/models", method: "GET" },
      { route: "/v1/responses", method: "POST" },
      { route: "/responses", method: "POST" },
    ];
    for (const entry of protectedRoutes) {
      const body = entry.method === "POST" ? { model: "fixture-chat", input: "auth probe" } : undefined;
      const missing = await gatewayRequest(baseUrl, entry.route, body, {
        method: entry.method,
        key: null,
      });
      assert.equal(missing.status, 401, entry.route + " missing key");
      const bad = await gatewayRequest(baseUrl, entry.route, body, {
        method: entry.method,
        key: "wrong-fixture-key",
      });
      assert.equal(bad.status, 401, entry.route + " bad key");
    }
  });
});

integrationTest("authorized health and models routes expose the configured gateway", async () => {
  await withGateway(async () => {}, async ({ baseUrl }) => {
    for (const route of ["/health", "/health/liveliness"]) {
      const response = await gatewayRequest(baseUrl, route, undefined);
      assert.equal(response.status, 200, route);
      const body = await responseJson(response);
      assert.equal(body.ok, true);
      assert.equal(body.backend, "rust");
    }
    const response = await gatewayRequest(baseUrl, "/v1/models", undefined);
    assert.equal(response.status, 200);
    const body = await responseJson(response);
    assert.deepEqual(
      body.data.map((entry) => entry.id),
      ["anthropicfixture", "fixture-chat", "responsesfixture"],
    );
  });
});

integrationTest("unknown model is rejected with 400 before contacting an upstream", async () => {
  await withGateway(async () => {
    throw new Error("unknown models must not reach the upstream stub");
  }, async ({ baseUrl, upstream }) => {
    const response = await gatewayRequest(baseUrl, "/v1/responses", {
      model: "does-not-exist",
      input: "unknown model",
      stream: false,
    });
    assert.equal(response.status, 400);
    const body = await responseJson(response);
    assert.equal(body.error.code, "unknown_model");
    assert.equal(upstream.requests.length, 0);
  });
});

integrationTest("Responses input string and instructions become a non-stream Chat request with text, usage, and controls", async () => {
  await withGateway(async (request, response) => {
    assertUpstreamRequest(request, "upstream-chat", "/v1/chat/completions");
    sendJson(response, 200, {
      id: "chatcmpl_fixture_text",
      object: "chat.completion",
      model: "upstream-chat",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "fixture chat answer" },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 7,
        completion_tokens: 3,
        total_tokens: 10,
      },
    });
  }, async ({ baseUrl, upstream }) => {
    const schema = {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    };
    const response = await gatewayRequest(baseUrl, "/v1/responses", {
      model: "fixture-chat",
      input: "fixture user prompt",
      instructions: "fixture system instruction",
      max_output_tokens: 42,
      reasoning: { effort: "high" },
      text: {
        format: {
          type: "json_schema",
          name: "answer",
          schema,
          strict: true,
        },
      },
      parallel_tool_calls: false,
      stream: false,
    });
    assert.equal(response.status, 200);
    const body = await responseJson(response);
    assert.equal(responseText(body), "fixture chat answer");
    assert.equal(body.status, "completed");
    assert.deepEqual(body.usage, {
      input_tokens: 7,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 3,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 10,
    });
    const request = upstream.requests[0];
    assert.deepEqual(request.body.messages, [
      { role: "system", content: "fixture system instruction" },
      { role: "user", content: "fixture user prompt" },
    ]);
    assert.equal(request.body.max_tokens, 42);
    assert.equal(request.body.reasoning_effort, "high");
    assert.equal(request.body.parallel_tool_calls, false);
    assert.deepEqual(request.body.response_format, {
      type: "json_schema",
      json_schema: {
        name: "answer",
        schema,
        strict: true,
      },
    });
  });
});

integrationTest("Responses message image, function call, and function call output become Chat messages", async () => {
  await withGateway(async (request, response) => {
    assertUpstreamRequest(request, "upstream-chat", "/v1/chat/completions");
    sendJson(response, 200, {
      id: "chatcmpl_fixture_history",
      object: "chat.completion",
      model: "upstream-chat",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "history accepted" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    });
  }, async ({ baseUrl, upstream }) => {
    const response = await gatewayRequest(baseUrl, "/v1/responses", {
      model: "fixture-chat",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Inspect this image" },
            {
              type: "input_image",
              image_url: "data:image/png;base64,ZmFrZS1pbWFnZQ==",
              detail: "high",
            },
          ],
        },
        {
          type: "function_call",
          call_id: "call_lookup",
          name: "lookup",
          arguments: "{\"query\":\"fixture\"}",
        },
        {
          type: "function_call_output",
          call_id: "call_lookup",
          output: "{\"value\":\"fixture result\"}",
        },
      ],
      stream: false,
    });
    assert.equal(response.status, 200);
    assert.equal(responseText(await responseJson(response)), "history accepted");
    const messages = upstream.requests[0].body.messages;
    assert.deepEqual(messages[0], {
      role: "user",
      content: [
        { type: "text", text: "Inspect this image" },
        {
          type: "image_url",
          image_url: {
            url: "data:image/png;base64,ZmFrZS1pbWFnZQ==",
            detail: "high",
          },
        },
      ],
    });
    assert.deepEqual(messages[1], {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_lookup",
          type: "function",
          function: {
            name: "lookup",
            arguments: "{\"query\":\"fixture\"}",
          },
        },
      ],
    });
    assert.deepEqual(messages[2], {
      role: "tool",
      tool_call_id: "call_lookup",
      content: "{\"value\":\"fixture result\"}",
    });
  });
});

integrationTest("Responses function tool schemas and tool choice become Chat function controls", async () => {
  await withGateway(async (request, response) => {
    assertUpstreamRequest(request, "upstream-chat", "/v1/chat/completions");
    sendJson(response, 200, {
      id: "chatcmpl_fixture_tools",
      object: "chat.completion",
      model: "upstream-chat",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "tool schema accepted" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
    });
  }, async ({ baseUrl, upstream }) => {
    const parameters = {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    };
    const response = await gatewayRequest(baseUrl, "/v1/responses", {
      model: "fixture-chat",
      input: "Use the lookup function",
      tools: [
        {
          type: "function",
          name: "lookup",
          description: "Look up a fixture",
          parameters,
          strict: true,
        },
      ],
      tool_choice: { type: "function", name: "lookup" },
      parallel_tool_calls: true,
      stream: false,
    });
    assert.equal(response.status, 200);
    assert.equal(responseText(await responseJson(response)), "tool schema accepted");
    const request = upstream.requests[0].body;
    assert.deepEqual(request.tools, [
      {
        type: "function",
        function: {
          name: "lookup",
          description: "Look up a fixture",
          parameters,
          strict: true,
        },
      },
    ]);
    assert.deepEqual(request.tool_choice, {
      type: "function",
      function: { name: "lookup" },
    });
    assert.equal(request.parallel_tool_calls, true);
  });
});

integrationTest("custom apply_patch uses one content string schema and returns a custom_tool_call raw input", async () => {
  await withGateway(async (request, response) => {
    assertUpstreamRequest(request, "upstream-chat", "/v1/chat/completions");
    assert.deepEqual(request.body.tools, [
      {
        type: "function",
        function: {
          name: "apply_patch",
          description: "Apply a patch\n\nFormat:\n\`\`\`lark\nstart: patch\npatch: /.+/\n\`\`\`",
          parameters: {
            type: "object",
            properties: {
              content: {
                type: "string",
                description: "The apply_patch content following the specified format",
              },
            },
            required: ["content"],
          },
        },
      },
    ]);
    sendJson(response, 200, {
      id: "chatcmpl_fixture_patch",
      object: "chat.completion",
      model: "upstream-chat",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_patch",
                type: "function",
                function: {
                  name: "apply_patch",
                  arguments: "{\"content\":\"*** Begin Patch\\n*** End Patch\"}",
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 },
    });
  }, async ({ baseUrl }) => {
    const response = await gatewayRequest(baseUrl, "/v1/responses", {
      model: "fixture-chat",
      input: "Apply the patch",
      tools: [
        {
          type: "custom",
          name: "apply_patch",
          description: "Apply a patch",
          format: {
            type: "grammar",
            syntax: "lark",
            definition: "start: patch\npatch: /.+/",
          },
        },
      ],
      stream: false,
    });
    assert.equal(response.status, 200);
    const body = await responseJson(response);
    const patchCall = outputItem(body, "custom_tool_call");
    assert.ok(patchCall);
    assert.equal(patchCall.id, "call_patch");
    assert.equal(patchCall.call_id, "call_patch");
    assert.equal(patchCall.name, "apply_patch");
    assert.equal(patchCall.input, "*** Begin Patch\n*** End Patch");
  });
});

integrationTest("custom tool follow-up input wraps the custom call arguments as content", async () => {
  await withGateway(async (request, response) => {
    assertUpstreamRequest(request, "upstream-chat", "/v1/chat/completions");
    sendJson(response, 200, {
      id: "chatcmpl_fixture_patch_followup",
      object: "chat.completion",
      model: "upstream-chat",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "follow-up accepted" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
    });
  }, async ({ baseUrl, upstream }) => {
    const response = await gatewayRequest(baseUrl, "/v1/responses", {
      model: "fixture-chat",
      input: [
        {
          type: "custom_tool_call",
          call_id: "call_patch",
          name: "apply_patch",
          input: "*** Begin Patch\n*** End Patch",
        },
        {
          type: "custom_tool_call_output",
          call_id: "call_patch",
          output: "patch applied",
        },
      ],
      tools: [
        {
          type: "custom",
          name: "apply_patch",
          format: { type: "grammar", syntax: "lark", definition: "start: patch" },
        },
      ],
      stream: false,
    });
    assert.equal(response.status, 200);
    assert.equal(responseText(await responseJson(response)), "follow-up accepted");
    assert.deepEqual(upstream.requests[0].body.messages, [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_patch",
            type: "function",
            function: {
              name: "apply_patch",
              arguments: "{\"content\":\"*** Begin Patch\\n*** End Patch\"}",
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_patch",
        content: "patch applied",
      },
    ]);
  });
});

integrationTest("Chat SSE handles fragmented JSON, split UTF-8, CRLF comments, reasoning, tools, and usage", async () => {
  await withGateway(async (request, response) => {
    assertUpstreamRequest(request, "upstream-chat", "/v1/chat/completions");
    assert.equal(request.body.stream, true);
    assert.deepEqual(request.body.stream_options, { include_usage: true });
    const frames = [
      Buffer.from(": fixture comment\r\n\r\n"),
      Buffer.from(
        "data: {\"id\":\"chat_sse\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"こんにちは\"}}]}\r\n\r\n",
      ),
      Buffer.from(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\" world\"}}]}\r\n\r\n",
      ),
      Buffer.from(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"考\"}}]}\r\n\r\n",
      ),
      Buffer.from(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_read\",\"type\":\"function\",\"function\":{\"name\":\"read\",\"arguments\":\"{\\\\\"path\\\\\":\"}}]}}]}\r\n\r\n",
      ),
      Buffer.from(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\\\"file\\\\\"}\"}}]}}]}\r\n\r\n",
      ),
      Buffer.from(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":1,\"id\":\"call_write\",\"type\":\"function\",\"function\":{\"name\":\"write\",\"arguments\":\"{\\\\\"path\\\\\":\"}}]}}]}\r\n\r\n",
      ),
      Buffer.from(
        "data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":1,\"function\":{\"arguments\":\"\\\\\"out\\\\\"}\"}}]}}]}\r\n\r\n",
      ),
      Buffer.from(
        "data: {\"choices\":[{\"index\":0,\"finish_reason\":\"tool_calls\",\"delta\":{}}],\"usage\":{\"prompt_tokens\":11,\"completion_tokens\":8,\"total_tokens\":19}}\r\n\r\n",
      ),
      Buffer.from("data: [DONE]\r\n\r\n"),
    ];
    const chatFrame = (value) => "data: " + JSON.stringify(value) + "\r\n\r\n";
    frames.splice(
      0,
      frames.length,
      Buffer.from(": fixture comment\r\n\r\n"),
      Buffer.from(
        chatFrame({
          id: "chat_sse",
          choices: [{ index: 0, delta: { role: "assistant", content: "こんにちは" } }],
        }),
      ),
      Buffer.from(chatFrame({ choices: [{ index: 0, delta: { content: " world" } }] })),
      Buffer.from(chatFrame({ choices: [{ index: 0, delta: { reasoning_content: "考" } }] })),
      Buffer.from(
        chatFrame({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_read",
                    type: "function",
                    function: { name: "read", arguments: '{"path":' },
                  },
                ],
              },
            },
          ],
        }),
      ),
      Buffer.from(
        chatFrame({
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: '"file"}' } }] },
            },
          ],
        }),
      ),
      Buffer.from(
        chatFrame({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 1,
                    id: "call_write",
                    type: "function",
                    function: { name: "write", arguments: '{"path":' },
                  },
                ],
              },
            },
          ],
        }),
      ),
      Buffer.from(
        chatFrame({
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 1, function: { arguments: '"out"}' } }] },
            },
          ],
        }),
      ),
      Buffer.from(
        chatFrame({
          choices: [{ index: 0, finish_reason: "tool_calls", delta: {} }],
          usage: { prompt_tokens: 11, completion_tokens: 8, total_tokens: 19 },
        }),
      ),
      Buffer.from("data: [DONE]\r\n\r\n"),
    );
    const utf8 = frames[1];
    const split = utf8.indexOf(Buffer.from("に"));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(frames[0]);
    response.write(utf8.subarray(0, split + 1));
    response.write(utf8.subarray(split + 1));
    for (const frame of frames.slice(2)) response.write(frame);
    response.end();
  }, async ({ baseUrl }) => {
    const response = await gatewayRequest(baseUrl, "/v1/responses", {
      model: "fixture-chat",
      input: "streaming fixture",
      stream: true,
    });
    assert.equal(response.status, 200);
    const events = parseSse(Buffer.from(await response.arrayBuffer()));
    const text = events
      .filter((entry) => entry.json.type === "response.output_text.delta")
      .map((entry) => entry.json.delta)
      .join("");
    assert.equal(text, "こんにちは world");
    const reasoning = events
      .filter((entry) => entry.json.type === "response.reasoning_summary_text.delta")
      .map((entry) => entry.json.delta)
      .join("");
    assert.equal(reasoning, "考");
    const tools = events
      .filter((entry) => entry.json.type === "response.output_item.added")
      .map((entry) => entry.json.item)
      .filter((item) => item.type === "function_call");
    assert.equal(tools.length, 2);
    assert.deepEqual(
      tools.map((item) => [item.call_id, item.name]),
      [
        ["call_read", "read"],
        ["call_write", "write"],
      ],
    );
    const deltas = events
      .filter((entry) => entry.json.type === "response.function_call_arguments.delta")
      .reduce((map, entry) => {
        const key = entry.json.item_id;
        map.set(key, (map.get(key) || "") + entry.json.delta);
        return map;
      }, new Map());
    assert.equal(deltas.get("call_read"), "{\"path\":\"file\"}");
    assert.equal(deltas.get("call_write"), "{\"path\":\"out\"}");
    const completed = events.find((entry) => entry.json.type === "response.completed");
    assert.ok(completed);
    assert.equal(completed.json.response.usage.input_tokens, 11);
    assert.equal(completed.json.response.usage.output_tokens, 8);
    assert.equal(completed.json.response.usage.total_tokens, 19);
  });
});

integrationTest("Responses SSE emits ordered created, in-progress, exact deltas, ids, indices, and completed output", async () => {
  await withGateway(async (request, response) => {
    assertUpstreamRequest(request, "upstream-chat", "/v1/chat/completions");
    const chunks = [
      "data: {\"id\":\"chat_output\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"one\"}}]}\n\n",
      "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\" two\"}}]}\n\n",
      "data: {\"choices\":[{\"index\":0,\"finish_reason\":\"stop\",\"delta\":{}}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2,\"total_tokens\":5}}\n\n",
      "data: [DONE]\n\n",
    ];
    sendSse(response, chunks);
  }, async ({ baseUrl }) => {
    const response = await gatewayRequest(baseUrl, "/v1/responses", {
      model: "fixture-chat",
      input: "lifecycle fixture",
      stream: true,
    });
    assert.equal(response.status, 200);
    const events = parseSse(Buffer.from(await response.arrayBuffer()));
    const types = events.map((entry) => entry.json.type);
    assert.equal(types[0], "response.created");
    assert.equal(types[1], "response.in_progress");
    assert.equal(types.at(-1), "response.completed");
    assert.ok(types.indexOf("response.output_text.delta") > types.indexOf("response.in_progress"));
    assert.ok(types.indexOf("response.output_item.done") < types.indexOf("response.completed"));
    const deltas = events
      .filter((entry) => entry.json.type === "response.output_text.delta")
      .map((entry) => entry.json);
    assert.deepEqual(deltas.map((entry) => entry.delta), ["one", " two"]);
    assert.ok(deltas.every((entry) => entry.output_index === 0 && entry.content_index === 0));
    const itemAdded = events.find((entry) => entry.json.type === "response.output_item.added");
    assert.ok(itemAdded);
    const itemId = itemAdded.json.item.id;
    assert.match(itemId, /^msg_/);
    assert.ok(deltas.every((entry) => entry.item_id === itemId));
    const completed = events.at(-1).json;
    assert.equal(completed.response.status, "completed");
    assert.equal(completed.response.output[0].id, itemId);
    assert.equal(completed.response.output[0].content[0].text, "one two");
  });
});

integrationTest("Anthropic requests convert system, messages, tools, and tool results and return text plus tool use", async () => {
  await withGateway(async (request, response) => {
    assertUpstreamRequest(request, "upstream-anthropic", "/messages");
    assert.deepEqual(request.body.system, [{ type: "text", text: "Anthropic system fixture" }]);
    assert.deepEqual(request.body.messages, [
      {
        role: "user",
        content: [{ type: "text", text: "Call the lookup tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_lookup",
            name: "lookup",
            input: { query: "fixture" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_lookup",
            content: [{ type: "text", text: "{\"value\":\"ok\"}" }],
          },
        ],
      },
    ]);
    assert.deepEqual(request.body.tools, [
      {
        name: "lookup",
        description: "Look up a fixture",
        input_schema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ]);
    assert.deepEqual(request.body.tool_choice, { type: "tool", name: "lookup" });
    assert.equal(request.body.max_tokens, 30);
    sendJson(response, 200, {
      id: "msg_fixture_anthropic",
      type: "message",
      role: "assistant",
      model: "upstream-anthropic",
      content: [
        { type: "text", text: "Anthropic answer" },
        {
          type: "tool_use",
          id: "toolu_next",
          name: "lookup",
          input: { query: "next" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 12, output_tokens: 7 },
    });
  }, async ({ baseUrl }) => {
    const response = await gatewayRequest(baseUrl, "/v1/responses", {
      model: "anthropicfixture",
      instructions: "Anthropic system fixture",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Call the lookup tool" }],
        },
        {
          type: "function_call",
          call_id: "call_lookup",
          name: "lookup",
          arguments: "{\"query\":\"fixture\"}",
        },
        {
          type: "function_call_output",
          call_id: "call_lookup",
          output: "{\"value\":\"ok\"}",
        },
      ],
      tools: [
        {
          type: "function",
          name: "lookup",
          description: "Look up a fixture",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      ],
      tool_choice: { type: "function", name: "lookup" },
      max_output_tokens: 30,
      stream: false,
    });
    assert.equal(response.status, 200);
    const body = await responseJson(response);
    assert.equal(responseText(body), "Anthropic answer");
    const call = outputItem(body, "function_call");
    assert.ok(call);
    assert.equal(call.id, "toolu_next");
    assert.equal(call.name, "lookup");
    assert.equal(call.arguments, "{\"query\":\"next\"}");
    assert.equal(body.usage.input_tokens, 12);
    assert.equal(body.usage.output_tokens, 7);
  });
});

integrationTest("signed Anthropic thinking and interleaved tools round-trip exactly once", async () => {
  const originalContent = [
    { type: "thinking", thinking: "fixture...", signature: "fixture_sig" },
    { type: "tool_use", id: "call1", name: "probe", input: { target: "one" } },
    { type: "redacted_thinking", data: "fixture_redacted" },
    { type: "tool_use", id: "call2", name: "probe", input: { target: "two" } },
  ];
  await withGateway(
    async (request, response) => {
      if (request.body.messages.length === 1) {
        sendJson(response, 200, {
          id: "msg_signed_fixture",
          type: "message",
          role: "assistant",
          model: "upstream-anthropic",
          content: originalContent,
          stop_reason: "tool_use",
          usage: { input_tokens: 16, output_tokens: 12 },
        });
        return;
      }
      sendJson(response, 200, {
        id: "msg_signed_followup",
        type: "message",
        role: "assistant",
        model: "upstream-anthropic",
        content: [{ type: "text", text: "simpletext completion" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 30, output_tokens: 3 },
      });
    },
    async ({ baseUrl, upstream }) => {
      const firstResponse = await gatewayRequest(baseUrl, "/v1/responses", {
        model: "fixture-anthropic",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "userinitial" }],
          },
        ],
        stream: false,
      });
      assert.equal(firstResponse.status, 200);
      const first = await responseJson(firstResponse);
      assert.deepEqual(upstream.requests[0].body.messages, [
        {
          role: "user",
          content: [{ type: "text", text: "userinitial" }],
        },
      ]);
      const reasoning = outputItem(first, "reasoning");
      assert.ok(reasoning?.encrypted_content);
      assert.ok(reasoning.encrypted_content.startsWith("codex-router-anthropic-v1:"));
      const signed = JSON.parse(
        reasoning.encrypted_content.slice("codex-router-anthropic-v1:".length),
      );
      assert.deepEqual(signed, { model: "fixture-anthropic", blocks: originalContent });
      assert.deepEqual(
        (first.output || []).filter((item) => item.type === "function_call").map((item) => item.call_id),
        ["call1", "call2"],
      );

      const followupResponse = await gatewayRequest(baseUrl, "/v1/responses", {
        model: "fixture-anthropic",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "userinitial" }],
          },
          ...(first.output || []),
          { type: "function_call_output", call_id: "call1", output: "tool result one" },
          { type: "function_call_output", call_id: "call2", output: "tool result two" },
        ],
        stream: false,
      });
      assert.equal(followupResponse.status, 200);
      assert.equal(responseText(await responseJson(followupResponse)), "simpletext completion");
      assert.equal(upstream.requests.length, 2);
      assert.equal(upstream.requests[1].body.model, "upstream-anthropic");
      assert.deepEqual(upstream.requests[1].body.messages[0], {
        role: "user",
        content: [{ type: "text", text: "userinitial" }],
      });
      const assistant = upstream.requests[1].body.messages[1];
      assert.deepEqual(assistant, { role: "assistant", content: originalContent });
      assert.equal(assistant.tool_calls, undefined, "signed tool calls must not be duplicated");
      assert.equal(upstream.requests[1].body.messages.length, 3);
      assert.deepEqual(upstream.requests[1].body.messages[2], {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call1",
            content: [{ type: "text", text: "tool result one" }],
          },
          {
            type: "tool_result",
            tool_use_id: "call2",
            content: [{ type: "text", text: "tool result two" }],
          },
        ],
      });
    },
    signedAnthropicConfig,
  );
});

integrationTest("signed Anthropic model binding drops mismatched blocks and rejects malformed context", async () => {
  await withGateway(
    async (request, response) => {
      assertUpstreamRequest(request, "upstream-anthropic", "/messages");
      const serialized = JSON.stringify(request.body.messages);
      assert.doesNotMatch(serialized, /fixture_sig|fixture_redacted|call1|raw-block-marker/);
      sendJson(response, 200, {
        id: "msg_binding_fixture",
        type: "message",
        role: "assistant",
        model: "upstream-anthropic",
        content: [{ type: "text", text: "binding accepted" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 4, output_tokens: 2 },
      });
    },
    async ({ baseUrl, upstream }) => {
      const mismatched = await gatewayRequest(baseUrl, "/v1/responses", {
        model: "fixture-anthropic",
        input: [
          {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "summary context" }],
            encrypted_content:
              "codex-router-anthropic-v1:" +
              JSON.stringify({
                model: "wrong-provider",
                blocks: [
                  { type: "thinking", thinking: "raw-block-marker", signature: "fixture_sig" },
                  { type: "tool_use", id: "call1", name: "probe", input: {} },
                ],
              }),
          },
        ],
        stream: false,
      });
      assert.equal(mismatched.status, 200);
      assert.equal(responseText(await responseJson(mismatched)), "binding accepted");
      const requestCount = upstream.requests.length;

      const malformed = await gatewayRequest(baseUrl, "/v1/responses", {
        model: "fixture-anthropic",
        input: [
          {
            type: "reasoning",
            summary: [],
            encrypted_content: "codex-router-anthropic-v1:not-json",
          },
        ],
        stream: false,
      });
      assert.equal(malformed.status, 400);
      assert.equal((await responseJson(malformed)).error.code, "invalid_input");
      assert.equal(upstream.requests.length, requestCount);
    },
    signedAnthropicConfig,
  );
});

integrationTest("Anthropic SSE message start, content blocks, deltas, stop, and usage become Responses events", async () => {
  await withGateway(async (request, response) => {
    assertUpstreamRequest(request, "upstream-anthropic", "/messages");
    assert.equal(request.body.stream, true);
    const anthropicData = (value) => "data: " + JSON.stringify(value) + "\n\n";
    const frames = [
      "event: message_start\n",
      "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_stream_anthropic\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"usage\":{\"input_tokens\":4}}}\n\n",
      "event: content_block_start\n",
      "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n",
      "event: content_block_delta\n",
      "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"stream thought\"}}\n\n",
      "event: content_block_delta\n",
      "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"fixture-sig-part-a\"}}\n\n",
      "event: content_block_delta\n",
      "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"-part-b\"}}\n\n",
      "event: content_block_stop\n",
      "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
      "event: content_block_start\n",
      "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
      "event: content_block_delta\n",
      "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"Anthropic \"}}\n\n",
      "event: content_block_delta\n",
      "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"stream\"}}\n\n",
      "event: content_block_stop\n",
      "data: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
      "event: content_block_start\n",
      "data: {\"type\":\"content_block_start\",\"index\":2,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_stream\",\"name\":\"lookup\",\"input\":{}}}\n\n",
      "event: content_block_delta\n",
      anthropicData({
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: '{"query":"' },
      }),
      "event: content_block_delta\n",
      anthropicData({
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: 'stream"}' },
      }),
      "event: message_delta\n",
      "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":5}}\n\n",
      "event: message_stop\n",
      "data: {\"type\":\"message_stop\"}\n\n",
    ];
    sendSse(response, frames);
  }, async ({ baseUrl }) => {
    const response = await gatewayRequest(baseUrl, "/v1/responses", {
      model: "anthropicfixture",
      input: "streaming Anthropic fixture",
      stream: true,
    });
    assert.equal(response.status, 200);
    const events = parseSse(Buffer.from(await response.arrayBuffer()));
    const text = events
      .filter((entry) => entry.json.type === "response.output_text.delta")
      .map((entry) => entry.json.delta)
      .join("");
    assert.equal(text, "Anthropic stream");
    const tool = events
      .filter((entry) => entry.json.type === "response.output_item.added")
      .map((entry) => entry.json.item)
      .find((item) => item.type === "function_call");
    assert.ok(tool);
    assert.equal(tool.id, "toolu_stream");
    const completed = events.find((entry) => entry.json.type === "response.completed");
    assert.ok(completed, events.map((entry) => entry.json.type).join(","));
    assert.equal(completed.json.response.status, "completed");
    assert.equal(completed.json.response.usage.input_tokens, 4);
    assert.equal(completed.json.response.usage.output_tokens, 5);
    const reasoning = completed.json.response.output.find((item) => item.type === "reasoning");
    assert.ok(reasoning?.encrypted_content);
    const signed = JSON.parse(
      reasoning.encrypted_content.slice("codex-router-anthropic-v1:".length),
    );
    assert.deepEqual(signed.blocks, [
      {
        type: "thinking",
        thinking: "stream thought",
        signature: "fixture-sig-part-a-part-b",
      },
      { type: "text", text: "Anthropic stream" },
      {
        type: "tool_use",
        id: "toolu_stream",
        name: "lookup",
        input: { query: "stream" },
      },
    ]);
  });
});

integrationTest("native Responses upstream JSON and streaming bodies pass through byte-for-byte", async () => {
  let call = 0;
  await withGateway(async (request, response) => {
    call += 1;
    assertUpstreamRequest(request, "upstream-responses", "/v1/responses");
    if (call === 1) {
      const raw = Buffer.from(
        ": native comment\r\n\r\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"こんにちは\"}\r\n\r\ndata: [DONE]\r\n\r\n",
        "utf8",
      );
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(raw);
      return;
    }
    const raw = Buffer.from(
      "{\"id\":\"resp_native\",\"object\":\"response\",\"status\":\"completed\",\"output\":[],\"usage\":null}",
      "utf8",
    );
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(raw.length),
    });
    response.end(raw);
  }, async ({ baseUrl }) => {
    const streamResponse = await gatewayRequest(baseUrl, "/v1/responses", {
      model: "responsesfixture",
      input: "native stream",
      stream: true,
    });
    assert.equal(streamResponse.status, 200);
    const streamRaw = Buffer.from(await streamResponse.arrayBuffer());
    assert.deepEqual(
      streamRaw,
      Buffer.from(
        ": native comment\r\n\r\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"こんにちは\"}\r\n\r\ndata: [DONE]\r\n\r\n",
        "utf8",
      ),
    );
    const jsonResponseBody = await gatewayRequest(baseUrl, "/v1/responses", {
      model: "responsesfixture",
      input: "native json",
      stream: false,
    });
    assert.equal(jsonResponseBody.status, 200);
    assert.deepEqual(
      Buffer.from(await jsonResponseBody.arrayBuffer()),
      Buffer.from(
        "{\"id\":\"resp_native\",\"object\":\"response\",\"status\":\"completed\",\"output\":[],\"usage\":null}",
        "utf8",
      ),
    );
  });
});

integrationTest("upstream 429 preserves rate-limit headers while returning a safe error body", async () => {
  await withGateway(async (request, response) => {
    assertUpstreamRequest(request, "upstream-chat", "/v1/chat/completions");
    sendJson(
      response,
      429,
      {
        error: {
          message: "private upstream details must not cross the gateway",
          type: "rate_limit_error",
        },
      },
      {
        "retry-after": "7",
        "x-ratelimit-limit-requests": "100",
        "x-ratelimit-remaining-requests": "0",
      },
    );
  }, async ({ baseUrl }) => {
    const response = await gatewayRequest(baseUrl, "/v1/responses", {
      model: "fixture-chat",
      input: "rate limit fixture",
      stream: false,
    });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "7");
    assert.equal(response.headers.get("x-ratelimit-limit-requests"), "100");
    assert.equal(response.headers.get("x-ratelimit-remaining-requests"), "0");
    const raw = await response.text();
    assert.doesNotMatch(raw, /private upstream details|fixture-internal-key|authorization|stack/i);
    const body = JSON.parse(raw);
    assert.equal(body.error.code, "upstream_error");
  });
});

integrationTest("client cancellation closes the upstream streaming request", async () => {
  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  await withGateway(async (request, response) => {
    assertUpstreamRequest(request, "upstream-chat", "/v1/chat/completions");
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"first\"}}]}\n\n");
    const interval = setInterval(() => {
      if (!response.destroyed) response.write("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"tick\"}}]}\n\n");
    }, 20);
    response.once("close", () => {
      clearInterval(interval);
      resolveClosed();
    });
  }, async ({ baseUrl }) => {
    const url = new URL("/v1/responses", baseUrl);
    await new Promise((resolve) => {
      const request = http.request(
        {
          hostname: url.hostname,
          port: Number(url.port),
          path: url.pathname,
          method: "POST",
          headers: {
            authorization: "Bearer " + INTERNAL_KEY,
            "content-type": "application/json",
          },
        },
        (response) => {
          response.once("data", () => {
            request.destroy();
            resolve();
          });
        },
      );
      request.once("error", () => resolve());
      request.end(JSON.stringify({ model: "fixture-chat", input: "cancel fixture", stream: true }));
    });
    await Promise.race([closed, delay(3_000)]);
    assert.equal(await Promise.race([closed.then(() => true), delay(50).then(() => false)]), true);
  });
});

integrationTest("premature upstream stream termination emits response.failed and never response.completed", async () => {
  await withGateway(async (request, response) => {
    assertUpstreamRequest(request, "upstream-chat", "/v1/chat/completions");
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"}}]}\n\n");
    setTimeout(() => response.destroy(), 30);
  }, async ({ baseUrl }) => {
    const response = await gatewayRequest(baseUrl, "/v1/responses", {
      model: "fixture-chat",
      input: "premature fixture",
      stream: true,
    });
    assert.equal(response.status, 200);
    const events = parseSse(Buffer.from(await response.arrayBuffer()));
    assert.ok(events.some((entry) => entry.json.type === "response.failed"));
    assert.equal(events.some((entry) => entry.json.type === "response.completed"), false);
    const failed = events.find((entry) => entry.json.type === "response.failed");
    assert.equal(failed.json.response.status, "failed");
  });
});

integrationTest("Chat finish_reason length becomes a response.incomplete result", async () => {
  await withGateway(async (request, response) => {
    assertUpstreamRequest(request, "upstream-chat", "/v1/chat/completions");
    sendJson(response, 200, {
      id: "chatcmpl_fixture_length",
      object: "chat.completion",
      model: "upstream-chat",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "truncated output" },
          finish_reason: "length",
        },
      ],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    });
  }, async ({ baseUrl }) => {
    const response = await gatewayRequest(baseUrl, "/v1/responses", {
      model: "fixture-chat",
      input: "length fixture",
      max_output_tokens: 2,
      stream: false,
    });
    assert.equal(response.status, 200);
    const body = await responseJson(response);
    assert.equal(body.status, "incomplete");
    assert.deepEqual(body.incomplete_details, { reason: "max_output_tokens" });
    assert.equal(responseText(body), "truncated output");
  });
});
