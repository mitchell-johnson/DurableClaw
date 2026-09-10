import { importPKCS8, SignJWT } from "jose";
import type { ConnectorConfig } from "./core";
import { ConnectorError, record } from "./validation";

export const KEEP_SCOPE = "https://www.googleapis.com/auth/keep";
export const GMAIL_SETTINGS_SCOPES = [
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/gmail.settings.sharing",
] as const;
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export function delegationConfigured(config: ConnectorConfig): boolean {
  return (
    !!config.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON &&
    !!config.GOOGLE_WORKSPACE_DOMAIN
  );
}
export function validateDelegatedAccount(
  config: ConnectorConfig,
  email: string,
): void {
  const domain = config.GOOGLE_WORKSPACE_DOMAIN?.toLowerCase();
  if (
    !delegationConfigured(config) ||
    !domain ||
    !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(domain) ||
    domain.includes("..")
  )
    throw new ConnectorError(
      503,
      "Workspace delegation configuration required",
    );
  if (
    email.split("@").length !== 2 ||
    email.split("@")[1].toLowerCase() !== domain
  )
    throw new ConnectorError(
      403,
      "This Google account is outside the configured Workspace domain",
    );
}

export async function delegatedAccessToken(
  profile: "keep" | "gmail-settings",
  config: ConnectorConfig,
  email: string,
  requestJson: (
    request: Request,
  ) => Promise<{ response: Response; body: unknown }>,
  now: number,
): Promise<string> {
  validateDelegatedAccount(config, email);
  const scopes = profile === "keep" ? [KEEP_SCOPE] : [...GMAIL_SETTINGS_SCOPES];
  try {
    const account = record(
      JSON.parse(config.GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON!),
    );
    if (
      account.type !== "service_account" ||
      typeof account.client_email !== "string" ||
      !/^[^\s@]+@[^\s@]+\.gserviceaccount\.com$/.test(account.client_email) ||
      typeof account.private_key !== "string" ||
      account.private_key.length > 16_384
    )
      throw new Error("Invalid service account");
    const key = await importPKCS8(account.private_key, "RS256");
    const issued = Math.floor(now / 1000);
    const assertion = await new SignJWT({ scope: scopes.join(" ") })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(account.client_email)
      .setSubject(email)
      .setAudience(TOKEN_ENDPOINT)
      .setIssuedAt(issued)
      .setExpirationTime(issued + 3600)
      .sign(key);
    const upstream = await requestJson(
      new Request(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }),
      }),
    );
    const body = record(upstream.body);
    if (
      !upstream.response.ok ||
      body.token_type !== "Bearer" ||
      typeof body.access_token !== "string" ||
      !body.access_token ||
      body.access_token.length > 8192 ||
      /[\u0000-\u0020\u007f]/u.test(body.access_token) ||
      !Number.isInteger(body.expires_in) ||
      Number(body.expires_in) < 60 ||
      Number(body.expires_in) > 3600 ||
      (body.scope !== undefined &&
        (typeof body.scope !== "string" ||
          body.scope.split(" ").sort().join(" ") !==
            [...scopes].sort().join(" ")))
    )
      throw new Error("Invalid delegated token");
    return body.access_token;
  } catch {
    throw new ConnectorError(502, "Workspace delegation authorization failed");
  }
}
