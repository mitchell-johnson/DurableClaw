import { object } from "./catalog";
import { rejectDotSegments } from "./apis";
import { segment, type Command, type Data, type RequestOptions } from "./types";

interface Method {
  id: string;
  resource: string;
  name: string;
  spec: Data;
}
export function discoveryMethods(description: Data): Method[] {
  const result: Method[] = [];
  function visit(node: Data, resource = "", depth = 0) {
    if (depth > 16) throw new Error("Invalid Discovery document");
    for (const [name, spec] of Object.entries(node.methods ?? {})) {
      const definition = object(spec);
      result.push({
        id: definition.id || [resource, name].filter(Boolean).join("."),
        resource,
        name,
        spec: definition,
      });
      if (result.length > 10_000)
        throw new Error("Discovery document is too large");
    }
    for (const [name, nested] of Object.entries(node.resources ?? {}))
      visit(
        object(nested),
        [resource, name].filter(Boolean).join("."),
        depth + 1,
      );
  }
  visit(description);
  return result.sort((left, right) => left.id.localeCompare(right.id));
}
export function googleApiAddress(address: string): URL {
  const url = new URL(address);
  if (
    url.protocol !== "https:" ||
    !/(?:^|\.)googleapis\.com$/.test(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error("Unapproved Discovery destination");
  return url;
}
export function discoveryRequest(
  description: Data,
  method: Method,
  values: Data,
): { address: string; options: RequestOptions } {
  let path = String(method.spec.path ?? "");
  const schemas = { ...description.parameters, ...method.spec.parameters };
  if (
    Object.keys(values).some(
      (key) =>
        !Object.hasOwn(schemas, key) ||
        ["access_token", "oauth_token", "key"].includes(key),
    )
  )
    throw new Error("Unknown Discovery parameter");
  const query: Data = {};
  for (const [name, rawSchema] of Object.entries(schemas)) {
    const schema = object(rawSchema);
    const value = values[name];
    if (value === undefined || value === null) {
      if (schema.required) throw new Error(`Missing parameter ${name}`);
      continue;
    }
    if (schema.location === "path") {
      if (typeof value !== "string" && typeof value !== "number")
        throw new Error("Invalid path parameter");
      rejectDotSegments(String(value));
      path = path
        .replaceAll(`{${name}}`, segment(value))
        .replaceAll(
          `{+${name}}`,
          String(value).split("/").map(segment).join("/"),
        );
    } else query[name] = value;
  }
  if (/[{}]/.test(path) || path.startsWith("//") || path.includes("\\"))
    throw new Error("Invalid Discovery path");
  rejectDotSegments(path);
  const root = description.rootUrl
    ? String(description.rootUrl).replace(/\/$/, "") +
      "/" +
      String(description.servicePath ?? "").replace(/^\/|\/$/g, "")
    : String(description.baseUrl ?? "");
  const address = googleApiAddress(
    root.replace(/\/$/, "") + "/" + path.replace(/^\//, ""),
  );
  const methodName = String(method.spec.httpMethod ?? "");
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(methodName))
    throw new Error("Unsupported Discovery HTTP method");
  return {
    address: address.href,
    options: { method: methodName as RequestOptions["method"], query },
  };
}
export async function executeDiscovery(
  command: Command,
  transport: {
    request(
      address: string,
      authenticated: boolean,
      options?: RequestOptions,
    ): Promise<Data>;
    jsonInput(value: unknown): any;
  },
): Promise<unknown> {
  const f = command.flags;
  const [api, version, methodId] = command.positionals;
  if (command.command === "api.list")
    return transport.request(
      "https://www.googleapis.com/discovery/v1/apis",
      false,
      { query: f.all ? {} : { preferred: true } },
    );
  if (
    !/^[a-z][a-z0-9-]{0,62}$/.test(api) ||
    !/^[A-Za-z0-9_.-]{1,80}$/.test(version)
  )
    throw new Error("Invalid Discovery API or version");
  let description: Data;
  try {
    description = await transport.request(
      `https://www.googleapis.com/discovery/v1/apis/${segment(api)}/${segment(version)}/rest`,
      false,
    );
  } catch (error) {
    if (!(error instanceof Error) || !error.message.endsWith("(404)"))
      throw error;
    description = await transport.request(
      `https://${api}.googleapis.com/$discovery/rest`,
      false,
      { query: { version } },
    );
  }
  const methods = discoveryMethods(description);
  if (command.command === "api.describe" && !methodId)
    return {
      name: description.name,
      version: description.version,
      title: description.title,
      documentation_link: description.documentationLink,
      methods,
    };
  const method = methods.find(
    (entry) =>
      entry.id === methodId ||
      [entry.resource, entry.name].filter(Boolean).join(".") === methodId,
  );
  if (!method) throw new Error("Discovery method not found");
  if (command.command === "api.describe") return method;
  const parameters = object(transport.jsonInput(f.params ?? "{}"));
  const request = discoveryRequest(description, method, parameters);
  if (request.options.method !== "GET" && f["allow-write"] !== true)
    throw new Error("This method requires allow-write");
  if (
    f.scope &&
    (!Array.isArray(method.spec.scopes) ||
      !method.spec.scopes.includes(f.scope))
  )
    throw new Error("Scope is not listed for this method");
  if (f.body !== undefined && f.body !== "")
    request.options.body = transport.jsonInput(f.body);
  return transport.request(request.address, true, request.options);
}
