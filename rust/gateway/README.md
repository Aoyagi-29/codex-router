# Native Responses gateway

This Rust service replaces the LiteLLM process. The existing Node router and
credential forwarders keep model selection, provider profiles, authentication,
quota accounting, compaction and collaboration relay behavior.

The gateway translates Responses requests and streamed results for Chat
Completions and Anthropic Messages, and passes native Responses bodies through.
Function tools, custom grammar tools, tool-result follow-ups, images, reasoning,
usage, cancellation and incomplete/error responses are covered by loopback
fixtures. Anthropic signed thinking and interleaved assistant content are
preserved in an opaque, model-bound reasoning context so tool results can
continue the same conversation. This follows the
[Anthropic block-preservation contract](https://platform.claude.com/docs/en/docs/build-with-claude/extended-thinking).

Build with `node src/gateway-build.mjs` from the checkout. Cargo is required to
build; Python is no longer required to run or install the gateway. Startup fails
clearly if the binary is missing; it does not launch a Python fallback. Existing
Python environments and old configuration files are retained without use by the
runtime. The credential key stays in the child environment, never the routing
configuration or process arguments. Listener and upstream forwarders are local.

Validation (all loopback, no provider charges):

```sh
cargo test --manifest-path rust/gateway/Cargo.toml --locked --jobs 2
node --test test/rust-gateway.test.mjs test/gateway-config.test.mjs test/startup-cleanup.test.mjs
MODEL_ROUTER_GATEWAY_INTEGRATION=1 node --test test/anthropic-api-integration.test.mjs
node scripts/gateway-benchmark.mjs --run
node scripts/gateway-runtime-state.mjs
```

The benchmark compares startup, RSS, process I/O and 30 identical requests to a
local upstream. It does not flush caches. Logical reads and physical disk reads
are distinct, and request latency excludes a real model's generation time.
Provider generation was not tested with paid or quota-consuming requests.
The literature pipeline's scheduling, concurrency and collection settings are
outside this service and are unchanged.
