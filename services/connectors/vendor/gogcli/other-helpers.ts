import type { Command, Data, Runtime } from "./types";
export function csv(value: unknown): string[] {
  return (
    Array.isArray(value)
      ? value
      : value === undefined || value === ""
        ? []
        : [value]
  )
    .flatMap((entry) => String(entry).split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
}
export function mapped(
  flags: Data,
  names: Record<string, string>,
  upper: string[] = [],
): Data {
  const result: Data = {};
  for (const [flag, property] of Object.entries(names))
    if (flags[flag] !== undefined && flags[flag] !== "")
      result[property] = upper.includes(flag)
        ? String(flags[flag]).toUpperCase()
        : typeof flags[flag] === "string"
          ? flags[flag].trim()
          : flags[flag];
  return result;
}
export async function list(
  runtime: Runtime,
  api: string,
  path: string,
  key: string,
  command: Command,
  query: Data = {},
  pageSize = "pageSize",
  accept?: (item: Data) => boolean,
): Promise<Data> {
  const flags = command.flags;
  if (
    flags.max !== undefined &&
    (!Number.isInteger(flags.max) || flags.max <= 0)
  )
    throw new Error("max must be positive");
  let page = flags.page;
  let nextPageToken = "";
  const items: Data[] = [];
  const seen = new Set<string>();
  for (let pages = 0; pages < 50; pages++) {
    const response = await runtime.json(api, path, {
      query: {
        ...query,
        ...(pageSize ? { [pageSize]: flags.max } : {}),
        pageToken: page,
      },
    });
    const found = response[key] ?? [];
    if (!Array.isArray(found)) throw new Error("Invalid provider list");
    items.push(...(accept ? found.filter(accept) : found));
    nextPageToken = response.nextPageToken ?? "";
    if (
      !nextPageToken ||
      (!flags.all && (!accept || items.length >= (flags.max ?? 100)))
    )
      break;
    if (seen.has(nextPageToken)) throw new Error("Repeated pagination token");
    seen.add(nextPageToken);
    if (flags["scan-pages"] && pages + 1 >= flags["scan-pages"]) break;
    if (pages === 49) throw new Error("Pagination limit reached");
    page = nextPageToken;
  }
  if (flags["fail-empty"] && !items.length) throw new Error("No results");
  return {
    [key]: accept && !flags.all ? items.slice(0, flags.max ?? 100) : items,
    nextPageToken,
  };
}
