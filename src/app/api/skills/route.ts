import { AGENT_SKILLS } from "@/lib/shared/agent-skills";
import { handle } from "@/lib/server/http";

export async function GET() { return handle(async () => ({ skills: AGENT_SKILLS.filter((skill) => skill.implemented) })); }
