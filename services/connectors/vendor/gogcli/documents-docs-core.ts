import { RE2JS } from "re2js";
import { marked } from "marked";
import { type Command, type Data, type Runtime } from "./types";
import {
  flags,
  id,
  integer,
  mask,
  textStyle,
  color,
  pt,
} from "./documents-common";
export type Target = {
  full: Data;
  doc: Data;
  content: Data[];
  tabId?: string;
  segmentId?: string;
};
export const docRoot = (c: Command) => `documents/${id(c.positionals[0])}`;
export function tabs(doc: Data): Data[] {
  return (doc.tabs ?? []).flatMap((t: Data) => [
    t,
    ...tabs({ tabs: t.childTabs }),
  ]);
}
export function tabBy(doc: Data, value?: string): Data | undefined {
  const list = tabs(doc);
  if (!value) return list[0];
  const found = list.filter(
    (t) => t.tabProperties?.tabId === value || t.tabProperties?.title === value,
  );
  if (found.length !== 1)
    throw new Error(found.length ? "Tab title is ambiguous" : "Tab not found");
  return found[0];
}
export async function loadDoc(c: Command, r: Runtime): Promise<Target> {
  const f = flags(c),
    full = await r.json("docs", docRoot(c), {
      query: { includeTabsContent: true },
    }),
    tab = tabBy(full, f.tab),
    doc = tab?.documentTab ?? full;
  let content = doc.body?.content ?? [];
  if (f.segment) {
    const segment =
      doc.headers?.[f.segment] ??
      doc.footers?.[f.segment] ??
      doc.footnotes?.[f.segment];
    if (!segment) throw new Error("Document segment not found");
    content = segment.content ?? [];
  }
  return {
    full,
    doc,
    content,
    tabId: tab?.tabProperties?.tabId,
    segmentId: f.segment,
  };
}
export const targetFields = (t: Target): Data => ({
  ...(t.tabId ? { tabId: t.tabId } : {}),
  ...(t.segmentId ? { segmentId: t.segmentId } : {}),
});
export function docRange(t: Target, start: number, end: number): Data {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start
  )
    throw new Error("Invalid document range");
  return { startIndex: start, endIndex: end, ...targetFields(t) };
}
export function elements(content: Data[]): Data[] {
  return content.flatMap((e) => [
    e,
    ...(e.table?.tableRows ?? []).flatMap((row: Data) =>
      (row.tableCells ?? []).flatMap((cell: Data) =>
        elements(cell.content ?? []),
      ),
    ),
    ...(e.tableOfContents ? elements(e.tableOfContents.content ?? []) : []),
  ]);
}
export function paragraphs(t: Target): Data[] {
  return elements(t.content).filter((e) => e.paragraph);
}
export function tablesOf(t: Target): Data[] {
  return elements(t.content).filter((e) => e.table);
}
export function paragraphText(e: Data, chips = true): string {
  return (e.paragraph?.elements ?? [])
    .map(
      (run: Data) =>
        run.textRun?.content ??
        (chips
          ? (run.person?.personProperties?.name ??
            run.person?.personProperties?.email ??
            run.richLink?.richLinkProperties?.title ??
            run.dateElement?.dateElementProperties?.displayText ??
            "")
          : ""),
    )
    .join("");
}
export function textMap(t: Target): { text: string; indices: number[] } {
  let text = "",
    indices: number[] = [];
  for (const p of paragraphs(t))
    for (const run of p.paragraph.elements ?? []) {
      const value = run.textRun?.content ?? "";
      for (let i = 0; i < value.length; i++) {
        text += value[i];
        indices.push((run.startIndex ?? p.startIndex ?? 0) + i);
      }
    }
  return { text, indices };
}
export function endIndex(t: Target): number {
  return Math.max(
    t.segmentId ? 0 : 1,
    ...t.content.map((e) => (e.endIndex ?? 1) - 1),
  );
}
export function matches(t: Target, needle: string, f: Data = {}): Data[] {
  if (!needle) throw new Error("Search text cannot be empty");
  let { text, indices } = textMap(t);
  const boundaries: number[] = [];
  for (let i = 1; i < indices.length; i++)
    if (indices[i] !== indices[i - 1] + 1) boundaries.push(indices[i]);
  if (f["normalize-whitespace"]) {
    let normalized = "",
      map: number[] = [];
    for (let i = 0; i < text.length; i++) {
      if (/\s/.test(text[i])) {
        if (normalized.endsWith(" ")) continue;
        normalized += " ";
        map.push(indices[i]);
      } else {
        normalized += text[i];
        map.push(indices[i]);
      }
    }
    text = normalized;
    indices = map;
    needle = needle.replace(/\s+/g, " ");
  }
  const pattern = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = RE2JS.compile(
    pattern,
    f["match-case"] ? 0 : RE2JS.CASE_INSENSITIVE,
  ).matcher(text);
  const found: Data[] = [];
  while (matcher.find()) {
    const at = matcher.start(),
      last = matcher.end() - 1;
    // A Docs range cannot bridge cells, inline objects, or unrelated segments.
    if (
      boundaries.some(
        (boundary) => boundary > indices[at] && boundary <= indices[last],
      )
    )
      continue;
    found.push({
      startIndex: indices[at],
      endIndex: indices[last] + 1,
      ...targetFields(t),
    });
  }
  return found;
}
export function anchor(t: Target, f: Data): Data | undefined {
  if (f.at === undefined) return undefined;
  const found = matches(t, f.at, { "match-case": f["match-case"] });
  if (!found.length) throw new Error("Anchor not found");
  if (f.occurrence !== undefined) {
    const selected = found[integer(f.occurrence, "occurrence", 1) - 1];
    if (!selected) throw new Error("Anchor occurrence not found");
    return selected;
  }
  if (found.length > 1) throw new Error("Ambiguous anchor: specify occurrence");
  return found[0];
}
export function position(t: Target, f: Data, fallback = "start"): number {
  const selectors = [
    f.at !== undefined,
    f.index !== undefined,
    Boolean(f["at-end"]),
  ].filter(Boolean).length;
  if (selectors > 1) throw new Error("Choose at, index, or at-end");
  if (f.at !== undefined) return anchor(t, f)!.startIndex;
  if (f.index !== undefined)
    return integer(f.index, "index", t.segmentId ? 0 : 1, endIndex(t));
  return f["at-end"] || fallback === "end" ? endIndex(t) : t.segmentId ? 0 : 1;
}
export async function docBatch(
  c: Command,
  r: Runtime,
  requests: Data[],
  t?: Target,
): Promise<any> {
  if (!requests.length) return { documentId: c.positionals[0], requests: 0 };
  return r.json("docs", docRoot(c) + ":batchUpdate", {
    method: "POST",
    body: {
      requests,
      ...(t?.full.revisionId
        ? { writeControl: { requiredRevisionId: t.full.revisionId } }
        : {}),
    },
  });
}
export function dimension(value: unknown): Data {
  const m = /^\s*(\d+(?:\.\d+)?)(pt|in|cm|mm)?\s*$/i.exec(String(value));
  if (!m) throw new Error("Dimension must be nonnegative pt, in, cm, or mm");
  return pt(
    Number(m[1]) *
      ({ pt: 1, in: 72, cm: 72 / 2.54, mm: 72 / 25.4 }[
        m[2]?.toLowerCase() ?? "pt"
      ] ?? 1),
  );
}
export function layoutRequest(f: Data, t?: Target): Data | undefined {
  const style: Data = {},
    sizes: Record<string, number[]> = {
      a3: [841.89, 1190.551],
      a4: [595.275, 841.89],
      a5: [419.528, 595.275],
      letter: [612, 792],
      legal: [612, 1008],
      tabloid: [792, 1224],
    };
  if (f.layout !== undefined || f.pageless !== undefined)
    style.documentFormat = {
      documentMode: f.layout
        ? ["paged", "pages"].includes(f.layout)
          ? "PAGES"
          : "PAGELESS"
        : f.pageless
          ? "PAGELESS"
          : "PAGES",
    };
  if (f["page-size"]) {
    const size = sizes[String(f["page-size"]).toLowerCase()];
    if (!size) throw new Error("Unknown page size");
    style.pageSize = { width: pt(size[0]), height: pt(size[1]) };
  }
  for (const [flag, key] of [
    ["page-width", "width"],
    ["page-height", "height"],
  ])
    if (f[flag] !== undefined) {
      style.pageSize ??= {};
      style.pageSize[key] = dimension(f[flag]);
    }
  for (const [flag, key] of [
    ["margin-left", "marginLeft"],
    ["margin-right", "marginRight"],
    ["margin-top", "marginTop"],
    ["margin-bottom", "marginBottom"],
  ])
    if (f[flag] !== undefined) style[key] = dimension(f[flag]);
  return Object.keys(style).length
    ? {
        updateDocumentStyle: {
          documentStyle: style,
          fields: mask(style),
          ...(t?.tabId ? { tabId: t.tabId } : {}),
        },
      }
    : undefined;
}
export function formatRequests(f: Data, range: Data): Data[] {
  const requests: Data[] = [],
    style = textStyle(f);
  if (f.code) {
    style.weightedFontFamily = { fontFamily: "Courier New" };
    style.backgroundColor = { color: { rgbColor: color("#eeeeee") } };
  }
  if (f.link && f["no-link"]) throw new Error("Conflicting link flags");
  if (f.link?.startsWith("#")) style.link = { bookmarkId: f.link.slice(1) };
  if (f["no-link"]) delete style.link;
  if (Object.keys(style).length || f["no-link"])
    requests.push({
      updateTextStyle: {
        range,
        textStyle: style,
        fields: [mask(style), ...(f["no-link"] ? ["link"] : [])]
          .filter(Boolean)
          .join(","),
      },
    });
  const paragraph: Data = {};
  if (f.alignment) {
    const map: Data = {
      left: "START",
      right: "END",
      center: "CENTER",
      justify: "JUSTIFIED",
      start: "START",
      end: "END",
      justified: "JUSTIFIED",
    };
    paragraph.alignment = map[String(f.alignment).toLowerCase()];
    if (!paragraph.alignment) throw new Error("Invalid paragraph alignment");
  }
  if (f["named-style"]) paragraph.namedStyleType = f["named-style"];
  if (f["heading-level"] !== undefined) {
    if (f["named-style"])
      throw new Error("Choose heading-level or named-style");
    paragraph.namedStyleType = `HEADING_${integer(f["heading-level"], "heading-level", 1, 6)}`;
  }
  if (f["line-spacing"] !== undefined)
    paragraph.lineSpacing = Number(f["line-spacing"]);
  if (f["spacing-mode"]) paragraph.spacingMode = f["spacing-mode"];
  for (const [flag, key] of [
    ["indent-start", "indentStart"],
    ["indent-end", "indentEnd"],
    ["indent-first-line", "indentFirstLine"],
    ["space-above", "spaceAbove"],
    ["space-below", "spaceBelow"],
  ])
    if (f[flag] !== undefined) paragraph[key] = pt(f[flag]);
  for (const [flag, key] of [
    ["keep-with-next", "keepWithNext"],
    ["keep-lines-together", "avoidWidowAndOrphan"],
  ])
    if (f[flag] !== undefined) paragraph[key] = f[flag];
  if (Object.keys(paragraph).length)
    requests.push({
      updateParagraphStyle: {
        range,
        paragraphStyle: paragraph,
        fields: mask(paragraph),
      },
    });
  if (f["no-bullets"] && (f.bullets || f.ordered || f["bullet-preset"]))
    throw new Error("Conflicting bullet flags");
  if (f["no-bullets"]) requests.push({ deleteParagraphBullets: { range } });
  else if (f.bullets || f.ordered || f["bullet-preset"])
    requests.push({
      createParagraphBullets: {
        range,
        bulletPreset:
          f["bullet-preset"] ??
          (f.ordered
            ? "NUMBERED_DIGIT_ALPHA_ROMAN"
            : "BULLET_DISC_CIRCLE_SQUARE"),
      },
    });
  return requests;
}
export type MarkdownPlan = {
  text: string;
  styles: { start: number; end: number; flags: Data }[];
  specials: { at: number; kind: string; value: any }[];
  headings?: { text: string; anchor: string }[];
};
export function markdownPlan(source: string): MarkdownPlan {
  const plan: MarkdownPlan = { text: "", styles: [], specials: [] };
  const append = (s: string) => {
    plan.text += s;
  };
  const style = (start: number, f: Data) => {
    if (plan.text.length > start)
      plan.styles.push({ start, end: plan.text.length, flags: f });
  };
  const htmlStack: { tag: string; flags: Data }[] = [];
  const htmlFlags = (tag: string, raw: string): Data => {
    const f: Data = {};
    const names: Data = {
      b: "bold",
      strong: "bold",
      i: "italic",
      em: "italic",
      u: "underline",
      s: "strikethrough",
      del: "strikethrough",
      code: "code",
    };
    if (names[tag]) f[names[tag]] = true;
    const attributes: Data = {};
    for (const match of raw.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
      attributes[match[1].toLowerCase()] = match[2] ?? match[3];
    if (tag === "a" && attributes.href) f.link = attributes.href;
    for (const declaration of (attributes.style ?? "").split(";")) {
      const [key, ...values] = declaration.split(":"),
        value = values.join(":").trim();
      if (!value) continue;
      if (key.trim() === "color") f["text-color"] = value;
      else if (key.trim() === "background-color") f["bg-color"] = value;
      else if (key.trim() === "font-family")
        f["font-family"] = value.replace(/['"]/g, "");
      else if (
        key.trim() === "font-weight" &&
        (value === "bold" || Number(value) >= 600)
      )
        f.bold = true;
      else if (key.trim() === "font-style" && value === "italic")
        f.italic = true;
      else if (key.trim() === "text-decoration" && value.includes("underline"))
        f.underline = true;
    }
    return f;
  };
  const inline = (tokens: Data[], inherited: Data = {}) => {
    for (const token of tokens) {
      const start = plan.text.length;
      const active = {
        ...inherited,
        ...Object.assign({}, ...htmlStack.map((item) => item.flags)),
      };
      switch (token.type) {
        case "strong":
          inline(token.tokens ?? [], { ...active, bold: true });
          break;
        case "em":
          inline(token.tokens ?? [], { ...active, italic: true });
          break;
        case "del":
          inline(token.tokens ?? [], { ...active, strikethrough: true });
          break;
        case "codespan":
          append(token.text);
          style(start, { ...active, code: true });
          break;
        case "link":
          inline(token.tokens ?? [], { ...active, link: token.href });
          break;
        case "image":
          plan.specials.push({
            at: start,
            kind: "image",
            value: { url: token.href, alt: token.text },
          });
          append("\ufffc");
          break;
        case "br":
          append("\n");
          break;
        case "html": {
          const text = token.text ?? token.raw ?? "";
          if (/^<br\s*\/?\s*>$/i.test(text)) append("\n");
          else {
            const tag = /^<(\/?)([a-z][a-z0-9]*)\b[^>]*>$/i.exec(text.trim());
            if (tag) {
              if (tag[1]) {
                let last = -1;
                for (let i = htmlStack.length - 1; i >= 0; i--)
                  if (htmlStack[i].tag === tag[2].toLowerCase()) {
                    last = i;
                    break;
                  }
                if (last >= 0) htmlStack.splice(last);
              } else
                htmlStack.push({
                  tag: tag[2].toLowerCase(),
                  flags: htmlFlags(tag[2].toLowerCase(), text),
                });
            } else append(text.replace(/<[^>]*>/g, ""));
          }
          break;
        }
        default:
          if (token.tokens) inline(token.tokens, active);
          else append(token.text ?? token.raw ?? "");
      }
      if (Object.keys(active).length && plan.text.length > start)
        style(start, active);
    }
  };
  const block = (tokens: Data[], depth = 0) => {
    for (const token of tokens) {
      const start = plan.text.length;
      switch (token.type) {
        case "space":
          break;
        case "heading": {
          const anchor = /\s+\{#([^}\s]+)\}\s*$/.exec(token.text ?? "");
          inline(
            anchor
              ? (marked.Lexer.lexInline(
                  token.text.slice(0, anchor.index),
                ) as Data[])
              : (token.tokens ?? []),
          );
          if (anchor)
            (plan.headings ??= []).push({
              text: plan.text.slice(start),
              anchor: anchor[1],
            });
          append("\n");
          style(start, { "heading-level": token.depth });
          break;
        }
        case "paragraph":
        case "text":
          inline(token.tokens ?? [token]);
          if (!plan.text.endsWith("\n")) append("\n");
          break;
        case "list":
          for (const item of token.items) {
            const begin = plan.text.length;
            append("\t".repeat(depth));
            block(item.tokens ?? [], depth + 1);
            const lineEnd = plan.text.indexOf("\n", begin) + 1;
            plan.styles.push({
              start: begin,
              end: lineEnd,
              flags: item.task
                ? {
                    "bullet-preset": "BULLET_CHECKBOX",
                    ...(item.checked ? { strikethrough: true } : {}),
                  }
                : token.ordered
                  ? { ordered: true }
                  : { bullets: true },
            });
          }
          break;
        case "blockquote":
          block(token.tokens ?? [], depth);
          style(start, { "indent-start": 36, italic: true });
          break;
        case "code":
          append(token.text + "\n");
          style(start, { code: true });
          break;
        case "hr":
          append("\n");
          plan.specials.push({ at: start, kind: "hr", value: null });
          break;
        case "table":
          plan.specials.push({
            at: start,
            kind: "table",
            value: [
              token.header.map((v: Data) => v.text),
              ...token.rows.map((row: Data[]) => row.map((v) => v.text)),
            ],
          });
          append("\ufffc\n");
          break;
        case "html":
          inline(
            marked.Lexer.lexInline(
              String(token.text ?? token.raw)
                .replace(/<br\s*\/?\s*>/gi, "\n")
                .replace(/<\/(?:p|div|li|h[1-6])>/gi, "\n"),
            ) as Data[],
          );
          if (!plan.text.endsWith("\n")) append("\n");
          break;
        default:
          inline([token]);
          if (!plan.text.endsWith("\n")) append("\n");
      }
    }
  };
  block(marked.lexer(source) as Data[]);
  return plan;
}
export function selectedTable(t: Target, value = 1): Data {
  const all = tablesOf(t),
    n = Number(value);
  if (!Number.isInteger(n) || n === 0)
    throw new Error("Table index must be nonzero");
  const table = all[n > 0 ? n - 1 : all.length + n];
  if (!table) throw new Error("Table not found");
  return table;
}
export function selectedCell(table: Data, row: unknown, col: unknown): Data {
  const ri = integer(row, "row", 1) - 1,
    ci = integer(col, "col", 1) - 1;
  const cell = table.table.tableRows?.[ri]?.tableCells?.[ci];
  if (!cell) throw new Error("Table cell not found");
  return cell;
}
export async function populateTable(
  c: Command,
  r: Runtime,
  t: Target,
  table: Data,
  values: unknown[][],
  markdown = false,
): Promise<any> {
  const cells: {
    index: number;
    text: string;
    styles: MarkdownPlan["styles"];
  }[] = [];
  for (let row = 0; row < values.length; row++)
    for (let col = 0; col < values[row].length; col++) {
      const raw = String(values[row][col] ?? "");
      if (!raw) continue;
      const cell = selectedCell(table, row + 1, col + 1),
        p = (cell.content ?? []).find((e: Data) => e.paragraph);
      if (!p) throw new Error("Table cell has no editable paragraph");
      const plan = markdown
        ? markdownPlan(raw)
        : { text: raw, styles: [], specials: [] };
      if (plan.specials.length)
        throw new Error(
          "Use the image/table commands to insert structural objects within table cells",
        );
      cells.push({
        index: p.startIndex,
        text: markdown ? plan.text.replace(/\n$/, "") : plan.text,
        styles: plan.styles,
      });
    }
  const inserts: Data[] = [];
  for (const cell of cells.sort((a, b) => b.index - a.index)) {
    if (!cell.text) continue;
    inserts.push({
      insertText: {
        location: { index: cell.index, ...targetFields(t) },
        text: cell.text,
      },
    });
    for (const style of cell.styles)
      if (style.end > style.start)
        inserts.push(
          ...formatRequests(
            style.flags,
            docRange(
              t,
              cell.index + style.start,
              cell.index + Math.min(style.end, cell.text.length),
            ),
          ),
        );
  }
  return docBatch(c, r, inserts, t);
}
export async function insertMarkdown(
  c: Command,
  r: Runtime,
  t: Target,
  start: number,
  source: string,
  extra: Data[] = [],
  format: Data = {},
): Promise<any> {
  const plan = markdownPlan(source),
    requests = [...extra];
  if (plan.text)
    requests.push({
      insertText: {
        location: { index: start, ...targetFields(t) },
        text: plan.text,
      },
    });
  // Validate every external image before any mutation, including the base text.
  for (const special of plan.specials)
    if (
      special.kind === "image" &&
      new URL(special.value.url).protocol !== "https:"
    )
      throw new Error("HTTPS image URL required");
  const bulletStyles: typeof plan.styles = [];
  for (const s of plan.styles) {
    const regular = { ...s.flags };
    if (regular.bullets || regular.ordered || regular["bullet-preset"]) {
      bulletStyles.push(s);
      delete regular.bullets;
      delete regular.ordered;
      delete regular["bullet-preset"];
    }
    requests.push(
      ...formatRequests(regular, docRange(t, start + s.start, start + s.end)),
    );
  }
  if (plan.text && Object.keys(format).length)
    requests.push(
      ...formatRequests(format, docRange(t, start, start + plan.text.length)),
    );
  const removed: number[] = [];
  for (const s of bulletStyles.sort((a, b) => b.start - a.start)) {
    requests.push(
      ...formatRequests(
        {
          bullets: s.flags.bullets,
          ordered: s.flags.ordered,
          "bullet-preset": s.flags["bullet-preset"],
        },
        docRange(t, start + s.start, start + s.end),
      ),
    );
    for (let i = s.start; plan.text[i] === "\t"; i++) removed.push(i);
  }
  const result = await docBatch(c, r, requests, t);
  for (const special of plan.specials.sort((a, b) => b.at - a.at)) {
    const current = await loadDoc(c, r),
      at =
        start +
        special.at -
        removed.filter((index) => index < special.at).length;
    if (special.kind === "image") {
      if (new URL(special.value.url).protocol !== "https:")
        throw new Error("HTTPS image URL required");
      await docBatch(
        c,
        r,
        [
          { deleteContentRange: { range: docRange(current, at, at + 1) } },
          {
            insertInlineImage: {
              location: { index: at, ...targetFields(current) },
              uri: special.value.url,
            },
          },
        ],
        current,
      );
    } else if (special.kind === "hr")
      await docBatch(
        c,
        r,
        [
          {
            updateParagraphStyle: {
              range: docRange(current, at, at + 1),
              paragraphStyle: {
                borderBottom: {
                  color: { color: { rgbColor: color("#999999") } },
                  width: pt(1),
                  padding: pt(0),
                  dashStyle: "SOLID",
                },
              },
              fields: "borderBottom",
            },
          },
        ],
        current,
      );
    else {
      const data = special.value as unknown[][];
      await docBatch(
        c,
        r,
        [
          { deleteContentRange: { range: docRange(current, at, at + 1) } },
          {
            insertTable: {
              rows: data.length,
              columns: Math.max(...data.map((row) => row.length)),
              location: { index: at, ...targetFields(current) },
            },
          },
        ],
        current,
      );
      const updated = await loadDoc(c, r),
        table = tablesOf(updated).find((e) => e.startIndex === at + 1);
      if (!table) throw new Error("Created Markdown table not found");
      await populateTable(c, r, updated, table, data, true);
    }
  }
  if (
    plan.styles.some((style) => String(style.flags.link ?? "").startsWith("#"))
  ) {
    const current = await loadDoc(c, r),
      removedCount = extra.reduce(
        (sum, request) =>
          sum +
          (request.deleteContentRange
            ? request.deleteContentRange.range.endIndex -
              request.deleteContentRange.range.startIndex
            : 0),
        0,
      ),
      insertedEnd = start + endIndex(current) - endIndex(t) + removedCount;
    const headings = new Map<string, string>();
    const slug = (value: string) =>
      value
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, "")
        .replace(/\s+/g, "-");
    for (const p of paragraphs(current)) {
      const headingId = p.paragraph.paragraphStyle?.headingId;
      if (!headingId) continue;
      const text = paragraphText(p).trim();
      if (!headings.has(slug(text))) headings.set(slug(text), headingId);
      for (const anchor of plan.headings ?? [])
        if (anchor.text.trim() === text && !headings.has(anchor.anchor))
          headings.set(anchor.anchor, headingId);
    }
    const requests: Data[] = [];
    for (const p of paragraphs(current))
      for (const run of p.paragraph.elements ?? []) {
        if (run.startIndex < start || run.startIndex >= insertedEnd) continue;
        const url = run.textRun?.textStyle?.link?.url;
        if (
          typeof url !== "string" ||
          !url.startsWith("#") ||
          url.startsWith("#heading=")
        )
          continue;
        const headingId = headings.get(url.slice(1));
        if (!headingId) continue;
        requests.push({
          updateTextStyle: {
            range: docRange(current, run.startIndex, run.endIndex),
            textStyle: {
              link: current.tabId
                ? { heading: { id: headingId, tabId: current.tabId } }
                : { headingId },
            },
            fields: "link",
          },
        });
      }
    if (requests.length) await docBatch(c, r, requests, current);
  }
  return result;
}
