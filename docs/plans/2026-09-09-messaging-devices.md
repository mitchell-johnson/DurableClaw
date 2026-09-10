# Messaging plugins and macOS devices implementation plan

Subsequent authorized production deployment and live test results are recorded in [the deployment report](../deployment-2026-09-09.md).

**Goal:** Connect Telegram through an extensible messaging interface and let the agent run explicitly approved Bash commands on an owner's enrolled Macs.

**Architecture:** Reuse the authenticated owner/workspace identity and existing conversation engine. Provider adapters authenticate and normalize messages; owner-issued links associate an external sender with a conversation. Devices make outbound HTTPS requests signed with individual Ed25519 keys. Cloudflare Access verifies browser identity; the existing AUTH service contract remains available for multi-user deployments.

**Tech stack:** TypeScript, Cloudflare Workers/Durable Objects/D1, React, Node.js 22, macOS launchd, Web Crypto, Vitest.

## Decisions and boundaries

- Prefer Access with verified issuer/audience/signature and an explicit owner email over introducing password storage. Configuring Access disables the legacy bearer fallback. AUTH continues to support deployment-specific multi-user authorization.
- Device keys identify one enrolled device only. Enrollment uses a short-lived, single-use owner-issued code. Signatures cover protocol version, method, origin/path, timestamp, nonce, and body hash. Replays, expired signatures, wrong keys and revoked devices fail closed.
- A per-user LaunchAgent runs Bash without root or inbound listeners. Its key and state use private filesystem permissions. Full Bash intentionally has the installing user's privileges; it is not a sandbox and can access that user's files and credentials.
- Device selection, command, working directory and timeout are covered by the existing exact-argument confirmation protocol. Chat content and messaging plugins cannot approve execution. Device output is untrusted tool data.
- Commands are claimed once and are never automatically re-executed after ambiguous delivery or a daemon crash. Durable command/result records expose unknown/expired outcomes. Bound execution time, output, queue sizes and stored history.
- Telegram starts with private text chats, verified webhook secrets, stable numeric identities, owner-issued linking, deduplication and bounded plain-text replies. Plugins are trusted deployment code; adding one requires implementing the adapter contract and registering it.
- No production deployment or persistent service installation on this development machine is needed to deliver the implementation.

## Work checklist

- [x] Pull latest main; inspect auth, approvals, conversation runtime, migrations and tests.
- [x] Select architecture and document implementation sequence and security properties.
- [x] Phase 1: Implement messaging contract, registry, Telegram adapter, owner linking, replay protection and tests. Files: `src/channels/`, `migrations/0002_messaging.sql`, `tests/channels/`.
- [x] Phase 2: Implement device protocol, enrollment, ownership/revocation, durable command claims/results and approval-gated tools. Files: `src/devices/`, `migrations/0003_devices.sql`, `tests/devices/`.
- [x] Checkpoint: independently inspect initial interfaces and security boundaries; apply findings before final integration.
- [x] Phase 3: Implement installable macOS agent, signed polling, local execution/replay journal, launchd lifecycle and tests. Files: `device-daemon/`, `tests/device-daemon/`.
- [x] Phase 4: Integrate server routes, conversation delivery/tools, Access verification, browser connection/device management. Files: `src/server.ts`, `src/auth.ts`, `src/types/env.ts`, `src/durable-objects/NanoChatAgent.ts`, `src/app.tsx`, new focused UI components.
- [x] Phase 5: Add setup, plugin-authoring, security, install/uninstall, rollout and recovery documentation and configuration examples.
- [x] Phase 6: Run targeted negative tests, full unit/workerd suites, typecheck, formatting and production dry-run build. Run independent complete-code Checker then Decider; fix accepted defects and re-verify.

## Validation approach

Write failing behavioral tests before each implementation slice, then run the focused suite to green. Cover webhook forgery and linking isolation; revoked/expired/wrong-owner device credentials; signed-body and URL tampering and replay; exact-command approval; concurrent claims; ambiguous execution; shell timeout/output limits; secure installation paths and permissions. Exercise protocol across real Node signatures and Worker verification. Keep worker-native tests for integration with actual D1 and Durable Objects. Finish with `npm run check`, `npm test`, `npm run test:workers`, `npm run build`, and formatting checks.

## References

- [Telegram Bot API](https://core.telegram.org/bots/api): webhook secret headers and text delivery.
- [Cloudflare Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/): validate tokens at the Worker, including direct-origin requests.
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/): bounded input, explicit async ownership and secrets.

## Verification results

Validated on the completed feature branch `codex/messaging-device-plugins`, based on main commit `513d0b0` (the requested pull reported already up to date).

- Formatting check, TypeScript check and `git diff --check`: passed.
- Unit/component tests: 56 files, 527 tests passed.
- Native Cloudflare runtime tests: 7 files, 24 tests passed, including real D1 enrollment/claim/result and messaging link/deduplication.
- Node daemon tests: 22 passed. The generated launchd plist also passed macOS `plutil -lint`.
- Node signing / Worker Web Crypto interoperability and real shell startup-failure recovery: passed.
- Production build: Vite passed; Wrangler dry run passed (2,150.53 KiB, 382.75 KiB gzip). Nothing was deployed.
- Production dependency audit: zero advisories. Full audit reports four high development-tool advisories inherited through Sharp/Miniflare/Wrangler; no unrelated downgrade or forced dependency update was applied.

The independent checkpoint identified and resolved bodyless Access mutation headers, invalid spawn-failure exit codes, discarded busy-channel messages, missing timeout terminal frames, and unsupported automatic AUTH-service logout. Added current-owner authorization before confirmation decisions. The final Checker reviewed the integrated implementation and reported no remaining issues. The final Decider confirmed completion with no additional qualifying fixes.

Operational setup remains explicit: apply the two additive D1 migrations, configure Access and Telegram secrets/webhook, then pair and install on each user's Mac using the documented CLI. No live Telegram message, production deployment, actual enrollment or persistent service installation was performed in this development session.
