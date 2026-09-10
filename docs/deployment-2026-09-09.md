# Cloudflare deployment — 9 September 2026

Application: [DurableClaw](https://durable-claw.mitchell-125.workers.dev).

## Deployment

| Component                  | Deployed resource                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------- |
| Application Worker         | `durable-claw`                                                                         |
| Application version        | `044db93e-d2f1-478c-9393-d7312810751b`                                                 |
| Private connector Worker   | `durable-claw-connectors`, named `ConnectorEntrypoint`, no public route or preview URL |
| Connector version          | `bb96ffe5-5638-4dd3-972f-e2f0376b8dbe`                                                 |
| D1 control database        | `durable-claw-control` (`c191619b-bff9-4c12-a493-7e1104652632`)                        |
| Workspace R2 bucket        | Existing `durable-claw-workspace`, retained                                            |
| Google connector execution | Native TypeScript inside owner-scoped `ConnectorVault` Durable Objects                 |
| Native identity storage    | SQLite `IdentityDO`, additive `v3` migration                                           |

Applied D1 migrations `0001_control.sql`, `0002_messaging.sql` and `0003_devices.sql`. Preserved the existing NanoChatAgent namespace and its `v1` migration; added ResearchSubagent with `v2` and IdentityDO with `v3`. Native authentication uses Durable Object SQLite, not D1. No container or Go process is deployed. The native source fork is [mitchell-johnson/gogcli, codex/durableclaw-connector](https://github.com/mitchell-johnson/gogcli/tree/codex/durableclaw-connector), commit `6e2ca7bd8ff0b662fa94e220443ee8b86f32949b`.

Chat, background work and housekeeping use `google/gemini-3.8-flash` through OpenRouter, pinned to `google-ai-studio` with provider fallback disabled. Background reasoning is `high`, supported by this model. Pinned housekeeping uses bounded synchronous inference coordinated by Durable Object alarms because the Batch API cannot enforce the provider pin.

The supplied API key and independently generated internal authentication/encryption keys are Cloudflare secrets. Source and frontend assets contain no deployment credentials. Access verifies the configured application audience, team issuer and exact owner identity. The unused temporary `AGENT_TOKEN` was removed from the deployed Worker after successful Access verification.

Installation-specific configurations are retained locally, ignored by Git, in `.wrangler/deploy/main.jsonc` and `.wrangler/deploy/connector.jsonc`. They contain resource identifiers and nonsecret settings. Existing Worker secrets are preserved on redeployment:

```sh
npx vite build
npx wrangler deploy --config .wrangler/deploy/connector.jsonc
npx wrangler deploy --config .wrangler/deploy/main.jsonc
```

## Verification

- 929 unit/frontend tests passed across 74 files.
- 53 existing Workers integration tests passed across 11 files, including native-session socket enforcement.
- 18 native identity integration tests passed, including real signed WebAuthn ceremonies, password authentication, challenge replay, credential recovery, and live socket revocation/expiry.
- 7 connector Durable Object tests passed.
- 23 deterministic deployment-harness tests passed.
- TypeScript checks, vendor integrity verification, formatting, Vite build and both Worker bundles passed.
- A live OpenRouter request verified the exact model and returned provider `Google AI Studio`.

All 16 live smoke checks passed against native-auth code version `6055c3cb-a91e-40ae-bfb2-a1962dc1f567` in 18.991 seconds, with exit status 0. The subsequent version above changes only Telegram secrets. The staged deployment presented both the existing Access cookie and a native session cookie, and required the application to confirm native authentication. This includes authorization, static security headers, D1 registries, the private connector binding, a real Gemini tool-result round trip, socket ticket replay rejection, persisted conversation messages and verified cleanup. The earlier test conversation was also deleted and verified absent. Live testing exposed an empty streamed DELETE-body issue, now fixed and regression-tested. Runtime tests also reproduced and fixed unsupported `redirect: "error"` request options; manual redirect handling continues to reject redirect responses.

The smoke harness uses a generated conversation, calls only `list_service_connections({})`, verifies the model response and stored messages, and deletes only its own conversation. See [reproduction instructions](deployment-smoke.md).

## Email OTP sign-in correction

The DurableClaw Access application (`678f96e6-fc1f-4d45-bd8b-407d174bf71c`) now permits only its existing GitHub provider (`7cf835cb-1885-49e0-aa37-0d3788644d0e`) and uses instant authentication. This removes emailed OTP links from this application's sign-in flow. The hostname, audience, 24-hour application session setting and `Allow Mitchell` policy (`dbe178a4-36cf-456d-a7eb-40d50a4426d7`) were retained. Organization-wide login methods and other applications were not modified.

The change was applied through the authenticated Cloudflare dashboard because the supplied API token still cannot manage Access. A fresh unauthenticated browser visit redirected directly to GitHub's Cloudflare Access authorization flow, with no email OTP form. All 16 authenticated deployment integration checks passed again in 17.9 seconds, including the model/tool round trip, rejected forged credentials, persisted messages and verified cleanup. No Worker redeployment was required.

## Telegram configuration

Verified the supplied bot token with Telegram `getMe` as [DurableClawBot](https://t.me/DurableClawBot). Installed `TELEGRAM_BOT_TOKEN` and an independently generated 32-byte random `TELEGRAM_WEBHOOK_SECRET` as Worker secrets. Registered `https://durable-claw.mitchell-125.workers.dev/api/messaging/webhooks/telegram` with `allowed_updates: ["message"]`, `max_connections: 1`, and the matching secret. Pending updates were not dropped. Telegram `getWebhookInfo` confirmed the URL and settings, with zero pending updates and no reported delivery error at setup time.

A probe with no message payload, sent through the existing owner Access session, returned HTTP 401 with missing and incorrect webhook secrets, and HTTP 200 with the correct secret. These probes do not link accounts, dispatch agent turns, or send Telegram messages.

After explicit approval, created the separate Access application **DurableClaw Telegram webhook** (`1a4a56e7-f416-4b32-9ef5-431ff0f2041d`) for `durable-claw.mitchell-125.workers.dev/api/messaging/webhooks/telegram`, with Bypass policy **DurableClaw Telegram webhook proof** (`f61258a5-dffc-49e4-87fd-14e644dca3aa`), including Everyone. The Worker's webhook secret verification remains mandatory. The original hostname application and owner policy were retained.

All ten live checks passed after applying the exception. Anonymous message-free webhook probes returned JSON 401 for missing/wrong secrets and JSON 200 for the correct secret, without Access cookies. The root page, owner messaging APIs, a sibling webhook path and device enrollment still redirected to Access. An authenticated owner request reported Telegram configured. Telegram confirmed the registered URL, message-only updates and one connection, with zero pending updates. Its status retained a historical HTTP 302 error from the Access-blocked period. A real linked conversation round trip still requires the owner to send the linking command and a message privately to the bot; setup did not perform those actions.

## Remaining account setup

- Native password/passkey support is deployed. The hostname-wide Access gate remains in place pending approval to narrow it to the exact `/api/auth/access` path. Direct sign-in therefore still requires GitHub at the edge. Deployment did not enroll credentials on the owner's behalf; the owner completes this personally in Settings → Account security after fresh initial GitHub authentication. See [native authentication](native-auth.md).
- Google OAuth client credentials and owner consent are not configured. The private connector is deployed, but live Google reads/writes have not been exercised. No Gmail message was sent or modified. See [service connector setup](service-connectors.md).
- Telegram credentials, webhook registration and the webhook Access exception are complete. Owner linking remains: select a conversation → Connections → Link Telegram, then personally send the displayed `/start CODE` privately to DurableClawBot within ten minutes and refresh connections. No live Telegram message was sent by setup.
- The Access edge gate still blocks the three device-ingress paths. Narrowing Access to `/api/auth/access` would let those paths reach their existing application-level signed device checks. Access-only installations instead need the three device exceptions in [Access setup](access-security.md); the Telegram exception is now applied. The current Wrangler OAuth grant and supplied account API token cannot manage Access, so this deployment uses the authenticated dashboard for Access changes. The owner policy has been retained.
- The macOS LaunchAgent is implemented and locally tested; no real device was enrolled or installed by the deployment smoke. Each device needs explicit pairing and installation after machine ingress is configured.

These account- and device-dependent checks remain separate from the authenticated cloud application integration run.
