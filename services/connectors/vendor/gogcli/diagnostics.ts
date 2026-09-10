/** The only native failure details permitted across the credential boundary. */
export interface CleanupWarning {
  file_id: string;
  public_read_permission_may_remain: boolean;
}
export function cleanupWarnings(value: unknown): CleanupWarning[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > 8)
    return undefined;
  const result: CleanupWarning[] = [];
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).some(
        (key) =>
          !["file_id", "public_read_permission_may_remain"].includes(key),
      ) ||
      typeof item.file_id !== "string" ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(item.file_id) ||
      typeof item.public_read_permission_may_remain !== "boolean"
    )
      return undefined;
    result.push({
      file_id: item.file_id,
      public_read_permission_may_remain: item.public_read_permission_may_remain,
    });
  }
  return result;
}
export class NativeCleanupError extends Error {
  readonly cleanupRequired: CleanupWarning[];
  constructor(warnings: CleanupWarning[]) {
    super("Image operation failed and cleanup is required");
    this.cleanupRequired = cleanupWarnings(warnings) ?? [];
  }
}
