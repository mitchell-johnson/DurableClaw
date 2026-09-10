import {
  required,
  segment,
  type Command,
  type Data,
  type Runtime,
  type RequestOptions,
} from "./types";

export const FOLDER = "application/vnd.google-apps.folder";
export const G = "application/vnd.google-apps.";
export const quote = (value: unknown) =>
  String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
export const list = (value: unknown): string[] =>
  value === undefined
    ? []
    : Array.isArray(value)
      ? value.map(String)
      : [String(value)];
export function id(value: unknown, name = "id"): string {
  const text = required(value, name).trim();
  if (/^https:\/\//.test(text)) {
    const url = new URL(text);
    const match = url.pathname.match(/\/(?:d|folders)\/([^/]+)/);
    return required(
      match?.[1] ?? url.searchParams.get("id") ?? undefined,
      name,
    );
  }
  return text;
}
export const pos = (c: Command, index = 0) =>
  id(c.positionals[index], `argument ${index + 1}`);
export function integer(
  value: unknown,
  fallback: number,
  min = 0,
  max = 10_000,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`Expected an integer between ${min} and ${max}`);
  return parsed;
}
export function enumValue(
  value: unknown,
  allowed: string[],
  fallback: string,
): string {
  const result = String(value ?? fallback);
  if (!allowed.includes(result))
    throw new Error(`Expected one of ${allowed.join(", ")}`);
  return result;
}
export function resource(value: unknown, prefix: string): string {
  const text = id(value);
  return text.startsWith(prefix + "/")
    ? prefix +
        "/" +
        text
          .slice(prefix.length + 1)
          .split("/")
          .map(segment)
          .join("/")
    : prefix + "/" + segment(text);
}
export function safeName(value: unknown, fallback = "file"): string {
  const basename =
    String(value ?? "")
      .split(/[\\/]/)
      .at(-1) ?? "";
  const name = basename
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 100);
  return name || fallback;
}
export function allDriveQuery(flags: Data): Data {
  if (flags.drive && flags["all-drives"] === false)
    throw new Error("--drive conflicts with --no-all-drives");
  return {
    supportsAllDrives: true,
    includeItemsFromAllDrives: flags["all-drives"] !== false,
    ...(flags.drive
      ? { corpora: "drive", driveId: flags.drive }
      : flags["all-drives"] !== false
        ? { corpora: "allDrives" }
        : {}),
  };
}
export async function paged(
  r: Runtime,
  api: string,
  path: string,
  key: string,
  c: Command,
  options: RequestOptions = {},
  defaultMax = 100,
): Promise<Data> {
  let page = c.flags.page;
  const items: any[] = [];
  const seen = new Set<string>();
  let response: Data = {};
  do {
    r.signal.throwIfAborted();
    response = await r.json(api, path, {
      ...options,
      query: {
        pageSize: integer(c.flags.max, defaultMax, 1),
        ...options.query,
        ...(page ? { pageToken: page } : {}),
      },
    });
    items.push(...(response[key] ?? []));
    if (items.length > 5000)
      throw new Error(
        "Result exceeds 5000 items; narrow the request or use page tokens",
      );
    page = response.nextPageToken;
    if (!c.flags.all || !page) break;
    if (seen.has(page)) throw new Error("Provider repeated a page token");
    seen.add(page);
  } while (page);
  if (c.flags["fail-empty"] && items.length === 0)
    throw new Error("No results");
  return { ...response, [key]: items, nextPageToken: page ?? "" };
}
export function mediaType(name: string): string {
  const types: Data = {
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    json: "application/json",
    html: "text/html",
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    zip: "application/zip",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  return (
    types[name.split(".").at(-1)?.toLowerCase() ?? ""] ??
    "application/octet-stream"
  );
}
export async function multipart(
  r: Runtime,
  api: string,
  path: string,
  metadata: Data,
  bytes: Uint8Array,
  mime: string,
  options: RequestOptions = {},
): Promise<any> {
  const boundary = "gog-native-" + crypto.randomUUID();
  const enc = new TextEncoder();
  const start = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
  );
  const end = enc.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(start.length + bytes.length + end.length);
  body.set(start);
  body.set(bytes, start.length);
  body.set(end, start.length + bytes.length);
  return r.upload(api, path, body, {
    ...options,
    method: options.method ?? "POST",
    query: { uploadType: "multipart", ...options.query },
    headers: {
      ...options.headers,
      "content-type": `multipart/related; boundary=${boundary}`,
    },
  });
}
export function date(value: unknown): Data {
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (
    !match ||
    new Date(String(value) + "T00:00:00Z").toISOString().slice(0, 10) !== value
  )
    throw new Error("Dates must use YYYY-MM-DD");
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}
export function duration(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  const match = String(value).match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/);
  if (!match) throw new Error("Use a duration such as 10s or 1m");
  return (
    Number(match[1]) * ({ ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2]] ?? 1)
  );
}
