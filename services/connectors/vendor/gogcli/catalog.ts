import source from "./catalog.json";
import type { Command, Data } from "./types";

export interface Field {
  name: string;
  type: string;
  required?: boolean;
  enum?: string[];
  default?: string;
  cumulative?: boolean;
  file_mode?: string;
}
export const commands = source.commands;
const byName = new Map(commands.map((command) => [command.command, command]));
const encoder = new TextEncoder();
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export function filename(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    value
      .split("/")
      .every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(part))
  );
}
export function object(value: unknown): Data {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return value as Data;
}
export function closed(value: unknown, keys: readonly string[]): Data {
  const data = object(value);
  if (Object.keys(data).some((key) => !keys.includes(key)))
    throw new Error("Unknown argument");
  return data;
}
export function decodeFile(value: unknown): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 ||
    value.length % 4 ||
    /[^A-Za-z0-9+/=]/.test(value)
  )
    throw new Error("Invalid file encoding");
  const padding = value.indexOf("=");
  if (
    padding !== -1 &&
    (padding < value.length - 2 || !/^={1,2}$/.test(value.slice(padding)))
  )
    throw new Error("Invalid file encoding");
  const decoded = atob(value);
  if (decoded.length > MAX_FILE_BYTES) throw new Error("File is too large");
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}
export function encodeFile(bytes: Uint8Array): string {
  let value = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    value += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(value);
}
function fieldValue(
  field: Field,
  value: unknown,
  fromDefault = false,
): unknown {
  const type = field.type.replace(/^\*/, "");
  if (type === "[]string") {
    const items = typeof value === "string" ? [value] : value;
    if (!Array.isArray(items) || items.length > 100)
      throw new Error(`Invalid ${field.name}`);
    return items.map((entry) =>
      fieldValue({ ...field, type: "string" }, entry),
    );
  }
  if (type === "bool") {
    if (fromDefault && (value === "true" || value === "false"))
      return value === "true";
    if (typeof value !== "boolean") throw new Error(`Invalid ${field.name}`);
    return value;
  }
  if (["int", "int64", "float64"].includes(type)) {
    const number = fromDefault ? Number(value) : value;
    if (
      typeof number !== "number" ||
      !Number.isFinite(number) ||
      (type !== "float64" && !Number.isSafeInteger(number))
    )
      throw new Error(`Invalid ${field.name}`);
    return number;
  }
  if (
    typeof value !== "string" ||
    value.length > 64_000 ||
    value.includes("\0")
  )
    throw new Error(`Invalid ${field.name}`);
  if (field.enum?.length && !field.enum.includes(value))
    throw new Error(`Invalid ${field.name}`);
  if (
    type === "time.Duration" &&
    !/^(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h))+$/.test(value)
  )
    throw new Error(`Invalid ${field.name}`);
  return value;
}
export function parseCommand(raw: unknown): Command {
  const input = closed(raw, [
    "command",
    "positionals",
    "flags",
    "files",
    "output_files",
  ]);
  const definition = byName.get(input.command);
  if (!definition) throw new Error("Unknown command");
  const positionals = input.positionals ?? [];
  if (
    !Array.isArray(positionals) ||
    positionals.length > 64 ||
    positionals.some(
      (value) =>
        typeof value !== "string" ||
        value.length > 64_000 ||
        value.includes("\0"),
    )
  )
    throw new Error("Invalid positional arguments");
  const fields: Field[] = definition.positionals;
  const repeated = fields.at(-1)?.type === "[]string";
  if (
    (!repeated && positionals.length > fields.length) ||
    positionals.length < fields.filter((field) => field.required).length
  )
    throw new Error("Wrong number of positional arguments");
  const supplied = object(input.flags ?? {});
  const flags: Data = {};
  for (const [name, value] of Object.entries(supplied)) {
    const field = definition.flags.find((entry) => entry.name === name);
    if (!field) throw new Error(`Unknown flag ${name}`);
    flags[name] = fieldValue(field as Field, value);
  }
  for (const field of definition.flags as Field[]) {
    if (Object.hasOwn(flags, field.name)) continue;
    if (field.default !== undefined)
      flags[field.name] = fieldValue(field, field.default, true);
    else if (field.required) throw new Error(`${field.name} is required`);
  }
  if (encoder.encode(JSON.stringify({ positionals, flags })).length > 128_000)
    throw new Error("Arguments are too large");
  const files = input.files ?? [];
  if (!Array.isArray(files) || files.length > 8)
    throw new Error("Too many files");
  const names = new Set<string>();
  let bytes = 0;
  for (const rawFile of files) {
    const file = closed(rawFile, ["name", "content_base64"]);
    if (!filename(file.name) || names.has(file.name))
      throw new Error("Invalid input file");
    names.add(file.name);
    bytes += decodeFile(file.content_base64).byteLength;
  }
  if (bytes > MAX_FILE_BYTES)
    throw new Error("Input files exceed the byte limit");
  const outputs = input.output_files ?? [];
  if (
    !Array.isArray(outputs) ||
    outputs.length > 8 ||
    outputs.some((name) => !filename(name)) ||
    new Set(outputs).size !== outputs.length
  )
    throw new Error("Invalid output declarations");
  function checkFile(field: Field, rawValue: unknown) {
    if (!field.file_mode || rawValue === undefined || rawValue === "") return;
    for (let value of Array.isArray(rawValue) ? rawValue : [rawValue]) {
      if (typeof value !== "string") throw new Error("Invalid file reference");
      if (field.file_mode === "json_file") {
        if (!value.startsWith("@") && !value.startsWith("input:")) continue;
        value = value.replace(/^@/, "");
      }
      if (field.file_mode === "output" || field.file_mode === "output_dir") {
        if (
          definition!.command === "contacts.export" &&
          field.name === "out" &&
          value === "-"
        )
          continue;
        if (
          !value.startsWith("output:") ||
          !filename(value.slice(7)) ||
          !outputs.includes(value.slice(7))
        )
          throw new Error("Output file must be declared");
      } else if (field.file_mode === "state" && value.startsWith("output:")) {
        if (!outputs.includes(value.slice(7)))
          throw new Error("State output must be declared");
      } else {
        const name = value.startsWith("input:") ? value.slice(6) : "";
        if (
          !filename(name) ||
          (field.file_mode === "input_dir"
            ? ![...names].some((entry) => entry.startsWith(name + "/"))
            : !names.has(name))
        )
          throw new Error("Input file must be supplied");
      }
    }
  }
  for (const field of definition.flags as Field[])
    checkFile(field, flags[field.name]);
  fields.forEach((field, index) =>
    checkFile(
      field,
      repeated && index === fields.length - 1
        ? positionals.slice(index)
        : positionals[index],
    ),
  );
  return {
    command: definition.command,
    positionals,
    flags,
    suppliedFlags: Object.keys(supplied),
    files,
    output_files: outputs,
  };
}

export function describeCatalog(raw: unknown): unknown {
  const args = closed(raw, ["service", "command", "cursor", "limit"]);
  if (
    (args.service !== undefined && typeof args.service !== "string") ||
    (args.command !== undefined && typeof args.command !== "string") ||
    (args.cursor !== undefined && !/^\d{1,10}$/.test(args.cursor))
  )
    throw new Error("Invalid catalog filter");
  const limit = args.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20)
    throw new Error("Invalid catalog page size");
  const selected = commands.filter(
    (entry) =>
      (!args.service || entry.service === args.service) &&
      (!args.command || entry.command === args.command),
  );
  const offset = Number(args.cursor ?? 0);
  return {
    commands: selected.slice(offset, offset + limit),
    ...(offset + limit < selected.length
      ? { next_cursor: String(offset + limit) }
      : {}),
  };
}
