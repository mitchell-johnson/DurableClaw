import { RE2JS } from "re2js";
import type { Command, Data, Runtime, Handler } from "./types";
import { flags, integer, color, pt } from "./documents-common";
import {
  loadDoc,
  paragraphs,
  paragraphText,
  textMap,
  endIndex,
  docRange,
  docBatch,
  targetFields,
  tablesOf,
  selectedCell,
  insertMarkdown,
  formatRequests,
  type Target,
} from "./documents-docs-core";

export type SedExpression = {
  address?: string;
  command: string;
  pattern: string;
  replacement: string;
  global: boolean;
  ignoreCase: boolean;
  multiline: boolean;
  nth?: number;
};
export function parseSed(source: string): SedExpression {
  const match = /^(?:(\d+|\$)(?:,(\d+|\$))?)?([sdaiy])([\s\S]*)$/.exec(
    source.trim(),
  );
  if (!match) throw new Error("Invalid sed expression");
  const address = match[1]
      ? [match[1], match[2]].filter(Boolean).join(",")
      : undefined,
    command = match[3],
    tail = match[4];
  if (!tail && command === "d" && address)
    return {
      address,
      command,
      pattern: "",
      replacement: "",
      global: true,
      ignoreCase: false,
      multiline: false,
    };
  const delimiter = tail[0];
  if (!delimiter || /[\w\s\\]/.test(delimiter))
    throw new Error("Sed delimiter must be punctuation");
  const fields: string[] = [];
  let value = "",
    escaped = false,
    at = 1;
  for (; at < tail.length; at++) {
    const ch = tail[at];
    if (escaped) {
      value += ch === delimiter ? ch : "\\" + ch;
      escaped = false;
    } else if (ch === "\\") escaped = true;
    else if (ch === delimiter) {
      fields.push(value);
      value = "";
      if (
        fields.length ===
        (command === "d" || (address && ["a", "i"].includes(command)) ? 1 : 2)
      ) {
        at++;
        break;
      }
    } else value += ch;
  }
  if (
    fields.length !==
    (command === "d" || (address && ["a", "i"].includes(command)) ? 1 : 2)
  )
    throw new Error("Unterminated sed expression");
  const suffix = tail.slice(at);
  if (!/^[gim\d]*$/.test(suffix)) throw new Error("Invalid sed flags");
  const nth = suffix.match(/\d+/)?.[0];
  return {
    address,
    command,
    pattern: address && ["a", "i"].includes(command) ? "" : fields[0],
    replacement:
      address && ["a", "i"].includes(command) ? fields[0] : (fields[1] ?? ""),
    global: suffix.includes("g"),
    ignoreCase: suffix.includes("i"),
    multiline: suffix.includes("m"),
    ...(nth ? { nth: integer(nth, "match number", 1) } : {}),
  };
}
function scopedParagraphs(t: Target, address?: string): Data[] {
  const list = paragraphs(t);
  if (!address) return list;
  const pair = address.split(","),
    index = (value: string) =>
      value === "$" ? list.length : integer(value, "paragraph", 1, list.length),
    start = index(pair[0]),
    end = index(pair[1] ?? pair[0]);
  if (end < start) throw new Error("Reversed paragraph address");
  return list.slice(start - 1, end);
}
function replacement(
  source: string,
  match: readonly (string | null)[],
): string {
  return source
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r")
    .replace(/\\([0-9]+)|\$\{(\d+)\}|\$(\d+)|(?<!\\)&/g, (_, a, b, c) =>
      a || b || c ? (match[Number(a ?? b ?? c)] ?? "") : (match[0] ?? ""),
    )
    .replace(/\\&/g, "&")
    .replace(/\$\$/g, "$");
}
export function braceReplacement(source: string): {
  text: string;
  styles: Data;
  extra: Data;
  structural?: Data;
} {
  const styles: Data = {},
    extra: Data = {};
  let structural: Data | undefined;
  const text = source.replace(/\{([^{}]+)\}/g, (all, body) => {
    const previousStyles = { ...styles },
      previousExtra = { ...extra },
      previousStructural = structural;
    const atoms = body.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    let recognized = false;
    for (const atom of atoms) {
      const at = atom.indexOf("="),
        key = at < 0 ? atom : atom.slice(0, at),
        value =
          at < 0
            ? ""
            : atom
                .slice(at + 1)
                .replace(/^['"]|['"]$/g, "")
                .replaceAll("+", " "),
        neg = key.startsWith("!"),
        k = neg ? key.slice(1) : key;
      const bools: Data = {
        b: "bold",
        bold: "bold",
        i: "italic",
        italic: "italic",
        _: "underline",
        underline: "underline",
        "-": "strikethrough",
        strike: "strikethrough",
      };
      if (bools[k]) {
        styles[(neg ? "no-" : "") + bools[k]] = true;
        recognized = true;
        continue;
      }
      switch (k) {
        case "#":
        case "code":
          styles.code = !neg;
          break;
        case "^":
        case "sup":
          extra.baselineOffset = neg ? "NORMAL" : "SUPERSCRIPT";
          break;
        case ",":
        case "sub":
          extra.baselineOffset = neg ? "NORMAL" : "SUBSCRIPT";
          break;
        case "w":
        case "smallcaps":
          extra.smallCaps = !neg;
          break;
        case "0":
          if (neg) extra.noReset = true;
          else extra.clear = true;
          break;
        case "c":
        case "color":
          styles["text-color"] = value;
          break;
        case "z":
        case "bg":
          styles["bg-color"] = value;
          break;
        case "f":
        case "font":
          styles["font-family"] = value;
          break;
        case "s":
        case "size":
          styles["font-size"] = Number(value);
          break;
        case "u":
        case "url":
          styles.link = value;
          break;
        case "h":
        case "heading":
          if (value === "t") styles["named-style"] = "TITLE";
          else if (value === "s") styles["named-style"] = "SUBTITLE";
          else styles["heading-level"] = integer(value, "heading", 1, 6);
          break;
        case "a":
        case "align":
          styles.alignment = value;
          break;
        case "l":
        case "leading":
          styles["line-spacing"] = Number(value);
          break;
        case "n":
        case "indent":
          styles["indent-start"] = Number(value);
          break;
        case "p":
        case "spacing": {
          const pair = value.split(",");
          styles["space-above"] = Number(pair[0]);
          styles["space-below"] = Number(pair[1] ?? pair[0]);
          break;
        }
        case "check":
          styles["bullet-preset"] = "BULLET_CHECKBOX";
          break;
        case "cols":
          structural = {
            kind: "columns",
            value: integer(value || 1, "columns", 1, 3),
          };
          break;
        case "toc":
          throw new Error(
            "Google Docs cannot create a table of contents through its API",
          );
        case "+":
          structural = { kind: "break", value: value || "p" };
          break;
        case "T":
          structural = { kind: "table", value };
          break;
        case "img":
          structural = { ...structural, kind: "image", url: value };
          break;
        case "x":
        case "width":
          structural = { ...structural, width: Number(value) };
          break;
        case "y":
        case "height":
          structural = { ...structural, height: Number(value) };
          break;
        case "@":
          structural = { kind: "bookmark", value };
          break;
        case "o":
        case "opacity":
        case "k":
        case "kerning":
        case "e":
        case "effect":
          throw new Error(
            `${k} is not exposed by the Google Docs text style API`,
          );
        default:
          for (const key of Object.keys(styles)) delete styles[key];
          Object.assign(styles, previousStyles);
          for (const key of Object.keys(extra)) delete extra[key];
          Object.assign(extra, previousExtra);
          structural = previousStructural;
          return all;
      }
      recognized = true;
    }
    return recognized ? "" : all;
  });
  return { text, styles, extra, structural };
}
type BraceResult = ReturnType<typeof braceReplacement>;
function positionedBraces(
  source: string,
  original: string,
): {
  parsed: BraceResult;
  spans: { start: number; end: number; parsed: BraceResult }[];
  hasGlobal: boolean;
  formatOnly: boolean;
} {
  let text = "",
    cursor = 0;
  const globals: string[] = [],
    spans: { start: number; end: number; parsed: BraceResult }[] = [];
  for (const match of source.matchAll(/(?<!\\)\{([^{}]+)\}/g)) {
    text += source.slice(cursor, match.index);
    cursor = match.index! + match[0].length;
    const atoms = match[1].match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    const inline: { text: string; flags: string }[] = [];
    let explicit: string | undefined;
    const flags: string[] = [];
    for (const atom of atoms) {
      const at = atom.indexOf("="),
        key = at < 0 ? atom : atom.slice(0, at),
        raw =
          at < 0
            ? ""
            : atom
                .slice(at + 1)
                .replace(/^['"]|['"]$/g, "")
                .replaceAll("+", " ");
      if (
        at >= 0 &&
        /^(b|bold|i|italic|_|underline|-|strike|#|code|\^|sup|,|sub|w|smallcaps)$/.test(
          key,
        )
      )
        inline.push({ text: raw, flags: key });
      else if (key === "t" || key === "text") explicit = raw;
      else flags.push(atom);
    }
    if (inline.length) {
      for (const item of inline) {
        const start = text.length;
        text += item.text;
        spans.push({
          start,
          end: text.length,
          parsed: braceReplacement("{" + item.flags + "}"),
        });
      }
    } else if (explicit !== undefined) {
      const start = text.length;
      text += explicit;
      spans.push({
        start,
        end: text.length,
        parsed: braceReplacement("{" + flags.join(" ") + "}"),
      });
    } else {
      const parsed = braceReplacement(match[0]);
      if (parsed.text === match[0]) text += match[0];
      else globals.push(match[0]);
    }
  }
  text += source.slice(cursor);
  text = text.replace(/\\([{}])/g, "$1");
  const parsed = braceReplacement(globals.join("")),
    formatOnly =
      !text &&
      globals.length > 0 &&
      (!parsed.structural ||
        ["columns", "bookmark"].includes(parsed.structural.kind));
  if (formatOnly) text = original;
  parsed.text = text;
  return { parsed, spans, hasGlobal: globals.length > 0, formatOnly };
}
async function applyReplacement(
  c: Command,
  r: Runtime,
  t: Target,
  start: number,
  end: number,
  value: string,
): Promise<void> {
  const mapped = textMap(t),
    original = mapped.text
      .split("")
      .filter((_, i) => mapped.indices[i] >= start && mapped.indices[i] < end)
      .join("");
  const positioned = positionedBraces(value, original),
    parsed = positioned.parsed,
    range = end > start ? docRange(t, start, end) : undefined,
    requests: Data[] =
      range && !positioned.formatOnly
        ? [{ deleteContentRange: { range } }]
        : [];
  if (parsed.structural?.kind === "table") {
    const m = /^(?:create:)?(\d+)x(\d+)(:header)?$/.exec(
      parsed.structural.value,
    );
    if (!m) throw new Error("Table spec must be rowsxcols");
    requests.push({
      insertTable: {
        rows: integer(m[1], "rows", 1),
        columns: integer(m[2], "cols", 1),
        location: { index: start, ...targetFields(t) },
      },
    });
    await docBatch(c, r, requests, t);
    if (m[3]) {
      const updated = await loadDoc(c, r),
        table = tablesOf(updated).find((e) => e.startIndex === start + 1);
      if (table)
        await docBatch(
          c,
          r,
          [
            {
              pinTableHeaderRows: {
                tableStartLocation: {
                  index: table.startIndex,
                  ...targetFields(updated),
                },
                pinnedHeaderRowsCount: 1,
              },
            },
          ],
          updated,
        );
    }
    return;
  }
  if (parsed.structural?.kind === "image") {
    const s = parsed.structural;
    if (!s.url || new URL(s.url).protocol !== "https:")
      throw new Error("Image URL must be HTTPS");
    requests.push({
      insertInlineImage: {
        location: { index: start, ...targetFields(t) },
        uri: s.url,
        ...(s.width || s.height
          ? {
              objectSize: {
                ...(s.width ? { width: pt(s.width * 0.75) } : {}),
                ...(s.height ? { height: pt(s.height * 0.75) } : {}),
              },
            }
          : {}),
      },
    });
    await docBatch(c, r, requests, t);
    return;
  }
  if (parsed.structural?.kind === "break") {
    const kind = parsed.structural.value;
    if (!["p", "s", "c"].includes(kind)) throw new Error("Unknown break type");
    requests.push(
      kind === "s"
        ? {
            insertSectionBreak: {
              location: { index: start, ...targetFields(t) },
              sectionType: "NEXT_PAGE",
            },
          }
        : kind === "c"
          ? {
              insertText: {
                location: { index: start, ...targetFields(t) },
                text: "\u000b",
              },
            }
          : {
              insertPageBreak: {
                location: { index: start, ...targetFields(t) },
              },
            },
    );
    await docBatch(c, r, requests, t);
    return;
  }
  const markdown =
    /^(?:#{1,6}\s|\s*(?:[-*]\s|\d+\.\s)|>|\|)|\*|~~|`|!\[|\]\(/.test(
      parsed.text,
    );
  if (
    markdown &&
    !Object.keys(parsed.extra).length &&
    !positioned.spans.length &&
    !parsed.structural
  ) {
    await insertMarkdown(c, r, t, start, parsed.text, requests, parsed.styles);
    return;
  }
  if (parsed.text && !positioned.formatOnly)
    requests.push({
      insertText: {
        location: { index: start, ...targetFields(t) },
        text: parsed.text,
      },
    });
  const applyStyle = (
    parsed: BraceResult,
    from: number,
    to: number,
    reset: boolean,
  ) => {
    if (to <= from) return;
    const styled = docRange(t, from, to);
    if (reset && !parsed.extra.noReset)
      requests.push({
        updateTextStyle: {
          range: styled,
          textStyle: {},
          fields:
            "bold,italic,underline,strikethrough,smallCaps,baselineOffset,foregroundColor,backgroundColor,fontSize,weightedFontFamily,link",
        },
      });
    const styleFlags = { ...parsed.styles };
    if (String(styleFlags.link ?? "").startsWith("#")) {
      requests.push({
        updateTextStyle: {
          range: styled,
          textStyle: { link: { bookmarkId: styleFlags.link.slice(1) } },
          fields: "link",
        },
      });
      delete styleFlags.link;
    }
    requests.push(...formatRequests(styleFlags, styled));
    const extra = { ...parsed.extra };
    delete extra.clear;
    delete extra.noReset;
    if (Object.keys(extra).length)
      requests.push({
        updateTextStyle: {
          range: styled,
          textStyle: extra,
          fields: Object.keys(extra).join(","),
        },
      });
  };
  if (parsed.text)
    applyStyle(parsed, start, start + parsed.text.length, positioned.hasGlobal);
  for (const span of positioned.spans)
    applyStyle(span.parsed, start + span.start, start + span.end, true);
  if (parsed.structural?.kind === "bookmark")
    requests.push({
      createNamedRange: {
        name: parsed.structural.value,
        range: docRange(t, start, start + Math.max(parsed.text.length, 1)),
      },
    });
  if (parsed.structural?.kind === "columns")
    requests.push({
      updateSectionStyle: {
        range: docRange(t, start, start + Math.max(parsed.text.length, 1)),
        sectionStyle: {
          columnProperties: Array.from(
            { length: parsed.structural.value },
            () => ({ paddingEnd: pt(36) }),
          ),
          columnSeparatorStyle: "NONE",
        },
        fields: "columnProperties,columnSeparatorStyle",
      },
    });
  await docBatch(c, r, requests, t);
}
async function tableOperation(
  c: Command,
  r: Runtime,
  t: Target,
  expr: SedExpression,
): Promise<boolean> {
  const match = /^\|(-?\d+|\*)\|(?:\[([^\]]+)\])?$/.exec(expr.pattern);
  if (!match) return false;
  const all = tablesOf(t),
    index = Number(match[1]),
    selected =
      match[1] === "*"
        ? all
        : [all[index > 0 ? index - 1 : all.length + index]];
  if (selected.some((v) => !v)) throw new Error("Table not found");
  for (const selectedTable of selected.reverse()) {
    t = await loadDoc(c, r);
    // Earlier mutations may have removed a nested table and changed this
    // enclosing table's end index. The verified revision lineage alone does
    // not make those old bounds current.
    const table = tablesOf(t).find(
      (candidate) => candidate.startIndex === selectedTable.startIndex,
    );
    if (!table) throw new Error("Selected table changed during this command");
    if (!match[2]) {
      if (expr.replacement)
        throw new Error("Whole table substitution requires empty replacement");
      await docBatch(
        c,
        r,
        [
          {
            deleteContentRange: {
              range: docRange(t, table.startIndex, table.endIndex),
            },
          },
        ],
        t,
      );
      continue;
    }
    const coords = match[2];
    if (/^(\+\d+,0|0,\+\d+)$/.test(coords)) {
      const row = coords.startsWith("+"),
        count = Number(coords.match(/\+(\d+)/)![1]);
      for (let n = 0; n < count; n++) {
        const current = await loadDoc(c, r),
          target = tablesOf(current).find(
            (e) => e.startIndex === table.startIndex,
          )!;
        await docBatch(
          c,
          r,
          [
            {
              [row ? "insertTableRow" : "insertTableColumn"]: {
                tableCellLocation: {
                  tableStartLocation: {
                    index: target.startIndex,
                    ...targetFields(current),
                  },
                  rowIndex: row ? target.table.rows - 1 : 0,
                  columnIndex: row ? 0 : target.table.columns - 1,
                },
                [row ? "insertBelow" : "insertRight"]: true,
              },
            },
          ],
          current,
        );
      }
      continue;
    }
    const bounds = /^(\d+|\*),(\d+|\*)(?::(\d+),(\d+))?$/.exec(coords);
    if (!bounds) throw new Error("Invalid table cell address");
    const rows =
        bounds[1] === "*"
          ? Array.from({ length: table.table.rows }, (_, i) => i + 1)
          : [Number(bounds[1])],
      cols =
        bounds[2] === "*"
          ? Array.from({ length: table.table.columns }, (_, i) => i + 1)
          : [Number(bounds[2])];
    if (bounds[3] || expr.replacement === "split") {
      const row = rows[0] - 1,
        col = cols[0] - 1;
      await docBatch(
        c,
        r,
        [
          {
            [expr.replacement === "split"
              ? "unmergeTableCells"
              : "mergeTableCells"]: {
              tableRange: {
                tableCellLocation: {
                  tableStartLocation: {
                    index: table.startIndex,
                    ...targetFields(t),
                  },
                  rowIndex: row,
                  columnIndex: col,
                },
                rowSpan: Number(bounds[3] ?? rows[0]) - row,
                columnSpan: Number(bounds[4] ?? cols[0]) - col,
              },
            },
          },
        ],
        t,
      );
      continue;
    }
    const selectedCells = rows
      .flatMap((row) => cols.map((col) => selectedCell(table, row, col)))
      .sort((a, b) => b.startIndex - a.startIndex);
    for (const cell of selectedCells) {
      const current = await loadDoc(c, r),
        start = cell.content?.[0]?.startIndex ?? cell.startIndex + 1,
        end = cell.endIndex - 1,
        text = (cell.content ?? [])
          .map(paragraphText)
          .join("")
          .replace(/\n$/, "");
      const fake = [text] as unknown as RegExpExecArray;
      await applyReplacement(
        c,
        r,
        current,
        start,
        end,
        replacement(expr.replacement, fake),
      );
    }
  }
  return true;
}
async function imageOperation(
  c: Command,
  r: Runtime,
  t: Target,
  expr: SedExpression,
): Promise<boolean> {
  const m = /^!(?:\((-?\d+|\*)\)|\[([^\]]+)\])$/.exec(expr.pattern);
  if (!m) return false;
  const refs = paragraphs(t).flatMap((p) =>
    (p.paragraph.elements ?? [])
      .filter((e: Data) => e.inlineObjectElement)
      .map((e: Data) => ({
        id: e.inlineObjectElement.inlineObjectId,
        start: e.startIndex,
        end: e.endIndex,
        object: t.doc.inlineObjects?.[e.inlineObjectElement.inlineObjectId],
      })),
  );
  let selected: Data[];
  if (m[2])
    selected = refs.filter(
      (v) =>
        v.object?.inlineObjectProperties?.embeddedObject?.title === m[2] ||
        v.object?.inlineObjectProperties?.embeddedObject?.description === m[2],
    );
  else if (m[1] === "*") selected = refs;
  else {
    const n = Number(m[1]);
    selected = [refs[n > 0 ? n - 1 : refs.length + n]].filter(Boolean);
  }
  if (!selected.length) throw new Error("Image not found");
  const uri = /^!\(([\s\S]+)\)$/.exec(expr.replacement)?.[1];
  if (expr.replacement && !uri)
    throw new Error("Image replacement must be !(https://URL)");
  await docBatch(
    c,
    r,
    selected.reverse().map((v) =>
      uri
        ? {
            replaceImage: {
              imageObjectId: v.id,
              uri,
              imageReplaceMethod: "CENTER_CROP",
              ...(t.tabId ? { tabId: t.tabId } : {}),
            },
          }
        : { deleteContentRange: { range: docRange(t, v.start, v.end) } },
    ),
    t,
  );
  return true;
}
export const sedHandler: Handler = async (c, r) => {
  const f = flags(c),
    sources = [
      ...(c.positionals[1] ? [c.positionals[1]] : []),
      ...(f.expressions ?? []),
      ...(f.file
        ? r
            .text(f.file)
            .split("\n")
            .map((s) => s.trim())
            .filter((s) => s && !s.startsWith("#"))
        : []),
    ];
  if (!sources.length) throw new Error("Sed expression required");
  const expressions = sources.map(parseSed);
  let applied = 0;
  for (const expr of expressions) {
    const t = await loadDoc(c, r);
    if (
      (await tableOperation(c, r, t, expr)) ||
      (await imageOperation(c, r, t, expr))
    ) {
      applied++;
      continue;
    }
    const addressed = scopedParagraphs(t, expr.address),
      scope: Target = { ...t, content: addressed };
    if (
      expr.command === "d" ||
      (expr.address && ["a", "i"].includes(expr.command))
    ) {
      const re = expr.pattern
        ? RE2JS.compile(
            expr.pattern,
            expr.ignoreCase ? RE2JS.CASE_INSENSITIVE : 0,
          )
        : undefined;
      for (const p of addressed
        .filter((p) => !re || re.matcher(paragraphText(p)).find())
        .reverse()) {
        const current = await loadDoc(c, r);
        if (expr.command === "d")
          await docBatch(
            c,
            r,
            [
              {
                deleteContentRange: {
                  range: docRange(
                    current,
                    p.startIndex,
                    Math.min(p.endIndex, endIndex(current)),
                  ),
                },
              },
            ],
            current,
          );
        else {
          const at =
            expr.command === "a"
              ? Math.min(p.endIndex, endIndex(current))
              : p.startIndex;
          await applyReplacement(
            c,
            r,
            current,
            at,
            at,
            expr.replacement.replaceAll("\\n", "\n"),
          );
        }
        applied++;
      }
      continue;
    }
    const mapped = textMap(scope);
    if (expr.command === "y") {
      const from = [...expr.pattern],
        to = [...expr.replacement];
      if (from.length !== to.length)
        throw new Error("Transliteration alphabets must have equal length");
      const changes: { index: number; length: number; text: string }[] = [];
      let offset = 0;
      for (const char of mapped.text) {
        const match = from.indexOf(char);
        if (match >= 0 && char !== to[match])
          changes.push({
            index: mapped.indices[offset],
            length: char.length,
            text: to[match],
          });
        offset += char.length;
      }
      const requests: Data[] = changes.reverse().flatMap((change) => [
        {
          deleteContentRange: {
            range: docRange(t, change.index, change.index + change.length),
          },
        },
        {
          insertText: {
            location: { index: change.index, ...targetFields(t) },
            text: change.text,
          },
        },
      ]);
      if (requests.length) await docBatch(c, r, requests, t);
      applied++;
      continue;
    }
    const regex = RE2JS.compile(
      expr.pattern,
      (expr.ignoreCase ? RE2JS.CASE_INSENSITIVE : 0) |
        (expr.multiline ? RE2JS.MULTILINE : 0),
    );
    const matcher = regex.matcher(mapped.text),
      found: { start: number; end: number; text: string }[] = [];
    let n = 0;
    while (matcher.find()) {
      n++;
      if (!expr.nth || expr.nth === n) {
        const offset = matcher.start(),
          length = matcher.end() - offset;
        const start = mapped.indices[offset] ?? endIndex(t),
          end = length
            ? (mapped.indices[offset + length - 1] ?? start) + 1
            : start;
        if (length && end - start !== length)
          throw new Error(
            "A sed match crosses a table, chip, or other structural boundary; select a single paragraph or cell",
          );
        const groups = Array.from({ length: regex.groupCount() + 1 }, (_, i) =>
          matcher.group(i),
        );
        found.push({ start, end, text: replacement(expr.replacement, groups) });
        if (!expr.global) break;
      }
    }
    for (const foundMatch of found.reverse()) {
      const current = await loadDoc(c, r);
      if (expr.command === "a")
        await applyReplacement(
          c,
          r,
          current,
          foundMatch.end,
          foundMatch.end,
          foundMatch.text,
        );
      else if (expr.command === "i")
        await applyReplacement(
          c,
          r,
          current,
          foundMatch.start,
          foundMatch.start,
          foundMatch.text,
        );
      else
        await applyReplacement(
          c,
          r,
          current,
          foundMatch.start,
          foundMatch.end,
          foundMatch.text,
        );
      applied++;
    }
  }
  return {
    documentId: c.positionals[0],
    expressions: expressions.length,
    operations: applied,
  };
};
