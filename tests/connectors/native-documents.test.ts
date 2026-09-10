import { describe, expect, it, vi } from "vitest";
import {
  parseSlidey,
  renderSlidey,
} from "../../services/connectors/vendor/gogcli/documents-slidey";
import { documentAPISchemas } from "../../services/connectors/vendor/gogcli/documents-api-schema";
import catalog from "../../services/connectors/vendor/gogcli/catalog.json";
import { documentHandlers } from "../../services/connectors/vendor/gogcli/documents";
import { gridRange } from "../../services/connectors/vendor/gogcli/documents-sheets";
import {
  markdownPlan,
  matches,
  type Target,
} from "../../services/connectors/vendor/gogcli/documents-docs-core";
import {
  parseSed,
  braceReplacement,
} from "../../services/connectors/vendor/gogcli/documents-sed";
import type {
  Command,
  Runtime,
  Data,
  RequestOptions,
} from "../../services/connectors/vendor/gogcli/types";

function validateRequest(api: string, body: unknown): void {
  const catalog = (documentAPISchemas as Data)[api];
  if (!catalog) return;
  const check = (schema: Data, value: any, path: string): void => {
    if (schema.$ref) return check(catalog.schemas[schema.$ref], value, path);
    if (value === undefined) return;
    if (schema.type === "object") {
      expect(value, path).not.toBeNull();
      expect(Array.isArray(value), path).toBe(false);
      expect(typeof value, path).toBe("object");
      for (const [key, child] of Object.entries(value)) {
        const field = schema.properties?.[key] ?? schema.additionalProperties;
        expect(field, `${path}.${key} is a documented API field`).toBeTruthy();
        if (typeof field === "object") check(field, child, `${path}.${key}`);
      }
    } else if (schema.type === "array") {
      expect(Array.isArray(value), path).toBe(true);
      value.forEach((item: unknown, index: number) =>
        check(schema.items, item, `${path}[${index}]`),
      );
    } else if (schema.type === "integer") {
      expect(Number.isInteger(value), path).toBe(true);
    } else if (schema.type === "string" && schema.format === "int64") {
      expect(["string", "number"].includes(typeof value), path).toBe(true);
    } else if (schema.type) expect(typeof value, path).toBe(schema.type);
    if (schema.enum) expect(schema.enum, path).toContain(value);
  };
  check(catalog.schemas[catalog.root], body, api);
}
const sheet = {
  spreadsheetId: "sheet",
  sheets: [
    {
      properties: {
        sheetId: 7,
        title: "Annual Report",
        gridProperties: { rowCount: 100, columnCount: 26 },
      },
      tables: [
        {
          tableId: "table1",
          name: "Orders",
          range: {
            sheetId: 7,
            startRowIndex: 0,
            endRowIndex: 4,
            startColumnIndex: 0,
            endColumnIndex: 2,
          },
          columnProperties: [{ columnIndex: 0 }, { columnIndex: 1 }],
        },
      ],
    },
  ],
  namedRanges: [
    {
      name: "Totals",
      namedRangeId: "named1",
      range: {
        sheetId: 7,
        startRowIndex: 2,
        endRowIndex: 4,
        startColumnIndex: 1,
        endColumnIndex: 2,
      },
    },
  ],
};
const doc = {
  documentId: "doc",
  title: "Document",
  revisionId: "revision-1",
  tabs: [
    {
      tabProperties: { tabId: "t1", title: "Notes" },
      documentTab: {
        body: {
          content: [
            { startIndex: 0, endIndex: 1, sectionBreak: {} },
            {
              startIndex: 1,
              endIndex: 10,
              paragraph: {
                elements: [
                  {
                    startIndex: 1,
                    endIndex: 10,
                    textRun: { content: "😀 hello\n" },
                  },
                ],
              },
            },
          ],
        },
      },
    },
  ],
};
function setup(metadata: Data = sheet) {
  const calls: { api: string; path: string; options: RequestOptions }[] = [],
    outputs: Data[] = [];
  const runtime: Runtime = {
    cleanupGoogleFile: async () => {},
    account: "owner@example.com",
    signal: new AbortController().signal,
    discovery: async () => ({}),
    async json(api, path, options = {}) {
      calls.push({ api, path, options });
      if (path.endsWith(":batchUpdate") && !path.includes("/values:"))
        validateRequest(api, options.body);
      if (options.method && options.method !== "GET")
        return {
          documentId: "doc",
          presentationId: "presentation",
          replies: [],
          updatedRange: "'Annual Report'!A1:B2",
          updates: { updatedRange: "'Annual Report'!A5:B5" },
        };
      return structuredClone(metadata);
    },
    async bytes(api, path, options = {}) {
      calls.push({ api, path, options });
      return {
        bytes: new Uint8Array([1, 2, 3]),
        contentType: "application/pdf",
      };
    },
    async externalBytes() {
      return { bytes: new Uint8Array([1, 2]), contentType: "image/png" };
    },
    async upload() {
      return { id: "uploaded" };
    },
    input() {
      return new Uint8Array();
    },
    inputs() {
      return [];
    },
    text(ref) {
      return ref === "input:note.txt" ? "File note" : "{}";
    },
    jsonInput(value) {
      return typeof value === "string" ? JSON.parse(value) : value;
    },
    output(name, bytes) {
      outputs.push({ name, bytes });
      return {
        name,
        bytes: typeof bytes === "string" ? bytes.length : bytes.byteLength,
      };
    },
    outputName(command, fallback = "artifacts/result") {
      return String(command.flags.out ?? fallback).replace(/^output:/, "");
    },
  };
  const run = (command: string, positionals: string[], flags: Data = {}) =>
    documentHandlers[command](
      {
        command,
        positionals,
        flags,
        files: [],
        output_files: [],
      } satisfies Command,
      runtime,
    );
  const writes = () =>
    calls.filter((c) => c.options.method && c.options.method !== "GET");
  return { calls, outputs, run, writes, runtime };
}
describe("native document command catalog", () => {
  it("covers each of the 183 catalog leaves with a callable native handler", () => {
    const expected = catalog.commands
      .filter((c) => ["docs", "sheets", "slides"].includes(c.service))
      .map((c) => c.command)
      .sort();
    expect(expected).toHaveLength(183);
    expect(Object.keys(documentHandlers).sort()).toEqual(expected);
  });
  it("parses quoted A1, whole-column and named ranges", () => {
    expect(gridRange("'Annual Report'!$B$2:$D$8", sheet)).toEqual({
      sheetId: 7,
      startRowIndex: 1,
      endRowIndex: 8,
      startColumnIndex: 1,
      endColumnIndex: 4,
    });
    expect(gridRange("'Annual Report'!B:D", sheet)).toEqual({
      sheetId: 7,
      startColumnIndex: 1,
      endColumnIndex: 4,
    });
    expect(gridRange("Totals", sheet)).toEqual(sheet.namedRanges[0].range);
    expect(() => gridRange("'Annual Report'!D8:B2", sheet)).toThrow();
  });
  it("preserves explicit false and zero cell formatting with an inferred mask", async () => {
    const s = setup();
    await s.run("sheets.format", ["sheet", "Totals"], {
      "format-json": '{"textFormat":{"bold":false},"padding":{"top":0}}',
    });
    expect(s.writes()[0].options.body).toEqual({
      requests: [
        {
          repeatCell: {
            range: sheet.namedRanges[0].range,
            cell: {
              userEnteredFormat: {
                textFormat: { bold: false },
                padding: { top: 0 },
              },
            },
            fields:
              "userEnteredFormat.textFormat.bold,userEnteredFormat.padding.top",
          },
        },
      ],
    });
  });
  it("uses one multi-range values batch request and preserves typed cells", async () => {
    const s = setup();
    await s.run("sheets.batch-update", ["sheet"], {
      "data-json": JSON.stringify([
        { range: "A1", values: [[false, 0, "=SUM(A2:A3)"]] },
      ]),
      input: "RAW",
      "include-values-in-response": true,
    });
    expect(s.writes()).toHaveLength(1);
    expect(s.writes()[0]).toMatchObject({
      api: "sheets",
      path: "spreadsheets/sheet/values:batchUpdate",
      options: {
        body: {
          valueInputOption: "RAW",
          includeValuesInResponse: true,
          data: [{ values: [[false, 0, "=SUM(A2:A3)"]] }],
        },
      },
    });
  });
  it("appends table data with INSERT_ROWS to preserve surrounding data", async () => {
    const s = setup();
    await s.run("sheets.table.append", ["sheet", "Orders"], {
      "values-json": '[["new",7]]',
    });
    expect(s.writes()).toHaveLength(1);
    expect(s.writes()[0]).toMatchObject({
      path: "spreadsheets/sheet/values/'Annual%20Report'!A1%3AB4:append",
      options: {
        method: "POST",
        query: {
          insertDataOption: "INSERT_ROWS",
          valueInputOption: "USER_ENTERED",
        },
      },
    });
  });
  it("refuses destructive table deletion without the discard-data flag before mutation", async () => {
    const s = setup();
    await expect(
      s.run("sheets.table.delete", ["sheet", "Orders"]),
    ).rejects.toThrow(/discard-data/);
    expect(s.writes()).toHaveLength(0);
    await s.run("sheets.table.delete", ["sheet", "Orders"], {
      "discard-data": true,
    });
    expect(s.writes()[0].options.body).toEqual({
      requests: [{ deleteTable: { tableId: "table1" } }],
    });
  });
  it("sends BigQuery source specs and preserves explicit billing project", async () => {
    const s = setup();
    await s.run("sheets.datasource.add", ["sheet"], {
      "billing-project": "billing-project",
      query: "SELECT 1 AS count",
    });
    expect(s.writes()[0].options.body).toEqual({
      requests: [
        {
          addDataSource: {
            dataSource: {
              spec: {
                bigQuery: {
                  projectId: "billing-project",
                  querySpec: { rawQuery: "SELECT 1 AS count" },
                },
              },
            },
          },
        },
      ],
    });
  });
  it("exports binary files through the runtime output capability", async () => {
    const s = setup();
    await s.run("sheets.export", ["sheet"], {
      format: "xlsx",
      out: "output:reports/sheet.xlsx",
    });
    expect(s.calls[0]).toMatchObject({
      api: "drive",
      path: "files/sheet/export",
      options: {
        query: {
          mimeType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      },
    });
    expect(s.outputs).toEqual([
      { name: "reports/sheet.xlsx", bytes: new Uint8Array([1, 2, 3]) },
    ]);
  });
  it("clears all validation while preserving false filteredRowsIncluded", async () => {
    const s = setup();
    await s.run("sheets.validation.clear", ["sheet", "Totals"], {
      "filtered-rows-included": false,
    });
    expect(s.writes()[0].options.body).toEqual({
      requests: [
        {
          setDataValidation: {
            range: sheet.namedRanges[0].range,
            filteredRowsIncluded: false,
          },
        },
      ],
    });
  });
  it("builds hyperlink runs with UTF-16 offsets from text+uri inputs", async () => {
    const s = setup();
    await s.run("sheets.links.set", ["sheet", "'Annual Report'!A1"], {
      "runs-json":
        '[{"text":"😀","uri":"https://example.com"},{"text":" plain"}]',
    });
    const body = s.writes()[0].options.body as Data;
    expect(body.requests[0].updateCells.rows[0].values[0]).toEqual({
      userEnteredValue: { stringValue: "😀 plain" },
      textFormatRuns: [
        { startIndex: 0, format: { link: { uri: "https://example.com" } } },
        { startIndex: 2, format: {} },
      ],
    });
  });
});
describe("Docs native indexing and semantics", () => {
  it("finds UTF-16 ranges without splitting surrogate pairs", async () => {
    const s = setup(doc),
      result = await s.run("docs.find-range", ["doc", "hello"], {
        tab: "Notes",
      });
    expect(result).toEqual({
      matches: [{ startIndex: 4, endIndex: 9, tabId: "t1" }],
    });
  });
  it("applies range styles and paragraph formatting with revision control", async () => {
    const s = setup(doc);
    await s.run("docs.format", ["doc"], {
      match: "hello",
      bold: true,
      "heading-level": 2,
      "space-above": 0,
      tab: "Notes",
    });
    const body = s.writes()[0].options.body as Data;
    expect(body.writeControl).toEqual({ requiredRevisionId: "revision-1" });
    expect(body.requests).toEqual([
      {
        updateTextStyle: {
          range: { startIndex: 4, endIndex: 9, tabId: "t1" },
          textStyle: { bold: true },
          fields: "bold",
        },
      },
      {
        updateParagraphStyle: {
          range: { startIndex: 4, endIndex: 9, tabId: "t1" },
          paragraphStyle: {
            namedStyleType: "HEADING_2",
            spaceAbove: { magnitude: 0, unit: "PT" },
          },
          fields: "namedStyleType,spaceAbove.magnitude,spaceAbove.unit",
        },
      },
    ]);
  });
  it("replaces anchor text and inserts a person chip atomically", async () => {
    const s = setup(doc);
    await s.run("docs.insert-person", ["doc"], {
      at: "hello",
      email: "person@example.com",
    });
    const body = s.writes()[0].options.body as Data;
    expect(body.requests).toEqual([
      {
        deleteContentRange: {
          range: { startIndex: 4, endIndex: 9, tabId: "t1" },
        },
      },
      {
        insertPerson: {
          location: { index: 4, tabId: "t1" },
          personProperties: { email: "person@example.com" },
        },
      },
    ]);
  });
  it("compiles Markdown headings, bold, links and tables as structured operations", () => {
    const p = markdownPlan(
      "# Heading\n\n**Bold** and [link](https://example.com)\n\n| A | B |\n|---|---|\n| 1 | 2 |",
    );
    expect(p.text).toContain("Heading\nBold and link");
    expect(p.styles.some((s) => s.flags["heading-level"] === 1)).toBe(true);
    expect(p.styles.some((s) => s.flags.bold)).toBe(true);
    expect(p.styles.some((s) => s.flags.link === "https://example.com")).toBe(
      true,
    );
    expect(p.specials).toContainEqual(
      expect.objectContaining({
        kind: "table",
        value: [
          ["A", "B"],
          ["1", "2"],
        ],
      }),
    );
  });
  it("supports sed alternative delimiters, escaped delimiter, captures and paragraph addresses", () => {
    expect(parseSed("3,7s#(hello)#{$1}#gi")).toMatchObject({
      address: "3,7",
      command: "s",
      pattern: "(hello)",
      replacement: "{$1}",
      global: true,
      ignoreCase: true,
    });
    expect(parseSed("s/a\\/b/c/2")).toMatchObject({ pattern: "a/b", nth: 2 });
    expect(parseSed("$d")).toMatchObject({ address: "$", command: "d" });
    expect(braceReplacement("{b c=red}Important")).toEqual({
      text: "Important",
      styles: { bold: true, "text-color": "red" },
      extra: {},
      structural: undefined,
    });
  });
  it("supports ordinary sed replacement with captured text and style", async () => {
    const s = setup(doc);
    await s.run("docs.sed", ["doc", "s/(hello)/{b}$1/"]);
    const body = s.writes()[0].options.body as Data;
    expect(body.requests).toContainEqual({
      insertText: { location: { index: 4, tabId: "t1" }, text: "hello" },
    });
    expect(body.requests).toContainEqual({
      updateTextStyle: {
        range: { startIndex: 4, endIndex: 9, tabId: "t1" },
        textStyle: { bold: true },
        fields: "bold",
      },
    });
  });
});
describe("Slides native multi-operation semantics", () => {
  const presentation = {
    presentationId: "presentation",
    revisionId: "revision-2",
    slides: [
      {
        objectId: "slide1",
        pageElements: [{ objectId: "table1", table: { rows: 3, columns: 3 } }],
        slideProperties: {
          notesPage: { notesProperties: { speakerNotesObjectId: "notes1" } },
        },
      },
    ],
  };
  it("combines cell fill and UTF-16 text style updates under one revision", async () => {
    const s = setup(presentation);
    await s.run("slides.table.cell.style", ["presentation", "table1"], {
      row: 1,
      col: 2,
      "fill-color": "#ff0000",
      "no-bold": true,
      range: "0:2",
    });
    const body = s.writes()[0].options.body as Data;
    expect(body.writeControl).toEqual({ requiredRevisionId: "revision-2" });
    expect(body.requests).toHaveLength(2);
    expect(body.requests[1]).toEqual({
      updateTextStyle: {
        objectId: "table1",
        cellLocation: { rowIndex: 1, columnIndex: 2 },
        textRange: { type: "FIXED_RANGE", startIndex: 0, endIndex: 2 },
        style: { bold: false },
        fields: "bold",
      },
    });
  });
  it("rejects table ranges outside the known table before writing", async () => {
    const s = setup(presentation);
    await expect(
      s.run("slides.table.merge", ["presentation", "table1"], {
        row: 2,
        col: 2,
        "row-span": 2,
      }),
    ).rejects.toThrow(/bounds/);
    expect(s.writes()).toHaveLength(0);
  });
  it("replaces speaker notes as one delete+insert batch", async () => {
    const s = setup(presentation);
    await s.run("slides.update-notes", ["presentation", "slide1"], {
      notes: "New notes",
    });
    expect((s.writes()[0].options.body as Data).requests).toEqual([
      { deleteText: { objectId: "notes1", textRange: { type: "ALL" } } },
      {
        insertText: {
          objectId: "notes1",
          text: "New notes",
          insertionIndex: 0,
        },
      },
    ]);
  });
  it("updates rotation using a valid affine transform", async () => {
    const s = setup();
    await s.run("slides.element.transform", ["presentation", "shape"], {
      rotate: 90,
      "translate-x": 10,
    });
    const transform = (s.writes()[0].options.body as Data).requests[0]
      .updatePageElementTransform.transform;
    expect(transform.shearX).toBeCloseTo(-1);
    expect(transform.shearY).toBeCloseTo(1);
    expect(transform.translateX).toBe(10);
  });
  it("requires an explicit replacement scope and preserves repeated page selectors", async () => {
    const s = setup();
    await expect(
      s.run("slides.replace-text", ["presentation", "old", "new"]),
    ).rejects.toThrow(/scope/);
    expect(s.writes()).toHaveLength(0);
    await s.run("slides.replace-text", ["presentation", "old", "new"], {
      page: ["slide1", "slide2"],
    });
    expect(
      (s.writes()[0].options.body as Data).requests[0].replaceAllText
        .pageObjectIds,
    ).toEqual(["slide1", "slide2"]);
  });
});

describe("portable Markdown and cleanup regressions", () => {
  it("retains rich HTML formatting and renders table-cell line breaks", () => {
    const plan = markdownPlan("<b>Bold</b> and <i>italic</i>");
    expect(plan.text).toBe("Bold and italic\n");
    expect(plan.styles).toContainEqual({
      start: 0,
      end: 4,
      flags: { bold: true },
    });
    expect(plan.styles.some((s) => s.flags.italic)).toBe(true);
  });
  it("gives nested list paragraphs separate bullet ranges", () => {
    const plan = markdownPlan("- Outer\n  - Inner\n- Last");
    const bullets = plan.styles.filter((s) => s.flags.bullets);
    expect(bullets.map((s) => plan.text.slice(s.start, s.end))).toEqual([
      "\tInner\n",
      "Outer\n",
      "Last\n",
    ]);
  });
  it("preserves UTF-16 offsets for Unicode case-insensitive literal search", () => {
    const target = {
      full: {},
      doc: {},
      content: [
        {
          startIndex: 1,
          endIndex: 7,
          paragraph: {
            elements: [{ startIndex: 1, textRun: { content: "İ abc\n" } }],
          },
        },
      ],
    } as Target;
    expect(matches(target, "abc")).toEqual([{ startIndex: 3, endIndex: 6 }]);
  });
  it("rejects explicitly negative freeze counts and keeps page layout mode when only changing margins", async () => {
    const s = setup();
    await expect(
      s.run("sheets.freeze", ["sheet"], { rows: -1, cols: 2 }),
    ).rejects.toThrow(/nonnegative/);
    expect(s.writes()).toHaveLength(0);
    const d = setup(doc);
    await d.run("docs.page-layout", ["doc"], { "margin-left": "1in" });
    expect(
      (d.writes()[0].options.body as Data).requests[0].updateDocumentStyle
        .documentStyle,
    ).toEqual({ marginLeft: { magnitude: 72, unit: "PT" } });
  });
  it("uses linear-time Go-compatible sed regexes and rejects backreferences in patterns", async () => {
    const s = setup(doc);
    await expect(
      s.run("docs.sed", ["doc", "s/(hello)\\1/no/"]),
    ).rejects.toThrow();
    expect(s.writes()).toHaveLength(0);
    const long = structuredClone(doc);
    long.tabs[0].documentTab.body.content[1].paragraph!.elements[0].textRun.content =
      "a".repeat(10000) + "!\n";
    const d = setup(long);
    await expect(
      d.run("docs.sed", ["doc", "s/(a+)+$/no/"]),
    ).resolves.toMatchObject({ operations: 0 });
  });
  it("parses frontmatter and notes without splitting fenced separators", () => {
    expect(
      parseSlidey(
        "---\nlayout: two-cols\n---\n# Deck\n```txt\n---\n```\n## Notes\nPrivate notes\n---\n# Next",
      ),
    ).toEqual([
      {
        frontmatter: { layout: "two-cols" },
        body: "# Deck\n```txt\n---\n```",
        notes: "Private notes",
      },
      { frontmatter: {}, body: "# Next", notes: "" },
    ]);
  });
  it("renders slidey columns, rich text, code and native tables as documented API operations", () => {
    const plan = renderSlidey(
      "---\nlayout: two-cols\n---\n# Title\n**Left** and `code`\n::right::\n| A | B |\n|---|---|\n| 1 | 2 |",
      {},
    );
    validateRequest("slides", { requests: plan.requests });
    expect(plan.requests.some((r) => r.createTable?.columns === 2)).toBe(true);
    expect(
      plan.requests.some(
        (r) => r.updateTextStyle?.style.fontFamily === "Roboto Mono",
      ),
    ).toBe(true);
    expect(
      plan.requests
        .filter((r) => r.createShape)
        .some((r) => r.createShape.elementProperties.transform.translateX > 36),
    ).toBe(false);
    expect(
      plan.requests.find((r) => r.createTable)?.createTable.elementProperties
        .transform.translateX,
    ).toBeGreaterThan(36);
  });
  it("returns explicit skipped-renderer warnings and rejects strict mode before remote creation", async () => {
    const content = "# Title\n:far-star:\n```mermaid\ngraph TD; A-->B\n```",
      plan = renderSlidey(content, {});
    expect(plan.warnings).toHaveLength(2);
    expect(JSON.stringify(plan.requests)).not.toContain("graph TD");
    const s = setup();
    await expect(
      s.run("slides.create-from-markdown", ["New"], { content, strict: true }),
    ).rejects.toThrow(/optional/);
    expect(s.calls).toHaveLength(0);
  });
  it("revokes Docs temporary sharing after a successful local image import", async () => {
    const s = setup(doc),
      cleanup = vi.fn(async () => {});
    s.runtime.cleanupGoogleFile = cleanup;
    const png = new Uint8Array(24),
      view = new DataView(png.buffer);
    view.setUint32(0, 0x89504e47);
    view.setUint32(16, 10);
    view.setUint32(20, 10);
    s.runtime.input = () => png;
    const original = s.runtime.json;
    s.runtime.json = async (api, path, opts) =>
      path.endsWith("/permissions")
        ? { id: "perm1" }
        : original(api, path, opts);
    const result = await s.run("docs.insert-image", ["doc"], {
      file: "input:photo.png",
    });
    expect(cleanup).toHaveBeenCalledWith("uploaded", "perm1");
    expect(result).toMatchObject({
      assets: [{ fileId: "uploaded", public: false, revoked: true }],
    });
  });
  it("revokes Docs sharing and deletes orphaned uploads when the image mutation fails", async () => {
    const s = setup(doc),
      cleanup = vi.fn(async () => {});
    s.runtime.cleanupGoogleFile = cleanup;
    const png = new Uint8Array(24),
      view = new DataView(png.buffer);
    view.setUint32(0, 0x89504e47);
    view.setUint32(16, 10);
    view.setUint32(20, 10);
    s.runtime.input = () => png;
    const original = s.runtime.json;
    s.runtime.json = async (api, path, opts) => {
      if (path.endsWith("/permissions")) return { id: "perm1" };
      if (api === "docs" && opts?.method === "POST")
        throw new Error("Google request failed (503)");
      return original(api, path, opts);
    };
    await expect(
      s.run("docs.insert-image", ["doc"], { file: "input:photo.png" }),
    ).rejects.toThrow(/503/);
    expect(cleanup.mock.calls).toEqual([
      ["uploaded", "perm1"],
      ["uploaded", undefined],
    ]);
  });
  it("deletes Slides temporary uploads when permission creation fails", async () => {
    const s = setup(),
      cleanup = vi.fn(async () => {});
    s.runtime.cleanupGoogleFile = cleanup;
    const png = new Uint8Array(24),
      view = new DataView(png.buffer);
    view.setUint32(0, 0x89504e47);
    view.setUint32(16, 10);
    view.setUint32(20, 10);
    s.runtime.input = () => png;
    s.runtime.json = async () => {
      throw new Error("Google request failed (403)");
    };
    await expect(
      s.run("slides.insert-image", ["presentation", "page", "input:photo.png"]),
    ).rejects.toThrow(/403/);
    expect(cleanup).toHaveBeenCalledWith("uploaded", undefined);
  });
  it("uses a private hyperlink for restricted Docs sharing only when explicitly requested", async () => {
    const s = setup(doc),
      cleanup = vi.fn(async () => {});
    s.runtime.cleanupGoogleFile = cleanup;
    const png = new Uint8Array(24),
      view = new DataView(png.buffer);
    view.setUint32(0, 0x89504e47);
    view.setUint32(16, 10);
    view.setUint32(20, 10);
    s.runtime.input = () => png;
    const original = s.runtime.json;
    s.runtime.json = async (api, path, opts) => {
      if (path.endsWith("/permissions"))
        throw new Error("Google request failed (403)");
      return original(api, path, opts);
    };
    const result = await s.run("docs.insert-image", ["doc"], {
      file: "input:photo.png",
      "on-restricted": "link",
      name: "Photo",
    });
    expect(cleanup).not.toHaveBeenCalled();
    expect((s.writes()[0].options.body as Data).requests).toContainEqual(
      expect.objectContaining({
        insertText: expect.objectContaining({ text: "Photo" }),
      }),
    );
    expect(result).toMatchObject({
      assets: [{ fileId: "uploaded", public: false }],
    });
  });
});

describe("independent review regressions", () => {
  it("parses comma rows and pipe cells but preserves delimiters in a single-cell positional update", async () => {
    const s = setup();
    await s.run("sheets.update", ["sheet", "'Annual Report'!A1:B2", "a|b,c|d"]);
    expect((s.writes()[0].options.body as Data).values).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    const cell = setup();
    await cell.run("sheets.update", ["sheet", "'Annual Report'!A1", "a|b,c|d"]);
    expect((cell.writes()[0].options.body as Data).values).toEqual([
      ["a|b,c|d"],
    ]);
  });
  it("accepts cols and inherits before when inserting after a dimension", async () => {
    const s = setup();
    await s.run("sheets.insert", ["sheet", "Annual Report", "cols", "2"], {
      after: true,
    });
    expect(
      (s.writes()[0].options.body as Data).requests[0].insertDimension,
    ).toEqual({
      range: { sheetId: 7, dimension: "COLUMNS", startIndex: 2, endIndex: 3 },
      inheritFromBefore: true,
    });
  });
  it("verifies formulas over the API-returned updated range", async () => {
    const s = setup();
    await s.run("sheets.update", ["sheet", "A1"], {
      "values-json": '[[1,"=1/0"]]',
      "fail-on-formula-error": true,
    });
    expect(
      s.calls.find((call) => call.options.query?.includeGridData)?.options.query
        ?.ranges,
    ).toBe("'Annual Report'!A1:B2");
  });
  it("excludes header and footer when clearing table data", async () => {
    const meta = structuredClone(sheet) as Data;
    meta.sheets[0].tables[0].rowsProperties = {
      footerColorStyle: { rgbColor: { red: 1 } },
    };
    const s = setup(meta);
    await s.run("sheets.table.clear", ["sheet", "Orders"]);
    expect(s.writes()[0].path).toContain("A2%3AB3:clear");
  });
  it("uses documented BigQuery tableProjectId and a partial update field mask", async () => {
    const add = setup();
    await add.run("sheets.datasource.add", ["sheet"], {
      "billing-project": "bill",
      "table-project": "source",
      dataset: "events",
      table: "daily",
    });
    expect(
      (add.writes()[0].options.body as Data).requests[0].addDataSource
        .dataSource.spec.bigQuery.tableSpec,
    ).toEqual({
      tableProjectId: "source",
      datasetId: "events",
      tableId: "daily",
    });
    const s = setup({
      ...sheet,
      dataSources: [
        {
          dataSourceId: "ds",
          spec: {
            bigQuery: {
              projectId: "bill",
              tableSpec: {
                tableProjectId: "source",
                datasetId: "old",
                tableId: "old",
              },
            },
          },
        },
      ],
    });
    await s.run("sheets.datasource.update", ["sheet", "ds"], { table: "new" });
    expect(
      (s.writes()[0].options.body as Data).requests[0].updateDataSource,
    ).toEqual({
      dataSource: {
        dataSourceId: "ds",
        spec: { bigQuery: { tableSpec: { tableId: "new" } } },
      },
      fields: "spec.bigQuery.tableSpec.tableId",
    });
  });
  it("inserts Docs updates at the end and defaults plain writes to replacement", async () => {
    const update = setup(doc);
    await update.run("docs.update", ["doc"], { text: "More" });
    expect(
      (update.writes()[0].options.body as Data).requests[0].insertText.location
        .index,
    ).toBe(9);
    const write = setup(doc);
    await write.run("docs.write", ["doc"], { text: "Replacement" });
    expect((write.writes()[0].options.body as Data).requests).toContainEqual({
      deleteContentRange: {
        range: { startIndex: 1, endIndex: 9, tabId: "t1" },
      },
    });
  });
  it("preflights malformed row values before inserting a Docs table row", async () => {
    const meta = structuredClone(doc) as Data;
    meta.tabs[0].documentTab.body.content.push({
      startIndex: 11,
      endIndex: 25,
      table: {
        rows: 1,
        columns: 1,
        tableRows: [
          {
            tableCells: [
              {
                startIndex: 12,
                endIndex: 22,
                content: [
                  {
                    startIndex: 13,
                    endIndex: 22,
                    paragraph: {
                      elements: [
                        {
                          startIndex: 13,
                          endIndex: 22,
                          textRun: { content: "Key\n" },
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    const s = setup(meta);
    await expect(
      s.run("docs.table-row.insert", ["doc"], {
        table: "Key",
        "values-json": "{}",
      }),
    ).rejects.toThrow(/scalar row/);
    expect(s.writes()).toHaveLength(0);
  });
  it("blocks Markdown replacement that would orphan an open comment in the target tab", async () => {
    const s = setup(doc),
      original = s.runtime.json;
    s.runtime.json = async (api, path, options) =>
      path.endsWith("/comments")
        ? {
            comments: [
              { id: "comment1", quotedFileContent: { value: "hello" } },
            ],
          }
        : original(api, path, options);
    await expect(
      s.run("docs.write", ["doc"], {
        text: "# Different",
        replace: true,
        markdown: true,
        "check-orphans": true,
      }),
    ).rejects.toThrow(/orphan open comments: comment1/);
    expect(s.writes()).toHaveLength(0);
  });
  it("permits Markdown replacement preserving open comment quotes", async () => {
    const s = setup(doc),
      original = s.runtime.json;
    s.runtime.json = async (api, path, options) =>
      path.endsWith("/comments")
        ? {
            comments: [
              { id: "comment1", quotedFileContent: { value: "hello" } },
            ],
          }
        : original(api, path, options);
    await s.run("docs.write", ["doc"], {
      text: "# hello",
      replace: true,
      markdown: true,
      "check-orphans": true,
    });
    expect(s.writes()).toHaveLength(1);
  });
  it("applies whole-match sed styling without deleting the match and supports positioned inline braces", async () => {
    const global = setup(doc);
    await global.run("docs.sed", ["doc", "s/hello/{b}/"]);
    const requests = (global.writes()[0].options.body as Data).requests;
    expect(
      requests.some(
        (request: Data) => request.deleteContentRange || request.insertText,
      ),
    ).toBe(false);
    expect(requests[0].updateTextStyle.textStyle).toEqual({});
    expect(requests[1].updateTextStyle.textStyle).toEqual({ bold: true });
    const local = setup(doc);
    await local.run("docs.sed", ["doc", "s/hello/H{,=2}O/"]);
    const operations = (local.writes()[0].options.body as Data).requests;
    expect(operations[1].insertText.text).toBe("H2O");
    expect(operations).toContainEqual({
      updateTextStyle: {
        range: { startIndex: 5, endIndex: 6, tabId: "t1" },
        textStyle: { baselineOffset: "SUBSCRIPT" },
        fields: "baselineOffset",
      },
    });
  });
  it("leaves unknown brace expressions literal without partially applying known flags", () => {
    expect(braceReplacement("{b unknown}Text")).toEqual({
      text: "{b unknown}Text",
      styles: {},
      extra: {},
      structural: undefined,
    });
  });
  it("deletes Slides text without sending an invalid empty insert", async () => {
    const s = setup({
      presentationId: "presentation",
      revisionId: "r1",
      slides: [
        {
          objectId: "page",
          pageElements: [
            {
              objectId: "text",
              shape: {
                text: { textElements: [{ textRun: { content: "old" } }] },
              },
            },
          ],
        },
      ],
    });
    await s.run("slides.replace-text", ["presentation", "old", ""], {
      object: "text",
    });
    expect((s.writes()[0].options.body as Data).requests).toHaveLength(1);
    expect((s.writes()[0].options.body as Data).requests[0]).toHaveProperty(
      "deleteText",
    );
  });
});

describe("Google structural API schema regressions", () => {
  it("inserts date and Drive file chips using the exact upstream API version", async () => {
    const s = setup(doc);
    await s.run("docs.insert-date-chip", ["doc"], { date: "2026-09-09" });
    expect(
      (s.writes()[0].options.body as Data).requests[0].insertDate
        .dateElementProperties.timestamp,
    ).toBe("2026-09-09T00:00:00Z");
    await expect(
      s.run("docs.insert-date-chip", ["doc"], { date: "2026-02-31" }),
    ).rejects.toThrow(/YYYY/);
    const file = setup(doc),
      original = file.runtime.json;
    file.runtime.json = async (api, path, options) =>
      api === "drive"
        ? {
            id: "file1",
            webViewLink: "https://drive.google.com/file/d/file1/view",
          }
        : original(api, path, options);
    await file.run("docs.insert-file-chip", ["doc"], { "file-id": "file1" });
    expect((file.writes()[0].options.body as Data).requests[0]).toHaveProperty(
      "insertRichLink",
    );
  });
  it("validates section columns and the complete side-border payload", async () => {
    const s = setup(doc);
    await s.run("docs.section-columns", ["doc"], { count: 2 });
    expect(
      (s.writes()[0].options.body as Data).requests[0].updateSectionStyle
        .sectionStyle.columnProperties,
    ).toHaveLength(2);
    await expect(
      s.run("docs.section-columns", ["doc"], { count: 4 }),
    ).rejects.toThrow();
  });
});

it("never treats text in different table cells as one normalized replacement range", () => {
  const target: Target = {
    full: {},
    doc: {},
    content: [
      {
        paragraph: {
          elements: [{ startIndex: 1, textRun: { content: "first\n" } }],
        },
      },
      {
        paragraph: {
          elements: [{ startIndex: 20, textRun: { content: "second\n" } }],
        },
      },
    ],
  };
  expect(
    matches(target, "first second", { "normalize-whitespace": true }),
  ).toEqual([]);
});

describe("Docs range and revision continuity", () => {
  const snapshot = (text: string, revisionId: string): Data => ({
    documentId: "doc",
    revisionId,
    tabs: [
      {
        tabProperties: { tabId: "t1", title: "Notes" },
        documentTab: {
          body: {
            content: [
              { startIndex: 0, endIndex: 1, sectionBreak: {} },
              {
                startIndex: 1,
                endIndex: text.length + 1,
                paragraph: {
                  elements: [
                    {
                      startIndex: 1,
                      endIndex: text.length + 1,
                      textRun: { content: text },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    ],
  });
  it.each(["docs.find-replace", "docs.sed"])(
    "refuses %s when another editor changes the snapshot before the first indexed mutation",
    async (command) => {
      const s = setup();
      let reads = 0;
      s.runtime.json = async (api, path, options = {}) => {
        s.calls.push({ api, path, options });
        if (options.method === "POST")
          return { writeControl: { requiredRevisionId: "ours" } };
        return ++reads === 1
          ? snapshot("target\n", "rev-A")
          : snapshot("prefix target\n", "rev-B");
      };
      await expect(
        s.run(
          command,
          command === "docs.sed"
            ? ["doc", "s/target/changed/"]
            : ["doc", "target", "changed"],
          { format: "markdown" },
        ),
      ).rejects.toThrow(/revision/i);
      expect(s.writes()).toHaveLength(0);
    },
  );
  it("refuses to carry old ranges into a concurrent revision after its own first replacement", async () => {
    const s = setup();
    let reads = 0;
    s.runtime.json = async (api, path, options = {}) => {
      s.calls.push({ api, path, options });
      if (options.method === "POST")
        return { writeControl: { requiredRevisionId: "our-revision-1" } };
      return ++reads <= 2
        ? snapshot("target target\n", "rev-A")
        : snapshot("prefix target changed\n", "concurrent-revision");
    };
    await expect(
      s.run("docs.find-replace", ["doc", "target", "changed"], {
        format: "markdown",
      }),
    ).rejects.toThrow(/revision/i);
    expect(s.writes()).toHaveLength(1);
    expect((s.writes()[0].options.body as Data).writeControl).toEqual({
      requiredRevisionId: "rev-A",
    });
  });
  it("uses the revision returned by its own mutation for dependent replacements", async () => {
    const s = setup();
    let revision = "rev-A",
      writes = 0;
    s.runtime.json = async (api, path, options = {}) => {
      s.calls.push({ api, path, options });
      if (options.method === "POST") {
        revision = `ours-${++writes}`;
        return { writeControl: { requiredRevisionId: revision } };
      }
      return snapshot("target target\n", revision);
    };
    await s.run("docs.find-replace", ["doc", "target", "changed"], {
      format: "markdown",
    });
    expect(
      s
        .writes()
        .map(
          (call) => (call.options.body as Data).writeControl.requiredRevisionId,
        ),
    ).toEqual(["rev-A", "ours-1"]);
  });
  it("fails closed before a dependent write if Google omits its resulting revision", async () => {
    const s = setup();
    s.runtime.json = async (api, path, options = {}) => {
      s.calls.push({ api, path, options });
      return options.method === "POST"
        ? {}
        : snapshot("target target\n", "arbitrary-revision");
    };
    await expect(
      s.run("docs.find-replace", ["doc", "target", "changed"], {
        format: "markdown",
      }),
    ).rejects.toThrow(/revision/i);
    expect(s.writes()).toHaveLength(1);
  });
  it("allows header replacement at index zero but still rejects body index zero", async () => {
    const meta = snapshot("body\n", "rev-A");
    meta.tabs[0].documentTab.headers = {
      h1: {
        content: [
          {
            startIndex: 0,
            endIndex: 5,
            paragraph: {
              elements: [
                { startIndex: 0, endIndex: 5, textRun: { content: "head\n" } },
              ],
            },
          },
        ],
      },
    };
    const s = setup(meta);
    await s.run("docs.update", ["doc"], {
      segment: "h1",
      "replace-range": "0:1",
      text: "H",
    });
    expect((s.writes()[0].options.body as Data).requests[0]).toEqual({
      deleteContentRange: {
        range: { startIndex: 0, endIndex: 1, tabId: "t1", segmentId: "h1" },
      },
    });
    const body = setup(meta);
    await expect(
      body.run("docs.update", ["doc"], { "replace-range": "0:1", text: "H" }),
    ).rejects.toThrow();
    expect(body.writes()).toHaveLength(0);
  });
});

it("uses updated outer-table bounds after its own nested-table deletion", async () => {
  const nested = {
    startIndex: 6,
    endIndex: 12,
    table: {
      rows: 1,
      columns: 1,
      tableRows: [{ tableCells: [{ content: [] }] }],
    },
  };
  const original = {
    documentId: "doc",
    revisionId: "rev-A",
    body: {
      content: [
        {
          startIndex: 1,
          endIndex: 20,
          table: {
            rows: 1,
            columns: 1,
            tableRows: [{ tableCells: [{ content: [nested] }] }],
          },
        },
      ],
    },
  };
  const updated = {
    documentId: "doc",
    revisionId: "ours-1",
    body: {
      content: [
        {
          startIndex: 1,
          endIndex: 14,
          table: {
            rows: 1,
            columns: 1,
            tableRows: [{ tableCells: [{ content: [] }] }],
          },
        },
      ],
    },
  };
  const s = setup();
  let writes = 0;
  s.runtime.json = async (api, path, options = {}) => {
    s.calls.push({ api, path, options });
    if (options.method === "POST")
      return { writeControl: { requiredRevisionId: `ours-${++writes}` } };
    return structuredClone(writes ? updated : original);
  };
  await s.run("docs.sed", ["doc", "s@|*|@@"]);
  expect(
    s
      .writes()
      .map(
        (call) =>
          (call.options.body as Data).requests[0].deleteContentRange.range,
      ),
  ).toEqual([
    { startIndex: 6, endIndex: 12 },
    { startIndex: 1, endIndex: 14 },
  ]);
});

it("carries the returned revision into a header text insertion that has no extra GET", async () => {
  const s = setup(doc);
  let writes = 0;
  s.runtime.json = async (api, path, options = {}) => {
    s.calls.push({ api, path, options });
    if (options.method === "POST")
      return {
        replies: [{ createHeader: { headerId: "h2" } }],
        writeControl: { requiredRevisionId: `ours-${++writes}` },
      };
    return structuredClone(doc);
  };
  await s.run("docs.header.create", ["doc"], { text: "New header" });
  expect(
    s
      .writes()
      .map(
        (call) => (call.options.body as Data).writeControl.requiredRevisionId,
      ),
  ).toEqual(["revision-1", "ours-1"]);
});
