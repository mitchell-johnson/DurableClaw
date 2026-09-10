import { API_BASES, rejectDotSegments } from "./apis";
import { decodeFile, encodeFile, filename, MAX_FILE_BYTES } from "./catalog";
import type { Command, RequestOptions, Runtime } from "./types";
import { executeDiscovery, googleApiAddress } from "./discovery";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MEDIA_HOST =
  /(?:^|\.)(?:googleusercontent\.com|usercontent\.google\.com|ggpht\.com)$/;
const SAFE_HEADERS = new Set([
  "content-type",
  "accept",
  "if-match",
  "if-none-match",
  "x-goog-fieldmask",
  "x-goog-user-project",
  "x-goog-upload-protocol",
  "x-goog-upload-command",
  "x-goog-upload-offset",
  "x-goog-upload-header-content-length",
  "x-goog-upload-header-content-type",
]);
export interface RuntimeOptions {
  accessToken: string;
  account: string;
  mapsKey?: string;
  fetch(request: Request): Promise<Response>;
  signal?: AbortSignal;
}
/** Per-invocation state only. No raw fetch or credential access is exposed to a command. */
export class NativeRuntime implements Runtime {
  readonly account: string;
  readonly signal: AbortSignal;
  private count = 0;
  private received = 0;
  private outputBytes = 0;
  private cleanupCount = 0;
  private cleanupSignal?: AbortSignal;
  private readonly files = new Map<string, Uint8Array>();
  private readonly outputs = new Map<string, Uint8Array>();
  constructor(
    private readonly inputCommand: Command,
    private readonly options: RuntimeOptions,
  ) {
    this.account = options.account;
    this.signal = AbortSignal.any([
      AbortSignal.timeout(30_000),
      ...(options.signal ? [options.signal] : []),
    ]);
    for (const file of inputCommand.files)
      this.files.set(file.name, decodeFile(file.content_base64));
  }
  private secrets(): string[] {
    return [this.options.accessToken, this.options.mapsKey ?? ""].filter(
      Boolean,
    );
  }
  private checkSecret(data: Uint8Array | string): void {
    const text = typeof data === "string" ? data : decoder.decode(data);
    if (this.secrets().some((secret) => text.includes(secret)))
      throw new Error("Invalid provider result");
  }
  input(reference: string): Uint8Array {
    const name = reference.startsWith("input:") ? reference.slice(6) : "";
    const bytes = this.files.get(name);
    if (!bytes) throw new Error("Input file was not supplied");
    return bytes.slice();
  }
  inputs(reference: string): { name: string; bytes: Uint8Array }[] {
    const name = reference.startsWith("input:") ? reference.slice(6) : "";
    if (!filename(name)) throw new Error("Invalid input directory");
    const files = [...this.files]
      .filter(([path]) => path.startsWith(name + "/"))
      .map(([path, bytes]) => ({
        name: path.slice(name.length + 1),
        bytes: bytes.slice(),
      }));
    if (!files.length) throw new Error("Input directory was not supplied");
    return files;
  }
  text(reference: string): string {
    return decoder.decode(this.input(reference));
  }
  jsonInput(value: unknown): any {
    if (typeof value !== "string") return value;
    if (value.startsWith("@input:")) value = this.text(value.slice(1));
    else if (value.startsWith("input:")) value = this.text(value);
    else if (value.startsWith("@"))
      throw new Error("JSON file must use input:NAME");
    try {
      return JSON.parse(value as string);
    } catch {
      throw new Error("Invalid JSON argument");
    }
  }
  outputName(command: Command, fallback = "artifacts/result"): string {
    const reference =
      command.flags.out ?? command.flags["out-dir"] ?? command.flags.dir;
    if (reference) {
      if (typeof reference !== "string" || !reference.startsWith("output:"))
        throw new Error("Invalid output reference");
      return reference.slice(7);
    }
    return command.output_files[0] ?? fallback;
  }
  output(
    rawName: string,
    value: Uint8Array | string,
  ): { name: string; bytes: number } {
    const name = rawName.replace(/^output:/, "");
    if (!filename(name)) throw new Error("Invalid output filename");
    const bytes = typeof value === "string" ? encoder.encode(value) : value;
    this.checkSecret(bytes);
    const size =
      this.outputBytes -
      (this.outputs.get(name)?.byteLength ?? 0) +
      bytes.byteLength;
    if (
      size > MAX_FILE_BYTES ||
      (!this.outputs.has(name) && this.outputs.size >= 32)
    )
      throw new Error("Output artifacts exceed the limit");
    this.outputs.set(name, bytes.slice());
    this.outputBytes = size;
    return { name, bytes: bytes.byteLength };
  }
  result(output: unknown): unknown {
    const serialized = JSON.stringify(output ?? null);
    if (encoder.encode(serialized).byteLength > 1024 * 1024)
      throw new Error("Command output exceeds the limit");
    this.checkSecret(serialized);
    return {
      output,
      files: [...this.outputs].map(([name, bytes]) => ({
        name,
        content_base64: encodeFile(bytes),
      })),
    };
  }
  async cleanupGoogleFile(
    fileId: string,
    permissionId?: string,
  ): Promise<void> {
    if (
      ![fileId, ...(permissionId === undefined ? [] : [permissionId])].every(
        (value) => /^[A-Za-z0-9_-]{1,200}$/.test(value),
      )
    )
      throw new Error("Invalid cleanup resource");
    if (++this.cleanupCount > 16)
      throw new Error("Cleanup request limit reached");
    // Cleanup has one small separate budget so an expired command can revoke a
    // permission it created. It cannot extend the command or change its target.
    const signal = (this.cleanupSignal ??= AbortSignal.timeout(3_000));
    signal.throwIfAborted();
    const request = new Request(
      `https://www.googleapis.com/drive/v3/files/${fileId}${permissionId === undefined ? "" : `/permissions/${permissionId}`}?supportsAllDrives=true`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${this.options.accessToken}` },
        signal,
        redirect: "manual",
      },
    );
    let stop = () => {};
    const interrupted = new Promise<never>((_, reject) => {
      stop = () => reject(new Error("Google image cleanup timed out"));
      signal.addEventListener("abort", stop, { once: true });
    });
    try {
      const response = await Promise.race([
        this.options.fetch(request).then((response) => {
          if (signal.aborted) {
            void response.body?.cancel().catch(() => {});
            throw new Error("Google image cleanup timed out");
          }
          return response;
        }),
        interrupted,
      ]);
      await response.body?.cancel();
      if (!response.ok && response.status !== 404)
        throw new Error("Google image cleanup failed");
    } finally {
      signal.removeEventListener("abort", stop);
    }
  }
  private async read(
    response: Response,
    limit = MAX_FILE_BYTES,
  ): Promise<Uint8Array> {
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    const abort = () => {
      void reader.cancel().catch(() => {});
    };
    this.signal.addEventListener("abort", abort, { once: true });
    try {
      for (;;) {
        this.signal.throwIfAborted();
        const part = await reader.read();
        this.signal.throwIfAborted();
        if (part.done) break;
        size += part.value.byteLength;
        this.received += part.value.byteLength;
        if (size > limit || this.received > 32 * 1024 * 1024)
          throw new Error("Provider response exceeds the limit");
        parts.push(part.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      this.signal.removeEventListener("abort", abort);
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return bytes;
  }
  async discovery(command: Command): Promise<unknown> {
    return executeDiscovery(command, {
      jsonInput: (value) => this.jsonInput(value),
      request: async (address, authenticated, options = {}) => {
        const url = googleApiAddress(address);
        for (const [key, raw] of Object.entries(options.query ?? {})) {
          if (["access_token", "oauth_token", "key"].includes(key))
            throw new Error("Credentials cannot be supplied as parameters");
          for (const value of Array.isArray(raw) ? raw : [raw]) {
            if (
              typeof value !== "string" &&
              typeof value !== "number" &&
              typeof value !== "boolean"
            )
              throw new Error("Invalid Discovery parameter");
            url.searchParams.append(key, String(value));
          }
        }
        const headers = new Headers();
        if (authenticated)
          headers.set("Authorization", `Bearer ${this.options.accessToken}`);
        const body =
          options.body === undefined ? undefined : JSON.stringify(options.body);
        if (body) headers.set("Content-Type", "application/json");
        if (body && encoder.encode(body).byteLength > MAX_FILE_BYTES)
          throw new Error("Discovery request exceeds the limit");
        const response = await this.fetch(
          new Request(url, {
            method: options.method ?? "GET",
            headers,
            body,
            redirect: "manual",
            signal: this.signal,
          }),
        );
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`Google request failed (${response.status})`);
        }
        const bytes = await this.read(
          response,
          authenticated ? MAX_FILE_BYTES : 16 * 1024 * 1024,
        );
        this.checkSecret(bytes);
        if (!bytes.length) return {};
        try {
          return JSON.parse(decoder.decode(bytes));
        } catch {
          throw new Error("Invalid Discovery response");
        }
      },
    });
  }
  private async fetch(request: Request): Promise<Response> {
    this.signal.throwIfAborted();
    if (++this.count > 100) throw new Error("Command request limit reached");
    let stop = () => {};
    const interrupted = new Promise<never>((_, reject) => {
      stop = () => reject(new Error("Command deadline reached"));
      this.signal.addEventListener("abort", stop, { once: true });
    });
    try {
      return await Promise.race([
        this.options.fetch(request).then((response) => {
          if (this.signal.aborted) {
            void response.body?.cancel().catch(() => {});
            throw new Error("Command deadline reached");
          }
          return response;
        }),
        interrupted,
      ]);
    } finally {
      this.signal.removeEventListener("abort", stop);
    }
  }
  private async request(
    api: string,
    path: string,
    options: RequestOptions = {},
    binary?: Uint8Array,
    mediaRedirect = false,
  ): Promise<Response> {
    const base = API_BASES[api];
    if (
      !base ||
      typeof path !== "string" ||
      path.includes("\\") ||
      path.startsWith("//") ||
      path.includes("://")
    )
      throw new Error("Invalid API destination");
    rejectDotSegments(path);
    const url = new URL("./" + path.replace(/^\//, ""), base);
    if (!url.href.startsWith(base) || url.username || url.password || url.hash)
      throw new Error("Invalid API destination");
    for (const [key, raw] of Object.entries(options.query ?? {})) {
      if (["access_token", "oauth_token", "key"].includes(key.toLowerCase()))
        throw new Error("Credentials cannot be supplied as parameters");
      if (raw === undefined || raw === null || raw === "") continue;
      for (const value of Array.isArray(raw) ? raw : [raw])
        url.searchParams.append(key, String(value));
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      if (!SAFE_HEADERS.has(name.toLowerCase()))
        throw new Error("Unsupported request header");
      headers.set(name, value);
    }
    if (api === "maps" || api === "places") {
      if (!this.options.mapsKey) throw new Error("Maps authorization required");
      if (api === "maps") url.searchParams.set("key", this.options.mapsKey);
      else headers.set("X-Goog-Api-Key", this.options.mapsKey);
    } else headers.set("Authorization", `Bearer ${this.options.accessToken}`);
    let body: BodyInit | undefined;
    if (binary) body = binary.slice().buffer;
    else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      if (!headers.has("Content-Type"))
        headers.set("Content-Type", "application/json");
    }
    if (
      body &&
      (typeof body === "string"
        ? encoder.encode(body).byteLength
        : (body as ArrayBuffer).byteLength) >
        8 * 1024 * 1024
    )
      throw new Error("Provider request exceeds the limit");
    const response = await this.fetch(
      new Request(url, {
        method: options.method ?? "GET",
        headers,
        body,
        redirect: "manual",
        signal: this.signal,
      }),
    );
    if (
      mediaRedirect &&
      (options.method ?? "GET") === "GET" &&
      response.status >= 300 &&
      response.status < 400
    )
      return response;
    if (!response.ok) {
      // Provider errors can contain personal data or credentials. Retain only status.
      await response.body?.cancel();
      throw new Error(`Google request failed (${response.status})`);
    }
    return response;
  }
  async json(
    api: string,
    path: string,
    options?: RequestOptions,
  ): Promise<any> {
    const response = await this.request(api, path, options);
    const bytes = await this.read(response);
    this.checkSecret(bytes);
    if (!bytes.length) return {};
    try {
      return JSON.parse(decoder.decode(bytes));
    } catch {
      throw new Error("Invalid Google response");
    }
  }
  async bytes(
    api: string,
    path: string,
    options?: RequestOptions,
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    const response = await this.request(api, path, options, undefined, true);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("Location");
      await response.body?.cancel();
      if (!location) throw new Error("Invalid media redirect");
      return this.externalBytes(location);
    }
    const bytes = await this.read(response);
    this.checkSecret(bytes);
    return {
      bytes,
      contentType:
        response.headers.get("Content-Type") ?? "application/octet-stream",
    };
  }
  async upload(
    api: string,
    path: string,
    bytes: Uint8Array,
    options: RequestOptions = {},
  ): Promise<any> {
    const response = await this.request(
      api,
      path,
      { ...options, method: options.method ?? "POST" },
      bytes,
    );
    const body = await this.read(response);
    this.checkSecret(body);
    if (!body.length) return {};
    const type = response.headers.get("Content-Type") ?? "";
    if (type.includes("json")) {
      try {
        return JSON.parse(decoder.decode(body));
      } catch {
        throw new Error("Invalid upload result");
      }
    }
    return decoder.decode(body);
  }
  async externalBytes(
    address: string,
    authorization?: "photos-picker",
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    let url = new URL(address);
    for (let count = 0; count < 4; count++) {
      if (
        url.protocol !== "https:" ||
        !MEDIA_HOST.test(url.hostname) ||
        url.port ||
        url.username ||
        url.password ||
        url.hash
      )
        throw new Error("Unapproved media destination");
      const headers = new Headers();
      if (authorization === "photos-picker" && count === 0)
        headers.set("Authorization", `Bearer ${this.options.accessToken}`);
      const response = await this.fetch(
        new Request(url, { headers, redirect: "manual", signal: this.signal }),
      );
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("Location");
        await response.body?.cancel();
        if (!location) throw new Error("Invalid media redirect");
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Media download failed");
      }
      const bytes = await this.read(response);
      this.checkSecret(bytes);
      return {
        bytes,
        contentType:
          response.headers.get("Content-Type") ?? "application/octet-stream",
      };
    }
    throw new Error("Too many media redirects");
  }
}
