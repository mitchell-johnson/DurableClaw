# External service connectors and Gmail

Subsequent authorized production deployment and live test results are recorded in [the deployment report](../deployment-2026-09-09.md).

**Goal:** Add an always-on external-service connector interface and full gogcli Google Workspace read/write integration, including Gmail, using the requested fork. Preserve the messaging and device work already on this branch.

**Architecture:** The conversation Durable Object calls typed connector tools through a private service binding. An owner/workspace credential Durable Object owns OAuth state, encrypted refresh tokens, Google account metadata, refresh coordination, disconnect and a durable invocation ledger. It executes a native TypeScript port of gogcli's 542 Google API commands in-process. All Google execution remains on Cloudflare Workers and Durable Objects. The conversation agent and its Bash tools never receive Google credentials.

The earlier native Go/container design was rejected by the user and removed before publication. Existing OAuth, approval, registry and UI work is retained. The Go bridge's tests and reviews do not validate the replacement port.

## Implementation checklist

- [x] Inspect upstream source and current Cloudflare documentation. Create https://github.com/mitchell-johnson/gogcli.
- [x] Implement private credential service, trusted connector registry, exact web approvals, authenticated owner routes and Google Workspace UI with explicit service grants.
- [x] Port communications, Docs/Sheets/Slides, Drive-related APIs, reporting, Classroom, Admin/Groups/Keep and Discovery commands to native TypeScript. Remove Dockerfiles, container classes/bindings and runtime dependency.
- [x] Validate behavior against upstream with semantic request tests and native Durable Object tests; check the exact 542-command catalog and bounded runtime/security contract.
- [x] Complete independent unified Checker and Decider reviews, fix accepted findings and repeat affected validation.
- [x] Publish the reviewed native port in the requested fork, vendor exact provenance and run full formatting, typechecks, unit/daemon/Worker suites and both production dry-run builds.

## Security boundaries

- The user explicitly expanded scope to full gogcli read/write compatibility. Generate canonical Google API command discovery from the pinned upstream schema. Generic commands, including sends, deletes and sharing changes, always require exact-argument web approval. The three audited Gmail read tools remain direct reads. File inputs and outputs use bounded in-memory file capabilities; shell hooks, credential/config commands and local daemons are outside the cloud API connector.
- Provider plugins and service bindings are trusted deployment code. Untrusted customer code is a future separate execution boundary, not a configuration toggle that receives credentials.
- The connector service has no public request endpoint. A named service entrypoint checks signed owner context, and the credential DO pins its owner/workspace. Every agent invocation rechecks current owner authority and persona policy.
- OAuth errors, tokens, client secrets and raw provider errors must not enter application logs or model output. Only bounded results and safe account metadata cross the service boundary. Email content remains untrusted data.
- Token ciphertext is authenticated against owner, workspace, connection and provider. Pending authorization state expires, is consumed once and cannot link an account into another workspace. Google endpoints and callback destinations are fixed configuration. The user selects service grants explicitly; the server derives approved scopes from the pinned provider manifest. Immutable Google subjects prevent email reuse from retargeting a connection.
- Every generic invocation consumes exact web approval and reserves a durable invocation ID before dispatch. Completed results may be fetched again; running/unknown invocations never dispatch twice. Permanent bounded tombstones fail closed on capacity exhaustion.
- Disconnect removes the local credential first and attempts Google revocation. In-flight API calls and already-issued Google access tokens cannot be recalled locally; disclose failed remote revocation without retaining local credentials.
- Full Bash on an enrolled Mac remains the previous feature's user-privilege boundary. Cloud Gmail credentials are separate from that device state.
- No live mailbox access, messages, production deployment or consent is performed while building. Google OAuth app setup and applicable restricted-scope verification remain operator steps.

## Review record

The native checkpoint review accepted three fixes: reject literal/encoded dot-segment API paths before URL normalization; route short and fully qualified Gmail Discovery method IDs through the same delegation policy; preserve Contacts export-to-stdout defaults. Each has regression tests.

Native completion round 1 accepted three further fixes: preserve source revision continuity across dependent Docs mutations; retain bounded cleanup diagnostics through native failures and owner-scoped durable receipts, including ambiguous public-permission creation and failed revocation; allow index zero in Docs header/footer segments while preserving body index rules. All are implemented with regressions. Round 2 independently verified the fixes and unintended side effects: Checker reported no issues and Decider returned `DONE`. No review items were rejected.

Makers compared command behavior with the pinned Go implementation and tested request construction, mutation order, pagination, MIME, file handling and Google request schemas. The shared runtime has negative tests for credential overrides, escaped destinations, media redirects, input/output limits, cancellation and no automatic write retries. Generic Discovery authorization tests enforce explicit service grants even when OAuth bundles overlap. All provider tests use fake HTTP; they do not establish live-account compatibility or Google policy approval.

## Final verification and provenance

- Root unit/component suites: 873 tests in 69 files passed.
- Native main Worker integration: 25 tests in eight files passed. Native connector Durable Object integration: seven tests passed, including known and ambiguous image-sharing failures through the full HTTP/native/vault/SQLite/owner-recovery path.
- Existing macOS daemon suite: 22 tests passed; connector work does not modify that implementation.
- Main and connector TypeScript checks, formatting, and both production dry-run builds passed. Connector bundle: 1,320.37 KiB, 248.95 KiB gzip, with only `ConnectorVault` as its stateful execution binding.
- Standalone fork package: 214 native tests in seven files, TypeScript and formatting passed. Its runtime dependencies are pinned to `marked@18.0.12` and `re2js@2.8.6`.
- Published native port: [commit 6e2ca7b](https://github.com/mitchell-johnson/gogcli/commit/6e2ca7bd8ff0b662fa94e220443ee8b86f32949b), branch `codex/durableclaw-connector`. Verified the remote branch SHA. All 38 vendored source files are byte-identical to this commit and SHA-256 pinned in `services/connectors/vendor/manifest.json`; `npm run check:vendor` checks the complete file set and dependency pins.
- Runtime adaptations and local-only CLI exclusions are documented in the vendor README. The port provides the 542-command Google API surface; optional native rendering and unbounded local listeners are not emulated.

Nothing was deployed, and no live Google account was connected or accessed. Configure the private connector deployment, Google OAuth client/consent, and required secrets before connecting an account through the UI. The earlier Telegram and device implementation remains intact.

## References

- [gogcli source](https://github.com/openclaw/gogcli/tree/29a5adfb3e90e2829ee75141773f148464bc801e)
- [gogcli MCP contract](https://github.com/openclaw/gogcli/blob/29a5adfb3e90e2829ee75141773f148464bc801e/docs/mcp.md)
- [Workers runtime support](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
- [Workers for Platforms](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/)
- [Google web OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Gmail authorization scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
