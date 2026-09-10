# Native password and passkey authentication

Add direct DurableClaw sign-in while preserving the existing single owner and
Cloudflare-only execution model. Credentials, sessions, WebAuthn challenges and
login limits live in a SQLite IdentityDO. Better Auth and its passkey plugin
provide the authentication protocols; a small tested adapter bridges DO SQLite.

There is no public registration or email-based owner claiming. The existing
verified Access identity provisions the owner. Initial credential enrollment has
a one-time fresh-token exception that closes permanently after enrollment.
Password recovery uses a fresh native passkey session or supported, verified
upstream `auth_time` evidence; an ordinary GitHub/Access application token is not
enough. Recovery does not send or consume emailed links. Passwords and passkeys
are entered by the user, never generated or enrolled by an agent.

## Implementation phases

1. Implement the identity DO, library adapter, owner bootstrap and restricted
   credential/session APIs. Fix origin, RP, user verification, fresh authentication,
   rate limiting and revocation rules in the server.
2. Integrate the outer Worker and frontend sign-in/account settings. Retain legacy
   installations and existing device, connector and conversation ownership.
3. Run adversarial review and native Workers tests, including successful password
   and passkey ceremonies, replay, cross-origin, wrong-owner and revocation cases.
   Build and deploy additively behind the existing Access gate; validate before
   moving the gate to the exact `/api/auth/access` endpoint.

Independent make-check review covers the completed implementation before deployment.
The deployment keeps the current owner policy, Access audience and agent DO data.
The user completes actual credential enrollment. GitHub remains a sign-in method;
its ordinary application tokens do not authorize changing native credentials.

## Deployment status

Implemented, independently reviewed and deployed with the additive IdentityDO
migration. Native identity integration tests exercise real WebAuthn signatures,
and all 16 live application checks passed with a native session behind the
existing Access gate. The final Access path change awaits approval, followed by
user-controlled credential enrollment. See the [deployment report](../deployment-2026-09-09.md).

## References

- [Better Auth passkeys](https://better-auth.com/docs/plugins/passkey)
- [Better Auth security](https://better-auth.com/docs/reference/security)
- [Drizzle Durable SQLite](https://orm.drizzle.team/docs/sqlite/connect-cloudflare-do)
- [Durable Object transactions](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transaction)
