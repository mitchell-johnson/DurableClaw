import type { Env } from "../types";
import { doName } from "../durable-objects/assistant/principal";
export const MAX_FILE_BYTES = 128 * 1024;
export function workspacePrefix(userId: string, workspaceId: string): string {
  return `files/${doName(userId, workspaceId)}/`;
}
export function safePath(path: string): string {
  if (
    !path ||
    path.length > 512 ||
    path.startsWith("/") ||
    path.split("/").some((x) => x === ".." || x === "." || !x) ||
    /[\\\x00-\x1f]/.test(path)
  )
    throw new Error("Invalid workspace path");
  return path;
}
export async function readWorkspaceFile(
  env: Env,
  userId: string,
  workspaceId: string,
  path: string,
): Promise<string | null> {
  const object = await env.WORKSPACE.get(
    workspacePrefix(userId, workspaceId) + safePath(path),
  );
  if (!object) return null;
  if (object.size > MAX_FILE_BYTES) {
    await object.body.cancel();
    throw new Error("File exceeds text tool size limit");
  }
  return object.text();
}
