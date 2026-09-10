import { describe, expect, it, vi } from "vitest";
import { NativeRuntime } from "../../services/connectors/vendor/gogcli/runtime";
import {
  commands,
  describeCatalog,
  parseCommand,
} from "../../services/connectors/vendor/gogcli/catalog";
import { discoveryRequest } from "../../services/connectors/vendor/gogcli/discovery";
import type { Command } from "../../services/connectors/vendor/gogcli/types";
import { communicationHandlers } from "../../services/connectors/vendor/gogcli/communications";
import { administrationHandlers } from "../../services/connectors/vendor/gogcli/administration";

const input: Command = {
  command: "gmail.labels.list",
  positionals: [],
  flags: {},
  files: [],
  output_files: [],
};
function fixture(
  responses: Response[] = [],
  command = input,
  signal?: AbortSignal,
) {
  const fetcher = vi.fn(
    async (_request: Request) =>
      responses.shift() ?? Response.json({ ok: true }),
  );
  return {
    fetcher,
    runtime: new NativeRuntime(command, {
      accessToken: "secret-access-token",
      account: "owner@example.com",
      mapsKey: "secret-maps-key",
      fetch: fetcher,
      signal,
    }),
  };
}
describe("native credential and file runtime", () => {
  it("attaches OAuth only to fixed Google APIs and Maps credentials only to Maps", async () => {
    const { runtime, fetcher } = fixture();
    await runtime.json("gmail", "users/me/messages", {
      query: { labelIds: ["INBOX", "UNREAD"], missing: undefined },
    });
    await runtime.json("maps", "geocode/json", { query: { address: "Suva" } });
    await runtime.json("places", "places:searchText", {
      method: "POST",
      body: { textQuery: "Suva" },
      headers: { "X-Goog-FieldMask": "places.id" },
    });
    const requests = fetcher.mock.calls.map(([r]) => r);
    expect(requests[0].headers.get("Authorization")).toBe(
      "Bearer secret-access-token",
    );
    expect(new URL(requests[0].url).searchParams.getAll("labelIds")).toEqual([
      "INBOX",
      "UNREAD",
    ]);
    expect(requests[1].headers.has("Authorization")).toBe(false);
    expect(new URL(requests[1].url).searchParams.get("key")).toBe(
      "secret-maps-key",
    );
    expect(requests[2].headers.get("X-Goog-Api-Key")).toBe("secret-maps-key");
    expect(requests[2].headers.has("Authorization")).toBe(false);
    expect(requests.every((request) => request.redirect === "manual")).toBe(
      true,
    );
  });
  it.each([
    "https://attacker.example/",
    "//attacker.example",
    "../../oauth2/token",
    "%2e%2e/%2e%2e/other",
    "users/me#token",
    "users\\me",
  ])("rejects an escaped API path %s before fetch", async (path) => {
    const { runtime, fetcher } = fixture();
    await expect(runtime.json("gmail", path)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects credential overrides and arbitrary headers before fetch", async () => {
    const { runtime, fetcher } = fixture();
    for (const key of ["key", "access_token", "oauth_token"])
      await expect(
        runtime.json("gmail", "users/me", { query: { [key]: "injected" } }),
      ).rejects.toThrow();
    await expect(
      runtime.json("gmail", "users/me", {
        headers: { Authorization: "injected" },
      }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    "groups/group-id/members/..",
    "groups/group-id/members/%2E%2E",
    "groups/group-id/members/.%2e",
    "groups/group-id/members/..%2F..",
  ])("rejects dot-segment resource rewriting: %s", async (path) => {
    const { runtime, fetcher } = fixture();
    await expect(
      runtime.json("admin", path, { method: "DELETE" }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("never retries writes or exposes provider error text", async () => {
    const { runtime, fetcher } = fixture([
      new Response("secret-access-token and private email", { status: 503 }),
    ]);
    await expect(
      runtime.json("gmail", "users/me/messages/send", {
        method: "POST",
        body: { raw: "AA" },
      }),
    ).rejects.toThrow("Google request failed (503)");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("bounds request count and permits a 50-result list with 50 message reads", async () => {
    const { runtime, fetcher } = fixture();
    for (let n = 0; n < 100; n++)
      await runtime.json("gmail", "users/me/messages");
    await expect(runtime.json("gmail", "users/me/messages")).rejects.toThrow(
      "request limit",
    );
    expect(fetcher).toHaveBeenCalledTimes(100);
  });
  it("cancels oversized provider streams and rejects token-bearing JSON/artifacts", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
      },
      cancel,
    });
    const { runtime } = fixture([
      new Response(stream),
      Response.json({ leaked: "secret-access-token" }),
    ]);
    await expect(runtime.json("drive", "files")).rejects.toThrow("exceeds");
    expect(cancel).toHaveBeenCalledOnce();
    await expect(runtime.json("gmail", "users/me")).rejects.toThrow(
      "Invalid provider result",
    );
    expect(() => runtime.output("result.txt", "secret-maps-key")).toThrow();
    expect(() => runtime.result({ token: "secret-access-token" })).toThrow();
  });
  it("stops an uncooperative fetch on cancellation", async () => {
    const controller = new AbortController();
    const runtime = new NativeRuntime(input, {
      accessToken: "secret",
      account: "a@b.com",
      signal: controller.signal,
      fetch: () => new Promise(() => {}),
    });
    const pending = runtime.json("gmail", "users/me");
    controller.abort();
    await expect(pending).rejects.toThrow("deadline");
  });
  it("revokes temporary image permissions after command cancellation with a separate narrow budget", async () => {
    const controller = new AbortController();
    const { runtime, fetcher } = fixture(
      [
        new Response(null, { status: 204 }),
        new Response(null, { status: 404 }),
      ],
      input,
      controller.signal,
    );
    controller.abort();
    await runtime.cleanupGoogleFile("file-id", "anyoneWithLink");
    await runtime.cleanupGoogleFile("temporary-image");
    expect(fetcher.mock.calls[0][0].url).toBe(
      "https://www.googleapis.com/drive/v3/files/file-id/permissions/anyoneWithLink?supportsAllDrives=true",
    );
    expect(fetcher.mock.calls[0][0].method).toBe("DELETE");
    expect(fetcher.mock.calls[0][0].signal.aborted).toBe(false);
    expect(fetcher.mock.calls[1][0].url).toContain("/files/temporary-image?");
    await expect(runtime.cleanupGoogleFile("../other")).rejects.toThrow(
      "Invalid",
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("follows bounded Google media redirects without forwarding credentials", async () => {
    const { runtime, fetcher } = fixture([
      new Response(null, {
        status: 302,
        headers: { Location: "https://lh3.googleusercontent.com/media" },
      }),
      new Response("image", { headers: { "Content-Type": "image/png" } }),
    ]);
    const file = await runtime.bytes("drive", "files/f/export", {
      query: { mimeType: "image/png" },
    });
    expect(new TextDecoder().decode(file.bytes)).toBe("image");
    expect(fetcher.mock.calls[1][0].headers.has("Authorization")).toBe(false);
    for (const url of [
      "https://googleusercontent.com.attacker.example/file",
      "http://lh3.googleusercontent.com/file",
      "https://user:password@lh3.googleusercontent.com/file",
      "https://localhost/file",
    ])
      await expect(runtime.externalBytes(url)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("keeps file capabilities in memory, validates declarations and enforces aggregate limits", () => {
    const command = parseCommand({
      command: "drive.upload",
      positionals: ["input:folder/file.txt"],
      files: [{ name: "folder/file.txt", content_base64: btoa("hello") }],
    });
    const { runtime } = fixture([], command);
    expect(runtime.text("input:folder/file.txt")).toBe("hello");
    expect(runtime.inputs("input:folder")[0].name).toBe("file.txt");
    expect(() => runtime.input("/etc/passwd")).toThrow();
    expect(() => runtime.output("../secret", "x")).toThrow();
    runtime.output("folder/result.txt", "hello");
    expect(runtime.result({ ok: true })).toEqual({
      output: { ok: true },
      files: [{ name: "folder/result.txt", content_base64: btoa("hello") }],
    });
    expect(() =>
      runtime.output("large", new Uint8Array(4 * 1024 * 1024)),
    ).toThrow("limit");
    expect(() =>
      parseCommand({ command: "drive.upload", positionals: ["input:missing"] }),
    ).toThrow("supplied");
  });
  it("rejects unsupported flags and invalid types before network operations", () => {
    expect(() =>
      parseCommand({ command: "gmail.send", flags: { track: true } }),
    ).toThrow("Unknown flag");
    expect(() =>
      parseCommand({
        command: "gmail.labels.list",
        flags: { impersonate: "other@example.com" },
      }),
    ).toThrow();
    expect(() =>
      parseCommand({ command: "drive.ls", flags: { max: "10" } }),
    ).toThrow();
    expect(() =>
      parseCommand({ command: "gmail.labels.list", flags: { unknown: true } }),
    ).toThrow();
    expect(() => parseCommand({ command: "auth.login" })).toThrow(
      "Unknown command",
    );
    expect(parseCommand({ command: "drive.ls" }).flags.max).toBe(20);
  });
  it("preserves the contacts export stdout default without requesting a host file", () => {
    expect(
      parseCommand({ command: "contacts.export", flags: { all: true } }).flags
        .out,
    ).toBe("-");
    expect(
      parseCommand({
        command: "contacts.export",
        flags: { all: true, out: "-" },
      }).flags.out,
    ).toBe("-");
    expect(() =>
      parseCommand({
        command: "contacts.export",
        flags: { all: true, out: "/tmp/private" },
      }),
    ).toThrow();
  });
  it("runs parsed contact exports as structured vCard output or declared artifacts", async () => {
    for (const out of [undefined, "-", "output:contacts.vcf"]) {
      const command = parseCommand({
        command: "contacts.export",
        flags: { all: true, ...(out ? { out } : {}) },
        ...(out?.startsWith("output:")
          ? { output_files: ["contacts.vcf"] }
          : {}),
      });
      const { runtime } = fixture(
        [
          Response.json({
            connections: [
              {
                resourceName: "people/c1",
                names: [{ displayName: "Person" }],
                emailAddresses: [{ value: "person@example.com" }],
              },
            ],
          }),
        ],
        command,
      );
      const result = runtime.result(
        await communicationHandlers[command.command](command, runtime),
      ) as any;
      if (out?.startsWith("output:"))
        expect(atob(result.files[0].content_base64)).toContain("BEGIN:VCARD");
      else {
        expect(result.output.content).toContain("person@example.com");
        expect(result.files).toEqual([]);
      }
    }
  });
  it("rejects a parsed member-removal command before any authenticated request can change target", async () => {
    const command = parseCommand({
      command: "admin.groups.members.remove",
      positionals: ["group-id", ".."],
    });
    const { runtime, fetcher } = fixture([], command);
    await expect(
      administrationHandlers[command.command](command, runtime),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("paginates the complete static catalog with no credentials or truncation", () => {
    const found: string[] = [];
    let cursor: string | undefined;
    do {
      const page = describeCatalog({ cursor, limit: 20 }) as {
        commands: { command: string }[];
        next_cursor?: string;
      };
      expect(
        new TextEncoder().encode(JSON.stringify(page)).length,
      ).toBeLessThan(256 * 1024);
      found.push(...page.commands.map((entry) => entry.command));
      cursor = page.next_cursor;
    } while (cursor);
    expect(found).toEqual(commands.map((entry) => entry.command));
    expect(found).toHaveLength(542);
  });
});

describe("native Google Discovery execution", () => {
  const description = {
    name: "gmail",
    version: "v1",
    rootUrl: "https://gmail.googleapis.com/",
    servicePath: "gmail/v1/",
    resources: {
      users: {
        resources: {
          messages: {
            methods: {
              send: {
                id: "gmail.users.messages.send",
                path: "users/{userId}/messages/send",
                httpMethod: "POST",
                parameters: { userId: { location: "path", required: true } },
                scopes: ["gmail-scope"],
              },
            },
          },
        },
      },
    },
  };
  it("loads public metadata without credentials, then calls the selected method with its token", async () => {
    const { runtime, fetcher } = fixture([
      Response.json(description),
      Response.json({ id: "sent" }),
    ]);
    const command = parseCommand({
      command: "api.call",
      positionals: ["gmail", "v1", "users.messages.send"],
      flags: {
        params: '{"userId":"me"}',
        body: '{"raw":"AA"}',
        "allow-write": true,
      },
    });
    expect(await runtime.discovery(command)).toEqual({ id: "sent" });
    expect(fetcher.mock.calls[0][0].headers.has("Authorization")).toBe(false);
    const request = fetcher.mock.calls[1][0];
    expect(request.url).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    );
    expect(request.headers.get("Authorization")).toBe(
      "Bearer secret-access-token",
    );
    expect(await request.json()).toEqual({ raw: "AA" });
  });
  it("requires the write switch before dispatch and refuses unapproved Discovery destinations", async () => {
    const { runtime, fetcher } = fixture([Response.json(description)]);
    await expect(
      runtime.discovery(
        parseCommand({
          command: "api.call",
          positionals: ["gmail", "v1", "gmail.users.messages.send"],
          flags: { params: '{"userId":"me"}' },
        }),
      ),
    ).rejects.toThrow("allow-write");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const method = {
      id: "bad",
      resource: "",
      name: "bad",
      spec: { path: "x", httpMethod: "GET" },
    };
    expect(() =>
      discoveryRequest({ rootUrl: "https://attacker.example" }, method, {}),
    ).toThrow("Unapproved");
    expect(() =>
      discoveryRequest(description, method, { access_token: "injected" }),
    ).toThrow();
  });
  it("rejects dot segments in ordinary and reserved Discovery expansions", () => {
    for (const path of ["groups/{id}", "groups/{+id}"])
      for (const id of ["..", "members/../..", "%2e%2e"]) {
        const method = {
          id: "bad",
          resource: "",
          name: "bad",
          spec: {
            path,
            httpMethod: "DELETE",
            parameters: { id: { location: "path", required: true } },
          },
        };
        expect(() => discoveryRequest(description, method, { id })).toThrow();
      }
  });
});
