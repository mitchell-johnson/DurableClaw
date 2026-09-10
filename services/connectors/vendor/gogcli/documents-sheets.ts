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
  copyDocument,
  exportDocument,
  attachParent,
} from "./documents-common";

const root = (c: Command) => `spreadsheets/${id(c.positionals[0])}`;
const get = (c: Command, r: Runtime, query: Data = {}) =>
  r.json("sheets", root(c), { query });
const batch = (c: Command, r: Runtime, requests: Data[]) => {
  if (!requests.length) throw new Error("No changes requested");
  return r.json("sheets", root(c) + ":batchUpdate", {
    method: "POST",
    body: { requests },
  });
};
export function columnIndex(value: string): number {
  let n = 0;
  for (const ch of value.toUpperCase()) {
    if (ch < "A" || ch > "Z") throw new Error("Invalid A1 column");
    n = n * 26 + ch.charCodeAt(0) - 64;
  }
  return n - 1;
}
export function columnName(value: number): string {
  let out = "";
  for (let n = value + 1; n > 0; n = Math.floor((n - 1) / 26))
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  return out;
}
function selectSheet(meta: Data, name?: string): Data {
  const sheets = meta.sheets ?? [];
  if (!name) {
    if (!sheets.length) throw new Error("Spreadsheet has no sheets");
    return sheets[0];
  }
  const unquoted = name.replace(/^'(.*)'$/s, "$1").replaceAll("''", "'");
  const result = sheets.find(
    (s: Data) =>
      s.properties?.title === unquoted ||
      String(s.properties?.sheetId) === unquoted,
  );
  if (!result) throw new Error(`Sheet not found: ${name}`);
  return result;
}
export function gridRange(value: string, meta: Data): Data {
  const named = (meta.namedRanges ?? []).find(
    (n: Data) => n.name === value || n.namedRangeId === value,
  );
  if (named) return { ...named.range };
  const split = value.lastIndexOf("!"),
    sheet = selectSheet(meta, split < 0 ? undefined : value.slice(0, split));
  let span = split < 0 ? value : value.slice(split + 1);
  span = span.replaceAll("$", "");
  if (
    split < 0 &&
    (meta.sheets ?? []).some((s: Data) => s.properties.title === value)
  )
    return { sheetId: selectSheet(meta, value).properties.sheetId };
  const parts = span.split(":");
  if (parts.length > 2) throw new Error("Invalid A1 range");
  const parse = (v: string) => {
    const match = /^([A-Za-z]*)([1-9]\d*)?$/.exec(v);
    if (!match || (!match[1] && !match[2])) throw new Error("Invalid A1 range");
    return {
      column: match[1] ? columnIndex(match[1]) : undefined,
      row: match[2] ? Number(match[2]) - 1 : undefined,
    };
  };
  const a = parse(parts[0]),
    b = parse(parts[1] ?? parts[0]);
  const result: Data = { sheetId: sheet.properties.sheetId };
  if (a.row !== undefined) result.startRowIndex = a.row;
  if (b.row !== undefined) result.endRowIndex = b.row + 1;
  if (a.column !== undefined) result.startColumnIndex = a.column;
  if (b.column !== undefined) result.endColumnIndex = b.column + 1;
  if (
    (result.endRowIndex ?? Infinity) <= (result.startRowIndex ?? -1) ||
    (result.endColumnIndex ?? Infinity) <= (result.startColumnIndex ?? -1)
  )
    throw new Error("Reversed A1 range");
  return result;
}
const a1 = (range: Data, meta: Data) => {
  const sheet = selectSheet(meta, String(range.sheetId)).properties.title;
  return `'${sheet.replaceAll("'", "''")}'!${columnName(range.startColumnIndex ?? 0)}${(range.startRowIndex ?? 0) + 1}:${columnName((range.endColumnIndex ?? 1) - 1)}${range.endRowIndex ?? 1}`;
};
async function grid(
  c: Command,
  r: Runtime,
  value = c.positionals[1],
): Promise<Data> {
  return gridRange(
    value,
    await get(c, r, { fields: "sheets(properties),namedRanges" }),
  );
}
function values(c: Command, r: Runtime, f: Data, start = 2): unknown[][] {
  const data =
    f["values-json"] !== undefined
      ? r.jsonInput(f["values-json"])
      : c.positionals
          .slice(start)
          .join(" ")
          .split(",")
          .map((row) =>
            row
              .trim()
              .split("|")
              .map((cell) => cell.trim()),
          );
  if (
    !Array.isArray(data) ||
    !data.every(
      (row) =>
        Array.isArray(row) &&
        row.every(
          (v) =>
            typeof v === "string" ||
            typeof v === "number" ||
            typeof v === "boolean" ||
            v === null,
        ),
    )
  )
    throw new Error("values-json must be a scalar matrix");
  return data;
}
const allTables = (meta: Data) =>
  (meta.sheets ?? []).flatMap((s: Data) =>
    (s.tables ?? []).map((t: Data) => ({
      ...t,
      sheetId: s.properties.sheetId,
      sheetTitle: s.properties.title,
    })),
  );
const findTable = (meta: Data, name: string) => {
  const t = allTables(meta).find(
    (t: Data) => t.tableId === name || t.name === name,
  );
  if (!t) throw new Error("Table not found");
  return t;
};
function cells(meta: Data): Data[] {
  return (meta.sheets ?? []).flatMap((s: Data) =>
    (s.data ?? []).flatMap((d: Data) =>
      (d.rowData ?? []).flatMap((row: Data, ri: number) =>
        (row.values ?? []).map((v: Data, ci: number) => ({
          sheet: s.properties.title,
          row: (d.startRow ?? 0) + ri,
          col: (d.startColumn ?? 0) + ci,
          ...v,
        })),
      ),
    ),
  );
}
async function readCells(c: Command, r: Runtime): Promise<Data[]> {
  return cells(
    await get(c, r, { ranges: c.positionals[1], includeGridData: true }),
  );
}
const h: HandlerMap = {};
h["sheets.metadata"] = (c, r) => get(c, r);
h["sheets.raw"] = (c, r) =>
  get(c, r, { includeGridData: flags(c)["include-grid-data"] ?? false });
h["sheets.get"] = (c, r) => {
  const f = flags(c);
  return r.json("sheets", root(c) + `/values/${segment(c.positionals[1])}`, {
    query: {
      ...(f.dimension ? { majorDimension: f.dimension } : {}),
      ...(f.render ? { valueRenderOption: f.render } : {}),
    },
  });
};
h["sheets.clear"] = (c, r) =>
  r.json("sheets", root(c) + `/values/${segment(c.positionals[1])}:clear`, {
    method: "POST",
    body: {},
  });
for (const operation of ["update", "append"])
  h[`sheets.${operation}`] = async (c, r) => {
    const f = flags(c),
      data = values(c, r, f),
      requests: Data[] = [];
    if (f["values-json"] === undefined) {
      if (!c.positionals.slice(2).length)
        throw new Error("Provide values or values-json");
      if (operation === "update") {
        const range = await grid(c, r),
          rows =
            range.endRowIndex !== undefined
              ? range.endRowIndex - (range.startRowIndex ?? 0)
              : 0,
          cols =
            range.endColumnIndex !== undefined
              ? range.endColumnIndex - (range.startColumnIndex ?? 0)
              : 0;
        if (rows === 1 && cols === 1)
          data.splice(0, data.length, [
            c.positionals.slice(2).join(" ").trim(),
          ]);
        else if (
          (rows && data.length > rows) ||
          (cols && data.some((row) => row.length > cols))
        )
          throw new Error(
            "Positional values exceed the requested update range",
          );
      }
    }
    let source: Data | undefined;
    if (f["copy-validation-from"])
      source = await grid(c, r, f["copy-validation-from"]);
    const response = await r.json(
      "sheets",
      root(c) +
        `/values/${segment(c.positionals[1])}` +
        (operation === "append" ? ":append" : ""),
      {
        method: operation === "append" ? "POST" : "PUT",
        query: {
          valueInputOption: f.input,
          ...(f.insert ? { insertDataOption: f.insert } : {}),
          ...(f["fail-on-formula-error"]
            ? {
                includeValuesInResponse: true,
                responseValueRenderOption: "UNFORMATTED_VALUE",
              }
            : {}),
        },
        body: { range: c.positionals[1], majorDimension: "ROWS", values: data },
      },
    );
    const updatedRange =
      operation === "append"
        ? response.updates?.updatedRange
        : response.updatedRange;
    if ((source || f["fail-on-formula-error"]) && !updatedRange)
      throw new Error(
        "Update response missing updated range; inspect the sheet before retrying",
      );
    if (source) {
      const dest = await grid(c, r, updatedRange);
      requests.push({
        copyPaste: {
          source,
          destination: dest,
          pasteType: "PASTE_DATA_VALIDATION",
          pasteOrientation: "NORMAL",
        },
      });
      await batch(c, r, requests);
    }
    if (f["fail-on-formula-error"]) {
      const data = await readCells(
        { ...c, positionals: [c.positionals[0], updatedRange] },
        r,
      );
      const errors = data.filter((v) => v.effectiveValue?.errorValue);
      if (errors.length)
        throw new Error(
          "Formula errors detected after update; values may already have changed",
        );
    }
    return response;
  };
h["sheets.batch-update"] = (c, r) => {
  const f = flags(c),
    data = r.jsonInput(f["data-json"]);
  if (
    !Array.isArray(data) ||
    !data.every((d) => typeof d.range === "string" && Array.isArray(d.values))
  )
    throw new Error("data-json must be a list of ValueRange objects");
  return r.json("sheets", root(c) + "/values:batchUpdate", {
    method: "POST",
    body: {
      data,
      valueInputOption: f.input,
      includeValuesInResponse: f["include-values-in-response"] ?? false,
      ...(f["response-render"]
        ? { responseValueRenderOption: f["response-render"] }
        : {}),
      ...(f["response-date-time-render"]
        ? { responseDateTimeRenderOption: f["response-date-time-render"] }
        : {}),
    },
  });
};
h["sheets.create"] = async (c, r) => {
  const f = flags(c);
  const result = await r.json("sheets", "spreadsheets", {
    method: "POST",
    body: {
      properties: { title: c.positionals[0] },
      ...(f.sheets
        ? {
            sheets: String(f.sheets)
              .split(",")
              .map((title) => ({ properties: { title: title.trim() } })),
          }
        : {}),
    },
  });
  await attachParent(r, result.spreadsheetId, f.parent);
  return result;
};
h["sheets.copy"] = copyDocument;
h["sheets.export"] = exportDocument;
h["sheets.add-tab"] = (c, r) =>
  batch(c, r, [
    {
      addSheet: {
        properties: {
          title: c.positionals[1],
          ...(flags(c).index !== undefined
            ? { index: integer(flags(c).index, "index") }
            : {}),
        },
      },
    },
  ]);
for (const op of ["delete-tab", "rename-tab", "reorder-tab"])
  h[`sheets.${op}`] = async (c, r) => {
    const f = flags(c),
      s = selectSheet(
        await get(c, r),
        op === "reorder-tab" ? f.tab : c.positionals[1],
      );
    return batch(c, r, [
      op === "delete-tab"
        ? { deleteSheet: { sheetId: s.properties.sheetId } }
        : {
            updateSheetProperties: {
              properties: {
                sheetId: s.properties.sheetId,
                ...(op === "rename-tab"
                  ? { title: c.positionals[2] }
                  : { index: integer(f.to, "to") }),
              },
              fields: op === "rename-tab" ? "title" : "index",
            },
          },
    ]);
  };
h["sheets.freeze"] = async (c, r) => {
  const f = flags(c),
    s = selectSheet(await get(c, r), f.sheet),
    g: Data = {};
  for (const key of ["rows", "cols"])
    if (supplied(c, key) && f[key] < 0)
      throw new Error(`${key} must be nonnegative`);
  if (f.rows >= 0) g.frozenRowCount = integer(f.rows, "rows");
  if (f.cols >= 0) g.frozenColumnCount = integer(f.cols, "cols");
  if (!Object.keys(g).length) throw new Error("Set rows or cols");
  return batch(c, r, [
    {
      updateSheetProperties: {
        properties: { sheetId: s.properties.sheetId, gridProperties: g },
        fields: mask(g, "gridProperties."),
      },
    },
  ]);
};
h["sheets.format"] = async (c, r) => {
  const f = flags(c),
    format = r.jsonInput(f["format-json"]);
  if (!format || Array.isArray(format) || typeof format !== "object")
    throw new Error("format-json must be a CellFormat object");
  let fields = f["format-fields"] ?? mask(format);
  fields = String(fields)
    .split(",")
    .map((p) =>
      p.startsWith("userEnteredFormat.") ? p : "userEnteredFormat." + p,
    )
    .join(",");
  return batch(c, r, [
    {
      repeatCell: {
        range: await grid(c, r),
        cell: { userEnteredFormat: format },
        fields,
      },
    },
  ]);
};
h["sheets.number-format"] = async (c, r) => {
  const f = flags(c);
  return batch(c, r, [
    {
      repeatCell: {
        range: await grid(c, r),
        cell: {
          userEnteredFormat: {
            numberFormat: {
              type: f.type,
              ...(f.pattern !== undefined ? { pattern: f.pattern } : {}),
            },
          },
        },
        fields: "userEnteredFormat.numberFormat",
      },
    },
  ]);
};
h["sheets.update-note"] = async (c, r) => {
  const f = flags(c);
  if (f.note !== undefined && f["note-file"])
    throw new Error("Choose note or note-file");
  const note = f["note-file"] ? r.text(f["note-file"]) : f.note;
  if (typeof note !== "string") throw new Error("Provide note or note-file");
  return batch(c, r, [
    { repeatCell: { range: await grid(c, r), cell: { note }, fields: "note" } },
  ]);
};
for (const op of ["notes", "read-format", "validation.get", "links.get"])
  h[`sheets.${op}`] = async (c, r) => {
    const data = await readCells(c, r);
    if (op === "notes")
      return {
        notes: data
          .filter((c) => c.note)
          .map(({ sheet, row, col, note }) => ({
            sheet,
            row: row + 1,
            col: col + 1,
            note,
          })),
      };
    if (op === "read-format")
      return {
        cells: data.map((v) => ({
          sheet: v.sheet,
          row: v.row + 1,
          col: v.col + 1,
          format: flags(c).effective ? v.effectiveFormat : v.userEnteredFormat,
        })),
      };
    if (op === "validation.get")
      return {
        cells: data.map((v) => ({
          sheet: v.sheet,
          row: v.row + 1,
          col: v.col + 1,
          validation: v.dataValidation,
        })),
      };
    return {
      links: data.flatMap((v) =>
        [
          ...new Set(
            [
              v.hyperlink,
              v.userEnteredFormat?.textFormat?.link?.uri,
              ...(v.textFormatRuns ?? []).map((t: Data) => t.format?.link?.uri),
            ].filter(Boolean),
          ),
        ].map((link) => ({
          sheet: v.sheet,
          row: v.row + 1,
          col: v.col + 1,
          value: v.formattedValue,
          link,
        })),
      ),
    };
  };
for (const op of ["merge", "unmerge"])
  h[`sheets.${op}`] = async (c, r) =>
    batch(c, r, [
      {
        [op === "merge" ? "mergeCells" : "unmergeCells"]: {
          range: await grid(c, r),
          ...(op === "merge" ? { mergeType: flags(c).type } : {}),
        },
      },
    ]);
h["sheets.filter.set"] = async (c, r) =>
  batch(c, r, [{ setBasicFilter: { filter: { range: await grid(c, r) } } }]);
h["sheets.copy-paste"] = async (c, r) => {
  const meta = await get(c, r),
    f = flags(c);
  let type = String(f.type);
  if (!type.startsWith("PASTE_")) type = "PASTE_" + type;
  return batch(c, r, [
    {
      copyPaste: {
        source: gridRange(c.positionals[1], meta),
        destination: gridRange(c.positionals[2], meta),
        pasteType: type,
        pasteOrientation: f.transpose ? "TRANSPOSE" : "NORMAL",
      },
    },
  ]);
};
h["sheets.find-replace"] = async (c, r) => {
  const f = flags(c),
    spec: Data = {
      find: c.positionals[1],
      replacement: c.positionals[2],
      matchCase: f["match-case"] ?? false,
      matchEntireCell: f["match-entire"] ?? false,
      searchByRegex: f.regex ?? false,
      includeFormulas: f.formulas ?? false,
    };
  if (f.sheet)
    spec.sheetId = selectSheet(await get(c, r), f.sheet).properties.sheetId;
  else spec.allSheets = true;
  return batch(c, r, [{ findReplace: spec }]);
};
for (const op of ["resize-columns", "resize-rows"])
  h[`sheets.${op}`] = async (c, r) => {
    const f = flags(c),
      g = await grid(c, r),
      columns = op === "resize-columns",
      dimension = columns ? "COLUMNS" : "ROWS",
      startIndex = g[columns ? "startColumnIndex" : "startRowIndex"],
      endIndex = g[columns ? "endColumnIndex" : "endRowIndex"];
    if (startIndex === undefined || endIndex === undefined)
      throw new Error("A bounded row or column range is required");
    const range = { sheetId: g.sheetId, dimension, startIndex, endIndex };
    if (f.auto && f[columns ? "width" : "height"] !== undefined)
      throw new Error("Choose automatic or explicit size");
    return batch(c, r, [
      f.auto
        ? { autoResizeDimensions: { dimensions: range } }
        : {
            updateDimensionProperties: {
              range,
              properties: {
                pixelSize: integer(
                  f[columns ? "width" : "height"],
                  "pixel size",
                  1,
                ),
              },
              fields: "pixelSize",
            },
          },
    ]);
  };
h["sheets.insert"] = async (c, r) => {
  const f = flags(c),
    dimension = (
      {
        row: "ROWS",
        rows: "ROWS",
        col: "COLUMNS",
        cols: "COLUMNS",
        column: "COLUMNS",
        columns: "COLUMNS",
      } as Data
    )[c.positionals[2].toLowerCase()];
  if (!["ROWS", "COLUMNS"].includes(dimension))
    throw new Error("Dimension must be ROWS or COLUMNS");
  const s = selectSheet(await get(c, r), c.positionals[1]);
  const start = integer(c.positionals[3], "start", 1) - 1 + (f.after ? 1 : 0),
    count = integer(f.count, "count", 1);
  if (start === 0 && f["inherit-from-before"])
    throw new Error("Cannot inherit from before the first row or column");
  return batch(c, r, [
    {
      insertDimension: {
        range: {
          sheetId: s.properties.sheetId,
          dimension,
          startIndex: start,
          endIndex: start + count,
        },
        inheritFromBefore: f["inherit-from-before"] ?? Boolean(f.after),
      },
    },
  ]);
};
h["sheets.delete-dimension"] = async (c, r) => {
  const f = flags(c),
    meta = await get(c, r),
    dimension = String(f.dimension ?? "").toUpperCase();
  let range: Data;
  if (f.start !== undefined || f.end !== undefined) {
    if (!["ROWS", "COLUMNS"].includes(dimension))
      throw new Error("Explicit dimension required");
    range = {
      sheetId: selectSheet(meta, c.positionals[1]).properties.sheetId,
      dimension,
      startIndex: integer(f.start, "start", 1) - 1,
      endIndex: integer(f.end, "end", 1),
    };
  } else {
    const g = gridRange(c.positionals[1], meta);
    const dim =
      dimension ||
      (g.startColumnIndex === undefined
        ? "ROWS"
        : g.startRowIndex === undefined
          ? "COLUMNS"
          : "");
    if (!dim) throw new Error("Range must identify entire rows or columns");
    range = {
      sheetId: g.sheetId,
      dimension: dim,
      startIndex: g[dim === "ROWS" ? "startRowIndex" : "startColumnIndex"],
      endIndex: g[dim === "ROWS" ? "endRowIndex" : "endColumnIndex"],
    };
  }
  if (range.endIndex <= range.startIndex)
    throw new Error("Reversed dimension range");
  return batch(c, r, [{ deleteDimension: { range } }]);
};
for (const op of ["set", "clear"])
  h[`sheets.validation.${op}`] = async (c, r) => {
    const f = flags(c);
    const rule =
      op === "clear"
        ? undefined
        : {
            condition: {
              type: f.type,
              values: (f.value ?? []).map((userEnteredValue: string) => ({
                userEnteredValue,
              })),
            },
            strict: f.strict ?? false,
            showCustomUi: f["show-custom-ui"],
            ...(f["input-message"] ? { inputMessage: f["input-message"] } : {}),
          };
    return batch(c, r, [
      {
        setDataValidation: {
          range: await grid(c, r),
          ...(rule ? { rule } : {}),
          filteredRowsIncluded: f["filtered-rows-included"] ?? false,
        },
      },
    ]);
  };
for (const op of ["list", "get", "add", "update", "delete"])
  h[`sheets.named-ranges.${op}`] = async (c, r) => {
    const f = flags(c),
      meta = await get(c, r),
      ranges = meta.namedRanges ?? [];
    if (op === "list") return { namedRanges: ranges };
    const current = ranges.find(
      (v: Data) =>
        v.name === c.positionals[1] || v.namedRangeId === c.positionals[1],
    );
    if (op !== "add" && !current) throw new Error("Named range not found");
    if (op === "get") return current;
    if (op === "delete")
      return batch(c, r, [
        { deleteNamedRange: { namedRangeId: current.namedRangeId } },
      ]);
    if (op === "add")
      return batch(c, r, [
        {
          addNamedRange: {
            namedRange: {
              name: c.positionals[1],
              range: gridRange(c.positionals[2], meta),
            },
          },
        },
      ]);
    const namedRange: Data = { namedRangeId: current.namedRangeId };
    if (f.name !== undefined) namedRange.name = f.name;
    if (f.range !== undefined) namedRange.range = gridRange(f.range, meta);
    return batch(c, r, [
      {
        updateNamedRange: {
          namedRange,
          fields: Object.keys(namedRange)
            .filter((x) => x !== "namedRangeId")
            .join(","),
        },
      },
    ]);
  };
for (const op of ["list", "set", "clear"])
  h[`sheets.banding.${op}`] = async (c, r) => {
    const f = flags(c),
      meta = await get(c, r),
      ss = f.sheet ? [selectSheet(meta, f.sheet)] : (meta.sheets ?? []),
      bands = ss.flatMap((s: Data) => s.bandedRanges ?? []);
    if (op === "list") return { bandedRanges: bands };
    if (op === "set") {
      const row =
          f["row-properties-json"] !== undefined
            ? r.jsonInput(f["row-properties-json"])
            : undefined,
        column =
          f["column-properties-json"] !== undefined
            ? r.jsonInput(f["column-properties-json"])
            : undefined;
      if (!row && !column)
        throw new Error("Row or column banding properties required");
      return batch(c, r, [
        {
          addBanding: {
            bandedRange: {
              range: gridRange(c.positionals[1], meta),
              ...(row ? { rowProperties: row } : {}),
              ...(column ? { columnProperties: column } : {}),
            },
          },
        },
      ]);
    }
    if (!f.all && f.id === undefined) throw new Error("Choose all or id");
    const targets = f.all
      ? bands
      : bands.filter((b: Data) => b.bandedRangeId === Number(f.id));
    if (!targets.length) throw new Error("Banding not found");
    return batch(
      c,
      r,
      targets.map((b: Data) => ({
        deleteBanding: { bandedRangeId: b.bandedRangeId },
      })),
    );
  };
for (const op of ["list", "add", "clear"])
  h[`sheets.conditional-format.${op}`] = async (c, r) => {
    const f = flags(c),
      meta = await get(c, r);
    if (op === "add") {
      const range = gridRange(c.positionals[1], meta);
      let rule: Data;
      if (f["gradient-rule-json"]) {
        if (f.type || f.expr || f["format-json"])
          throw new Error("Choose gradient or boolean condition");
        rule = { gradientRule: r.jsonInput(f["gradient-rule-json"]) };
      } else {
        const format = r.jsonInput(f["format-json"]);
        if (f["format-fields"]) {
          const allowed = String(f["format-fields"]).split(",");
          for (const key of Object.keys(format))
            if (!allowed.some((p) => p === key || p.startsWith(key + ".")))
              throw new Error("format-fields does not include provided format");
        }
        rule = {
          booleanRule: {
            condition: {
              type: f.type ?? "CUSTOM_FORMULA",
              values: (Array.isArray(f.expr) ? f.expr : [f.expr])
                .filter((v) => v !== undefined)
                .map((userEnteredValue) => ({ userEnteredValue })),
            },
            format,
          },
        };
      }
      return batch(c, r, [
        {
          addConditionalFormatRule: {
            index: integer(f.index, "index"),
            rule: { ranges: [range], ...rule },
          },
        },
      ]);
    }
    const ss = f.sheet ? [selectSheet(meta, f.sheet)] : (meta.sheets ?? []);
    if (op === "list")
      return {
        rules: ss.flatMap((s: Data) =>
          (s.conditionalFormats ?? []).map((rule: Data, index: number) => ({
            sheet: s.properties.title,
            index,
            rule,
          })),
        ),
      };
    if (!f.all && f.index === undefined) throw new Error("Choose all or index");
    return batch(
      c,
      r,
      ss.flatMap((s: Data) =>
        (s.conditionalFormats ?? [])
          .map((_: Data, index: number) => index)
          .filter((i: number) => f.all || i === Number(f.index))
          .reverse()
          .map((index: number) => ({
            deleteConditionalFormatRule: {
              sheetId: s.properties.sheetId,
              index,
            },
          })),
      ),
    );
  };
for (const op of ["list", "get", "create", "update", "delete"])
  h[`sheets.chart.${op}`] = async (c, r) => {
    const f = flags(c);
    if (op === "delete")
      return batch(c, r, [
        {
          deleteEmbeddedObject: {
            objectId: integer(c.positionals[1], "chartId"),
          },
        },
      ]);
    if (op === "update")
      return batch(c, r, [
        {
          updateChartSpec: {
            chartId: integer(c.positionals[1], "chartId"),
            spec: r.jsonInput(f["spec-json"]),
          },
        },
      ]);
    const meta = await get(c, r);
    if (op === "create") {
      const sheet = selectSheet(meta, f.sheet),
        anchor = gridRange(f.anchor ?? `${sheet.properties.title}!A1`, meta);
      return batch(c, r, [
        {
          addChart: {
            chart: {
              spec: r.jsonInput(f["spec-json"]),
              position: {
                overlayPosition: {
                  anchorCell: {
                    sheetId: anchor.sheetId,
                    rowIndex: anchor.startRowIndex ?? 0,
                    columnIndex: anchor.startColumnIndex ?? 0,
                  },
                  widthPixels: integer(f.width, "width", 1),
                  heightPixels: integer(f.height, "height", 1),
                },
              },
            },
          },
        },
      ]);
    }
    const charts = (meta.sheets ?? []).flatMap((s: Data) => s.charts ?? []);
    if (op === "list") return { charts };
    const chart = charts.find(
      (v: Data) => v.chartId === Number(c.positionals[1]),
    );
    if (!chart) throw new Error("Chart not found");
    return chart;
  };
for (const op of ["list", "get", "create", "delete", "clear", "append"])
  h[`sheets.table.${op}`] = async (c, r) => {
    const f = flags(c),
      meta = await get(c, r);
    if (op === "list") return { tables: allTables(meta) };
    if (op === "create")
      return batch(c, r, [
        {
          addTable: {
            table: {
              range: gridRange(c.positionals[1], meta),
              ...(f.name ? { name: f.name } : {}),
              ...(f["columns-json"]
                ? { columnProperties: r.jsonInput(f["columns-json"]) }
                : {}),
            },
          },
        },
      ]);
    const t = findTable(meta, c.positionals[1]);
    if (op === "get") return t;
    if (op === "delete") {
      if (!f["discard-data"])
        throw new Error(
          "Table deletion removes its cells; pass discard-data to confirm",
        );
      return batch(c, r, [{ deleteTable: { tableId: t.tableId } }]);
    }
    const range = {
      ...t.range,
      startRowIndex: (t.range.startRowIndex ?? 0) + 1,
      endRowIndex:
        t.range.endRowIndex - (t.rowsProperties?.footerColorStyle ? 1 : 0),
    };
    if (op === "clear") {
      if (range.startRowIndex >= range.endRowIndex)
        return { clearedRange: null };
      return r.json(
        "sheets",
        root(c) + `/values/${segment(a1(range, meta))}:clear`,
        { method: "POST", body: {} },
      );
    }
    const vals = values(c, r, f);
    if (
      vals.some(
        (row) => row.length > t.range.endColumnIndex - t.range.startColumnIndex,
      )
    )
      throw new Error("Values exceed table width");
    return r.json(
      "sheets",
      root(c) + `/values/${segment(a1(t.range, meta))}:append`,
      {
        method: "POST",
        query: { valueInputOption: f.input, insertDataOption: "INSERT_ROWS" },
        body: { values: vals },
      },
    );
  };
for (const op of [
  "list",
  "describe",
  "add",
  "update",
  "delete",
  "refresh",
  "table.list",
  "table.describe",
  "table.read",
])
  h[`sheets.datasource.${op}`] = async (c, r) => {
    const f = flags(c);
    if (op === "delete")
      return batch(c, r, [
        { deleteDataSource: { dataSourceId: c.positionals[1] } },
      ]);
    if (op === "refresh")
      return batch(c, r, [
        {
          refreshDataSource: {
            dataSourceId: c.positionals[1],
            force: f["force-refresh"] ?? false,
          },
        },
      ]);
    const meta = await get(c, r, { includeGridData: op.startsWith("table.") });
    const sources = meta.dataSources ?? [];
    if (op === "list") return { dataSources: sources };
    if (op === "describe") {
      const source = sources.find(
        (s: Data) => s.dataSourceId === c.positionals[1],
      );
      if (!source) throw new Error("Data source not found");
      return source;
    }
    if (op === "add" || op === "update") {
      const changes: Data = {},
        paths: string[] = [];
      const keys = [
        "billing-project",
        "query",
        "table-project",
        "dataset",
        "table",
      ];
      for (const key of keys)
        if (supplied(c, key) && !String(f[key]).trim())
          throw new Error(`${key} cannot be empty`);
      const queryProvided = supplied(c, "query"),
        tableProvided = ["table-project", "dataset", "table"].some((key) =>
          supplied(c, key),
        );
      if (queryProvided && tableProvided)
        throw new Error("Choose SQL query or table");
      if (supplied(c, "billing-project")) {
        changes.projectId = String(f["billing-project"]).trim();
        paths.push("spec.bigQuery.projectId");
      }
      if (queryProvided) {
        changes.querySpec = { rawQuery: String(f.query).trim() };
        paths.push("spec.bigQuery.querySpec.rawQuery");
      }
      if (tableProvided) {
        changes.tableSpec = {};
        for (const [key, field] of [
          ["table-project", "tableProjectId"],
          ["dataset", "datasetId"],
          ["table", "tableId"],
        ])
          if (supplied(c, key)) {
            changes.tableSpec[field] = String(f[key]).trim();
            paths.push(`spec.bigQuery.tableSpec.${field}`);
          }
      }
      if (op === "add") {
        if (!changes.projectId) throw new Error("Billing project required");
        if (
          !queryProvided &&
          (!changes.tableSpec?.datasetId || !changes.tableSpec?.tableId)
        )
          throw new Error("Query or dataset and table required");
      } else {
        if (!paths.length) throw new Error("No data source changes requested");
        const old = sources.find(
          (source: Data) => source.dataSourceId === c.positionals[1],
        );
        if (!old?.spec?.bigQuery)
          throw new Error("BigQuery data source not found");
        if (queryProvided && !old.spec.bigQuery.querySpec)
          throw new Error("Cannot apply SQL to a non-query data source");
        if (tableProvided && !old.spec.bigQuery.tableSpec)
          throw new Error(
            "Cannot apply table fields to a non-table data source",
          );
      }
      const dataSource = {
        ...(op === "update" ? { dataSourceId: c.positionals[1] } : {}),
        spec: { bigQuery: changes },
      };
      return batch(c, r, [
        op === "add"
          ? { addDataSource: { dataSource } }
          : { updateDataSource: { dataSource, fields: paths.join(",") } },
      ]);
    }
    const tables = cells(meta)
      .filter((v) => v.dataSourceTable)
      .map((v) => ({
        ...v.dataSourceTable,
        anchor: { sheet: v.sheet, row: v.row, col: v.col },
      }));
    if (op === "table.list")
      return {
        tables: tables.filter(
          (t) => !f["data-source-id"] || t.dataSourceId === f["data-source-id"],
        ),
      };
    const anchor = gridRange(c.positionals[1], meta),
      sheet = selectSheet(meta, String(anchor.sheetId));
    const table = tables.find(
      (t) =>
        t.anchor.sheet === sheet.properties.title &&
        t.anchor.row === anchor.startRowIndex &&
        t.anchor.col === anchor.startColumnIndex,
    );
    if (!table) throw new Error("Connected data source table not found");
    if (op === "table.describe") return table;
    const maxRows = integer(f["max-rows"], "max-rows", 1, 10000);
    return r.json(
      "sheets",
      root(c) +
        `/values/${segment(a1({ ...anchor, endRowIndex: (anchor.startRowIndex ?? 0) + maxRows, endColumnIndex: (anchor.startColumnIndex ?? 0) + (table.columns?.length ?? 1) }, meta))}`,
      { query: { valueRenderOption: f.render } },
    );
  };
h["sheets.links.set"] = async (c, r) => {
  const f = flags(c),
    meta = await get(c, r);
  let entries: Data[];
  if (f["cells-json"]) entries = r.jsonInput(f["cells-json"]);
  else
    entries = [
      {
        cell: c.positionals[1],
        url: c.positionals[2],
        text: c.positionals[3],
        ...(f["runs-json"] ? { runs: r.jsonInput(f["runs-json"]) } : {}),
      },
    ];
  if (!Array.isArray(entries) || !entries.length)
    throw new Error("Provide cells JSON or cell, URL and text");
  const requests = entries.map((entry) => {
    const range = gridRange(entry.cell ?? entry.range, meta);
    if (
      range.endRowIndex !== range.startRowIndex + 1 ||
      range.endColumnIndex !== range.startColumnIndex + 1
    )
      throw new Error("Links must address a single cell");
    if (
      entry.runs &&
      (!Array.isArray(entry.runs) ||
        entry.runs.some(
          (run: Data) =>
            typeof run.text !== "string" ||
            (run.uri !== undefined && typeof run.uri !== "string"),
        ))
    )
      throw new Error("Runs must contain text and optional uri");
    const value = entry.runs
      ? entry.runs.map((run: Data) => run.text).join("")
      : (entry.text ?? entry.url);
    if (typeof value !== "string") throw new Error("Link text required");
    const cell: Data = { userEnteredValue: { stringValue: value } };
    if (entry.runs) {
      let startIndex = 0;
      cell.textFormatRuns = entry.runs.map((run: Data) => {
        const result = {
          startIndex,
          format: run.uri ? { link: { uri: run.uri } } : {},
        };
        startIndex += run.text.length;
        return result;
      });
    } else
      cell.userEnteredFormat = { textFormat: { link: { uri: entry.url } } };
    return {
      updateCells: {
        range,
        rows: [{ values: [cell] }],
        fields: entry.runs
          ? "userEnteredValue,textFormatRuns"
          : "userEnteredValue,userEnteredFormat.textFormat.link,textFormatRuns",
      },
    };
  });
  return batch(c, r, requests);
};
export const sheetHandlers = h;
