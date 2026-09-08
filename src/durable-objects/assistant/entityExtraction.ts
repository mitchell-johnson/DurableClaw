/** Adapters explicitly expose references; arbitrary object IDs are never guessed. */
export interface EntityReference {
  entity_type: string;
  entity_id: string;
}
export function extractEntities(
  _toolName: string,
  _toolArgs: unknown,
  toolOutput: unknown,
): EntityReference[] {
  let root = toolOutput;
  if (typeof root === "string") {
    if (root.length > 1_000_000) return [];
    try {
      root = JSON.parse(root);
    } catch {
      return [];
    }
  }
  const result = new Map<string, EntityReference>();
  const seen = new WeakSet<object>();
  let visited = 0;
  const visit = (value: unknown, depth: number) => {
    if (
      ++visited > 2000 ||
      depth > 8 ||
      result.size >= 100 ||
      !value ||
      typeof value !== "object" ||
      seen.has(value)
    )
      return;
    seen.add(value);
    const row = value as Record<string, unknown>;
    if (
      typeof row.entity_type === "string" &&
      /^[a-z][a-z0-9_-]{0,63}$/i.test(row.entity_type) &&
      typeof row.entity_id === "string" &&
      row.entity_id.length > 0 &&
      row.entity_id.length <= 256
    ) {
      const reference = {
        entity_type: row.entity_type,
        entity_id: row.entity_id,
      };
      result.set(
        JSON.stringify([reference.entity_type, reference.entity_id]),
        reference,
      );
    }
    for (const child of Array.isArray(value) ? value : Object.values(row))
      visit(child, depth + 1);
  };
  visit(root, 0);
  return [...result.values()];
}
