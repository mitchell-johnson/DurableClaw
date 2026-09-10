import catalog from "./catalog.json";
import { segment, type Command, type Data, type Runtime } from "./types";

export function flags(c: Command): Data {
  const definition = catalog.commands.find(
    (entry) => entry.command === c.command,
  );
  const result: Data = {};
  for (const f of definition?.flags ?? []) {
    if ("default" in f)
      result[f.name] =
        f.type.replace("*", "") === "bool"
          ? f.default === "true"
          : /^(\*)?(int|int64|float64)$/.test(f.type)
            ? Number(f.default)
            : f.default;
  }
  return { ...result, ...c.flags };
}
/** Catalog defaults are distinct from flags the caller deliberately supplied. */
export function supplied(c: Command, name: string): boolean {
  return c.suppliedFlags
    ? c.suppliedFlags.includes(name)
    : Object.hasOwn(c.flags, name);
}
export function integer(
  value: unknown,
  name: string,
  min = 0,
  max = 1_000_000,
): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new Error(`${name} must be an integer ${min}–${max}`);
  return n;
}
export function id(value: string): string {
  const found = value?.match(/\/d\/([\w-]+)/);
  if (!value) throw new Error("Document ID is required");
  return segment(found?.[1] ?? value);
}
export function color(value: string): Data {
  const named: Record<string, string> = {
    black: "#000000",
    white: "#ffffff",
    red: "#ff0000",
    green: "#008000",
    blue: "#0000ff",
    yellow: "#ffff00",
    gray: "#808080",
    grey: "#808080",
    orange: "#ffa500",
    purple: "#800080",
  };
  let s = named[String(value).toLowerCase()] ?? value;
  if (/^#[\da-f]{3}$/i.test(s))
    s =
      "#" +
      s
        .slice(1)
        .split("")
        .map((x) => x + x)
        .join("");
  if (!/^#[\da-f]{6}$/i.test(s))
    throw new Error("Color must be #RRGGBB, #RGB, or a supported named color");
  return {
    red: parseInt(s.slice(1, 3), 16) / 255,
    green: parseInt(s.slice(3, 5), 16) / 255,
    blue: parseInt(s.slice(5, 7), 16) / 255,
  };
}
export const pt = (n: unknown): Data => {
  const value = Number(n);
  if (!Number.isFinite(value) || value < 0)
    throw new Error("Invalid point dimension");
  return { magnitude: value, unit: "PT" };
};
export function mask(value: Data, prefix = ""): string {
  return Object.entries(value)
    .flatMap(([key, v]) =>
      v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length
        ? mask(v, `${prefix}${key}.`).split(",")
        : [`${prefix}${key}`],
    )
    .join(",");
}
export function textInput(
  f: Data,
  r: Runtime,
  fallback?: string,
  key = "file",
): string {
  if (f[key] !== undefined && (f.text !== undefined || fallback !== undefined))
    throw new Error("Choose file or inline content");
  const content = f[key] !== undefined ? r.text(f[key]) : (f.text ?? fallback);
  if (typeof content !== "string")
    throw new Error("Provide text or an input file");
  return content;
}
export async function copyDocument(c: Command, r: Runtime): Promise<any> {
  const f = flags(c);
  return r.json("drive", `files/${id(c.positionals[0])}/copy`, {
    method: "POST",
    body: {
      name: c.positionals[1],
      ...(f.parent ? { parents: [f.parent] } : {}),
    },
    query: { fields: "id,name,mimeType,webViewLink" },
  });
}
export async function attachParent(
  r: Runtime,
  fileId: string,
  parent?: string,
): Promise<void> {
  if (parent)
    await r.json("drive", `files/${id(fileId)}`, {
      method: "PATCH",
      query: { addParents: parent, fields: "id,parents" },
      body: {},
    });
}
export async function exportDocument(c: Command, r: Runtime): Promise<any> {
  const f = flags(c),
    format = String(f.format).toLowerCase();
  const formats: Record<string, string> = {
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    txt: "text/plain",
    text: "text/plain",
    md: "text/markdown",
    html: "text/html",
    rtf: "application/rtf",
    odt: "application/vnd.oasis.opendocument.text",
    ods: "application/vnd.oasis.opendocument.spreadsheet",
    odp: "application/vnd.oasis.opendocument.presentation",
    csv: "text/csv",
    tsv: "text/tab-separated-values",
    zip: "application/zip",
  };
  if (!formats[format]) throw new Error("Unsupported export format");
  const result = await r.bytes(
    "drive",
    `files/${id(c.positionals[0])}/export`,
    {
      query: { mimeType: formats[format], ...(f.tab ? { tabId: f.tab } : {}) },
    },
  );
  return r.output(r.outputName(c, `artifacts/export.${format}`), result.bytes);
}
export function rangeText(value?: string): Data {
  if (!value || value === "all") return { type: "ALL" };
  const m = /^(\d+):(\d+)$/.exec(value);
  if (!m) throw new Error("Text range must be start:end");
  const startIndex = integer(m[1], "start"),
    endIndex = integer(m[2], "end");
  if (endIndex <= startIndex) throw new Error("Text range must be nonempty");
  return { type: "FIXED_RANGE", startIndex, endIndex };
}
export function textStyle(f: Data, slide = false): Data {
  const style: Data = {};
  for (const key of ["bold", "italic", "underline", "strikethrough"]) {
    if (f[key] && f[`no-${key}`]) throw new Error(`Conflicting ${key} flags`);
    if (f[key]) style[key] = true;
    else if (f[`no-${key}`]) style[key] = false;
  }
  if (f["text-color"])
    style.foregroundColor = {
      ...(slide
        ? { opaqueColor: { rgbColor: color(f["text-color"]) } }
        : { color: { rgbColor: color(f["text-color"]) } }),
    };
  if (f["bg-color"])
    style.backgroundColor = {
      [slide ? "opaqueColor" : "color"]: { rgbColor: color(f["bg-color"]) },
    };
  if (f["font-family"] || f.font)
    style[slide ? "fontFamily" : "weightedFontFamily"] = slide
      ? (f.font ?? f["font-family"])
      : { fontFamily: f["font-family"] };
  if (f["font-size"] !== undefined || f.size !== undefined)
    style.fontSize = pt(f.size ?? f["font-size"]);
  if (f.code) {
    style[slide ? "fontFamily" : "weightedFontFamily"] = slide
      ? "Roboto Mono"
      : { fontFamily: "Roboto Mono" };
    style.backgroundColor = {
      [slide ? "opaqueColor" : "color"]: { rgbColor: color("#f1f3f4") },
    };
  }
  if (f.link) style.link = { url: f.link };
  return style;
}
export function uuid(prefix = "dc"): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
