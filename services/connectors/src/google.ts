import {
  PUBLIC_GOOGLE_SERVICES,
  OIDC_SCOPES,
  normalizeScope,
} from "./google-metadata";
export { normalizeScope } from "./google-metadata";
import {
  delegationConfigured,
  delegatedAccessToken,
  GMAIL_SETTINGS_SCOPES,
  validateDelegatedAccount,
} from "./delegation";
import type { ServiceProvider, ProviderGrant } from "./providers";
import {
  ConnectorError,
  fields,
  record,
  textValue,
  validateGmailOperation,
} from "./validation";

export function googleGrant(input: Record<string, unknown>): ProviderGrant {
  fields(input, ["provider", "services"]);
  if (
    !Array.isArray(input.services) ||
    !input.services.length ||
    input.services.length > PUBLIC_GOOGLE_SERVICES.length ||
    input.services.some((item) => typeof item !== "string")
  )
    throw new ConnectorError(400, "Select Google services to authorize");
  const services = [...new Set(input.services as string[])].sort();
  const scopes = [...OIDC_SCOPES];
  for (const id of services) {
    const service = PUBLIC_GOOGLE_SERVICES.find((item) => item.service === id);
    if (!service) throw new ConnectorError(400, "Unsupported Google service");
    if (id !== "keep")
      scopes.push(
        ...service.scopes.filter((scope) => scope !== GMAIL_SETTINGS_SCOPES[1]),
      );
  }
  return { services, scopes: [...new Set(scopes.map(normalizeScope))].sort() };
}

function scalar(value: unknown): boolean {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}
function safeFileName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    value
      .split("/")
      .every((part) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(part))
  );
}

function commandService(command: string): string {
  if (command.startsWith("drive.activity.")) return "driveactivity";
  if (command === "drive.labels.get" || command === "drive.labels.list")
    return "drivelabels";
  if (command.startsWith("drive.labels.file.")) return "drive";
  if (command.startsWith("photos.picker.")) return "photospicker";
  return command.split(".")[0];
}
function needsMaps(execution: { arguments: Record<string, unknown> }): boolean {
  const command = String(execution.arguments.command);
  const flags = (execution.arguments.flags ?? {}) as Record<string, unknown>;
  return (
    command.startsWith("maps.") ||
    ((command === "calendar.create" || command === "calendar.update") &&
      [flags["location-search"], flags["place-id"]].some(
        (value) => typeof value === "string" && value.length > 0,
      ))
  );
}

// These Gmail methods require Workspace delegation even for the account owner.
// https://developers.google.com/workspace/gmail/api/guides/delegate_settings
// https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.settings.sendAs/update
const DELEGATED_GMAIL_COMMANDS = new Set([
  "gmail.settings.delegates.add",
  "gmail.settings.delegates.get",
  "gmail.settings.delegates.list",
  "gmail.settings.delegates.remove",
  "gmail.settings.autoforward.update",
  "gmail.settings.forwarding.create",
  "gmail.settings.forwarding.delete",
  "gmail.settings.sendas.create",
  "gmail.settings.sendas.delete",
  "gmail.settings.sendas.verify",
]);
const DELEGATED_GMAIL_METHODS = new Set([
  "gmail.users.settings.delegates.create",
  "gmail.users.settings.delegates.get",
  "gmail.users.settings.delegates.list",
  "gmail.users.settings.delegates.delete",
  "gmail.users.settings.updateAutoForwarding",
  "gmail.users.settings.forwardingAddresses.create",
  "gmail.users.settings.forwardingAddresses.delete",
  "gmail.users.settings.sendAs.create",
  "gmail.users.settings.sendAs.delete",
  "gmail.users.settings.sendAs.verify",
]);
function delegatedProfile(
  execution: { arguments: Record<string, unknown> },
  account: string,
): "keep" | "gmail-settings" | undefined {
  const { command, positionals, flags } = execution.arguments;
  const args = Array.isArray(positionals) ? positionals : [];
  if (
    String(command).startsWith("keep.") ||
    (command === "api.call" && args[0] === "keep")
  )
    return "keep";
  if (DELEGATED_GMAIL_COMMANDS.has(String(command))) return "gmail-settings";
  let alias: unknown;
  if (command === "gmail.settings.sendas.update") alias = args[0];
  else if (command === "api.call" && args[0] === "gmail") {
    const method = String(args[2]).startsWith("gmail.")
      ? String(args[2])
      : `gmail.${String(args[2])}`;
    if (DELEGATED_GMAIL_METHODS.has(method)) return "gmail-settings";
    // PATCH changes the same alias as UPDATE; use the same nonprimary protection.
    if (
      method !== "gmail.users.settings.sendAs.update" &&
      method !== "gmail.users.settings.sendAs.patch"
    )
      return undefined;
    const params = (flags as Record<string, unknown> | undefined)?.params;
    try {
      alias = record(
        JSON.parse(typeof params === "string" ? params : "{}"),
      ).sendAsEmail;
    } catch {
      throw new ConnectorError(400, "Invalid Gmail API parameters");
    }
  } else return undefined;
  return typeof alias === "string" &&
    alias.trim().toLowerCase() === account.toLowerCase()
    ? undefined
    : "gmail-settings";
}
export const googleProvider: ServiceProvider = {
  id: "google",
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  revokeEndpoint: "https://oauth2.googleapis.com/revoke",
  profileEndpoint: "https://openidconnect.googleapis.com/v1/userinfo",
  scopes: OIDC_SCOPES,
  apiOrigins: ["https://www.googleapis.com"],
  oauth: (config) => ({
    clientId: config.GOOGLE_CLIENT_ID,
    clientSecret: config.GOOGLE_CLIENT_SECRET,
    redirectUri: config.GOOGLE_REDIRECT_URI,
  }),
  authorizationParameters: {
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "false",
  },
  grant(input, config) {
    const grant = googleGrant(input);
    if (grant.services.includes("keep") && !delegationConfigured(config))
      throw new ConnectorError(
        503,
        "Keep requires configured Workspace domain-wide delegation",
      );
    if (grant.services.includes("maps") && !config.GOOGLE_MAPS_API_KEY)
      throw new ConnectorError(
        503,
        "Maps requires a configured Google Maps API key",
      );
    return grant;
  },
  validateAccount(account, services, config) {
    if (services.includes("keep")) validateDelegatedAccount(config, account);
  },
  async executionToken(
    execution,
    config,
    account,
    subject,
    token,
    requestJson,
    now,
  ) {
    const profile = delegatedProfile(execution, account);
    if (!profile) return token;
    validateDelegatedAccount(config, account);
    // Workspace emails may be renamed and reassigned. Prove the current OAuth
    // token still identifies both the encrypted subject and email before DWD.
    const current = await requestJson(
      new Request("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
    if (!current.response.ok)
      throw new ConnectorError(502, "Could not revalidate Google identity");
    const identity = record(current.body);
    if (
      identity.email_verified !== true ||
      identity.sub !== subject ||
      identity.email !== account
    )
      throw new ConnectorError(
        409,
        "Google account identity changed; connector reauthorization required",
      );
    return delegatedAccessToken(profile, config, account, requestJson, now);
  },
  account(profile) {
    const info = record(profile);
    if (
      info.email_verified !== true ||
      typeof info.sub !== "string" ||
      !info.sub
    )
      throw new ConnectorError(502, "Could not verify Google account");
    const email = textValue(info.email, 320);
    if (!/^[^\s@]+@[^\s@]+$/.test(email))
      throw new ConnectorError(502, "Could not verify Google account");
    return email;
  },
  subject: (profile) => textValue(record(profile).sub, 255),
  validateOperation(operation, input) {
    if (
      operation === "gmail_search" ||
      operation === "gmail_get_message" ||
      operation === "gmail_get_thread"
    )
      return validateGmailOperation(operation, input);
    if (operation !== "gog_execute")
      throw new ConnectorError(400, "Unsupported Google operation");
    const args = record(input);
    fields(args, ["command", "positionals", "flags", "files", "output_files"]);
    const command = textValue(args.command, 200);
    if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(command))
      throw new ConnectorError(
        400,
        "Use a canonical command from the connector catalog",
      );
    if (
      args.positionals !== undefined &&
      (!Array.isArray(args.positionals) ||
        args.positionals.length > 64 ||
        !args.positionals.every((value) => typeof value === "string"))
    )
      throw new ConnectorError(400, "Invalid command arguments");
    if (args.flags !== undefined) {
      const flags = record(args.flags);
      if (
        Object.keys(flags).length > 100 ||
        Object.entries(flags).some(
          ([key, value]) =>
            !/^[a-z][a-z0-9-]*$/.test(key) ||
            !(
              scalar(value) ||
              (Array.isArray(value) &&
                value.length <= 100 &&
                value.every(scalar))
            ),
        )
      )
        throw new ConnectorError(400, "Invalid command flags");
    }
    if (args.files !== undefined) {
      if (!Array.isArray(args.files) || args.files.length > 8)
        throw new ConnectorError(400, "Too many command files");
      let total = 0;
      const names = new Set<string>();
      for (const file of args.files) {
        const item = record(file);
        fields(item, ["name", "content_base64"]);
        const name = textValue(item.name, 200);
        if (
          !safeFileName(name) ||
          names.has(name) ||
          typeof item.content_base64 !== "string" ||
          item.content_base64.length % 4 !== 0 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(item.content_base64)
        )
          throw new ConnectorError(400, "Invalid command file");
        names.add(name);
        total +=
          Math.floor((item.content_base64.length * 3) / 4) -
          (item.content_base64.endsWith("==")
            ? 2
            : item.content_base64.endsWith("=")
              ? 1
              : 0);
      }
      if (total > 4 * 1024 * 1024)
        throw new ConnectorError(413, "Command files exceed 4 MiB");
    }
    if (
      args.output_files !== undefined &&
      (!Array.isArray(args.output_files) ||
        args.output_files.length > 8 ||
        args.output_files.some((name) => !safeFileName(name)) ||
        new Set(args.output_files).size !== args.output_files.length)
    )
      throw new ConnectorError(400, "Invalid output files");
    return { operation, arguments: args };
  },
  requiresConfirmation: (execution) => execution.operation === "gog_execute",
  authorizeExecution(execution, services) {
    const service = execution.operation.startsWith("gmail_")
      ? "gmail"
      : commandService(String(execution.arguments.command));
    // Broad Google OAuth scopes must not bypass the user's per-service selection.
    const discoveryServices: Record<string, string[]> = {
      gmail: ["gmail"],
      calendar: ["calendar"],
      drive: ["drive"],
      docs: ["docs"],
      sheets: ["sheets"],
      slides: ["slides"],
      tasks: ["tasks"],
      chat: ["chat"],
      people: ["people", "contacts"],
      classroom: ["classroom"],
      admin: ["admin"],
      keep: ["keep"],
      forms: ["forms"],
      meet: ["meet"],
      script: ["appscript"],
      driveactivity: ["driveactivity"],
      drivelabels: ["drivelabels"],
      photoslibrary: ["photos"],
      photospicker: ["photospicker"],
      cloudidentity: ["groups"],
      youtube: ["youtube"],
      adsense: ["adsense"],
      analyticsadmin: ["analytics"],
      analyticsdata: ["analytics"],
      searchconsole: ["searchconsole"],
      webmasters: ["searchconsole"],
      // Connected Sheets grants include read access to its BigQuery datasource.
      bigquery: ["sheets"],
    };
    const allowed =
      execution.arguments.command === "api.call"
        ? (
            discoveryServices[
              String((execution.arguments.positionals as unknown[])?.[0])
            ] ?? []
          ).some((name) => services.includes(name))
        : service === "api" || services.includes(service);
    if (!allowed)
      throw new ConnectorError(
        403,
        "Authorize this Google service before using its commands",
      );
    const command = String(execution.arguments.command);
    const flags = execution.arguments.flags as
      Record<string, unknown> | undefined;
    const needsContacts =
      command === "calendar.users" ||
      command === "people.search" ||
      (command === "gmail.search" && !!flags?.["from-contact"]);
    if (
      (needsContacts && !services.includes("contacts")) ||
      (command === "calendar.team" && !services.includes("groups"))
    )
      throw new ConnectorError(
        403,
        "Authorize the directory or group service required by this command",
      );
    if (needsMaps(execution) && !services.includes("maps"))
      throw new ConnectorError(
        403,
        "Authorize Maps before requesting a location lookup",
      );
  },
  prepareExecution(execution, accessToken, account, config) {
    if (needsMaps(execution) && !config?.GOOGLE_MAPS_API_KEY)
      throw new ConnectorError(
        503,
        "Maps requires a configured Google Maps API key",
      );
    return {
      transport: "native",
      result: "wrapped",
      request: new Request("http://connector/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...execution,
          access_token: accessToken,
          account_email: account,
          ...(execution.operation === "gog_execute" ? { confirmed: true } : {}),
          ...(needsMaps(execution)
            ? { maps_api_key: config!.GOOGLE_MAPS_API_KEY }
            : {}),
        }),
      }),
    };
  },
};
