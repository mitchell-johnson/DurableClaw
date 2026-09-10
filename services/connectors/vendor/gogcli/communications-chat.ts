import type { Command, Data, HandlerMap, Runtime } from "./types";
import { required, segment } from "./types";
import { list, pages } from "./communications-mail";
function resource(value: string, kind: string): string {
  const parts = required(value, kind).split("/");
  if (
    parts[0] !== kind ||
    parts.length % 2 !== 0 ||
    parts.some((p) => !p || p === "." || p === "..")
  )
    throw new Error(`Invalid ${kind} resource`);
  return parts.map(segment).join("/");
}
function space(value: string): string {
  return resource(
    value.startsWith("spaces/") ? value : `spaces/${value}`,
    "spaces",
  );
}
function thread(parent: string, value: string): string {
  if (value.startsWith("spaces/") && !value.startsWith(parent + "/threads/"))
    throw new Error("Thread belongs to a different space");
  return resource(
    value.startsWith("spaces/")
      ? value
      : `${parent}/threads/${value.replace(/^threads\//, "")}`,
    "spaces",
  );
}
function message(value: string, parent?: string): string {
  if (value.startsWith("spaces/")) return resource(value, "spaces");
  if (!parent) throw new Error("Supply a full message name or --space");
  return resource(`${space(parent)}/messages/${value}`, "spaces");
}
function row(m: Data): Data {
  return {
    resource: m.name,
    sender: m.sender?.displayName || m.sender?.name,
    text: m.text ?? m.formattedText,
    createTime: m.createTime,
    thread: m.thread?.name,
    annotations: m.annotations,
    emojiReactionSummaries: m.emojiReactionSummaries,
  };
}
async function setupDM(r: Runtime, email: string): Promise<Data> {
  if (!/^[^\s@]+@[^\s@]+$/.test(email))
    throw new Error("Invalid recipient email");
  return r.json("chat", "spaces:setup", {
    method: "POST",
    body: {
      space: { spaceType: "DIRECT_MESSAGE" },
      memberships: [{ member: { name: `users/${email}`, type: "HUMAN" } }],
    },
  });
}
async function send(c: Command, r: Runtime, parent?: string): Promise<Data> {
  const f = c.flags;
  parent ||= space(c.positionals[0]);
  const refs = Array.isArray(f.attach) ? f.attach : f.attach ? [f.attach] : [];
  if (!f.text && !refs.length)
    throw new Error("Message text or an attachment is required");
  const body: Data = { text: f.text ?? "" };
  const query: Data = {};
  if (f.thread) {
    body.thread = { name: thread(parent, f.thread) };
    query.messageReplyOption = "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD";
  }
  if (refs.length) {
    body.attachment = [];
    for (const ref of refs) {
      const name = String(ref)
          .replace(/^input:/, "")
          .split("/")
          .at(-1)!,
        bytes = r.input(ref),
        boundary = "upload_" + crypto.randomUUID();
      const start = new TextEncoder().encode(
          `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ filename: name })}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
        ),
        end = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
      const wire = new Uint8Array(start.length + bytes.length + end.length);
      wire.set(start);
      wire.set(bytes, start.length);
      wire.set(end, start.length + bytes.length);
      const uploaded = await r.upload(
        "chat-upload",
        `${parent}/attachments:upload`,
        wire,
        {
          method: "POST",
          query: { uploadType: "multipart" },
          headers: {
            "Content-Type": `multipart/related; boundary=${boundary}`,
          },
        },
      );
      if (!uploaded.attachmentDataRef)
        throw new Error("Chat attachment upload returned no reference");
      body.attachment.push({ attachmentDataRef: uploaded.attachmentDataRef });
    }
  }
  return {
    message: await r.json("chat", `${parent}/messages`, {
      method: "POST",
      query,
      body,
    }),
  };
}
export const chatHandlers: HandlerMap = {
  "chat.dm.space": async (c, r) => ({
    space: await setupDM(r, c.positionals[0]),
  }),
  "chat.dm.send": async (c, r) => {
    required(c.flags.text, "text");
    const result = await setupDM(r, c.positionals[0]);
    return send(c, r, required(result.name, "created DM space"));
  },
  "chat.messages.send": send,
  "chat.spaces.list": (c, r) =>
    pages(r, "chat", "spaces", "spaces", c.flags, {
      pageSize: c.flags.max ?? 100,
    }),
  "chat.spaces.find": async (c, r) => {
    const result = await pages(
      r,
      "chat",
      "spaces",
      "spaces",
      { all: true },
      { pageSize: c.flags.max ?? 100 },
    );
    const needle = c.positionals.join(" ").toLowerCase();
    return {
      spaces: result.spaces.filter((s: Data) =>
        c.flags.exact
          ? String(s.displayName).toLowerCase() === needle
          : String(s.displayName).toLowerCase().includes(needle),
      ),
    };
  },
  "chat.spaces.create": async (c, r) => ({
    space: await r.json("chat", "spaces:setup", {
      method: "POST",
      body: {
        space: { spaceType: "SPACE", displayName: c.positionals[0] },
        memberships: list(c.flags.member).map((email) => ({
          member: {
            name: email.startsWith("users/") ? email : "users/" + email,
            type: "HUMAN",
          },
        })),
      },
    }),
  }),
  "chat.messages.list": async (c, r) => {
    const parent = space(c.positionals[0]),
      f = c.flags,
      filters: string[] = [];
    if (f.thread) filters.push(`thread.name = "${thread(parent, f.thread)}"`);
    if (f.unread) {
      const state = await r.json("chat", `users/me/${parent}/spaceReadState`);
      if (state.lastReadTime)
        filters.push(
          `createTime > "${String(state.lastReadTime).replace(/["\\]/g, "")}"`,
        );
    }
    const result = await pages(r, "chat", `${parent}/messages`, "messages", f, {
      pageSize: f.max ?? 50,
      ...(f.order ? { orderBy: f.order } : {}),
      ...(filters.length ? { filter: filters.join(" AND ") } : {}),
    });
    return {
      messages: result.messages.map(row),
      nextPageToken: result.nextPageToken,
    };
  },
  "chat.messages.search": async (c, r) => {
    const f = c.flags,
      results: Data[] = [];
    let pageToken = f.page;
    const seen = new Set<string>();
    do {
      if (pageToken && seen.has(pageToken))
        throw new Error("Provider repeated a page token");
      if (pageToken) seen.add(pageToken);
      const response = await r.json("chat", "spaces/-/messages:search", {
        method: "POST",
        body: {
          filter: c.positionals.join(" "),
          pageSize: f.max ?? 25,
          ...(pageToken ? { pageToken } : {}),
          ...(f.order ? { orderBy: f.order } : {}),
          view:
            f.view === "full"
              ? "SEARCH_MESSAGES_VIEW_FULL"
              : "SEARCH_MESSAGES_VIEW_BASIC",
          ...(f.markup
            ? {
                markupSyntax:
                  f.markup === "markdown"
                    ? "MARKUP_SYNTAX_MARKDOWN"
                    : "MARKUP_SYNTAX_CHAT",
              }
            : {}),
        },
      });
      results.push(...(response.results ?? []));
      pageToken = response.nextPageToken;
    } while (f.all && pageToken);
    if (f["fail-empty"] && !results.length) throw new Error("No results");
    return {
      results: results.map((v) => ({
        ...row(v.message ?? {}),
        space: v.message?.space?.name,
        formattedText: v.message?.formattedText,
        ...(f.view === "full" ? { read: v.read } : {}),
        spaceMuteSetting: v.spaceMuteSetting,
      })),
      nextPageToken: pageToken,
    };
  },
  "chat.threads.list": async (c, r) => {
    const result = await pages(
      r,
      "chat",
      `${space(c.positionals[0])}/messages`,
      "messages",
      c.flags,
      { pageSize: c.flags.max ?? 50, orderBy: "createTime desc" },
    );
    const unique = new Map<string, Data>();
    for (const m of result.messages)
      if (m.thread?.name && !unique.has(m.thread.name))
        unique.set(m.thread.name, {
          thread: m.thread.name,
          message: m.name,
          sender: m.sender?.displayName || m.sender?.name,
          text: m.text,
          createTime: m.createTime,
        });
    return {
      threads: [...unique.values()],
      nextPageToken: result.nextPageToken,
    };
  },
  "chat.messages.react": async (c, r) => ({
    reaction: await r.json(
      "chat",
      `${message(c.positionals[0], c.flags.space)}/reactions`,
      { method: "POST", body: { emoji: { unicode: c.positionals[1] } } },
    ),
  }),
  "chat.messages.reactions.create": async (c, r) => ({
    reaction: await r.json(
      "chat",
      `${message(c.positionals[0], c.flags.space)}/reactions`,
      { method: "POST", body: { emoji: { unicode: c.positionals[1] } } },
    ),
  }),
  "chat.messages.reactions.list": (c, r) =>
    pages(
      r,
      "chat",
      `${message(c.positionals[0], c.flags.space)}/reactions`,
      "reactions",
      c.flags,
      { pageSize: c.flags.max ?? 50 },
    ),
  "chat.messages.reactions.delete": async (c, r) => {
    await r.json("chat", resource(c.positionals[0], "spaces"), {
      method: "DELETE",
    });
    return { deleted: c.positionals[0] };
  },
};
