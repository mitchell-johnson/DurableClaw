import type { ConnectorConfig } from "./core";
import { textValue, record, validateGmailOperation } from "./validation";
import { googleProvider } from "./google";

export interface ProviderOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}
export interface ProviderExecution {
  operation: string;
  arguments: Record<string, unknown>;
}
export interface PreparedProviderRequest {
  request: Request;
  transport: "native" | "http";
  result: "wrapped" | "json";
}
export interface ProviderGrant {
  services: string[];
  scopes: string[];
}

/** Trusted deployment code only. No request can supply a URL, header, scope, implementation, or credential setting. */
export interface ServiceProvider {
  id: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revokeEndpoint: string;
  profileEndpoint: string;
  scopes: readonly string[];
  apiOrigins: readonly string[];
  grant?(
    input: Record<string, unknown>,
    config: ConnectorConfig,
  ): ProviderGrant;
  validateAccount?(
    account: string,
    services: readonly string[],
    config: ConnectorConfig,
  ): void;
  executionToken?(
    execution: ProviderExecution,
    config: ConnectorConfig,
    account: string,
    subject: string,
    token: string,
    requestJson: (
      request: Request,
    ) => Promise<{ response: Response; body: unknown }>,
    now: number,
  ): Promise<string>;
  authorizeExecution?(
    execution: ProviderExecution,
    services: readonly string[],
  ): void;
  oauth(config: ConnectorConfig): ProviderOAuthConfig;
  authorizationParameters?: Readonly<Record<string, string>>;
  account(profile: unknown): string;
  subject?(profile: unknown): string;
  validateOperation(operation: unknown, args: unknown): ProviderExecution;
  requiresConfirmation(execution: ProviderExecution): boolean;
  prepareExecution(
    execution: ProviderExecution,
    accessToken: string,
    account?: string,
    config?: ConnectorConfig,
  ): PreparedProviderRequest;
}

export const gmailProvider: ServiceProvider = {
  id: "gmail",
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  revokeEndpoint: "https://oauth2.googleapis.com/revoke",
  profileEndpoint: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
  scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
  apiOrigins: ["https://gmail.googleapis.com"],
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
  account: (profile) => textValue(record(profile).emailAddress, 320),
  validateOperation: validateGmailOperation,
  requiresConfirmation: () => false,
  prepareExecution: (execution, accessToken) => ({
    transport: "native",
    result: "wrapped",
    request: new Request("http://connector/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...execution, access_token: accessToken }),
    }),
  }),
};

/** Add a reviewed provider here and its matching agent/UI manifest under src/connectors/. */
export const SERVICE_PROVIDERS: ReadonlyMap<string, ServiceProvider> = new Map([
  [gmailProvider.id, gmailProvider],
  [googleProvider.id, googleProvider],
]);
