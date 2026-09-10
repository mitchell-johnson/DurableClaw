import { describe, expect, it, vi } from "vitest";
import catalog from "../../services/connectors/vendor/gogcli/catalog.json";
import { driveHandlers } from "../../services/connectors/vendor/gogcli/drive";
import {
  FOLDER,
  G,
} from "../../services/connectors/vendor/gogcli/drive-helpers";
import type {
  Command,
  Data,
  Runtime,
} from "../../services/connectors/vendor/gogcli/types";

function fixture(responses: Data[] = []) {
  const json = vi.fn(
    async (_api: string, _path: string, _options?: unknown): Promise<any> =>
      responses.shift() ?? {},
  );
  const upload = vi.fn(
    async (
      _api: string,
      _path: string,
      _bytes: Uint8Array,
      _options?: unknown,
    ) => ({ id: "uploaded", name: "file" }),
  );
  const output = vi.fn((name: string, value: Uint8Array | string) => ({
    name,
    bytes: new TextEncoder().encode(
      typeof value === "string" ? value : new TextDecoder().decode(value),
    ).length,
  }));
  const bytes = vi.fn(async () => ({
    bytes: new TextEncoder().encode("download"),
    contentType: "application/octet-stream",
  }));
  const externalBytes = vi.fn(async () => ({
    bytes: new TextEncoder().encode("media"),
    contentType: "image/jpeg",
  }));
  const runtime: Runtime = {
    account: "owner@example.com",
    signal: new AbortController().signal,
    json,
    upload,
    output,
    bytes,
    externalBytes,
    input: () => new TextEncoder().encode("file contents"),
    inputs: () => [
      { name: "report.txt", bytes: new TextEncoder().encode("file contents") },
    ],
    text: () => "file text",
    jsonInput: (value) =>
      typeof value === "string" ? JSON.parse(value) : value,
    outputName: (command, fallback = "artifacts/result") =>
      command.flags.out?.replace(/^output:/, "") ??
      command.output_files[0] ??
      fallback,
  };
  const run = async (
    command: string,
    positionals: string[] = [],
    flags: Data = {},
    files: Command["files"] = [],
  ) =>
    driveHandlers[command](
      { command, positionals, flags, files, output_files: [] },
      runtime,
    );
  return { json, upload, output, bytes, externalBytes, runtime, run };
}

describe("native Drive and document-service command ports", () => {
  it("implements exactly every pinned command assigned to these services", () => {
    const services = [
      "drive",
      "driveactivity",
      "drivelabels",
      "sites",
      "photos",
      "photospicker",
      "forms",
      "meet",
      "appscript",
    ];
    const expected = catalog.commands
      .filter((command) => services.includes(command.service))
      .map((command) => command.command)
      .sort();
    expect(Object.keys(driveHandlers).sort()).toEqual(expected);
    expect(expected).toHaveLength(90);
  });

  it("builds Drive search scope and quote escaping, and rejects conflicting switches", async () => {
    const f = fixture([{ files: [] }]);
    await f.run("drive.search", ["O'Reilly report"], {
      parent: "folder",
      drive: "shared",
      max: 7,
    });
    expect(f.json).toHaveBeenCalledWith(
      "drive",
      "files",
      expect.objectContaining({
        query: expect.objectContaining({
          q: "'folder' in parents and fullText contains 'O\\'Reilly report' and trashed = false",
          driveId: "shared",
          corpora: "drive",
          pageSize: 7,
        }),
      }),
    );
    await expect(
      f.run("drive.ls", [], { all: true, parent: "folder" }),
    ).rejects.toThrow();
    await expect(
      f.run("drive.search", ["x"], { drive: "shared", "all-drives": false }),
    ).rejects.toThrow();
    await expect(
      f.run("drive.search", ["x"], { parent: "folder", "raw-query": true }),
    ).rejects.toThrow();
  });

  it("removes existing parents when moving and distinguishes trash from permanent deletion", async () => {
    const f = fixture([
      { parents: ["old-one", "old-two"] },
      { id: "file", parents: ["new"] },
      {},
      {},
    ]);
    await f.run("drive.move", ["file"], { parent: "new" });
    expect(f.json).toHaveBeenNthCalledWith(
      2,
      "drive",
      "files/file",
      expect.objectContaining({
        method: "PATCH",
        query: expect.objectContaining({
          addParents: "new",
          removeParents: "old-one,old-two",
        }),
      }),
    );
    await f.run("drive.delete", ["file"]);
    expect(f.json).toHaveBeenLastCalledWith(
      "drive",
      "files/file",
      expect.objectContaining({ method: "PATCH", body: { trashed: true } }),
    );
    await f.run("drive.delete", ["file"], { permanent: true });
    expect(f.json).toHaveBeenLastCalledWith(
      "drive",
      "files/file",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("builds sharing permissions with explicit invitation and discovery controls", async () => {
    const f = fixture([
      { id: "permission" },
      { webViewLink: "https://drive.google.com/file/d/file/view" },
    ]);
    await f.run("drive.share", ["file"], {
      to: "domain",
      domain: "example.com",
      role: "commenter",
      discoverable: false,
      notify: true,
    });
    expect(f.json).toHaveBeenNthCalledWith(
      1,
      "drive",
      "files/file/permissions",
      expect.objectContaining({
        method: "POST",
        query: expect.objectContaining({ sendNotificationEmail: true }),
        body: {
          type: "domain",
          domain: "example.com",
          role: "commenter",
          allowFileDiscovery: false,
        },
      }),
    );
    await expect(
      f.run("drive.share", ["file"], { to: "anyone", email: "x@example.com" }),
    ).rejects.toThrow();
    await expect(
      f.run("drive.share", ["file"], {
        to: "user",
        email: "x@example.com",
        discoverable: true,
      }),
    ).rejects.toThrow();
  });

  it("uploads converted Markdown after stripping frontmatter and uses a multipart API body", async () => {
    const f = fixture();
    f.runtime.input = () =>
      new TextEncoder().encode("---\ntitle: Agenda\n---\n# Hello");
    await f.run("drive.upload", ["input:agenda.md"], {
      convert: true,
      parent: "folder",
    });
    expect(f.upload).toHaveBeenCalledOnce();
    const [api, path, bytes, options] = f.upload.mock.calls[0] as any;
    expect([api, path]).toEqual(["drive-upload", "files"]);
    const body = new TextDecoder().decode(bytes);
    expect(body).toContain('"mimeType":"application/vnd.google-apps.document"');
    expect(body).toContain('"parents":["folder"]');
    expect(body).toContain("# Hello");
    expect(body).not.toContain("title: Agenda");
    expect(options.headers["content-type"]).toContain(
      "multipart/related; boundary=",
    );
  });

  it("performs one ETag-conditional Drive v2 replacement and refuses stale versions", async () => {
    const f = fixture([
      { id: "file", mimeType: "text/plain", version: "7", etag: '"etag-7"' },
    ]);
    await f.run("drive.upload", ["input:report.txt"], {
      replace: "file",
      "if-version": 7,
      "keep-revision-forever": true,
      name: "Report",
    });
    expect(f.json).toHaveBeenCalledWith(
      "drive-v2",
      "files/file",
      expect.any(Object),
    );
    expect(f.upload).toHaveBeenCalledWith(
      "drive-v2-upload",
      "files/file",
      expect.any(Uint8Array),
      expect.objectContaining({
        method: "PUT",
        query: expect.objectContaining({ pinned: true }),
        headers: expect.objectContaining({ "If-Match": '"etag-7"' }),
      }),
    );
    const stale = fixture([
      { id: "file", mimeType: "text/plain", version: "8", etag: "changed" },
    ]);
    await expect(
      stale.run("drive.upload", ["input:report.txt"], {
        replace: "file",
        "if-version": 7,
      }),
    ).rejects.toThrow("version conflict");
    expect(stale.upload).not.toHaveBeenCalled();
  });

  it("downloads Workspace exports and validates document-specific formats", async () => {
    const f = fixture([
      { id: "sheet", name: "Budget", mimeType: G + "spreadsheet" },
    ]);
    await f.run("drive.download", ["sheet"], {
      format: "xlsx",
      out: "output:budget.xlsx",
    });
    expect(f.bytes).toHaveBeenCalledWith("drive", "files/sheet/export", {
      query: {
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
    expect(f.output).toHaveBeenCalledWith(
      "budget.xlsx",
      expect.any(Uint8Array),
    );
    const wrong = fixture([
      { id: "sheet", name: "Budget", mimeType: G + "spreadsheet" },
    ]);
    await expect(
      wrong.run("drive.download", ["sheet"], { format: "docx" }),
    ).rejects.toThrow();
    expect(wrong.bytes).not.toHaveBeenCalled();
  });

  it("preplans directory synchronization and skips matching MD5 content", async () => {
    const f = fixture([
      { id: "folder", mimeType: FOLDER },
      {
        files: [
          {
            id: "same",
            name: "same.txt",
            size: "1",
            md5Checksum: "0cc175b9c0f1b6a831c399e269772661",
            mimeType: "text/plain",
          },
        ],
      },
      { id: "nested" },
    ]);
    f.runtime.inputs = () => [
      { name: "same.txt", bytes: new TextEncoder().encode("a") },
      { name: "nested/report.txt", bytes: new TextEncoder().encode("new") },
    ];
    const result = (await f.run("drive.sync.push", ["input:project"], {
      parent: "folder",
    })) as any;
    expect(result.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "skip_file", file_id: "same" }),
        expect.objectContaining({ action: "create_folder", file_id: "nested" }),
        expect.objectContaining({ action: "create_file", file_id: "uploaded" }),
      ]),
    );
    expect(f.upload).toHaveBeenCalledOnce();
    const multipart = new TextDecoder().decode(f.upload.mock.calls[0][2]);
    expect(multipart).toContain('"parents":["nested"]');
    expect(JSON.stringify(result)).not.toContain('"bytes":{');
  });

  it("rejects ambiguous remote siblings before any sync mutation", async () => {
    const f = fixture([
      { id: "folder", mimeType: FOLDER },
      {
        files: [
          { id: "one", name: "report.txt" },
          { id: "two", name: "report.txt" },
        ],
      },
    ]);
    await expect(
      f.run("drive.sync.push", ["input:project"], { parent: "folder" }),
    ).rejects.toThrow("Ambiguous");
    expect(f.upload).not.toHaveBeenCalled();
    expect(
      f.json.mock.calls.every((call) => (call[2] as any)?.method !== "POST"),
    ).toBe(true);
  });

  it("plans bulk public-permission removal and leaves inherited grants alone", async () => {
    const f = fixture([
      { id: "file" },
      {
        permissions: [
          { id: "public", type: "anyone", role: "reader" },
          {
            id: "inherited",
            type: "anyone",
            role: "reader",
            permissionDetails: [{ inherited: true }],
          },
          { id: "private", type: "user", role: "writer" },
        ],
      },
      {},
    ]);
    const result = (await f.run("drive.bulk.remove-public", [], {
      file: "file",
    })) as any;
    expect(result.actions).toHaveLength(2);
    expect(result.actions[1]).toMatchObject({ inherited: true, skipped: true });
    expect(
      f.json.mock.calls.filter((call) => (call[2] as any)?.method === "DELETE"),
    ).toEqual([
      [
        "drive",
        "files/file/permissions/public",
        { method: "DELETE", query: { supportsAllDrives: true } },
      ],
    ]);
  });

  it("paginates comments without including quoted content unless requested", async () => {
    const f = fixture([
      { comments: [{ id: "one" }], nextPageToken: "page2" },
      { comments: [{ id: "two" }] },
    ]);
    const result = (await f.run("drive.comments.list", ["file"], {
      all: true,
      since: "2026-01-01T00:00:00Z",
      max: 10,
    })) as any;
    expect(result.comments).toHaveLength(2);
    expect((f.json.mock.calls[0][2] as any).query.fields).not.toContain(
      "quotedFileContent",
    );
    expect((f.json.mock.calls[1][2] as any).query.pageToken).toBe("page2");
    await f.run("drive.comments.resolve", ["file", "comment"], {
      message: "Done",
    });
    expect(f.json).toHaveBeenLastCalledWith(
      "drive",
      "files/file/comments/comment/replies",
      expect.objectContaining({
        method: "POST",
        body: { content: "Done", action: "resolve" },
      }),
    );
  });

  it("constructs typed label field modifications including integer strings and unset", async () => {
    const f = fixture();
    await f.run("drive.labels.file.apply", ["file", "labels/label"], {
      text: ["title=hello"],
      integer: ["count=123"],
      date: ["day=2026-09-09"],
      unset: ["old"],
      "fields-json": '{"number":7,"enabled":false,"empty":null}',
    });
    const body = (f.json.mock.calls[0][2] as any).body;
    expect(body.labelModifications[0]).toMatchObject({
      labelId: "label",
      fieldModifications: expect.arrayContaining([
        { fieldId: "count", setIntegerValues: ["123"] },
        { fieldId: "enabled", setTextValues: ["false"] },
        { fieldId: "old", unsetValues: true },
      ]),
    });
  });

  it("collects all Drive changes and returns a resumable state artifact for bounded polling", async () => {
    const f = fixture([
      { changes: [{ fileId: "wanted" }], nextPageToken: "p2" },
      { changes: [{ fileId: "other" }], newStartPageToken: "p3" },
    ]);
    f.runtime.jsonInput = () => ({
      version: 1,
      kind: "drive_changes_poll",
      page_token: "p1",
      drive_id: "shared",
    });
    const result = (await f.run("drive.changes.poll", [], {
      "state-file": "input:state.json",
      "filter-file": "wanted",
      interval: "60s",
      "max-iterations": 0,
    })) as any;
    expect(result.changes).toEqual([{ fileId: "wanted" }]);
    expect(result.continuation.poll_after_ms).toBe(60000);
    expect(JSON.parse(f.output.mock.calls[0][1] as string)).toMatchObject({
      page_token: "p3",
      drive_id: "shared",
    });
    expect(f.json).toHaveBeenCalledTimes(2);
  });

  it("builds Drive Activity action filters and consolidation body", async () => {
    const f = fixture([{ activities: [{ id: "event" }] }]);
    await f.run("drive.activity.query", [], {
      folder: "folder",
      actions: "share,edit",
      from: "2026-09-01T00:00:00Z",
      consolidate: true,
    });
    expect(f.json).toHaveBeenCalledWith("driveactivity", "activity:query", {
      method: "POST",
      body: expect.objectContaining({
        ancestorName: "items/folder",
        consolidationStrategy: { legacy: {} },
        filter:
          'time >= "2026-09-01T00:00:00Z" AND detail.action_detail_case:(PERMISSION_CHANGE EDIT)',
      }),
    });
  });

  it.each([
    "text",
    "paragraph",
    "radio",
    "checkbox",
    "dropdown",
    "scale",
    "date",
    "time",
  ])("creates a %s Form question with index zero retained", async (type) => {
    const f = fixture([{ form: { formId: "form" } }]);
    await f.run("forms.questions.add", ["form"], {
      title: "Question",
      type,
      index: 0,
      option: ["A", "B"],
      "include-time": true,
      "include-year": true,
      duration: true,
      "scale-low": 0,
      "scale-high": 10,
    });
    const body = (f.json.mock.calls[0][2] as any).body;
    expect(body.requests[0].createItem.location).toEqual({ index: 0 });
    expect(
      body.requests[0].createItem.item.questionItem.question,
    ).toMatchObject({ required: false });
    expect(
      Object.keys(body.requests[0].createItem.item.questionItem.question),
    ).toHaveLength(2);
  });

  it("appends graded form questions using the current item count", async () => {
    const f = fixture([{ items: [{}, {}] }, { form: { formId: "form" } }]);
    await f.run("forms.add-question", ["form"], {
      title: "Quiz",
      type: "radio",
      option: ["A", "B"],
      correct: ["B"],
      points: 2,
    });
    const body = (f.json.mock.calls[1][2] as any).body;
    expect(body.requests[0].createItem.location.index).toBe(2);
    expect(
      body.requests[0].createItem.item.questionItem.question.grading,
    ).toEqual({ pointValue: 2, correctAnswers: { answers: [{ value: "B" }] } });
    await expect(
      f.run("forms.add-question", ["form"], {
        title: "Quiz",
        correct: ["answer"],
      }),
    ).rejects.toThrow();
  });

  it("sends explicit false quiz and publication settings", async () => {
    const f = fixture([{ form: {} }, {}, { formId: "form" }]);
    await f.run("forms.update", ["form"], { quiz: "false" });
    expect((f.json.mock.calls[0][2] as any).body.requests[0]).toEqual({
      updateSettings: {
        settings: { quizSettings: { isQuiz: false } },
        updateMask: "quizSettings.isQuiz",
      },
    });
    await f.run("forms.publish", ["form"], { unpublish: true });
    expect(
      (f.json.mock.calls[1][2] as any).body.publishSettings.publishState,
    ).toEqual({ isPublished: false, isAcceptingResponses: false });
  });

  it("creates a form and follows with a description update", async () => {
    const f = fixture([
      { formId: "created", info: { title: "Form" } },
      { form: { formId: "created", info: { description: "Description" } } },
    ]);
    const result = (await f.run("forms.create", [], {
      title: "Form",
      description: "Description",
    })) as any;
    expect(f.json).toHaveBeenNthCalledWith(
      2,
      "forms",
      "forms/created:batchUpdate",
      expect.objectContaining({
        method: "POST",
        body: expect.objectContaining({
          requests: [
            {
              updateFormInfo: {
                info: { description: "Description" },
                updateMask: "description",
              },
            },
          ],
        }),
      }),
    );
    expect(result.created).toBe(true);
  });

  it("resolves Meet conference records before listing participants", async () => {
    const f = fixture([
      { name: "spaces/space" },
      { conferenceRecords: [{ name: "conferenceRecords/recent" }] },
      { participants: [{ name: "participant" }] },
    ]);
    await f.run("meet.participants", ["abc-defg-hij"]);
    expect(f.json).toHaveBeenNthCalledWith(1, "meet", "spaces/abc-defg-hij");
    expect(f.json).toHaveBeenNthCalledWith(2, "meet", "conferenceRecords", {
      query: { filter: 'space.name = "spaces/space"', pageSize: 1 },
    });
    expect(f.json).toHaveBeenLastCalledWith(
      "meet",
      "conferenceRecords/recent/participants",
      expect.any(Object),
    );
  });

  it("runs Apps Script with parsed parameters and exports source filenames by type", async () => {
    const f = fixture([
      { done: true },
      {
        files: [
          { name: "Code", type: "SERVER_JS", source: "function main() {}" },
          { name: "appsscript", type: "JSON", source: "{}" },
        ],
      },
    ]);
    await f.run("appscript.run", ["script", "main"], {
      params: '["x",3]',
      "dev-mode": true,
    });
    expect(f.json).toHaveBeenNthCalledWith(
      1,
      "appscript",
      "scripts/script:run",
      {
        method: "POST",
        body: { function: "main", parameters: ["x", 3], devMode: true },
      },
    );
    await f.run("appscript.pull", ["script", "output:source"]);
    expect(f.output).toHaveBeenCalledWith(
      "source/Code.gs",
      "function main() {}",
    );
    expect(f.output).toHaveBeenCalledWith("source/appsscript.json", "{}");
  });

  it("builds Photos filters and follows picker pages before authorized media download", async () => {
    const f = fixture([
      {},
      { mediaItems: [], nextPageToken: "page2" },
      {
        mediaItems: [
          {
            id: "media",
            type: "VIDEO",
            mediaFile: {
              filename: "video.mp4",
              baseUrl: "https://lh3.googleusercontent.com/media",
              mediaFileMetadata: {
                videoMetadata: { processingStatus: "READY" },
              },
            },
          },
        ],
      },
    ]);
    await f.run("photos.search", [], {
      from: "2026-09-01",
      to: "2026-09-09",
      "media-type": "PHOTO",
      "include-archived": true,
    });
    expect((f.json.mock.calls[0][2] as any).body.filters).toEqual({
      includeArchivedMedia: true,
      mediaTypeFilter: { mediaTypes: ["PHOTO"] },
      dateFilter: {
        ranges: [
          {
            startDate: { year: 2026, month: 9, day: 1 },
            endDate: { year: 2026, month: 9, day: 9 },
          },
        ],
      },
    });
    await f.run("photos.picker.download", ["session", "media"]);
    expect(f.externalBytes).toHaveBeenCalledWith(
      "https://lh3.googleusercontent.com/media=dv",
      "photos-picker",
    );
    expect(f.output).toHaveBeenCalledWith(
      "artifacts/video.mp4",
      expect.any(Uint8Array),
    );
  });

  it("returns pending Photos picking with an explicit resumable polling interval", async () => {
    const f = fixture([
      {
        id: "session",
        mediaItemsSet: false,
        pollingConfig: { pollInterval: "5s", timeoutIn: "300s" },
      },
    ]);
    const result = (await f.run("photos.picker.wait", ["session"], {
      timeout: "30s",
    })) as any;
    expect(result).toMatchObject({
      ready: false,
      continuation: { poll_after_ms: 5000, timeout_ms: 30000 },
    });
    expect(f.json).toHaveBeenCalledOnce();
  });
});
