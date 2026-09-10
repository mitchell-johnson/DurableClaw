import { describe, expect, it, vi } from "vitest";
import { parseCommand } from "../../services/connectors/vendor/gogcli/catalog";
import { NativeRuntime } from "../../services/connectors/vendor/gogcli/runtime";
import {
  communicationHandlers,
  gmailQuickRead,
} from "../../services/connectors/vendor/gogcli/communications";
import catalog from "../../services/connectors/vendor/gogcli/catalog.json";
import type {
  Command,
  Runtime,
} from "../../services/connectors/vendor/gogcli/types";
function fixture(responses: unknown[] = []) {
  const json = vi.fn(async () => responses.shift() ?? {});
  const output = vi.fn((name: string, bytes: Uint8Array | string) => ({
    name,
    bytes: bytes.length,
  }));
  const runtime: Runtime = {
    account: "owner@example.com",
    signal: new AbortController().signal,
    json,
    output,
    discovery: vi.fn(),
    externalBytes: vi.fn(),
    inputs: vi.fn(),
    bytes: vi.fn(),
    upload: vi.fn(),
    input: () => new TextEncoder().encode("attachment"),
    text: () => "file text",
    jsonInput: (v) => (typeof v === "string" ? JSON.parse(v) : v),
    outputName: (_c, fallback) => fallback ?? "result.json",
  };
  const run = (name: string, positionals: string[] = [], flags = {}) =>
    communicationHandlers[name](
      { command: name, positionals, flags, files: [], output_files: [] },
      runtime,
    );
  return { json, output, runtime, run };
}
describe("native communication command ports", () => {
  it("covers every communication leaf from the pinned catalog", () => {
    const commands = catalog.commands
      .filter((c) =>
        [
          "gmail",
          "calendar",
          "contacts",
          "people",
          "tasks",
          "maps",
          "chat",
        ].includes(c.service),
      )
      .map((c) => c.command);
    expect(Object.keys(communicationHandlers).sort()).toEqual(commands.sort());
  });
  it("resolves label names before changing message labels", async () => {
    const h = fixture([
      { labels: [{ id: "Label_7", name: "Work" }] },
      { id: "abc" },
    ]);
    await h.run("gmail.messages.modify", ["abc"], {
      add: "Work",
      remove: "UNREAD",
    });
    expect(h.json).toHaveBeenLastCalledWith(
      "gmail",
      "users/me/messages/abc/modify",
      {
        method: "POST",
        body: { addLabelIds: ["Label_7"], removeLabelIds: ["UNREAD"] },
      },
    );
  });
  it("builds RFC822 multipart mail with reply headers and attachments", async () => {
    const h = fixture([
      {
        id: "abc",
        threadId: "thread",
        payload: {
          headers: [
            { name: "From", value: "sender@example.com" },
            { name: "Message-ID", value: "<original@example.com>" },
            { name: "Subject", value: "Hello" },
          ],
          mimeType: "text/plain",
          body: { data: "T3JpZ2luYWw" },
        },
      },
      { id: "sent" },
    ]);
    await h.run("gmail.reply", ["abc"], {
      body: "Reply",
      attach: ["input:report.txt"],
    });
    const options = h.json.mock.calls.at(-1)?.[2] as any;
    expect(options.body.threadId).toBe("thread");
    const mime = atob(options.body.raw.replace(/-/g, "+").replace(/_/g, "/"));
    expect(mime).toContain("In-Reply-To: <original@example.com>");
    expect(mime).toContain("To: sender@example.com");
    expect(mime).toContain("multipart/mixed");
    expect(mime).toContain('filename="report.txt"');
  });
  it("sanitizes quick Gmail reads and omits raw payloads", async () => {
    const h = fixture([
      {
        id: "abc",
        payload: {
          mimeType: "text/html",
          body: { data: btoa("<b>Hello</b> https://unsafe.example") },
        },
      },
    ]);
    const result = await gmailQuickRead(
      "gmail_get_message",
      { message_id: "abc" },
      h.runtime,
    );
    expect(JSON.stringify(result)).toContain("Hello");
    expect(JSON.stringify(result)).not.toContain("https://unsafe.example");
    expect(JSON.stringify(result)).not.toContain("payload");
  });
  it("retains contact ETags when updating selected fields", async () => {
    const h = fixture([
      {
        resourceName: "people/c1",
        etag: "etag",
        metadata: { sources: [{ type: "CONTACT", etag: "source-etag" }] },
        names: [{ givenName: "Old", familyName: "Name" }],
      },
      { resourceName: "people/c1" },
    ]);
    await h.run("contacts.update", ["people/c1"], { given: "New" });
    const call = h.json.mock.calls.at(-1) as any;
    expect(call[1]).toBe("people/c1:updateContact");
    expect(call[2].body.etag).toBe("etag");
    expect(call[2].body.names[0]).toMatchObject({
      givenName: "New",
      familyName: "Name",
    });
    expect(call[2].query.updatePersonFields).toBe("names");
  });
  it("creates a DM space before sending its threaded message", async () => {
    const h = fixture([
      { name: "spaces/dm" },
      { name: "spaces/dm/messages/m1" },
    ]);
    await h.run("chat.dm.send", ["other@example.com"], {
      text: "Hello",
      thread: "t1",
    });
    expect(h.json).toHaveBeenNthCalledWith(1, "chat", "spaces:setup", {
      method: "POST",
      body: {
        space: { spaceType: "DIRECT_MESSAGE" },
        memberships: [
          { member: { name: "users/other@example.com", type: "HUMAN" } },
        ],
      },
    });
    expect(h.json).toHaveBeenLastCalledWith("chat", "spaces/dm/messages", {
      method: "POST",
      query: { messageReplyOption: "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD" },
      body: { text: "Hello", thread: { name: "spaces/dm/threads/t1" } },
    });
  });
});

describe("communication behavioral regressions", () => {
  it("archives every positional thread when --thread is a boolean", async () => {
    const h = fixture([{ id: "one" }, { id: "two" }]);
    await h.run("gmail.archive", ["one", "two"], { thread: true });
    expect(h.json.mock.calls.map((call: any[]) => call[1])).toEqual([
      "users/me/threads/one/modify",
      "users/me/threads/two/modify",
    ]);
  });
  it("loads the active Gmail signature for the boolean signature flag", async () => {
    const h = fixture([
      { signature: "<b>Owner signature</b>" },
      { id: "sent" },
    ]);
    await h.run("gmail.send", [], {
      to: "recipient@example.com",
      subject: "Hello",
      body: "Text",
      signature: true,
    });
    expect(h.json).toHaveBeenNthCalledWith(
      1,
      "gmail",
      "users/me/settings/sendAs/owner%40example.com",
    );
    const raw = (h.json.mock.calls.at(-1) as any)[2].body.raw;
    expect(
      atob(
        atob(raw.replace(/-/g, "+").replace(/_/g, "/"))
          .split("\r\n\r\n")[1]
          .trim(),
      ),
    ).toContain("Owner signature");
  });
  it("treats calendar location as display metadata and preserves events", async () => {
    const h = fixture([
      {
        items: [
          {
            id: "event",
            location: "Office",
            start: { dateTime: "2026-09-09T10:00:00Z" },
            end: { dateTime: "2026-09-09T11:00:00Z" },
          },
        ],
      },
    ]);
    const result = (await h.run("calendar.events", ["primary"], {
      from: "2026-09-09T00:00:00Z",
      to: "2026-09-10T00:00:00Z",
      location: true,
    })) as any;
    expect(result.events).toHaveLength(1);
    expect(result.events[0].location).toBe("Office");
  });
  it("creates timezone-aware recurring events with explicit false guest permissions", async () => {
    const h = fixture([{ id: "event" }]);
    await h.run("calendar.create", ["primary"], {
      summary: "Planning",
      from: "2026-09-09T09:00:00",
      to: "2026-09-09T10:00:00",
      timezone: "America/New_York",
      rrule: ["FREQ=WEEKLY;BYDAY=WE"],
      "guests-can-invite": false,
      reminder: ["popup:10m"],
      attendees: "a@example.com,b@example.com",
    });
    expect(h.json).toHaveBeenCalledWith(
      "calendar",
      "calendars/primary/events",
      {
        method: "POST",
        query: {},
        body: expect.objectContaining({
          start: {
            dateTime: "2026-09-09T13:00:00.000Z",
            timeZone: "America/New_York",
          },
          end: {
            dateTime: "2026-09-09T14:00:00.000Z",
            timeZone: "America/New_York",
          },
          recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=WE"],
          guestsCanInviteOthers: false,
          reminders: {
            useDefault: false,
            overrides: [{ method: "popup", minutes: 10 }],
          },
          attendees: [{ email: "a@example.com" }, { email: "b@example.com" }],
        }),
      },
    );
  });
  it("materializes task recurrence and validates the entire schedule before writes", async () => {
    const h = fixture([{ id: "one" }, { id: "two" }, { id: "three" }]);
    await h.run("tasks.add", ["@default"], {
      title: "Repeat",
      due: "2026-09-09",
      "recur-rrule": "FREQ=DAILY;INTERVAL=2",
      "repeat-count": 3,
    });
    expect(h.json.mock.calls.map((call: any[]) => call[2].body.due)).toEqual([
      "2026-09-09T00:00:00.000Z",
      "2026-09-11T00:00:00.000Z",
      "2026-09-13T00:00:00.000Z",
    ]);
    const denied = fixture();
    await expect(
      denied.run("tasks.add", ["@default"], {
        title: "No",
        due: "2026-09-09",
        repeat: "daily",
        "repeat-count": 51,
      }),
    ).rejects.toThrow("50");
    expect(denied.json).not.toHaveBeenCalled();
  });
  it("limits contact dedupe exactly to explicitly selected resources", async () => {
    const a = {
        resourceName: "people/a",
        emailAddresses: [{ value: "same@example.com" }],
      },
      b = {
        resourceName: "people/b",
        emailAddresses: [{ value: "same@example.com" }],
      };
    const h = fixture([a, b]);
    const result = (await h.run("contacts.dedupe", [], {
      resource: ["people/a", "people/b"],
    })) as any;
    expect(h.json.mock.calls.map((call: any[]) => call[1])).toEqual([
      "people/a",
      "people/b",
    ]);
    expect(result.groups[0].members).toHaveLength(2);
  });
});

describe("multi-step write protection", () => {
  const original = {
    id: "original",
    threadId: "thread",
    payload: {
      headers: [
        { name: "From", value: "sender@example.com" },
        { name: "To", value: "owner@example.com" },
        { name: "Subject", value: "Original topic" },
        { name: "Message-ID", value: "<original@example.com>" },
      ],
      mimeType: "text/plain",
      body: { data: btoa("Original text") },
    },
  };
  it("starts a new thread for changed reply subjects and forwards", async () => {
    for (const [command, flags] of [
      ["gmail.reply", { body: "New topic", subject: "Other topic" }],
      ["gmail.forward", { to: "next@example.com", note: "FYI" }],
    ] as const) {
      const h = fixture([original, { id: "sent" }]);
      await h.run(command, ["original"], flags);
      const body = (h.json.mock.calls.at(-1) as any)[2].body;
      expect(body.threadId).toBeUndefined();
      expect(
        atob(body.raw.replace(/-/g, "+").replace(/_/g, "/")),
      ).not.toContain("In-Reply-To:");
    }
  });
  it("keeps existing draft attachments and reply context unless cleared explicitly", async () => {
    const existing = {
      ...original,
      payload: {
        ...original.payload,
        headers: [
          ...original.payload.headers.filter((h) => h.name !== "From"),
          { name: "From", value: "owner@example.com" },
          { name: "To", value: "recipient@example.com" },
          { name: "In-Reply-To", value: "<parent@example.com>" },
        ],
        parts: [
          {
            filename: "old.txt",
            mimeType: "text/plain",
            body: { attachmentId: "attachment" },
          },
        ],
      },
    };
    const h = fixture([
      { message: existing },
      { data: btoa("retained bytes") },
      { id: "draft" },
    ]);
    await h.run("gmail.drafts.update", ["draft"], { body: "Updated" });
    const body = (h.json.mock.calls.at(-1) as any)[2].body.message;
    expect(body.threadId).toBe("thread");
    const raw = atob(body.raw.replace(/-/g, "+").replace(/_/g, "/"));
    expect(raw).toContain("old.txt");
    expect(raw).toContain("In-Reply-To: <parent@example.com>");
    const clear = fixture([{ message: existing }, { id: "draft" }]);
    await clear.run("gmail.drafts.update", ["draft"], {
      body: "New",
      "clear-attachments": true,
      "clear-reply-context": true,
    });
    expect(clear.json).toHaveBeenCalledTimes(2);
    expect(
      (clear.json.mock.calls.at(-1) as any)[2].body.message.threadId,
    ).toBeUndefined();
  });
  it("refuses to delete a dedupe candidate that changed after the merged update", async () => {
    const person = (id: string, etag: string) => ({
      resourceName: `people/${id}`,
      etag,
      metadata: { sources: [{ type: "CONTACT", etag }] },
      emailAddresses: [{ value: "same@example.com" }],
    });
    const a = person("a", "a"),
      b = person("b", "b");
    const h = fixture([a, b, a, b, {}, person("b", "changed")]);
    await expect(
      h.run("contacts.dedupe", [], {
        resource: ["people/a", "people/b"],
        apply: true,
      }),
    ).rejects.toThrow("changed");
    expect(
      h.json.mock.calls.some((call: any[]) => call[2]?.method === "DELETE"),
    ).toBe(false);
    expect(
      h.json.mock.calls.some((call: any[]) => call[2]?.method === "PATCH"),
    ).toBe(true);
  });
  it("rechecks that contacts still match before applying a merge", async () => {
    const person = (id: string, email: string) => ({
      resourceName: `people/${id}`,
      etag: id,
      metadata: { sources: [{ type: "CONTACT", etag: id }] },
      emailAddresses: [{ value: email }],
    });
    const a = person("a", "same@example.com"),
      b = person("b", "same@example.com");
    const h = fixture([a, b, a, person("b", "changed@example.com")]);
    await expect(
      h.run("contacts.dedupe", [], {
        resource: ["people/a", "people/b"],
        apply: true,
      }),
    ).rejects.toThrow("no longer match");
    expect(
      h.json.mock.calls.some((call: any[]) => call[2]?.method === "PATCH"),
    ).toBe(false);
  });
  it("does not collapse conflicting structured contact birthdays", async () => {
    const person = (id: string, year: number) => ({
      resourceName: `people/${id}`,
      etag: id,
      metadata: { sources: [{ type: "CONTACT", etag: id }] },
      emailAddresses: [{ value: "same@example.com" }],
      birthdays: [{ date: { year, month: 1, day: 2 } }],
    });
    const a = person("a", 2000),
      b = person("b", 2001);
    const h = fixture([a, b, a, b]);
    await expect(
      h.run("contacts.dedupe", [], {
        resource: ["people/a", "people/b"],
        apply: true,
      }),
    ).rejects.toThrow("birthdays");
    expect(
      h.json.mock.calls.some((call: any[]) => call[2]?.method === "PATCH"),
    ).toBe(false);
  });
  it("truncates the recurring parent instead of deleting the selected future instance", async () => {
    const parent = { id: "parent", recurrence: ["RRULE:FREQ=DAILY;COUNT=10"] },
      instance = {
        id: "instance",
        recurringEventId: "parent",
        originalStartTime: { dateTime: "2026-09-10T09:00:00Z" },
      };
    const h = fixture([parent, { items: [instance] }, {}]);
    await h.run("calendar.delete", ["primary", "parent"], {
      scope: "future",
      "original-start": "2026-09-10T09:00:00Z",
      "send-updates": "all",
    });
    expect(h.json).toHaveBeenLastCalledWith(
      "calendar",
      "calendars/primary/events/parent",
      {
        method: "PATCH",
        query: { sendUpdates: "all" },
        body: { recurrence: ["RRULE:FREQ=DAILY;UNTIL=20260910T085959Z"] },
      },
    );
    expect(
      h.json.mock.calls.some((call: any[]) => call[2]?.method === "DELETE"),
    ).toBe(false);
  });
  it("sends Chat attachment bytes only through the runtime upload interface", async () => {
    const h = fixture([{ name: "spaces/space/messages/sent" }]);
    vi.mocked(h.runtime.upload).mockResolvedValue({
      attachmentDataRef: { resourceName: "attachment-resource" },
    });
    await h.run("chat.messages.send", ["spaces/space"], {
      attach: ["input:test.txt"],
    });
    expect(h.runtime.upload).toHaveBeenCalledWith(
      "chat-upload",
      "spaces/space/attachments:upload",
      expect.any(Uint8Array),
      expect.objectContaining({
        method: "POST",
        query: { uploadType: "multipart" },
      }),
    );
    expect((h.json.mock.calls.at(-1) as any)[2].body.attachment).toEqual([
      { attachmentDataRef: { resourceName: "attachment-resource" } },
    ]);
  });
});

describe("communication ports through the production runtime", () => {
  it("supports the advertised fifty-message Gmail search within the request budget", async () => {
    const command: Command = {
      command: "gmail_search",
      positionals: [],
      flags: {},
      files: [],
      output_files: [],
    };
    const fetcher = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      expect(url.origin).toBe("https://gmail.googleapis.com");
      expect(request.headers.get("Authorization")).toBe(
        "Bearer private-test-token",
      );
      if (url.pathname.endsWith("/messages"))
        return Response.json({
          messages: Array.from({ length: 50 }, (_, i) => ({
            id: (i + 1).toString(16),
          })),
        });
      return Response.json({
        id: url.pathname.split("/").at(-1),
        internalDate: "0",
        payload: {
          headers: [
            { name: "Subject", value: "A result" },
            { name: "From", value: "sender@example.com" },
          ],
        },
      });
    });
    const runtime = new NativeRuntime(command, {
      accessToken: "private-test-token",
      account: "owner@example.com",
      fetch: fetcher,
    });
    const result = (await gmailQuickRead(
      "gmail_search",
      { query: "in:inbox", max: 50 },
      runtime,
    )) as any;
    expect(result.messages).toHaveLength(50);
    expect(fetcher).toHaveBeenCalledTimes(51);
    expect(JSON.stringify(runtime.result(result))).not.toContain(
      "private-test-token",
    );
  });
  it("reaches Google RPC-style contact creation paths through the runtime", async () => {
    const command: Command = {
      command: "contacts.create",
      positionals: [],
      flags: { given: "Example", email: "test@example.com" },
      files: [],
      output_files: [],
    };
    const fetcher = vi.fn(async (request: Request) => {
      expect(request.url).toBe(
        "https://people.googleapis.com/v1/people:createContact",
      );
      expect(request.method).toBe("POST");
      expect(await request.json()).toEqual({
        names: [{ givenName: "Example" }],
        emailAddresses: [{ value: "test@example.com" }],
      });
      return Response.json({ resourceName: "people/created" });
    });
    const runtime = new NativeRuntime(command, {
      accessToken: "private-test-token",
      account: "owner@example.com",
      fetch: fetcher,
    });
    expect(
      await communicationHandlers[command.command](command, runtime),
    ).toEqual({ contact: { resourceName: "people/created" } });
  });
});

describe("catalog-default and calendar helper parity", () => {
  it("does not reset an alias's treatAsAlias when the injected default was not supplied", async () => {
    const h = fixture([
      {
        sendAsEmail: "owner@example.com",
        treatAsAlias: false,
        displayName: "Old",
      },
      { sendAsEmail: "owner@example.com" },
    ]);
    const command = parseCommand({
      command: "gmail.settings.sendas.update",
      positionals: ["owner@example.com"],
      flags: { "display-name": "New" },
    });
    expect(command.flags["treat-as-alias"]).toBe(true);
    await communicationHandlers[command.command](command, h.runtime);
    expect((h.json.mock.calls.at(-1) as any)[2].body).toMatchObject({
      treatAsAlias: false,
      displayName: "New",
    });
  });
  it("maps the advertised home working-location type to Google's API fields", async () => {
    const h = fixture([{ timeZone: "UTC" }, { id: "working" }]);
    await h.run("calendar.working-location", [], {
      type: "home",
      from: "2026-09-09",
      to: "2026-09-10",
    });
    expect((h.json.mock.calls.at(-1) as any)[2].body).toMatchObject({
      eventType: "workingLocation",
      summary: "Working from home",
      start: { date: "2026-09-09" },
      end: { date: "2026-09-10" },
      workingLocationProperties: { type: "homeOffice", homeOffice: {} },
      transparency: "transparent",
      visibility: "public",
    });
  });
  it("supports changed-event duration defaults and returns the latest bounded changes", async () => {
    const h = fixture([
      {
        items: [
          { id: "older", updated: "2026-09-08T00:00:00Z" },
          { id: "newer", updated: "2026-09-09T00:00:00Z", status: "cancelled" },
        ],
      },
    ]);
    const result = (await h.run("calendar.changed", ["primary"], {
      since: "24h",
      max: 1,
      location: true,
    })) as any;
    const query = (h.json.mock.calls[0] as any)[2].query;
    expect(query).toMatchObject({
      maxResults: 250,
      showDeleted: true,
      orderBy: "updated",
    });
    expect(
      Math.abs(Date.parse(query.updatedMin) - (Date.now() - 86400_000)),
    ).toBeLessThan(1000);
    expect(result.events.map((e: any) => e.id)).toEqual(["newer"]);
  });
  it("rejects mail header injection before any send", async () => {
    const h = fixture();
    await expect(
      h.run("gmail.send", [], {
        to: "recipient@example.com",
        subject: "Hello\r\nBcc: attacker@example.com",
        body: "Text",
      }),
    ).rejects.toThrow("header");
    expect(h.json).not.toHaveBeenCalled();
  });
});

describe("additional upstream compound operations", () => {
  it("marks automatic replies with loop-suppression headers before marking the thread", async () => {
    const original = {
      id: "one",
      threadId: "thread",
      payload: {
        headers: [
          { name: "From", value: "sender@example.com" },
          { name: "Subject", value: "Question" },
          { name: "Message-ID", value: "<q@example.com>" },
        ],
        body: {},
      },
    };
    const h = fixture([
      { labels: [{ id: "Label_auto", name: "AutoReplied" }] },
      { messages: [{ id: "one" }] },
      original,
      original,
      { id: "sent" },
      {},
    ]);
    await h.run("gmail.autoreply", ["in:inbox"], {
      body: "Automatic answer",
      archive: true,
      "mark-read": true,
    });
    const sent = h.json.mock.calls.find(
      (call: any[]) => call[1] === "users/me/messages/send",
    ) as any;
    const raw = atob(sent[2].body.raw.replace(/-/g, "+").replace(/_/g, "/"));
    expect(raw).toContain("Auto-Submitted: auto-replied");
    expect(raw).toContain("X-Auto-Response-Suppress: All");
    expect(h.json).toHaveBeenLastCalledWith(
      "gmail",
      "users/me/threads/thread/modify",
      {
        method: "POST",
        body: {
          addLabelIds: ["Label_auto"],
          removeLabelIds: ["INBOX", "UNREAD"],
        },
      },
    );
  });
  it("resolves task-list names and clears the list's completed tasks endpoint", async () => {
    const h = fixture([
      { items: [{ id: "opaque-task-list-id", title: "Work" }] },
      {},
    ]);
    await h.run("tasks.clear", ["work"]);
    expect(h.json).toHaveBeenLastCalledWith(
      "tasks",
      "lists/opaque-task-list-id/clear",
      { method: "POST" },
    );
  });
  it("keeps a Gmail reply's added/moved recipients in the requested fields", async () => {
    const original = {
      id: "one",
      threadId: "thread",
      payload: {
        headers: [
          { name: "From", value: "sender@example.com" },
          { name: "To", value: "owner@example.com, coworker@example.com" },
          { name: "Cc", value: "observer@example.com" },
          { name: "Subject", value: "Question" },
        ],
        body: {},
      },
    };
    const h = fixture([original, { id: "sent" }]);
    await h.run("gmail.reply-all", ["one"], {
      body: "Answer",
      cc: ["sender@example.com"],
      to: ["new@example.com"],
      remove: ["observer@example.com"],
    });
    const raw = atob(
      (h.json.mock.calls.at(-1) as any)[2].body.raw
        .replace(/-/g, "+")
        .replace(/_/g, "/"),
    );
    expect(raw).toContain("To: coworker@example.com, new@example.com");
    expect(raw).toContain("Cc: sender@example.com");
    expect(raw).not.toContain("observer@example.com");
  });
});

describe("directory and calendar output parity", () => {
  it("lists calendar users from the Workspace directory", async () => {
    const h = fixture([
      {
        people: [
          {
            names: [{ displayName: "User" }],
            emailAddresses: [{ value: "user@example.com" }],
          },
        ],
      },
    ]);
    expect(await h.run("calendar.users", [], { max: 25 })).toMatchObject({
      users: [{ name: "User", email: "user@example.com" }],
    });
    expect(h.json).toHaveBeenCalledWith(
      "people",
      "people:listDirectoryPeople",
      {
        query: {
          pageSize: 25,
          readMask: "names,emailAddresses",
          sources: "DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE",
        },
      },
    );
  });
  it("redacts Zoom passwords unless the owner explicitly requests them", async () => {
    const event = {
      id: "event",
      description: "Join https://company.zoom.us/j/123?pwd=secret&other=value",
    };
    const h = fixture([event]);
    const result = await h.run("calendar.event", ["primary", "event"]);
    expect(JSON.stringify(result)).toContain("pwd=REDACTED");
    expect(JSON.stringify(result)).not.toContain("pwd=secret");
    const explicit = fixture([{ timeZone: "UTC" }, event]);
    const visible = await explicit.run("calendar.create", ["primary"], {
      summary: "Planning",
      from: "2026-09-09",
      to: "2026-09-10",
      "all-day": true,
      "include-passwords": true,
    });
    expect(JSON.stringify(visible)).toContain("pwd=secret");
  });
  it("rejects nonexistent local dates before creating an event", async () => {
    const h = fixture();
    await expect(
      h.run("calendar.create", ["primary"], {
        summary: "Planning",
        from: "2026-02-30",
        to: "2026-03-02",
        timezone: "UTC",
      }),
    ).rejects.toThrow("Invalid calendar date");
    expect(h.json).not.toHaveBeenCalled();
  });
});

describe("Gmail compose upstream regressions", () => {
  const original = {
    id: "original",
    threadId: "thread",
    internalDate: "200",
    payload: {
      headers: [
        { name: "From", value: "sender@example.com" },
        { name: "To", value: "owner@example.com, colleague@example.com" },
        { name: "Subject", value: "Question" },
        { name: "Message-ID", value: "<original@example.com>" },
      ],
      body: {},
    },
  };
  it("resolves --thread-id to the newest delivered message, ignoring newer drafts", async () => {
    const h = fixture([
      {
        id: "thread",
        messages: [
          original,
          {
            ...original,
            id: "draft",
            internalDate: "300",
            labelIds: ["DRAFT"],
          },
        ],
      },
      { id: "sent" },
    ]);
    const command = parseCommand({
      command: "gmail.send",
      flags: {
        "thread-id": "thread",
        "reply-all": true,
        body: "Answer",
      },
    });
    await communicationHandlers[command.command](command, h.runtime);
    const sent = (h.json.mock.calls.at(-1) as any)[2].body;
    const raw = atob(sent.raw.replace(/-/g, "+").replace(/_/g, "/"));
    expect(sent.threadId).toBe("thread");
    expect(raw).toContain("To: sender@example.com, colleague@example.com");
    expect(raw).toContain("In-Reply-To: <original@example.com>");
  });
  it("replaces draft attachments when --attach is supplied", async () => {
    const h = fixture([
      {
        message: {
          ...original,
          payload: {
            ...original.payload,
            parts: [
              {
                filename: "old.txt",
                mimeType: "text/plain",
                body: { attachmentId: "old", size: 3 },
              },
            ],
          },
        },
      },
      { id: "draft" },
    ]);
    await h.run("gmail.drafts.update", ["draft"], {
      attach: ["input:new.txt"],
      body: "Revised",
      from: "owner@example.com",
    });
    expect(h.json).toHaveBeenCalledTimes(2);
    const raw = atob(
      (h.json.mock.calls.at(-1) as any)[2].body.message.raw
        .replace(/-/g, "+")
        .replace(/_/g, "/"),
    );
    expect(raw).toContain('filename="new.txt"');
    expect(raw).not.toContain('filename="old.txt"');
  });
  it("permits a forward draft with no recipients while rejecting an addressless send", async () => {
    const h = fixture([original, { id: "draft" }]);
    await expect(
      h.run("gmail.drafts.forward", ["original"], { note: "Review" }),
    ).resolves.toMatchObject({ draft: { id: "draft" } });
    const send = fixture([original]);
    await expect(
      send.run("gmail.forward", ["original"], { note: "Review" }),
    ).rejects.toThrow("recipient");
    expect(send.json).toHaveBeenCalledTimes(1);
  });
  it("rejects mutually exclusive attachment and reply-context flags before network access", async () => {
    const h = fixture();
    await expect(
      h.run("gmail.drafts.create", [], {
        attach: ["input:new.txt"],
        "clear-attachments": true,
      }),
    ).rejects.toThrow("attachment");
    await expect(
      h.run("gmail.send", [], {
        "thread-id": "thread",
        "reply-to-message-id": "original",
      }),
    ).rejects.toThrow("reply");
    expect(h.json).not.toHaveBeenCalled();
  });
  it("accepts verified aliases for raw mail and rejects unverified aliases", async () => {
    const h = fixture([
      {
        sendAs: [
          { sendAsEmail: "alias@example.com", verificationStatus: "accepted" },
        ],
      },
      { id: "sent" },
    ]);
    h.runtime.input = () =>
      new TextEncoder().encode(
        "From: Alias <alias@example.com>\r\nTo: other@example.com\r\nSubject: Test\r\n\r\nHello",
      );
    await expect(
      h.run("gmail.send", [], { "raw-file": "input:message.eml" }),
    ).resolves.toMatchObject({ message: { id: "sent" } });
    const rejected = fixture([
      {
        sendAs: [
          { sendAsEmail: "alias@example.com", verificationStatus: "pending" },
        ],
      },
    ]);
    rejected.runtime.input = h.runtime.input;
    await expect(
      rejected.run("gmail.send", [], { "raw-file": "input:message.eml" }),
    ).rejects.toThrow("verified");
    expect(rejected.json).toHaveBeenCalledTimes(1);
  });
  it("encodes non-ASCII mailbox display names without encoding the email address", async () => {
    const h = fixture([{ id: "sent" }]);
    await h.run("gmail.send", [], {
      to: "José <jose@example.com>",
      subject: "Hello",
      body: "Hi",
    });
    const raw = atob(
      (h.json.mock.calls.at(-1) as any)[2].body.raw
        .replace(/-/g, "+")
        .replace(/_/g, "/"),
    );
    expect(raw).toContain("To: =?UTF-8?B?Sm9zw6k=?= <jose@example.com>");
  });
  it("renders HTML-only message text while retaining URLs on ordinary reads", async () => {
    const h = fixture([
      {
        id: "one",
        payload: {
          mimeType: "text/html",
          body: {
            data: btoa(
              '<p>Hello &amp; welcome</p><a href="https://example.com">Site</a> https://example.com',
            ),
          },
        },
      },
    ]);
    const result = await h.run("gmail.get", ["one"]);
    expect(result.body).not.toContain("<p>");
    expect(result.body).toContain("Hello & welcome");
    expect(result.body).toContain("https://example.com");
  });
  it("requires an ordinary calendar event title before any mutation", async () => {
    const h = fixture();
    await expect(
      h.run("calendar.create", ["primary"], {
        from: "2026-09-09",
        to: "2026-09-10",
        timezone: "UTC",
      }),
    ).rejects.toThrow("summary");
    expect(h.json).not.toHaveBeenCalled();
  });
});
