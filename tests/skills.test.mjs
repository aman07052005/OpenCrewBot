import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_SKILLS, EXECUTABLE_SKILL_IDS } from "../src/lib/shared/agent-skills.ts";
import { executeSkill, skillForObjective, validateSkillInput } from "../src/lib/server/skills.ts";

test("registry exposes exactly eight executable server-owned skills", () => {
  assert.equal(EXECUTABLE_SKILL_IDS.length, 8);
  assert.equal(AGENT_SKILLS.filter((skill) => skill.implemented).length, 8);
  assert.throws(() => validateSkillInput("skill.not-real", {}));
});

test("dynamic selection only chooses an enabled matching skill", () => {
  assert.equal(skillForObjective("Build a revenue forecast", ["skill.financial-modelling"]), "skill.financial-modelling");
  assert.equal(skillForObjective("Build a revenue forecast", ["skill.data-analysis"]), undefined);
});

test("financial model computes profit, margins and break-even deterministically", () => {
  const output = executeSkill("skill.financial-modelling", { revenue: 1000, costOfGoodsSold: 400, operatingCosts: 200, taxRate: .25, fixedCosts: 600, pricePerUnit: 20, variableCostPerUnit: 5, projectionPeriods: 1, growthRate: .1 });
  assert.equal(output.simulated, true);
  assert.equal(output.result.current.grossProfit, 600);
  assert.equal(output.result.current.netProfit, 300);
  assert.equal(output.result.current.breakEvenUnits, 40);
  assert.throws(() => executeSkill("skill.financial-modelling", { revenue: -1, operatingCosts: 0 }));
});

test("CSV analysis parses quoted fields, missing values, aggregation and chart values", () => {
  const output = executeSkill("skill.data-analysis", { csv: 'region,revenue,note\nNorth,120,"good, stable"\nSouth,80,\nWest,,missing', groupBy: "region", valueColumn: "revenue" });
  assert.deepEqual(output.result.dimensions, { rows: 3, columns: 3 });
  assert.equal(output.result.columns.find((column) => column.name === "revenue").missing, 1);
  assert.equal(output.result.numericalSummaries.revenue.mean, 100);
  assert.deepEqual(output.result.chartReady.values, [120, 80]);
  assert.throws(() => executeSkill("skill.data-analysis", { csv: 'a,b\n"broken,1' }));
});

test("data output protects formula-like values for spreadsheet export", () => {
  const output = executeSkill("skill.data-analysis", { records: [{ name: "=cmd()", amount: 1 }] });
  assert.equal(output.result.sanitizedPreview[0].name, "'=cmd()");
});

test("evidence, artifacts, drafts, code safety and leads are bounded to supplied information", () => {
  const market = executeSkill("skill.market-research", { question: "What is the market?", evidence: [] });
  assert.equal(market.result.findings.length, 0);
  assert.ok(market.limitations[0].includes("No live research"));
  const competitors = executeSkill("skill.competitor-analysis", { competitors: [{ name: "A", weaknesses: ["Slow onboarding"], evidence: [{ title: "A", url: "https://example.com" }] }] });
  assert.equal(competitors.result.opportunities[0].competitor, "A");
  const presentation = executeSkill("skill.presentation-creation", { title: "Plan", audience: "Team", objective: "Decide" });
  assert.equal(presentation.artifacts[0].name, "presentation-outline.md");
  const email = executeSkill("skill.email-drafting", { recipientRole: "Buyer", objective: "Say hello", callToAction: "Reply" });
  assert.equal(email.result.sent, false);
  assert.throws(() => executeSkill("skill.code-review", { files: [{ path: "../secret.ts", content: "x" }] }));
  const leads = executeSkill("skill.lead-generation", { industry: "Software", geography: "India", organizations: [] });
  assert.equal(leads.result.leads.length, 0);
});
