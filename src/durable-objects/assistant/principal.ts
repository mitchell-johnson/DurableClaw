import { createHash } from "node:crypto";
import type { Env } from "../../types";
import type { UserPermission } from "../../types/auth";
import type { RetrievalContext } from "../../services/retrieval/types";
import { authorizePrincipal } from "../../auth";
export function doName(userId: string, tenantBinding: string): string {
  return createHash("sha256")
    .update(JSON.stringify([tenantBinding, userId]))
    .digest("hex");
}
export function denyAllPermissions(userId: string): UserPermission[] {
  return [
    { user_id: userId, resource_type: "workspace", permission_type: "none" },
  ];
}
export function resolvePrincipalRole(role: string | null | undefined): string {
  return role || "none";
}
export async function buildRetrievalContextFor(args: {
  env: Env;
  user_id: string;
  user_role: string;
  organization_id?: string;
  tenant_binding: string;
  cachedPermissions?: UserPermission[] | null;
}): Promise<{ context: RetrievalContext; permissions: UserPermission[] }> {
  const p = await authorizePrincipal(
    args.env,
    args.user_id,
    args.tenant_binding,
  );
  const permissions: UserPermission[] = [
    {
      user_id: p.userId,
      resource_type: "workspace",
      permission_type: p.role === "owner" ? "write" : "read",
    },
  ];
  return {
    context: {
      env: args.env,
      tenantBinding: p.workspaceId,
      tenantDB: args.env.CONTROL_DB,
      principal: { userId: p.userId, userRole: p.role, permissions },
      telemetryTag: "agent",
    },
    permissions,
  };
}
