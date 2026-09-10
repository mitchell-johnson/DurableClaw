import type { JSONSchema7 } from "ai";

/** Trusted deployment code. OAuth credentials and execution live in the private
 * connector service; this contract exposes only reviewed operations to agents. */
export interface ConnectorOperation {
  readonly id: string;
  readonly description: string;
  readonly effect: "read" | "write";
  readonly properties: Record<string, JSONSchema7>;
  readonly required: string[];
  parse(value: unknown): Record<string, unknown>;
}
export interface ServiceConnectorPlugin {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** Increment when operation semantics or execution targets change. */
  readonly version: string;
  readonly operations: readonly ConnectorOperation[];
}
export function createConnectorRegistry(
  plugins: readonly ServiceConnectorPlugin[],
) {
  const providers = new Map<string, ServiceConnectorPlugin>();
  const operations = new Set<string>([
    "list_service_connections",
    "gog_describe",
    "get_service_invocation",
  ]);
  for (const plugin of plugins) {
    if (
      !/^[a-z][a-z0-9-]{0,31}$/.test(plugin.id) ||
      providers.has(plugin.id) ||
      !plugin.version
    )
      throw new Error("Invalid or duplicate connector plugin");
    for (const operation of plugin.operations) {
      if (
        !/^[a-z][a-z0-9_]{0,63}$/.test(operation.id) ||
        operations.has(operation.id) ||
        !["read", "write"].includes(operation.effect)
      )
        throw new Error("Invalid or duplicate connector operation");
      operations.add(operation.id);
    }
    providers.set(plugin.id, plugin);
  }
  return Object.freeze({
    get: (id: string) => providers.get(id),
    list: () => [...providers.values()],
  });
}
export type ConnectorRegistry = ReturnType<typeof createConnectorRegistry>;

export function strictObject(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.includes(key))
  )
    throw new Error("Invalid connector arguments");
  return value as Record<string, unknown>;
}
