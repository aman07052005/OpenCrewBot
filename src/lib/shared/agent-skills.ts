/** Server-owned skill identifiers. Existing descriptive tags remain compatible. */
export const AGENT_SKILLS = [
  { id: "skill.market-research", label: "Market Research", description: "Evidence-led market research or a labelled framework.", implemented: true },
  { id: "skill.competitor-analysis", label: "Competitor Analysis", description: "Structured competitor comparison from supplied evidence.", implemented: true },
  { id: "skill.financial-modelling", label: "Financial Modelling", description: "Deterministic financial calculations and forecasts.", implemented: true },
  { id: "skill.presentation-creation", label: "Presentation Creation", description: "Markdown presentation outlines with speaker notes.", implemented: true },
  { id: "skill.email-drafting", label: "Email Drafting", description: "Editable emails; never sends mail.", implemented: true },
  { id: "skill.code-review", label: "Code Review", description: "Read-only review of explicitly supplied source text.", implemented: true },
  { id: "skill.data-analysis", label: "Data Analysis", description: "Bounded CSV or JSON profiling, aggregation and chart data.", implemented: true },
  { id: "skill.lead-generation", label: "Lead Generation", description: "Qualification of supplied public business records.", implemented: true },
  { id: "skill.research", label: "Research", description: "Legacy agent profile tag.", implemented: false },
  { id: "skill.analysis", label: "Analysis", description: "Legacy agent profile tag.", implemented: false },
  { id: "skill.software-engineering", label: "Software engineering", description: "Legacy agent profile tag.", implemented: false },
  { id: "skill.marketing-strategy", label: "Marketing strategy", description: "Legacy agent profile tag.", implemented: false },
  { id: "skill.financial-analysis", label: "Financial analysis", description: "Legacy agent profile tag.", implemented: false },
  { id: "skill.quality-review", label: "Quality review", description: "Legacy agent profile tag.", implemented: false },
  { id: "skill.writing", label: "Writing", description: "Legacy agent profile tag.", implemented: false },
  { id: "skill.planning", label: "Planning", description: "Legacy agent profile tag.", implemented: false },
] as const;

export type AgentSkillId = (typeof AGENT_SKILLS)[number]["id"];
export type ExecutableSkillId = Extract<AgentSkillId, "skill.market-research" | "skill.competitor-analysis" | "skill.financial-modelling" | "skill.presentation-creation" | "skill.email-drafting" | "skill.code-review" | "skill.data-analysis" | "skill.lead-generation">;
export const EXECUTABLE_SKILL_IDS = AGENT_SKILLS.filter((skill) => skill.implemented).map((skill) => skill.id) as ExecutableSkillId[];
