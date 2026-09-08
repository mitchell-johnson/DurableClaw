export type { Env } from "./env";
export type { UserPermission } from "./auth";
export interface AgentPrincipal {
  userId: string;
  workspaceId: string;
  role: string;
  name?: string;
}
