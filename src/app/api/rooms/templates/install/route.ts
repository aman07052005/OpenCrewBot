import { handle } from "@/lib/server/http";
import { installCollaborationRooms } from "@/lib/server/collaboration-service";
export async function POST() { return handle(installCollaborationRooms); }
