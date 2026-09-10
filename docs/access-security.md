# Browser and device authentication

This page describes Access-only installations. For direct email/password and
passkey sign-in, use the [native authentication configuration](native-auth.md),
which intentionally moves the Access gate to the exact owner bootstrap path only
after native protection has been deployed and verified.

Use Cloudflare Access for production browser sign-in and approvals. DurableClaw verifies Access JWT signatures with the team's public keys, requires issuer, audience, subject, issued-at and expiration claims, and maps only the configured owner email to the existing `owner/default` workspace. Merely protecting a hostname at the edge is insufficient: the Worker verifies each assertion itself, including requests sent directly to its origin.

## Configure Access

1. Create a self-hosted Access application for your DurableClaw HTTPS hostname. Use a hostname destination: Worker-level Access does not support the WebSocket upgrades required by chat. Use an Allow policy for your own identity, through your identity provider, with MFA required. Choose a short session duration appropriate for device administration.
2. Set `ACCESS_TEAM_DOMAIN` to `https://your-team.cloudflareaccess.com`, `ACCESS_AUD` to that application's audience tag, and `ACCESS_OWNER_EMAIL` to the owner's exact email address. Store these as deployment settings. They are not secret keys.
3. Keep `INTERNAL_AUTH_SECRET` configured with a separate random secret. Remove `AGENT_TOKEN` in production after verifying Access sign-in. Any nonempty Access setting disables the built-in bearer fallback; partial configuration denies access.
4. Allow these exact machine-ingress paths through Access without an interactive browser login. Use separate, narrowly scoped Bypass applications for `/api/devices/enroll`, `/api/devices/poll`, `/api/devices/result`, and `/api/messaging/webhooks/telegram`. Do **not** bypass `/api/devices/*`, `/api/messaging/*`, `/api/agent/*`, or the whole hostname. The Worker authenticates ingress with one-use enrollment codes, per-device signatures, or the Telegram webhook secret. The rest of the application remains behind Access.
5. Open the protected hostname. The app detects the authenticated session without requesting or storing a bearer token. Browser mutation requests use JSON, reject cross-origin Origin headers and cross-site Fetch metadata, and use the Access cookie through the edge. Sign out uses `/cdn-cgi/access/logout`.
6. Validate with a non-owner account and a direct-origin request: owner API requests must fail. Validate enrollment and webhook ingress still reach the application without granting owner API access. No Access policies are created automatically by this repository.

The owner mapping intentionally retains the existing single-owner workspace when migrating from bearer authentication. Changing `ACCESS_OWNER_EMAIL` transfers access to that entire workspace, including enrolled devices. Revoke devices and unlink messaging first when transferring ownership. Access policy/session revocation takes effect according to Access token lifetime; application-side background/device authority is the configured owner mapping, not a live IdP group lookup. Revoke a device in DurableClaw to immediately prevent its next claim.

For multi-user installations, retain the `AUTH` service binding described in [the API contract](api.md#authentication-service). That service takes precedence over the built-in Access mode and must validate forwarded assertions itself, resolve trusted user/workspace identity, and implement current `/authorize` decisions. Never trust an unsigned email or caller-selected owner header. The forwarded `cf-access-jwt-assertion` is untrusted input until the AUTH service verifies it. Cookie-service deployments must apply equivalent CSRF protection; the browser requests JSON mutations and the host rejects cross-site requests.

## Email link scanners and sign-in

For installations affected by email link scanning, select a configured OAuth/OIDC provider for the application instead of email One-time PIN. Cloudflare documents that mail security tools can consume an emailed OTP link before its recipient uses the code. Manually copying the code does not solve a code that has already been consumed. See [Cloudflare OTP troubleshooting](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/).

In the application's Authentication → Identity settings, turn off **Accept all available identity providers**, select the existing identity provider, and enable **Apply instant authentication** when exactly one provider is selected. The equivalent application settings are `allowed_idps: [existingProviderId]` and `auto_redirect_to_identity: true`. Preserve its destinations, owner Allow policy, MFA configuration and session duration. Do not delete organization-wide OTP, relax email scanning, or replace the owner policy. These settings are managed in Access; a Worker deployment does not change them.

## Device security model

Each Mac generates its own Ed25519 private key locally. The cloud stores only the public key and a hash of each short-lived pairing code. A signed request binds protocol version, device ID, HTTP method, HTTPS origin/path/query, timestamp, fresh nonce and body digest. A replay, modified request, wrong key, expired signature, revoked device or removed owner authority fails closed. Device credentials only authorize polling and result submission for that device. They cannot create approvals, enqueue commands, read other devices, or call owner APIs.

`run_device_bash` previews the device ID, command, absolute working directory and timeout. The existing server-issued confirmation is bound to those exact arguments and the conversation, expires after ten minutes, and is consumed once. Telegram and plugins cannot approve actions; the authenticated web UI does. A queued command expires after five minutes. Current device revocation, owner authority and tool policy are checked again before claim. A failed or absent tool-policy check never dispatches a command.

Approval consumption in the owner's Durable Object and queue insertion in D1 are separate writes. A crash between them can consume an approval without queuing a command; a fresh approval is then required. This favors avoiding duplicate execution over automatic recovery. Claims are atomic and never redelivered; the daemon records a job before launching Bash and uploads a persisted result idempotently. A lost claim response, expired result upload, or crash can leave an unknown outcome. Inspect the device before deliberately requesting another execution.

The service runs as the installing user, with no inbound listener or root requirement. This is **full Bash access**, not a sandbox. An approved command can access that user's files and credentials, including the daemon's key, and can deliberately detach processes. Output limits and process-group cleanup bound ordinary jobs but cannot contain a deliberately escaping command. Mac privacy permissions still apply. A compromised Worker/control plane can issue commands; TLS, Access and device signatures do not remove that trust. There is no claim that an approved command is intrinsically safe.

Revocation prevents future claims and result uploads. It does not remotely kill a command already running. Stop the LaunchAgent locally for immediate local interruption. Device command content and output are retained privately in D1 with bounded history; they may contain sensitive data and appear in the owning conversation when retrieved. They are not intentionally written to request logs. Device output is treated as untrusted data.

See [device API and protocol](devices-api.md), [Mac installation and recovery](device-daemon.md), and [messaging plugin setup](messaging.md).

## References

- [Cloudflare Workers Access and WebSocket limitations](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
- [Cloudflare Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Access policies and Bypass behavior](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)
- [Telegram webhook authentication](https://core.telegram.org/bots/api#setwebhook)
