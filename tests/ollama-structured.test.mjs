import assert from "node:assert/strict";
import test from "node:test";
import { requestOllamaStructured } from "../src/lib/server/ollama-structured.ts";

const schema = { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false };
test("local structured generation sends the actual schema to the native Ollama endpoint and retains reported usage", async () => {
  const result = await requestOllamaStructured("http://127.0.0.1:11434/v1", "qwen3:4b-instruct", "Generate data", "Create an agent", schema, async (url, init) => {
    assert.equal(String(url), "http://127.0.0.1:11434/api/chat");
    assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).has("authorization"), false);
    const body = JSON.parse(init.body);
    assert.equal(body.model, "qwen3:4b-instruct");
    assert.equal(body.stream, false);
    assert.deepEqual(body.format, schema);
    assert.equal(body.tools, undefined);
    return Response.json({ done: true, message: { content: '{"name":"Orion"}' }, prompt_eval_count: 20, eval_count: 8 });
  });
  assert.deepEqual(result, { object: { name: "Orion" }, usage: { promptTokens: 20, completionTokens: 8 } });
});
test("local structured generation rejects unsafe endpoints, malformed JSON and tool calls", async () => {
  const run = (base, body) => requestOllamaStructured(base, "local", "system", "prompt", schema, async () => Response.json(body));
  await assert.rejects(run("https://example.com/v1", {}), /loopback/);
  await assert.rejects(run("http://127.0.0.1:11434/v1", { done: true, message: { content: "not JSON" } }), /invalid JSON/);
  await assert.rejects(run("http://127.0.0.1:11434/v1", { done: true, message: { content: "{}", tool_calls: [{}] } }), /tool-free/);
  await assert.rejects(run("http://127.0.0.1:11434/v1", { done: false, message: { content: "{}" } }), /completed/);
});

test("planner can apply a distinct bounded output limit while factory defaults remain unchanged", async () => {
  const transport = async (_url, init) => {
    assert.equal(JSON.parse(init.body).options.num_predict, 3072);
    assert.ok(init.signal instanceof AbortSignal);
    return Response.json({ done: true, message: { content: '{"name":"Orion"}' } });
  };
  await requestOllamaStructured("http://127.0.0.1:11434/v1", "local", "system", "prompt", schema, transport, { timeoutMs: 300_000, maxOutputTokens: 3072 });
});
