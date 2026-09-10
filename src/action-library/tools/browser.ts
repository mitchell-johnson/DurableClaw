import type { ToolSet } from "ai";
import {
  defineTool,
  defineConfirmTool,
  sanitizeToolOutput,
  type ConfirmToolOptions,
} from "../helpers";
import {
  BrowserSessions,
  browserActionsSchema,
  requireBrowserURL,
  type BrowserAction,
  type BrowserSelection,
} from "../../services/browser/BrowserSessions";

const actionFields = {
  selector: { type: "string", minLength: 1, maxLength: 1000 },
  value: { type: "string", maxLength: 8000 },
  key: {
    type: "string",
    enum: ["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp", "Space"],
  },
  delta_y: { type: "integer", minimum: -5000, maximum: 5000 },
};

const actionVariants = [
  { type: "click", fields: { selector: actionFields.selector } },
  {
    type: "fill",
    fields: { selector: actionFields.selector, value: actionFields.value },
  },
  {
    type: "select",
    fields: {
      selector: actionFields.selector,
      value: { type: "string", maxLength: 1000 },
    },
  },
  {
    type: "press",
    fields: { selector: actionFields.selector, key: actionFields.key },
  },
  { type: "scroll", fields: { delta_y: actionFields.delta_y } },
].map(({ type, fields }) => ({
  type: "object",
  properties: { type: { type: "string", const: type }, ...fields },
  required: ["type", ...Object.keys(fields)],
  additionalProperties: false,
}));

export function createBrowserTools(args: {
  sessions?: BrowserSessions;
  conversationId?: string;
  confirmations?: ConfirmToolOptions["confirmations"];
  signal?: AbortSignal;
  authorizeMutation: () => Promise<void>;
}): ToolSet {
  if (!args.sessions) return {};
  const sessions = args.sessions;
  const conversation = () => {
    args.signal?.throwIfAborted();
    if (!args.conversationId)
      throw new Error("A conversation is required for browser tools");
    return args.conversationId;
  };
  const output = async (run: () => Promise<unknown>) => {
    try {
      return sanitizeToolOutput(JSON.stringify(await run()));
    } catch (error) {
      args.signal?.throwIfAborted();
      return sanitizeToolOutput(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };
  return {
    browser_navigate: defineTool<{ url: string; engine?: BrowserSelection }>({
      description:
        "Open a public HTTP(S) page. Prefer engine=auto: new tasks use Kitesurf, existing sessions keep their engine. Choose chromium for persistent login sessions, work that must resume after a restart, video/WebGL, or pages incompatible with Kitesurf. Explicit engine changes discard the current browser state and require fresh action approval. Returns browser_engine, page text, links and an accessibility tree. Kitesurf sessions cannot be reconnected after connection loss; both engines close after 10 idle minutes.",
      properties: {
        url: { type: "string", maxLength: 8000 },
        engine: {
          type: "string",
          enum: ["auto", "kitesurf", "chromium"],
          description:
            "Defaults to auto (prefer Kitesurf). Use chromium when the task needs the full browser environment, or to reopen an incompatible page. Use kitesurf to explicitly start a fresh lightweight task after Chromium.",
        },
      },
      required: ["url"],
      execute: (i) =>
        output(() =>
          sessions.navigate(
            conversation(),
            requireBrowserURL(i.url),
            args.signal,
            i.engine,
          ),
        ),
    }),
    browser_read: defineTool<{ offset?: number }>({
      description:
        "Read the current browser page and refresh its snapshot_id. Use after navigation, to check a dynamic page, or with next_offset to read more text. Use aria/NAME or CSS selectors for controls in the accessibility tree.",
      properties: {
        offset: { type: "integer", minimum: 0, maximum: 10000000 },
      },
      execute: (i) =>
        output(() => sessions.read(conversation(), i.offset, args.signal)),
    }),
    browser_act: defineConfirmTool<{
      snapshot_id: string;
      actions: BrowserAction[];
    }>(
      "browser_act",
      {
        description:
          "Interact with the latest browser snapshot after user approval. Up to 8 ordered actions: click(selector), fill(selector,value), select(selector,value), press(selector,key), scroll(delta_y). Use Puppeteer aria/NAME or CSS selectors. Actions may submit data or change a website. Read the page after any failure; never blindly repeat a submission.",
        properties: {
          snapshot_id: { type: "string", minLength: 1 },
          actions: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: {
              anyOf: actionVariants,
            },
          },
        },
        required: ["snapshot_id", "actions"],
        buildPreview: async (i) => {
          const actions = browserActionsSchema.parse(i.actions);
          const url = await sessions.snapshotURL(conversation(), i.snapshot_id);
          // This is the human approval preview. Preserve the exact submitted
          // text, even when it contains markers filtered from page results.
          return `Interact with ${url}:\n${JSON.stringify(actions, null, 2)}`;
        },
        execute: (i) =>
          output(async () => {
            const id = conversation();
            await args.authorizeMutation();
            args.signal?.throwIfAborted();
            return sessions.act(id, i.snapshot_id, i.actions, args.signal);
          }),
      },
      {
        conversationId: args.conversationId,
        confirmations: args.confirmations,
      },
    ),
    browser_close: defineTool<Record<string, never>>({
      description:
        "Close this conversation's browser and discard its cookies/page state. Call when finished to stop browser usage charges.",
      properties: {},
      execute: () => output(() => sessions.close(conversation(), args.signal)),
    }),
  };
}
