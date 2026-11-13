export const AGENT_SKILLS = [
  { id: "skill.research", label: "Research", description: "Research-oriented agent profile metadata.", implemented: false },
  { id: "skill.analysis", label: "Analysis", description: "Analysis-oriented agent profile metadata.", implemented: false },
  { id: "skill.data-analysis", label: "Data analysis", description: "Data analysis profile metadata.", implemented: false },
  { id: "skill.software-engineering", label: "Software engineering", description: "Software engineering profile metadata.", implemented: false },
  { id: "skill.marketing-strategy", label: "Marketing strategy", description: "Marketing strategy profile metadata.", implemented: false },
  { id: "skill.financial-analysis", label: "Financial analysis", description: "Financial analysis profile metadata.", implemented: false },
  { id: "skill.quality-review", label: "Quality review", description: "Quality review profile metadata.", implemented: false },
  { id: "skill.writing", label: "Writing", description: "Writing profile metadata.", implemented: false },
  { id: "skill.planning", label: "Planning", description: "Planning profile metadata.", implemented: false },
] as const;

export type AgentSkillId = (typeof AGENT_SKILLS)[number]["id"];
