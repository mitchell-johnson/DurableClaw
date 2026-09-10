import type { AgentPrincipal, Env } from "../types";
import { authorizePrincipal } from "../auth";
import { createInternalAuthHeaders } from "../utils/internalAuth";

export class ConnectorError extends Error {
  constructor(
    message: string,
    public readonly status = 502,
  ) {
    super(message);
  }
}
export const connectionId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export function connectorsConfigured(env: Env): boolean {
  return Boolean(
    env.CONNECTORS &&
    env.CONNECTOR_AUTH_SECRET &&
    env.CONNECTOR_AUTH_SECRET.length >= 32,
  );
}
export async function currentConnectorOwner(
  env: Env,
  owner: AgentPrincipal,
): Promise<AgentPrincipal> {
  if (owner.role !== "owner")
    throw new ConnectorError("Owner access required", 403);
  try {
    const current = await authorizePrincipal(
      env,
      owner.userId,
      owner.workspaceId,
    );
    if (current.role !== "owner") throw new Error("Not owner");
    return current;
  } catch {
    throw new ConnectorError("Owner access required", 403);
  }
}
export async function boundedServiceJson(
  response: Response,
  maxBytes = 280_000,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  if (!response.body)
    throw new ConnectorError("Connector returned an invalid response");
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      signal?.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes)
        throw new ConnectorError(
          "Connector result is too large; narrow the request",
        );
      parts.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const output = new Uint8Array(bytes);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(output));
  } catch {
    throw new ConnectorError("Connector returned an invalid response");
  }
}
export async function callConnectorService(
  env: Env,
  owner: AgentPrincipal,
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<unknown> {
  options.signal?.throwIfAborted();
  if (!connectorsConfigured(env))
    throw new ConnectorError(
      "External service connectors are not configured",
      503,
    );
  const current = await currentConnectorOwner(env, owner);
  const signal = AbortSignal.any([
    AbortSignal.timeout(95000),
    ...(options.signal ? [options.signal] : []),
  ]);
  let stop!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    stop = () => reject(new Error("Connector request interrupted"));
    signal.addEventListener("abort", stop, { once: true });
  });
  // Signing is asynchronous. Handle an abort during signing immediately; the
  // original rejected promise still participates in the request/body races.
  void interrupted.catch(() => {});
  try {
    signal.throwIfAborted();
    const pending = env
      .CONNECTORS!.fetch(
        new Request("https://connectors.internal" + path, {
          method: options.method ?? "GET",
          headers: await createInternalAuthHeaders(
            {
              userId: current.userId,
              organizationId: current.workspaceId,
              tenantBinding: current.workspaceId,
              role: "owner",
            },
            env.CONNECTOR_AUTH_SECRET!,
          ),
          ...(options.body === undefined
            ? {}
            : { body: JSON.stringify(options.body) }),
          redirect: "manual",
          signal,
        }),
      )
      .then((response) => {
        if (signal.aborted) {
          void response.body?.cancel().catch(() => {});
          throw new Error("Connector request interrupted");
        }
        return response;
      });
    const response = await Promise.race([pending, interrupted]);
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 409)
        throw new ConnectorError(
          "Connection needs attention. Reconnect the account and try again",
          409,
        );
      if (response.status === 404)
        throw new ConnectorError("Connection unavailable", 404);
      if (response.status === 400)
        throw new ConnectorError(
          "Connector request rejected. Start a new connection attempt or check the arguments",
          400,
        );
      if (response.status === 429)
        throw new ConnectorError("Connector is busy. Try again shortly", 429);
      throw new ConnectorError("Connector service unavailable", 502);
    }
    const data = await Promise.race([
      boundedServiceJson(
        response,
        path === "/v1/execute" || path.startsWith("/v1/invocations/")
          ? 8 * 1024 * 1024
          : 280_000,
        signal,
      ),
      interrupted,
    ]);
    options.signal?.throwIfAborted();
    await currentConnectorOwner(env, owner);
    return data;
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    throw new ConnectorError("Connector request did not complete", 502);
  } finally {
    signal.removeEventListener("abort", stop);
  }
}
export interface ServiceConnection {
  id: string;
  provider: string;
  account: string;
  status: "connected" | "reauth_required";
  created_at: number;
  services: string[];
}
export async function listServiceConnections(
  env: Env,
  owner: AgentPrincipal,
  signal?: AbortSignal,
): Promise<ServiceConnection[]> {
  const data = (await callConnectorService(env, owner, "/v1/connections", {
    signal,
  })) as { connections?: unknown };
  if (!Array.isArray(data?.connections) || data.connections.length > 20)
    throw new ConnectorError("Connector returned invalid account metadata");
  return data.connections.map((row: unknown) => {
    const item = row as Partial<ServiceConnection> | null;
    if (
      !item ||
      !connectionId(item.id) ||
      typeof item.provider !== "string" ||
      !/^[a-z][a-z0-9-]{0,31}$/.test(item.provider) ||
      typeof item.account !== "string" ||
      item.account.length > 320 ||
      !["connected", "reauth_required"].includes(item.status ?? "") ||
      typeof item.created_at !== "number" ||
      !Number.isFinite(item.created_at)
    )
      throw new ConnectorError("Connector returned invalid account metadata");
    const services =
      item.services ?? (item.provider === "gmail" ? ["gmail"] : []);
    if (
      !Array.isArray(services) ||
      services.length > 64 ||
      services.some(
        (id) => typeof id !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(id),
      )
    )
      throw new ConnectorError("Connector returned invalid service grants");
    return {
      id: item.id,
      provider: item.provider,
      account: item.account,
      status: item.status!,
      created_at: item.created_at,
      services,
    };
  });
}
