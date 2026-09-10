import { fitVectorMetadata } from "../../../utils/vectorMetadata";
import type { ToolSet } from "ai";
import type { Env } from "../../../types";
import {
  defineTool,
  defineConfirmTool,
  sanitizeToolOutput,
} from "../../../action-library/helpers";
import { makeSqliteConfirmationCoordinator } from "../toolConfirmations";
import { createRetrievalTools } from "../../../action-library/tools/retrieval";
import {
  workspacePrefix,
  safePath,
  MAX_FILE_BYTES,
} from "../../../storage/workspace";
import { buildNamespace } from "../../../utils/memoryClient";
import { authorizePrincipal } from "../../../auth";
export function applyPersonaToolGate(
  tools: ToolSet,
  settings: {
    enabled_tools?: string[] | null;
    disabled_tools?: string[] | null;
  },
): ToolSet {
  const allow = settings.enabled_tools?.length
    ? new Set(settings.enabled_tools)
    : null;
  const deny = new Set(settings.disabled_tools || []);
  return Object.fromEntries(
    Object.entries(tools).filter(
      ([id]) => (!allow || allow.has(id)) && !deny.has(id),
    ),
  );
}
export function createWorkspaceTools(args: {
  env: Env;
  sql: SqlStorage;
  context: { user_id: string; tenant_binding: string; user_role: string };
  conversationId?: string;
  signal?: AbortSignal;
  schedule: (delay: number, payload: unknown) => Promise<void>;
}): ToolSet {
  const { env, context } = args;
  const prefix = workspacePrefix(context.user_id, context.tenant_binding);
  const retrieval = createRetrievalTools({
    env,
    tenantBinding: context.tenant_binding,
    tenantDB: env.CONTROL_DB,
    principal: {
      userId: context.user_id,
      userRole: context.user_role,
      permissions: [],
    },
    telemetryTag: "workspace",
  });
  const confirm = {
    confirmations: makeSqliteConfirmationCoordinator(args.sql),
    conversationId: args.conversationId,
  };
  const mutation = async () => {
    args.signal?.throwIfAborted();
    const p = await authorizePrincipal(
      env,
      context.user_id,
      context.tenant_binding,
    );
    if (p.role !== "owner") throw new Error("Write permission required");
    args.signal?.throwIfAborted();
  };
  return {
    ...retrieval,
    list_files: defineTool<{ prefix?: string; cursor?: string }>({
      description:
        "List files in your private workspace, with a cursor for the next page.",
      properties: { prefix: { type: "string" }, cursor: { type: "string" } },
      execute: async (i) => {
        await authorizePrincipal(env, context.user_id, context.tenant_binding);
        const page = await env.WORKSPACE.list({
          prefix: prefix + (i.prefix ? safePath(i.prefix) : ""),
          limit: 100,
          cursor: i.cursor,
        });
        return JSON.stringify({
          files: page.objects.map((f) => ({
            path: f.key.slice(prefix.length),
            size: f.size,
          })),
          cursor: page.truncated ? page.cursor : null,
        });
      },
    }),
    write_file: defineConfirmTool<{ path: string; content: string }>(
      "write_file",
      {
        description:
          "Create or replace a private workspace text file after user approval.",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        buildPreview: (i) =>
          `Write ${new TextEncoder().encode(i.content).length} bytes to ${safePath(i.path)}`,
        buildChannelPreview: (i, preview) =>
          `${preview}\n\nComplete file contents (JSON string):\n${JSON.stringify(i.content)}`,
        execute: async (i) => {
          await mutation();
          const path = safePath(i.path);
          if (new TextEncoder().encode(i.content).length > MAX_FILE_BYTES)
            throw new Error("File exceeds text tool size limit");
          await env.WORKSPACE.put(prefix + path, i.content);
          await env.CONTROL_DB.prepare(
            "INSERT INTO workspace_events (user_id,workspace_id,kind,resource_id,summary,occurred_at) VALUES (?,?,?,?,?,?)",
          )
            .bind(
              context.user_id,
              context.tenant_binding,
              "file.updated",
              path,
              `File updated: ${path}`,
              Date.now(),
            )
            .run();
          return `Saved ${path}`;
        },
      },
      confirm,
    ),
    index_file: defineConfirmTool<{ path: string }>(
      "index_file",
      {
        description:
          "Index a private workspace file for semantic retrieval after approval. Requires DOCUMENT_INDEX.",
        properties: { path: { type: "string" } },
        required: ["path"],
        buildPreview: (i) => `Index ${safePath(i.path)} for semantic retrieval`,
        execute: async (i) => {
          await mutation();
          if (!env.DOCUMENT_INDEX)
            throw new Error("DOCUMENT_INDEX binding is not configured");
          const path = safePath(i.path);
          const obj = await env.WORKSPACE.get(prefix + path);
          if (!obj) return "File not found";
          if (obj.size > MAX_FILE_BYTES) {
            await obj.body.cancel();
            throw new Error("File too large");
          }
          const text = (await obj.text()).slice(0, 5000);
          const embedding = (await env.AI.run("@cf/baai/bge-m3", {
            text: [text],
          })) as { data: number[][] };
          args.signal?.throwIfAborted();
          const namespace = buildNamespace(
            context.user_id,
            context.tenant_binding,
          );
          const digest = await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(prefix + path),
          );
          const id = Array.from(new Uint8Array(digest), (b) =>
            b.toString(16).padStart(2, "0"),
          ).join("");
          await env.DOCUMENT_INDEX.upsert([
            {
              id,
              namespace,
              values: embedding.data[0],
              metadata: fitVectorMetadata({
                user_namespace: namespace,
                path,
                text,
              }),
            },
          ]);
          return `Indexed ${path}`;
        },
      },
      confirm,
    ),
    schedule_task: defineTool<{
      description: string;
      delaySeconds: number;
      sendMessage?: boolean;
      message?: string;
    }>({
      description:
        "Schedule a durable reminder or workspace task. Notifications arrive in the inbox even when disconnected.",
      properties: {
        description: { type: "string" },
        delaySeconds: { type: "number", minimum: 1, maximum: 31536000 },
        sendMessage: { type: "boolean" },
        message: { type: "string" },
      },
      required: ["description", "delaySeconds"],
      execute: async (i) => {
        await mutation();
        if (
          !Number.isFinite(i.delaySeconds) ||
          i.delaySeconds < 1 ||
          i.delaySeconds > 31536000 ||
          i.description.length > 8000
        )
          throw new Error("Invalid schedule");
        await args.schedule(i.delaySeconds, {
          ...i,
          conversation_id: args.conversationId,
        });
        return "Task scheduled";
      },
    }),
  };
}
