import assert from "node:assert/strict";
import test from "node:test";
import { localPlannerPrompt } from "../src/lib/server/local-planner-prompt.ts";

test("local planner keeps original task, exact IDs and tools while bounding verbose agent profiles", () => {
  const instruction = "Compare fictional options A and B. Do not browse.";
  const agents = [{ id: "abc123", name: "Analyst", role: "Researcher", description: "D".repeat(1000), instructions: "I".repeat(4000), skillIds: ["skill.data-analysis"], availableDuringExecution: ["read_page"], expectedOutputFormat: "Report" }];
  const prompt = localPlannerPrompt(instruction, agents);
  const catalog = JSON.parse(prompt.split("## Available agents (JSON)\n\n")[1]);
  assert.ok(prompt.includes(instruction));
  assert.equal(catalog[0].id, "abc123");
  assert.deepEqual(catalog[0].tools, ["read_page"]);
  assert.deepEqual(catalog[0].skills, ["skill.data-analysis"]);
  assert.equal(catalog[0].description.length, 180);
  assert.equal(catalog[0].roleGuidance.length, 180);
  assert.ok(prompt.length < 2000);
});
