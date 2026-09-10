import { imageLifecycle } from "./documents-assets";
import {
  type Command,
  type Data,
  type Runtime,
  type HandlerMap,
  segment,
} from "./types";
import {
  flags,
  supplied,
  integer,
  id,
  mask,
  color,
  pt,
  textInput,
  textStyle,
  copyDocument,
  exportDocument,
  attachParent,
} from "./documents-common";
import {
  loadDoc,
  docRoot,
  tabs,
  tabBy,
  paragraphs,
  paragraphText,
  tablesOf,
  textMap,
  endIndex,
  matches,
  anchor,
  position,
  targetFields,
  docRange,
  docBatch,
  layoutRequest,
  formatRequests,
  dimension,
  selectedTable,
  selectedCell,
  populateTable,
  insertMarkdown,
  markdownPlan,
  type Target,
} from "./documents-docs-core";
import { uploadImage } from "./documents-slides";
const h: HandlerMap = {};
h["docs.info"] = async (c, r) => (await loadDoc(c, r)).full;
h["docs.raw"] = async (c, r) => {
  const f = flags(c);
  if (f.tab && f["all-tabs"]) throw new Error("Choose tab or all-tabs");
  const t = await loadDoc(c, r);
  return f.tab
    ? {
        documentId: t.full.documentId,
        title: t.full.title,
        revisionId: t.full.revisionId,
        ...t.doc,
      }
    : t.full;
};
h["docs.copy"] = copyDocument;
h["docs.export"] = async (c, r) => {
  const f = flags(c);
  if (f.tab) {
    const t = await loadDoc(c, r);
    if (!["pdf", "docx", "txt", "md", "html"].includes(f.format))
      throw new Error("Unsupported tab export format");
    const downloaded = await r.bytes(
      "docs-web",
      `document/d/${id(c.positionals[0])}/export`,
      {
        query: {
          format: f.format === "md" ? "markdown" : f.format,
          tab: t.tabId,
        },
      },
    );
    return r.output(
      r.outputName(c, `artifacts/export.${f.format}`),
      downloaded.bytes,
    );
  }
  return exportDocument(c, r);
};
h["docs.create"] = async (c, r) => {
  const f = flags(c),
    created = await r.json("docs", "documents", {
      method: "POST",
      body: { title: c.positionals[0] },
    });
  await attachParent(r, created.documentId, f.parent);
  const target = {
    ...c,
    positionals: [created.documentId],
    flags: {
      ...f,
      text: f.file ? r.text(f.file) : undefined,
      file: undefined,
      replace: true,
      markdown: Boolean(f.file),
    },
  };
  if (f.file || f.pageless) await h["docs.write"](target, r);
  return created;
};
for (const name of ["docs.tabs.list", "docs.list-tabs"])
  h[name] = async (c, r) => ({
    tabs: tabs((await loadDoc(c, r)).full).map((t) => t.tabProperties),
  });
for (const name of ["docs.tabs.add", "docs.add-tab"])
  h[name] = async (c, r) => {
    const f = flags(c),
      t = await loadDoc(c, r),
      properties: Data = { title: f.title };
    if (f.index !== undefined) properties.index = integer(f.index, "index");
    if (f["parent-tab"])
      properties.parentTabId = tabBy(t.full, f["parent-tab"])?.tabProperties
        .tabId;
    if (f["icon-emoji"]) properties.icon = { emoji: f["icon-emoji"] };
    return docBatch(
      c,
      r,
      [{ addDocumentTab: { tabProperties: properties } }],
      t,
    );
  };
for (const name of [
  "docs.tabs.rename",
  "docs.rename-tab",
  "docs.tabs.delete",
  "docs.delete-tab",
])
  h[name] = async (c, r) => {
    const f = flags(c);
    if (!f.tab) throw new Error("Tab required");
    const t = await loadDoc(c, r);
    return docBatch(
      c,
      r,
      [
        name.endsWith("delete") || name === "docs.delete-tab"
          ? { deleteTab: { tabId: t.tabId } }
          : {
              updateDocumentTabProperties: {
                tabProperties: { tabId: t.tabId, title: f.title },
                fields: "title",
              },
            },
      ],
      t,
    );
  };
h["docs.cat"] = async (c, r) => {
  const f = flags(c);
  if (f.tab && f["all-tabs"]) throw new Error("Choose tab or all-tabs");
  const t = await loadDoc(c, r),
    selected = f["all-tabs"]
      ? tabs(t.full).map((tab) => ({
          ...t,
          doc: tab.documentTab,
          content: tab.documentTab?.body?.content ?? [],
          tabId: tab.tabProperties.tabId,
        }))
      : [t];
  let text = selected
    .map((target) =>
      paragraphs(target)
        .map(
          (p, i) =>
            (f.numbered ? `[${i + 1}] ` : "") +
            paragraphText(p, f.chips !== false),
        )
        .join(""),
    )
    .join("\n");
  const encoded = new TextEncoder().encode(text),
    maximum = integer(f["max-bytes"], "max-bytes", 1, 8 * 1024 * 1024);
  if (encoded.length > maximum)
    text = new TextDecoder().decode(encoded.subarray(0, maximum));
  return { text, truncated: encoded.length > maximum, raw: f.raw ?? false };
};
h["docs.structure"] = async (c, r) => {
  const t = await loadDoc(c, r);
  return {
    documentId: c.positionals[0],
    tabId: t.tabId,
    paragraphs: paragraphs(t).map((p, i) => ({
      number: i + 1,
      startIndex: p.startIndex,
      endIndex: p.endIndex,
      text: paragraphText(p),
      style: p.paragraph.paragraphStyle,
    })),
    tables: tablesOf(t).map((e, i) => ({
      index: i + 1,
      startIndex: e.startIndex,
      endIndex: e.endIndex,
      rows: e.table.rows,
      columns: e.table.columns,
    })),
  };
};
for (const type of [
  "paragraphs",
  "headings",
  "tables",
  "images",
  "suggestions",
])
  h[`docs.${type}.list`] = async (c, r) => {
    const f = flags(c),
      t = await loadDoc(c, r);
    if (type === "tables")
      return { tables: tablesOf(t).map((e, i) => ({ index: i + 1, ...e })) };
    if (type === "images")
      return {
        images: Object.entries(t.doc.inlineObjects ?? {}).map(
          ([objectId, v]) => ({ objectId, ...(v as Data) }),
        ),
        positionedImages: t.doc.positionedObjects ?? {},
      };
    if (type === "suggestions")
      return {
        suggestions: paragraphs(t).flatMap((p) =>
          (p.paragraph.elements ?? [])
            .filter(
              (e: Data) =>
                e.suggestedInsertionIds ||
                e.suggestedDeletionIds ||
                e.textRun?.suggestedTextStyleChanges,
            )
            .map((e: Data) => ({ ...e, paragraphIndex: p.startIndex })),
        ),
      };
    return {
      [type]: paragraphs(t)
        .map((p, i) => ({
          number: i + 1,
          startIndex: p.startIndex,
          endIndex: p.endIndex,
          text: paragraphText(p),
          ...p.paragraph.paragraphStyle,
        }))
        .filter((p) =>
          type === "headings"
            ? /^HEADING_[1-6]$/.test(p.namedStyleType ?? "") &&
              (!f.level || p.namedStyleType === `HEADING_${f.level}`)
            : !f.style || p.namedStyleType === f.style,
        ),
    };
  };
h["docs.find-range"] = async (c, r) => {
  const f = flags(c),
    t = await loadDoc(c, r);
  let found = matches(t, c.positionals[1], f);
  if (!f.all) {
    const index = integer(f.occurrence ?? 1, "occurrence", 1) - 1;
    found = found.slice(index, index + 1);
  }
  if (!found.length && f["fail-empty"]) throw new Error("No matches");
  return { matches: found };
};
h["docs.format"] = async (c, r) => {
  const f = flags(c),
    t = await loadDoc(c, r);
  if (f["match-all"] && !f.match) throw new Error("match-all requires match");
  let ranges = f.match
    ? matches(t, f.match, f)
    : [docRange(t, t.segmentId ? 0 : 1, endIndex(t))];
  if (f.match && !f["match-all"]) ranges = ranges.slice(0, 1);
  if (!ranges.length) throw new Error("No matching text");
  const requests = ranges.flatMap((range) => formatRequests(f, range));
  if (!requests.length) throw new Error("No formatting flags provided");
  return docBatch(c, r, requests, t);
};
h["docs.page-layout"] = async (c, r) => {
  const t = await loadDoc(c, r),
    f = flags(c);
  if (
    !supplied(c, "layout") &&
    Object.keys(f).some((key) => /^(page-|margin-)/.test(key))
  )
    delete f.layout;
  const request = layoutRequest(f, t);
  if (!request) throw new Error("No layout changes requested");
  return docBatch(c, r, [request], t);
};
async function write(c: Command, r: Runtime): Promise<any> {
  const f = flags(c),
    t = await loadDoc(c, r),
    op = c.command;
  let content: string | undefined;
  if (f.file !== undefined) {
    if (
      f.text !== undefined ||
      (op === "docs.insert" && c.positionals[1] !== undefined)
    )
      throw new Error("Choose file or inline text");
    content = r.text(f.file);
  } else
    content = f.text ?? (op === "docs.insert" ? c.positionals[1] : undefined);
  const layout = layoutRequest(f, t),
    requests: Data[] = [];
  if (layout) requests.push(layout);
  if (content === undefined) {
    if (layout) return docBatch(c, r, requests, t);
    throw new Error("Provide text or input file");
  }
  let start = position(t, f, "end");
  if (op === "docs.write") {
    if (f.append && f.replace) throw new Error("Choose append or replace");
    if (f.markdown && !f.append && !f.replace)
      throw new Error("Markdown write requires append or replace");
    if (!f.append && endIndex(t) > 1)
      requests.push({
        deleteContentRange: { range: docRange(t, 1, endIndex(t)) },
      });
    start = f.append ? endIndex(t) : 1;
  } else if (op === "docs.update") {
    if (f["replace-range"]) {
      if (f.at !== undefined || f.index !== undefined)
        throw new Error("replace-range cannot combine with at or index");
      const m = /^(\d+):(\d+)$/.exec(f["replace-range"]);
      if (!m) throw new Error("replace-range must be start:end");
      start = integer(m[1], "start", t.segmentId ? 0 : 1);
      requests.push({
        deleteContentRange: {
          range: docRange(
            t,
            start,
            integer(m[2], "end", start + 1, endIndex(t)),
          ),
        },
      });
    } else if (f.at !== undefined)
      requests.push({ deleteContentRange: { range: anchor(t, f) } });
  }
  if (f["check-orphans"]) {
    if (!f.markdown || !f.replace || f.append)
      throw new Error("check-orphans requires replace and markdown");
    const proposed = markdownPlan(content),
      normalized = (value: string) =>
        value
          .replace(/<[^>]*>/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
    const outgoing = normalized(
      proposed.text +
        " " +
        proposed.specials
          .filter((item) => item.kind === "table")
          .flatMap((item) => item.value.flat())
          .map((value) => markdownPlan(String(value)).text)
          .join(" "),
    );
    const comments = await commentsList(c, r, { all: true, max: 100 });
    const orphans = comments.comments.filter((comment: Data) => {
      const quote = String(comment.quotedFileContent?.value ?? "").trim();
      return (
        quote &&
        matches(t, quote, { "normalize-whitespace": true }).length &&
        !outgoing.includes(normalized(quote))
      );
    });
    if (orphans.length)
      throw new Error(
        `Replacement would orphan open comments: ${orphans.map((comment: Data) => comment.id).join(", ")}. Preserve their quoted text or resolve the comments first.`,
      );
  }
  if (f.markdown) return insertMarkdown(c, r, t, start, content, requests, f);
  if (content)
    requests.push(
      {
        insertText: {
          location: { index: start, ...targetFields(t) },
          text: content,
        },
      },
      ...formatRequests(f, docRange(t, start, start + content.length)),
    );
  return docBatch(c, r, requests, t);
}
for (const op of ["write", "update", "insert"]) h[`docs.${op}`] = write;
h["docs.clear"] = async (c, r) => {
  const t = await loadDoc(c, r);
  return docBatch(
    c,
    r,
    endIndex(t) > 1
      ? [{ deleteContentRange: { range: docRange(t, 1, endIndex(t)) } }]
      : [],
    t,
  );
};
h["docs.delete"] = async (c, r) => {
  const f = flags(c),
    t = await loadDoc(c, r);
  if (f.at !== undefined && (f.start !== undefined || f.end !== undefined))
    throw new Error("Choose anchor or explicit range");
  const range =
    f.at !== undefined
      ? anchor(t, f)
      : docRange(
          t,
          integer(f.start, "start", t.segmentId ? 0 : 1),
          integer(f.end, "end", 1, endIndex(t)),
        );
  return docBatch(c, r, [{ deleteContentRange: { range } }], t);
};
for (const op of ["find-replace", "edit"])
  h[`docs.${op}`] = async (c, r) => {
    const f = flags(c),
      t = await loadDoc(c, r),
      find = c.positionals[1];
    let replacement = c.positionals[2];
    if (f["content-file"]) {
      if (replacement !== undefined)
        throw new Error("Choose replacement or content-file");
      replacement = r.text(f["content-file"]);
    }
    if (typeof replacement !== "string")
      throw new Error("Replacement required");
    let found = matches(t, find, { "match-case": f["match-case"] });
    if (f.first) found = found.slice(0, 1);
    if (!found.length) return { occurrencesChanged: 0 };
    if (f.format === "markdown") {
      for (const range of found.reverse()) {
        const current = await loadDoc(c, r);
        await insertMarkdown(c, r, current, range.startIndex, replacement, [
          { deleteContentRange: { range } },
        ]);
      }
      return { occurrencesChanged: found.length };
    }
    return docBatch(
      c,
      r,
      found.reverse().flatMap((range) => [
        { deleteContentRange: { range } },
        ...(replacement
          ? [
              {
                insertText: {
                  location: { index: range.startIndex, ...targetFields(t) },
                  text: replacement,
                },
              },
            ]
          : []),
      ]),
      t,
    );
  };
for (const kind of ["header", "footer"])
  for (const op of ["list", "create", "delete"])
    h[`docs.${kind}.${op}`] = async (c, r) => {
      const f = flags(c),
        t = await loadDoc(c, r);
      if (op === "list")
        return {
          [kind + "s"]: Object.entries(t.doc[kind + "s"] ?? {}).map(
            ([segmentId, v]) => ({ segmentId, ...(v as Data) }),
          ),
        };
      if (op === "delete")
        return docBatch(
          c,
          r,
          [
            {
              [kind === "header" ? "deleteHeader" : "deleteFooter"]: {
                [kind + "Id"]: c.positionals[1],
                ...(t.tabId ? { tabId: t.tabId } : {}),
              },
            },
          ],
          t,
        );
      const at = f.at !== undefined ? anchor(t, f) : undefined,
        location = position(t, f, "start"),
        result = await docBatch(
          c,
          r,
          [
            {
              [kind === "header" ? "createHeader" : "createFooter"]: {
                type: "DEFAULT",
                ...(t.tabId ? { tabId: t.tabId } : {}),
                ...(f.at !== undefined || f.index !== undefined || f["at-end"]
                  ? {
                      sectionBreakLocation: {
                        index: location,
                        ...targetFields(t),
                      },
                    }
                  : {}),
              },
            },
          ],
          t,
        );
      const segmentId =
        result.replies?.[0]?.[
          kind === "header" ? "createHeader" : "createFooter"
        ]?.[kind + "Id"];
      if (f.file !== undefined || f.text !== undefined) {
        if (!segmentId) throw new Error("Created segment ID unavailable");
        const text = textInput(f, r);
        await docBatch(c, r, [
          {
            insertText: {
              endOfSegmentLocation: {
                segmentId,
                ...(t.tabId ? { tabId: t.tabId } : {}),
              },
              text,
            },
          },
        ]);
      }
      return result;
    };
for (const op of [
  "insert-person",
  "insert-file-chip",
  "insert-date-chip",
  "insert-page-break",
  "insert-section-break",
  "insert-horizontal-rule",
  "insert-footnote",
  "section-columns",
])
  h[`docs.${op}`] = async (c, r) => {
    const f = flags(c),
      t = await loadDoc(c, r),
      start = position(t, f, "end"),
      location = { index: start, ...targetFields(t) },
      requests: Data[] = [];
    const replacement =
      f.at !== undefined && op === "insert-person" ? anchor(t, f) : undefined;
    if (replacement)
      requests.push({ deleteContentRange: { range: replacement } });
    let request: Data;
    if (op === "insert-person")
      request = {
        insertPerson: { location, personProperties: { email: f.email } },
      };
    else if (op === "insert-file-chip") {
      const file = await r.json("drive", `files/${id(f["file-id"])}`, {
        query: { fields: "id,name,webViewLink" },
      });
      request = {
        insertRichLink: {
          location,
          richLinkProperties: {
            uri:
              file.webViewLink ??
              `https://drive.google.com/file/d/${file.id}/view`,
          },
        },
      };
    } else if (op === "insert-date-chip") {
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(f.date) ||
        Number.isNaN(Date.parse(f.date)) ||
        new Date(f.date).toISOString().slice(0, 10) !== f.date
      )
        throw new Error("Date must be YYYY-MM-DD");
      const formats: Data = {
        abbreviated: "DATE_FORMAT_MONTH_DAY_YEAR_ABBREVIATED",
        full: "DATE_FORMAT_MONTH_DAY_FULL",
        iso: "DATE_FORMAT_ISO8601",
      };
      if (!formats[f.format]) throw new Error("Invalid date display format");
      request = {
        insertDate: {
          location,
          dateElementProperties: {
            dateFormat: formats[f.format],
            timeFormat: "TIME_FORMAT_DISABLED",
            timestamp: `${f.date}T00:00:00Z`,
          },
        },
      };
    } else if (op === "insert-page-break")
      request = { insertPageBreak: { location } };
    else if (op === "insert-section-break") {
      const type =
        f.type === "continuous"
          ? "CONTINUOUS"
          : f.type === "next-page"
            ? "NEXT_PAGE"
            : undefined;
      if (!type)
        throw new Error("Section type must be continuous or next-page");
      request = { insertSectionBreak: { location, sectionType: type } };
    } else if (op === "insert-horizontal-rule") {
      requests.push({ insertText: { location, text: "\n" } });
      request = {
        updateParagraphStyle: {
          range: docRange(t, start, start + 1),
          paragraphStyle: {
            borderBottom: {
              color: { color: { rgbColor: color("#000000") } },
              width: pt(1),
              padding: pt(0),
              dashStyle: "SOLID",
            },
          },
          fields: "borderBottom",
        },
      };
    } else if (op === "section-columns") {
      const count = integer(f.count, "count", 1, 3);
      request = {
        updateSectionStyle: {
          range: docRange(t, start, Math.min(start + 1, endIndex(t) + 1)),
          sectionStyle: {
            columnProperties: Array.from({ length: count }, () => ({
              paddingEnd: pt(18),
            })),
            columnSeparatorStyle:
              f.separator === "between" ? "BETWEEN_EACH_COLUMN" : "NONE",
          },
          fields: "columnProperties,columnSeparatorStyle",
        },
      };
    } else request = { createFootnote: { location } };
    requests.push(request);
    const result = await docBatch(c, r, requests, t);
    if (
      op === "insert-footnote" &&
      (f.file !== undefined || f.text !== undefined)
    ) {
      const footnoteId = result.replies?.at(-1)?.createFootnote?.footnoteId;
      if (!footnoteId) throw new Error("Created footnote ID unavailable");
      await docBatch(c, r, [
        {
          insertText: {
            endOfSegmentLocation: {
              segmentId: footnoteId,
              ...(t.tabId ? { tabId: t.tabId } : {}),
            },
            text: textInput(f, r),
          },
        },
      ]);
    }
    return result;
  };
h["docs.insert-table"] = async (c, r) => {
  const f = flags(c),
    t = await loadDoc(c, r),
    data = f["values-json"] ? r.jsonInput(f["values-json"]) : undefined;
  if (data && (!Array.isArray(data) || !data.every(Array.isArray)))
    throw new Error("values-json must be a matrix");
  const rows = integer(f.rows ?? data?.length, "rows", 1),
    columns = integer(
      f.cols ?? Math.max(...(data ?? []).map((row: any[]) => row.length)),
      "cols",
      1,
    );
  if (
    data &&
    (data.length > rows || data.some((row: any[]) => row.length > columns))
  )
    throw new Error("Values exceed table dimensions");
  const start = position(t, f, "end");
  const result = await docBatch(
    c,
    r,
    [
      {
        insertTable: {
          rows,
          columns,
          location: { index: start, ...targetFields(t) },
        },
      },
    ],
    t,
  );
  if (data) {
    const current = await loadDoc(c, r),
      table = tablesOf(current).find((e) => e.startIndex === start + 1);
    if (!table) throw new Error("Created table not found");
    await populateTable(c, r, current, table, data);
  }
  return result;
};
h["docs.cell-update"] = async (c, r) => {
  const f = flags(c),
    t = await loadDoc(c, r),
    table = selectedTable(t, f["table-index"]),
    cell = selectedCell(table, f.row, f.col),
    p = (cell.content ?? []).find((v: Data) => v.paragraph);
  if (!p) throw new Error("No cell paragraph");
  const content = f["content-file"] ? r.text(f["content-file"]) : f.content;
  if (
    typeof content !== "string" ||
    (f["content-file"] && f.content !== undefined)
  )
    throw new Error("Choose content or content-file");
  const start = f.append ? cell.endIndex - 1 : p.startIndex,
    requests: Data[] = [];
  if (!f.append && cell.endIndex - 1 > start)
    requests.push({
      deleteContentRange: { range: docRange(t, start, cell.endIndex - 1) },
    });
  if (f.format === "markdown")
    return insertMarkdown(c, r, t, start, content, requests);
  if (content)
    requests.push({
      insertText: {
        location: { index: start, ...targetFields(t) },
        text: content,
      },
    });
  return docBatch(c, r, requests, t);
};
h["docs.cell-style"] = async (c, r) => {
  const f = flags(c),
    t = await loadDoc(c, r),
    table = selectedTable(t, f["table-index"]),
    cell = selectedCell(table, f.row, f.col),
    row = integer(f.row, "row", 1) - 1,
    col = integer(f.col, "col", 1) - 1,
    rowSpan = integer(f["row-span"], "row-span", 1),
    columnSpan = integer(f["col-span"], "col-span", 1);
  if (
    row + rowSpan > table.table.rows ||
    col + columnSpan > table.table.columns
  )
    throw new Error("Cell style range exceeds table");
  const style: Data = {};
  if (f["background-color"])
    style.backgroundColor = {
      color: { rgbColor: color(f["background-color"]) },
    };
  if (f["content-align"])
    style.contentAlignment = String(f["content-align"]).toUpperCase();
  for (const side of ["top", "bottom", "left", "right"]) {
    const key = side[0].toUpperCase() + side.slice(1),
      border = f[`border-${side}`] ?? f["border-all"],
      padding = f[`padding-${side}`] ?? f["padding-all"];
    if (border) {
      const [width, c = "#000000", dashStyle = "SOLID"] =
        String(border).split(",");
      style["border" + key] = {
        width: dimension(width),
        color: { color: { rgbColor: color(c) } },
        dashStyle,
      };
    }
    if (padding !== undefined) style["padding" + key] = dimension(padding);
  }
  const requests: Data[] = [];
  if (Object.keys(style).length)
    requests.push({
      updateTableCellStyle: {
        tableRange: {
          tableCellLocation: {
            tableStartLocation: { index: table.startIndex, ...targetFields(t) },
            rowIndex: row,
            columnIndex: col,
          },
          rowSpan,
          columnSpan,
        },
        tableCellStyle: style,
        fields: mask(style),
      },
    });
  const text = textStyle(f);
  if (Object.keys(text).length) {
    if (rowSpan !== 1 || columnSpan !== 1)
      throw new Error("Text style requires exactly one cell");
    requests.push({
      updateTextStyle: {
        range: docRange(t, cell.startIndex + 1, cell.endIndex - 1),
        textStyle: text,
        fields: mask(text),
      },
    });
  }
  if (!requests.length) throw new Error("Style required");
  return docBatch(c, r, requests, t);
};
for (const axis of ["row", "column"])
  for (const op of ["insert", "delete"])
    h[`docs.table-${axis}.${op}`] = async (c, r) => {
      const f = flags(c),
        t = await loadDoc(c, r),
        table = selectedTable(t, f.table),
        isRow = axis === "row",
        count = table.table[isRow ? "rows" : "columns"];
      let n: number,
        after = false;
      if (op === "insert") {
        if (f.at === "end") {
          n = count - 1;
          after = true;
        } else if (f.at === "start") n = 0;
        else {
          const m = /^(?:(before|after):)?(\d+)$/.exec(String(f.at));
          if (!m)
            throw new Error("at must be start, end, before:N, or after:N");
          n = integer(m[2], "at", 1, count) - 1;
          after = m[1] === "after";
        }
      } else n = integer(f[isRow ? "row" : "col"], axis, 1, count) - 1;
      let rowValues: unknown[] | undefined;
      if (isRow && op === "insert" && f["values-json"] !== undefined) {
        const data = r.jsonInput(f["values-json"]);
        if (
          !Array.isArray(data) ||
          data.some((value) => value !== null && typeof value === "object") ||
          data.length > table.table.columns
        )
          throw new Error("values-json must be a scalar row fitting the table");
        rowValues = data;
      }
      const location = {
        tableStartLocation: { index: table.startIndex, ...targetFields(t) },
        rowIndex: isRow ? n : 0,
        columnIndex: isRow ? 0 : n,
      };
      const request =
        op === "insert"
          ? {
              [isRow ? "insertTableRow" : "insertTableColumn"]: {
                tableCellLocation: location,
                [isRow ? "insertBelow" : "insertRight"]: after,
              },
            }
          : {
              [isRow ? "deleteTableRow" : "deleteTableColumn"]: {
                tableCellLocation: location,
              },
            };
      const result = await docBatch(c, r, [request], t);
      if (rowValues) {
        const data = rowValues;
        const current = await loadDoc(c, r),
          target = selectedTable(current, f.table);
        const all = Array.from(
          { length: n + (after ? 1 : 0) },
          () => [] as unknown[],
        );
        all.push(data);
        await populateTable(c, r, current, target, all);
      }
      return result;
    };
for (const op of ["table-merge", "table-unmerge"])
  h[`docs.${op}`] = async (c, r) => {
    const f = flags(c),
      t = await loadDoc(c, r),
      table = selectedTable(t, f.table),
      m = /^(\d+),(\d+)(?::(\d+),(\d+))?$/.exec(f.range ?? f.cell ?? "");
    if (!m) throw new Error("Cell range must be r,c or r1,c1:r2,c2");
    const row = integer(m[1], "row", 1) - 1,
      col = integer(m[2], "col", 1) - 1,
      rowSpan = integer(m[3] ?? m[1], "end row", row + 1) - row,
      columnSpan = integer(m[4] ?? m[2], "end col", col + 1) - col;
    return docBatch(
      c,
      r,
      [
        {
          [op === "table-merge" ? "mergeTableCells" : "unmergeTableCells"]: {
            tableRange: {
              tableCellLocation: {
                tableStartLocation: {
                  index: table.startIndex,
                  ...targetFields(t),
                },
                rowIndex: row,
                columnIndex: col,
              },
              rowSpan,
              columnSpan,
            },
          },
        },
      ],
      t,
    );
  };
h["docs.table-column-width"] = async (c, r) => {
  const f = flags(c),
    t = await loadDoc(c, r),
    table = selectedTable(t, f["table-index"]);
  if (Boolean(f["evenly-distributed"]) === (f.width !== undefined))
    throw new Error("Choose width or evenly-distributed");
  return docBatch(
    c,
    r,
    [
      {
        updateTableColumnProperties: {
          tableStartLocation: { index: table.startIndex, ...targetFields(t) },
          ...(f.col !== undefined
            ? {
                columnIndices: [
                  integer(f.col, "col", 1, table.table.columns) - 1,
                ],
              }
            : {}),
          columnProperties: f["evenly-distributed"]
            ? { widthType: "EVENLY_DISTRIBUTED" }
            : { widthType: "FIXED_WIDTH", width: dimension(f.width) },
          fields: f["evenly-distributed"] ? "widthType" : "widthType,width",
        },
      },
    ],
    t,
  );
};
h["docs.table-row.pin-header"] = async (c, r) => {
  const f = flags(c),
    t = await loadDoc(c, r),
    table = selectedTable(t, f.table);
  return docBatch(
    c,
    r,
    [
      {
        pinTableHeaderRows: {
          tableStartLocation: { index: table.startIndex, ...targetFields(t) },
          pinnedHeaderRowsCount: integer(f.rows, "rows", 0, table.table.rows),
        },
      },
    ],
    t,
  );
};
h["docs.table-row.style"] = async (c, r) => {
  const f = flags(c),
    t = await loadDoc(c, r),
    table = selectedTable(t, f.table),
    style: Data = {};
  if (f["min-height"] !== undefined)
    style.minRowHeight = dimension(f["min-height"]);
  if (f["prevent-overflow"] !== undefined)
    style.preventOverflow = f["prevent-overflow"];
  if (!Object.keys(style).length) throw new Error("Row style required");
  return docBatch(
    c,
    r,
    [
      {
        updateTableRowStyle: {
          tableStartLocation: { index: table.startIndex, ...targetFields(t) },
          ...(f.row !== undefined
            ? { rowIndices: [integer(f.row, "row", 1, table.table.rows) - 1] }
            : {}),
          tableRowStyle: style,
          fields: mask(style),
        },
      },
    ],
    t,
  );
};
h["docs.insert-image"] = async (c, r) => {
  const f = flags(c),
    t = await loadDoc(c, r);
  if (Boolean(f.file) === Boolean(f.url)) throw new Error("Choose file or URL");
  let url = f.url;

  const selections = [
    f.before !== undefined,
    f.after !== undefined,
    f.at !== undefined,
  ].filter(Boolean).length;
  if (selections > 1) throw new Error("Choose before, after, or at");
  let start = endIndex(t),
    replace: Data | undefined;
  if (f.before || f.after) {
    const found = matches(t, f.before ?? f.after, { "match-case": true });
    if (found.length !== 1)
      throw new Error("Image text anchor must have one match");
    start = f.after ? found[0].endIndex : found[0].startIndex;
  } else if (f.at !== undefined && String(f.at).toLowerCase() !== "end") {
    replace = anchor(t, f);
    start = replace!.startIndex;
  }
  if (f.url && (f.parent || f.name || f["on-restricted"] === "link"))
    throw new Error(
      "parent, name and on-restricted=link require an input file",
    );
  const uploaded = f.file ? await uploadImage(r, f.file, f) : undefined;
  url = uploaded?.url ?? url;
  const parsedURL = new URL(url);
  if (
    parsedURL.protocol !== "https:" ||
    parsedURL.username ||
    parsedURL.password
  )
    throw new Error("Public HTTPS URL without credentials required");
  if (uploaded?.fallbackLink) {
    const text = f.name ?? "Image";
    return docBatch(
      c,
      r,
      [
        ...(replace ? [{ deleteContentRange: { range: replace } }] : []),
        {
          insertText: { location: { index: start, ...targetFields(t) }, text },
        },
        {
          updateTextStyle: {
            range: docRange(t, start, start + text.length),
            textStyle: { link: { url } },
            fields: "link",
          },
        },
      ],
      t,
    );
  }
  const objectSize: Data = {};
  if (f.width) objectSize.width = pt(f.width);
  if (f.height) objectSize.height = pt(f.height);
  return docBatch(
    c,
    r,
    [
      ...(replace ? [{ deleteContentRange: { range: replace } }] : []),
      {
        insertInlineImage: {
          location: { index: start, ...targetFields(t) },
          uri: url,
          ...(Object.keys(objectSize).length ? { objectSize } : {}),
        },
      },
    ],
    t,
  );
};
h["docs.replace-image"] = async (c, r) => {
  const f = flags(c),
    t = await loadDoc(c, r);
  if (Boolean(f.file) === Boolean(f.url) || (f["object-id"] && f["match-alt"]))
    throw new Error("Choose image source and exactly one image selector");
  const objectIds = f["object-id"]
    ? [f["object-id"]]
    : Object.entries(t.doc.inlineObjects ?? {})
        .filter(([, v]) => {
          const e = (v as Data).inlineObjectProperties?.embeddedObject;
          return (
            !f["match-alt"] ||
            `${e?.title ?? ""} ${e?.description ?? ""}`
              .toLowerCase()
              .includes(String(f["match-alt"]).toLowerCase())
          );
        })
        .map(([key]) => key);
  if (!objectIds.length) throw new Error("Image not found");
  if (objectIds.length > 1)
    throw new Error("Ambiguous image selector; use object-id");
  const url = f.file ? (await uploadImage(r, f.file, f)).url : f.url;
  const sourceURL = new URL(url);
  if (
    sourceURL.protocol !== "https:" ||
    sourceURL.username ||
    sourceURL.password
  )
    throw new Error("Public HTTPS image URL without credentials required");
  return docBatch(
    c,
    r,
    objectIds.map((imageObjectId) => ({
      replaceImage: {
        imageObjectId,
        uri: url,
        imageReplaceMethod: "CENTER_CROP",
        ...(t.tabId ? { tabId: t.tabId } : {}),
      },
    })),
    t,
  );
};
for (const op of ["list", "create", "delete", "replace"])
  h[`docs.named-range.${op}`] = async (c, r) => {
    const f = flags(c),
      t = await loadDoc(c, r),
      ranges = Object.values(t.doc.namedRanges ?? {}).flatMap(
        (v: any) => v.namedRanges ?? [],
      );
    if (op === "list")
      return {
        namedRanges: ranges.filter((v: Data) => !f.name || v.name === f.name),
      };
    if (op === "create") {
      if (!f.name) throw new Error("Name required");
      const range =
        f.at !== undefined
          ? anchor(t, f)
          : docRange(
              t,
              integer(f.start, "start", 1),
              integer(f.end, "end", 2, endIndex(t)),
            );
      return docBatch(c, r, [{ createNamedRange: { name: f.name, range } }], t);
    }
    const selected = ranges.filter(
      (v: Data) =>
        v.name === c.positionals[1] || v.namedRangeId === c.positionals[1],
    );
    if (!selected.length) throw new Error("Named range not found");
    if (op === "delete")
      return docBatch(
        c,
        r,
        selected.map((v: Data) => ({
          deleteNamedRange: {
            namedRangeId: v.namedRangeId,
            ...(t.tabId ? { tabsCriteria: { tabIds: [t.tabId] } } : {}),
          },
        })),
        t,
      );
    const text = textInput(f, r);
    return docBatch(
      c,
      r,
      selected.map((v: Data) => ({
        replaceNamedRangeContent: {
          namedRangeId: v.namedRangeId,
          text,
          ...(t.tabId ? { tabsCriteria: { tabIds: [t.tabId] } } : {}),
        },
      })),
      t,
    );
  };
async function commentsList(c: Command, r: Runtime, f: Data): Promise<Data> {
  let next = f.page,
    result: Data[] = [];
  const seen = new Set<string>();
  do {
    if (next && seen.has(next)) throw new Error("Repeated comment cursor");
    if (next) seen.add(next);
    const data = await r.json(
      "drive",
      `files/${id(c.positionals[0])}/comments`,
      {
        query: {
          fields: "*",
          pageSize: integer(f.max ?? 100, "max", 1, 100),
          ...(next ? { pageToken: next } : {}),
          ...(f.since ? { startModifiedTime: f.since } : {}),
        },
      },
    );
    result.push(
      ...(data.comments ?? []).filter(
        (v: Data) => f["include-resolved"] || !v.resolved,
      ),
    );
    next = data.nextPageToken;
  } while (f.all && next);
  if (!result.length && f["fail-empty"]) throw new Error("No comments");
  return { comments: result, nextPageToken: next };
}
for (const op of [
  "list",
  "get",
  "add",
  "delete",
  "reply",
  "resolve",
  "reopen",
  "locate",
  "poll",
])
  h[`docs.comments.${op}`] = async (c, r) => {
    const f = flags(c),
      base = `files/${id(c.positionals[0])}/comments`,
      item = base + "/" + segment(c.positionals[1]);
    if (op === "list") {
      const data = await commentsList(c, r, f);
      if (f.locate) {
        const t = await loadDoc(c, r);
        data.comments = data.comments.map((v: Data) => ({
          ...v,
          matches: v.quotedFileContent?.value
            ? matches(t, v.quotedFileContent.value, {
                "normalize-whitespace": true,
              })
            : [],
        }));
      }
      return data;
    }
    if (op === "get") return r.json("drive", item, { query: { fields: "*" } });
    if (op === "add")
      return r.json("drive", base, {
        method: "POST",
        query: { fields: "*" },
        body: {
          content: c.positionals[1],
          ...(f.anchor ? { anchor: f.anchor } : {}),
          ...(f.quoted
            ? { quotedFileContent: { mimeType: "text/plain", value: f.quoted } }
            : {}),
        },
      });
    if (op === "delete") return r.json("drive", item, { method: "DELETE" });
    if (["reply", "resolve", "reopen"].includes(op))
      return r.json("drive", item + "/replies", {
        method: "POST",
        query: { fields: "*" },
        body: {
          content: op === "reply" ? c.positionals[2] : (f.message ?? ""),
          ...(op === "reply"
            ? f.action
              ? { action: f.action }
              : {}
            : { action: op }),
        },
      });
    if (op === "locate") {
      const comment = await r.json("drive", item, { query: { fields: "*" } });
      return {
        comment,
        matches: comment.quotedFileContent?.value
          ? matches(await loadDoc(c, r), comment.quotedFileContent.value, f)
          : [],
      };
    }
    let state: Data = {};
    if (f["state-file"]?.startsWith("input:"))
      state = JSON.parse(r.text(f["state-file"]));
    const iterations = integer(
        f["max-iterations"] || 1,
        "max-iterations",
        1,
        50,
      ),
      all: Data[] = [];
    for (let i = 0; i < iterations; i++) {
      const watermark = new Date().toISOString();
      const result = await commentsList(c, r, {
        ...f,
        since: state.modifiedTime,
        all: true,
      });
      all.push(...result.comments);
      state.modifiedTime = watermark;
      if (i + 1 < iterations) {
        const m = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(f.interval ?? "60s");
        if (!m) throw new Error("Invalid polling interval");
        await new Promise<void>((resolve, reject) => {
          const handle = setTimeout(
            resolve,
            Number(m[1]) * ({ ms: 1, s: 1000, m: 60000 }[m[2]] ?? 1),
          );
          r.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(handle);
              reject(new Error("Polling aborted"));
            },
            { once: true },
          );
        });
      }
    }
    if (f["state-file"])
      r.output(
        String(f["state-file"]).replace(/^(input|output):/, ""),
        JSON.stringify(state),
      );
    return { comments: all, state };
  };
export const docHandlers = h;

// Table selectors are resolved from one read, then mutations run from the last
// table backwards so deleting a final row cannot renumber later targets.
for (const command of Object.keys(h).filter(
  (name) =>
    name.startsWith("docs.table-") && name !== "docs.table-column-width",
)) {
  const operation = h[command];
  h[command] = async (c, r) => {
    const f = flags(c),
      t = await loadDoc(c, r),
      all = tablesOf(t);
    const selector = String(f.table ?? "1");
    let chosen: { table: Data; index: number }[];
    if (selector === "*")
      chosen = all.map((table, index) => ({ table, index: index + 1 }));
    else if (/^-?\d+$/.test(selector)) {
      const n = Number(selector);
      if (!n) throw new Error("Table selector cannot be zero");
      const index = n > 0 ? n : all.length + n + 1;
      if (!all[index - 1]) throw new Error("Table not found");
      chosen = [{ table: all[index - 1], index }];
    } else {
      const text = selector.replace(/^text:/, "");
      chosen = all
        .map((table, index) => ({ table, index: index + 1 }))
        .filter(
          ({ table }) =>
            (table.table.tableRows?.[0]?.tableCells?.[0]?.content ?? [])
              .map(paragraphText)
              .join("")
              .trim() === text,
        );
      if (chosen.length !== 1)
        throw new Error(
          chosen.length
            ? "Table text selector is ambiguous"
            : "Table not found",
        );
    }
    if (!chosen.length) throw new Error("Table not found");
    const results = [];
    for (const selected of chosen.reverse()) {
      const next: Data = { ...f, table: String(selected.index) };
      for (const [key, size] of [
        ["row", "rows"],
        ["col", "columns"],
      ] as const)
        if (next[key] !== undefined && Number(next[key]) < 0)
          next[key] = selected.table.table[size] + Number(next[key]) + 1;
      if (next.at !== undefined && /^-\d+$/.test(String(next.at))) {
        const size = command.includes("column") ? "columns" : "rows";
        next.at = String(selected.table.table[size] + Number(next.at) + 1);
      }
      results.push(await operation({ ...c, flags: next }, r));
    }
    return results.length === 1 ? results[0] : { results };
  };
}

for (const name of ["docs.insert-image", "docs.replace-image"])
  h[name] = imageLifecycle(h[name], "docs");
