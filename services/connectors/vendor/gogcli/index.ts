import {
  commands,
  closed,
  describeCatalog,
  object,
  parseCommand,
} from "./catalog";
import { NativeRuntime } from "./runtime";
import { communicationHandlers, gmailQuickRead } from "./communications";
import { documentHandlers } from "./documents";
import { driveHandlers } from "./drive";
import { reportHandlers } from "./reports";
import { classroomHandlers } from "./classroom";
import { administrationHandlers } from "./administration";
import { NativeCleanupError } from "./diagnostics";
import type { Command, HandlerMap } from "./types";

const families = [
  communicationHandlers,
  documentHandlers,
  driveHandlers,
  reportHandlers,
  classroomHandlers,
  administrationHandlers,
];
export const handlers: HandlerMap = {
  "api.list": (command, runtime) => runtime.discovery(command),
  "api.describe": (command, runtime) => runtime.discovery(command),
  "api.call": (command, runtime) => runtime.discovery(command),
};
for (const family of families)
  for (const [name, handler] of Object.entries(family)) {
    if (Object.hasOwn(handlers, name))
      throw new Error("Duplicate native command");
    handlers[name] = handler;
  }
if (
  commands.length !== Object.keys(handlers).length ||
  commands.some(({ command }) => !Object.hasOwn(handlers, command))
)
  throw new Error("Native command catalog and handlers differ");

async function body(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("Missing request body");
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      request.signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 8 * 1024 * 1024) throw new Error("Request is too large");
      parts.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Called in-process by ConnectorVault after authenticated grant and approval checks.
 * This is not a public fetch handler or a network-facing server. */
export async function executeNative(
  request: Request,
  fetcher: (request: Request) => Promise<Response>,
): Promise<Response> {
  let command: Command, wire: Record<string, any>;
  try {
    if (request.method !== "POST") throw new Error("Invalid method");
    const path = new URL(request.url).pathname;
    if (path === "/catalog")
      return Response.json(describeCatalog(await body(request)));
    if (path !== "/execute") throw new Error("Invalid path");
    wire = closed(await body(request), [
      "operation",
      "arguments",
      "access_token",
      "account_email",
      "maps_api_key",
      "confirmed",
    ]);
    if (
      typeof wire.access_token !== "string" ||
      !wire.access_token ||
      wire.access_token.length > 16_384 ||
      /[\r\n]/.test(wire.access_token)
    )
      throw new Error("Invalid credentials");
    if (
      wire.account_email !== undefined &&
      (typeof wire.account_email !== "string" ||
        wire.account_email.length > 320)
    )
      throw new Error("Invalid account");
    if (
      wire.maps_api_key !== undefined &&
      (typeof wire.maps_api_key !== "string" || wire.maps_api_key.length > 4096)
    )
      throw new Error("Invalid Maps key");
    if (wire.operation === "gog_execute") {
      if (wire.confirmed !== true) throw new Error("Approval required");
      command = parseCommand(wire.arguments);
    } else {
      if (
        !["gmail_search", "gmail_get_message", "gmail_get_thread"].includes(
          wire.operation,
        )
      )
        throw new Error("Unknown operation");
      object(wire.arguments);
      command = {
        command: wire.operation,
        positionals: [],
        flags: {},
        files: [],
        output_files: [],
      };
    }
  } catch {
    return Response.json(
      { error: "Invalid native connector request" },
      { status: 400 },
    );
  }
  try {
    const runtime = new NativeRuntime(command, {
      accessToken: wire.access_token,
      account: wire.account_email ?? "",
      mapsKey: wire.maps_api_key,
      fetch: fetcher,
      signal: request.signal,
    });
    const output =
      wire.operation === "gog_execute"
        ? await handlers[command.command](command, runtime)
        : await gmailQuickRead(wire.operation, wire.arguments, runtime);
    const result = runtime.result(output) as { output: unknown };
    return Response.json({
      result: wire.operation === "gog_execute" ? result : result.output,
    });
  } catch (error) {
    // Commands may already have performed a write. The vault records an uncertain outcome.
    return Response.json(
      {
        error: "Google command failed; do not retry automatically",
        ...(error instanceof NativeCleanupError && error.cleanupRequired.length
          ? { cleanup_required: error.cleanupRequired }
          : {}),
      },
      { status: 502 },
    );
  }
}
