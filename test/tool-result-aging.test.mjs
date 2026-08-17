import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { ageToolResults } from "../src/tool-result-aging.mjs";

function call(id, name = "exec_command") {
  return { type: "function_call", call_id: id, name, arguments: "{}" };
}

function output(id, value) {
  return { type: "function_call_output", call_id: id, output: value };
}

test("ages only large consumed textual results outside the newest-four frontier", () => {
  const value = `HEAD\n${"a".repeat(1_018)}😀${"middle\n".repeat(8_000)}😀${"b".repeat(1_018)}TAIL`;
  const mixed = [
    { type: "input_text", text: "x".repeat(40_000) },
    { type: "input_image", image_url: "data:image/png;base64,AAAA" },
  ];
  const input = [
    call("old"),
    output("old", value),
    { type: "message", role: "assistant", content: "I used that result." },
    call("pending"),
    output("pending", "p".repeat(100)),
    call("mixed", "view_image"),
    output("mixed", mixed),
    ...Array.from({ length: 4 }, (_, index) => [
      call(`new-${index}`),
      output(`new-${index}`, "n".repeat(40_000)),
    ]).flat(),
  ];

  const result = ageToolResults(input);
  assert.notEqual(result.input, input);
  assert.equal(result.stats.toolResultsAged, 1);
  assert.ok(result.stats.toolResultBytesSaved > 40_000);
  assert.equal(result.input[1].call_id, "old");
  assert.match(result.input[1].output, /Repeat the preceding exec_command call/);
  assert.match(result.input[1].output, /HEAD/);
  assert.match(result.input[1].output, /TAIL/);
  assert.match(
    result.input[1].output,
    new RegExp(createHash("sha256").update(value).digest("hex")),
  );
  assert.doesNotMatch(result.input[1].output, /�/);
  assert.deepEqual(result.input[6].output, mixed);
  assert.equal(result.input.at(-1).output, "n".repeat(40_000));

  const unconsumed = [call("last"), output("last", "x".repeat(40_000))];
  assert.equal(ageToolResults(unconsumed, { frontier: 0 }).input, unconsumed);
  assert.equal(ageToolResults(input, { enabled: false }).input, input);
});
