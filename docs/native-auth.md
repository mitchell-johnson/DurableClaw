# Password and passkey sign-in

DurableClaw supports its existing owner signing in with email/password, a passkey,
or GitHub through Cloudflare Access. Authentication runs inside `IdentityDO` using
Better Auth 1.7.3 and its passkey plugin. Credentials, sessions, challenges and
login limits are stored in Durable Object SQLite, without another database,
container or hosted authentication service.

## Set up the owner

Configure `AUTH_ORIGIN` as the exact HTTPS application origin, `AUTH_SECRET` as a
separate random secret of at least 32 bytes, and the existing Access issuer,
audience and owner email. The Worker binds `IDENTITY` to `IdentityDO` using the
additive v3 migration. The DO creates its own tables.

Open `/api/auth/access` through the owner’s GitHub sign-in, then open **Settings →
Account security**. Within five minutes of the initial Access token being issued,
set a password or register a passkey. If initial setup says the login is too old,
use the explicit Access sign-out link and return to GitHub sign-in. Access logout
also signs the user out of other Access applications; the app never does this
automatically during setup.

The first successful credential permanently closes the initial enrollment
exception. The user can then sign in directly and add another passkey or a
password. Passwords must contain 15–128 characters. Passkeys require device user
verification and a discoverable credential. The RP ID is the configured hostname;
changing hostnames requires enrolling credentials for the new hostname.

There is no public registration, “first user wins,” email-based owner claiming,
or changing the owner email through the application.

## Recovery and sessions

Sign in with a passkey to set a new password. Password changes and recovery revoke
other sessions; removing a passkey also revokes other sessions. Logout revokes the
current session. Native chat connections check their session before commands and
outbound messages, including after hibernation.

Credential changes require authentication within five minutes. GitHub/Access
sign-in remains available, but an ordinary Access application token cannot reset
an existing password or add credentials. Only supported, verified upstream
`auth_time` evidence can grant that authority through Access; a newly issued
application token is not sufficient. If every native credential is lost and the
identity provider supplies no fresh authentication evidence, an operator must
restore access outside this UI. No emailed redemption links or codes are used.

Native sessions last at most 24 hours without refresh. Access-derived sessions
also expire no later than their source Access assertion. Cookies use the
`__Host-` prefix, Secure, HttpOnly and SameSite=Lax. They are never stored in browser
storage or returned as bearer credentials in JSON. Session lookup does not use a
cookie cache, so revocation is checked against durable storage.

## Deploying direct sign-in

First deploy and test with the existing hostname-wide Access gate. Once verified,
move that Access application to the exact `/api/auth/access` path, preserving the
owner policy, GitHub provider and audience. The remaining application is protected
by its native authentication checks. Leaving the hostname-wide gate in place
requires GitHub before users can reach password/passkey sign-in.

Machine ingress retains its own Telegram/device proofs; this change does not
authorize arbitrary device commands or service writes. Existing owner approvals
still apply.

## Validation

Run `npm run test:identity` for native workerd protocol and live socket tests, and
`npm run test:workers` for the existing agent integrations. Node tests separately
cover the Drizzle adapter’s transaction rollback and affected-row counts.
`npm run test:smoke` validates the bounded deployment harness.

After direct sign-in is enabled, the live harness accepts `SMOKE_AUTH_MODE=native`
and `SMOKE_AUTH_FILE` pointing to a mode-0600 file containing only the signed
`__Host-durableclaw.session_token` cookie value. It prints structural results,
creates one isolated test conversation, then deletes it.

During a staged deployment behind the original Access gate, also set
`SMOKE_ACCESS_FILE` to the private Access JWT file and `SMOKE_ACCESS_TEAM_DOMAIN`
to the configured team hostname. The harness then presents both cookies and
requires the application to confirm the native session.

## Implementation boundaries

The pinned Drizzle DO driver needs a small adapter for asynchronous storage
transactions and affected-row counts. The passkey plugin currently requests
optional verification in its internal verifier; server hooks additionally require
the verified user-presence/verification result, and authentication options request
verification explicitly. These behaviors are covered by real signed WebAuthn
ceremonies, not mocked crypto.

The owner-wide password limit is ten attempts per five minutes, combined with a
source limit. This prevents distributed guessing but can temporarily delay a
legitimate password login under attack; passkeys use a separate bounded category.

Sources: [Better Auth passkeys](https://better-auth.com/docs/plugins/passkey),
[Drizzle DO support](https://orm.drizzle.team/docs/sqlite/connect-cloudflare-do),
[Cloudflare session behavior](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/).
