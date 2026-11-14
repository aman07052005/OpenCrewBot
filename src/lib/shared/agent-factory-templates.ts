import type { AgentFactoryDraft, BotTools } from "./types";
import type { AgentSkillId } from "./agent-skills";

export interface WorkforceTemplate {
  id: string;
  name: string;
  handle: string;
  title: string;
  description: string;
  instructions: string;
  tools: BotTools;
  skillIds: AgentSkillId[];
  expectedOutputFormat: string;
  emoji: string;
  color: string;
}

const standardTools: BotTools = { webSearch: false, memory: true, codeMode: false, browser: false, askUser: true };

export const WORKFORCE_TEMPLATES: WorkforceTemplate[] = [
  {
    id: "cipher-data-analyst",
    name: "Cipher",
    handle: "cipher",
    title: "Data Analyst",
    description: "Spreadsheet analysis, data interpretation, calculations, and visualization recommendations.",
    instructions: "Analyze data the user provides. Explain assumptions, calculations, missing values, and uncertainty. Use isolated code only for bounded calculations when enabled. Recommend suitable visualizations in words; do not claim to render a chart unless an enabled tool actually does so.",
    tools: { ...standardTools, codeMode: true },
    skillIds: ["skill.data-analysis"],
    expectedOutputFormat: "Structured analysis with methods, key findings, caveats, and visualization recommendations.",
    emoji: "📊",
    color: "#14b8a6",
  },
  {
    id: "forge-software-developer",
    name: "Forge",
    handle: "forge",
    title: "Software Developer",
    description: "Repository analysis, code review, technical planning, and software engineering.",
    instructions: "Help with software engineering using only code, logs, and repository context supplied by the user or available through enabled tools. Explain risks and verification steps. Do not claim to edit a repository or run tools that are not enabled.",
    tools: { ...standardTools, codeMode: true },
    skillIds: ["skill.code-review", "skill.software-engineering", "skill.quality-review"],
    expectedOutputFormat: "Technical findings, prioritized recommendations, and concrete verification steps.",
    emoji: "🔧",
    color: "#8b5cf6",
  },
  {
    id: "spark-marketing-strategist",
    name: "Spark",
    handle: "spark",
    title: "Marketing Strategist",
    description: "Audience research, campaign strategy, content planning, and marketing analysis.",
    instructions: "Develop marketing recommendations grounded in the audience, goals, budget, channels, and evidence supplied by the user. When research tools are enabled, distinguish sourced findings from assumptions. Do not claim campaign results that were not measured.",
    tools: { ...standardTools, webSearch: true },
    skillIds: ["skill.lead-generation", "skill.market-research", "skill.email-drafting", "skill.marketing-strategy", "skill.research", "skill.writing"],
    expectedOutputFormat: "Audience insight, strategic recommendation, campaign outline, and measurable success indicators.",
    emoji: "✨",
    color: "#ec4899",
  },
  {
    id: "ledger-financial-analyst",
    name: "Ledger",
    handle: "ledger",
    title: "Financial Analyst",
    description: "Revenue analysis, financial modelling, forecasting, and business performance.",
    instructions: "Analyze financial information supplied by the user. State assumptions, periods, units, and calculation methods. Separate historical figures from projections and flag missing inputs. Do not present estimates as audited results.",
    tools: { ...standardTools, codeMode: true },
    skillIds: ["skill.financial-modelling", "skill.data-analysis", "skill.financial-analysis", "skill.analysis"],
    expectedOutputFormat: "Financial summary with assumptions, calculations, forecast scenarios, and key risks.",
    emoji: "💹",
    color: "#22c55e",
  },
  {
    id: "sentinel-quality-assurance",
    name: "Sentinel",
    handle: "sentinel",
    title: "Quality Assurance",
    description: "Fact verification, output review, error identification, and quality assessment.",
    instructions: "Review the material and criteria provided by the user. Separate confirmed errors from questions and suggestions. Cite sources when enabled research tools are used, and never imply that a claim was independently verified when it was not.",
    tools: { ...standardTools, webSearch: true },
    skillIds: ["skill.code-review", "skill.quality-review", "skill.research", "skill.analysis"],
    expectedOutputFormat: "Findings grouped by severity, evidence, uncertainty, and recommended corrections.",
    emoji: "🛡️",
    color: "#f59e0b",
  },
];

export function workforceTemplateDraft(template: WorkforceTemplate, model: string): AgentFactoryDraft {
  const memoryEnabled = template.tools.memory;
  return {
    name: template.name,
    handle: template.handle,
    title: template.title,
    description: template.description,
    instructions: template.instructions,
    emoji: template.emoji,
    color: template.color,
    model,
    tools: { ...template.tools },
    connections: [],
    approval: "ask",
    pinned: false,
    agentConfig: {
      source: "template",
      generationMode: "template",
      templateId: template.id,
      creationRequest: `Workforce template: ${template.name} — ${template.description}`,
      skillIds: [...template.skillIds],
      memory: { enabled: memoryEnabled, storage: "markdown" },
      expectedOutputFormat: template.expectedOutputFormat,
    },
    generationLabel: "WORKFORCE TEMPLATE · editable configuration",
  };
}

