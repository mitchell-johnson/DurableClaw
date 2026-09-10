/** Ported Google API command handlers run inside the credential Durable Object.
 * Only Runtime may attach credentials or perform network I/O. */
export type Data = Record<string, any>;
export interface Command {
  command: string;
  positionals: string[];
  flags: Data;
  /** Flags explicitly present in the request, before CLI defaults are applied. */
  suppliedFlags?: readonly string[];
  files: { name: string; content_base64: string }[];
  output_files: string[];
}
export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Data;
  body?: unknown;
  headers?: Record<string, string>;
}
export interface Runtime {
  readonly account: string;
  readonly signal: AbortSignal;
  discovery(command: Command): Promise<unknown>;
  /** Best-effort removal of uploaded Google image files or temporary permissions. */
  cleanupGoogleFile(fileId: string, permissionId?: string): Promise<void>;
  json(api: string, path: string, options?: RequestOptions): Promise<any>;
  bytes(
    api: string,
    path: string,
    options?: RequestOptions,
  ): Promise<{ bytes: Uint8Array; contentType: string }>;
  externalBytes(
    url: string,
    authorization?: "photos-picker",
  ): Promise<{ bytes: Uint8Array; contentType: string }>;
  upload(
    api: string,
    path: string,
    bytes: Uint8Array,
    options?: RequestOptions,
  ): Promise<any>;
  input(reference: string): Uint8Array;
  inputs(reference: string): { name: string; bytes: Uint8Array }[];
  text(reference: string): string;
  jsonInput(value: unknown): any;
  output(
    name: string,
    bytes: Uint8Array | string,
  ): { name: string; bytes: number };
  outputName(command: Command, fallback?: string): string;
}
export type Handler = (input: Command, runtime: Runtime) => Promise<unknown>;
export type HandlerMap = Record<string, Handler>;
export const segment = (value: unknown): string =>
  encodeURIComponent(String(value));
export function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value)
    throw new Error(`${name} is required`);
  return value;
}
