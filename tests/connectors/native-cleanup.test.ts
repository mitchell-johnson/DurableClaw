import { describe, expect, it, vi } from "vitest";
import { executeNative } from "../../services/connectors/vendor/gogcli";
import { imageLifecycle } from "../../services/connectors/vendor/gogcli/documents-assets";
import {
  cleanupWarnings,
  NativeCleanupError,
} from "../../services/connectors/vendor/gogcli/diagnostics";
import type {
  Command,
  Runtime,
} from "../../services/connectors/vendor/gogcli/types";

const empty: Command = {
  command: "test",
  positionals: [],
  flags: {},
  files: [],
  output_files: [],
};
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7ssAAAAASUVORK5CYII=";
describe("temporary image cleanup and safe failure diagnostics", () => {
  it.each([false, true])(
    "preserves cleanup details through executeNative (ambiguous permission: %s)",
    async (ambiguous) => {
      const fetcher = vi.fn(async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === "/v1/documents/doc")
          return Response.json({
            documentId: "doc",
            revisionId: "r1",
            body: {
              content: [
                {
                  startIndex: 1,
                  endIndex: 2,
                  paragraph: {
                    elements: [
                      {
                        startIndex: 1,
                        endIndex: 2,
                        textRun: { content: "\n" },
                      },
                    ],
                  },
                },
              ],
            },
          });
        if (path === "/upload/drive/v3/files")
          return Response.json({ id: "uploaded-image" });
        if (path.endsWith("/permissions") && request.method === "POST") {
          if (ambiguous)
            throw new Error("uncertain transport and private provider data");
          return Response.json({ id: "anyoneWithLink" });
        }
        return new Response("provider-private-error", { status: 503 });
      });
      const request = new Request("http://connector/execute", {
        method: "POST",
        body: JSON.stringify({
          operation: "gog_execute",
          confirmed: true,
          access_token: "access-secret-value",
          account_email: "owner@example.com",
          arguments: {
            command: "docs.insert-image",
            positionals: ["doc"],
            flags: { file: "input:image.png" },
            files: [{ name: "image.png", content_base64: png }],
          },
        }),
      });
      const response = await executeNative(request, fetcher);
      const body = await response.json();
      expect(response.status).toBe(502);
      expect(body).toMatchObject({
        cleanup_required: [
          {
            file_id: "uploaded-image",
            public_read_permission_may_remain: true,
          },
        ],
      });
      expect(JSON.stringify(body)).not.toMatch(
        /access-secret|provider-private|private provider/,
      );
      const deletions = fetcher.mock.calls
        .map(([r]) => r)
        .filter((r) => r.method === "DELETE");
      expect(
        deletions.some(
          (r) => new URL(r.url).pathname === "/drive/v3/files/uploaded-image",
        ),
      ).toBe(true);
      if (!ambiguous)
        expect(
          deletions.some((r) => r.url.includes("/permissions/anyoneWithLink")),
        ).toBe(true);
    },
  );
  it("attempts orphan deletion even when permission revocation fails", async () => {
    const cleanup = vi.fn(async (_file: string, permission?: string) => {
      if (permission) throw new Error("revoke denied");
    });
    const runtime = {
      upload: async () => ({ id: "image" }),
      json: async () => ({ id: "permission" }),
      cleanupGoogleFile: cleanup,
    } as unknown as Runtime;
    const handler = imageLifecycle(async (_c, r) => {
      await r.upload("drive-upload", "files", new Uint8Array());
      await r.json("drive", "files/image/permissions", {
        method: "POST",
        body: { type: "anyone", role: "reader" },
      });
      throw new Error("mutation failed");
    }, "docs");
    await expect(handler(empty, runtime)).rejects.toThrow("mutation failed");
    expect(cleanup.mock.calls).toEqual([
      ["image", "permission"],
      ["image", undefined],
    ]);
  });
  it("rejects the ninth upload before sending it and cleans the first eight", async () => {
    let count = 0;
    const upload = vi.fn(async () => ({ id: `image-${++count}` }));
    const cleanup = vi.fn(async () => {});
    const runtime = {
      upload,
      cleanupGoogleFile: cleanup,
    } as unknown as Runtime;
    const handler = imageLifecycle(async (_c, r) => {
      for (let n = 0; n < 9; n++)
        await r.upload("drive-upload", "files", new Uint8Array());
    }, "slides");
    await expect(handler(empty, runtime)).rejects.toThrow("eight images");
    expect(upload).toHaveBeenCalledTimes(8);
    expect(cleanup).toHaveBeenCalledTimes(8);
  });
  it("only accepts bounded file IDs and booleans as failure metadata", () => {
    const valid = [
      { file_id: "file-id", public_read_permission_may_remain: true },
    ];
    expect(new NativeCleanupError(valid).cleanupRequired).toEqual(valid);
    for (const value of [
      [],
      [
        ...valid,
        { file_id: "../other", public_read_permission_may_remain: true },
      ],
      [{ ...valid[0], raw_error: "secret" }],
      Array(9).fill(valid[0]),
    ])
      expect(cleanupWarnings(value)).toBeUndefined();
  });
});
