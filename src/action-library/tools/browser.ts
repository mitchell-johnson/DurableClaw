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
} from "../../services/browser/BrowserSessions";

const actionProperties = {
  type: {
    type: "string",
    enum: ["click", "fill", "select", "press", "scroll"],
  },
  selector: { type: "string", minLength: 1, maxLength: 1000 },
  value: { type: "string", maxLength: 8000 },
  key: {
    type: "string",
    enum: ["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp", "Space"],
  },
  delta_y: { type: "integer", minimum: -5000, maximum: 5000 },
};

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
    browser_navigate: defineTool<{ url: string }>({
      description:
        "Open a public HTTP(S) page in a real Cloudflare browser, rendering JavaScript. Returns page text, links and an accessibility tree. Session state is private to this conversation; idle sessions expire after 10 minutes.",
      properties: { url: { type: "string", maxLength: 8000 } },
      required: ["url"],
      execute: (i) =>
        output(() =>
          sessions.navigate(
            conversation(),
            requireBrowserURL(i.url),
            args.signal,
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
              type: "object",
              properties: actionProperties,
              required: ["type"],
              additionalProperties: false,
            },
          },
        },
        required: ["snapshot_id", "actions"],
        buildPreview: async (i) => {
          const actions = browserActionsSchema.parse(i.actions);
          const url = await sessions.snapshotURL(conversation(), i.snapshot_id);
          return sanitizeToolOutput(
            `Interact with ${url}:\n${JSON.stringify(actions, null, 2)}`,
          );
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
