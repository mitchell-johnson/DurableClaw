# Installation and development

This guide covers running your own DurableClaw installation, enabling optional features, and developing the project. For an overview of what you can do with the assistant, see the [README](../README.md).

## Local setup

Use Node.js 22.12 or later and npm. Cloudflare Workers AI needs an authenticated Cloudflare account; model generation needs an OpenRouter key. Unit and workerd tests run without model credentials or remote Cloudflare resources.

```sh
npm ci
cp .dev.vars.example .dev.vars
```

Set these values in `.dev.vars`:

| Setting                       | Purpose                                                              |
| ----------------------------- | -------------------------------------------------------------------- |
| `AGENT_TOKEN`                 | A long random bearer token for the default single-owner installation |
| `INTERNAL_AUTH_SECRET`        | A separate random secret signing internal object requests            |
| `OPENROUTER_API_KEY`          | OpenRouter model API access                                          |
| `CHAT_MODEL`                  | Tool-capable foreground model ID                                     |
| `BACKGROUND_MODEL`            | Tool-capable background research model ID                            |
| `BATCH_MODEL`                 | Housekeeping model; uses synchronous DO requests when pinned         |
| `OPENROUTER_PROVIDER`         | Optional exact provider slug, with fallback providers disabled       |
| `BACKGROUND_REASONING_EFFORT` | Background reasoning level supported by the selected model           |
| `MCP_CREDENTIALS_SECRET`      | A separate random secret when storing MCP credentials                |

Generate random secrets locally, for example with `openssl rand -hex 32`. Model IDs are deployment settings; verify tool support and provider availability for the IDs you choose. The current configuration selects `google/gemini-3.8-flash` through `google-ai-studio` and sets background reasoning to `high`. Pinned housekeeping executes in the Durable Object because OpenRouter's Batch API cannot enforce provider preferences. Foreground response depth remains user-controlled.

```sh
npx wrangler d1 migrations apply durable-claw-control --local
npm run dev
```

Open the local Worker URL and enter `AGENT_TOKEN`. The browser holds it in memory only. WebSockets use short-lived, single-use tickets bound to the authenticated identity and conversation. Refreshing the page requires signing in again.

The included workspace supports file search/read/list, approved writes and indexing, and durable scheduled inbox items. Application events can be submitted through `POST /api/events` to exercise proactive checks. Wakes and memory consolidation start disabled in each user's settings.

## Enable semantic memory and document search

Create separate 1024-dimension cosine Vectorize indexes:

```sh
npx wrangler vectorize create durable-claw-memory --dimensions=1024 --metric=cosine
npx wrangler vectorize create durable-claw-documents --dimensions=1024 --metric=cosine
```

Add bindings to `wrangler.toml`:

```toml
[[vectorize]]
binding = "MEMORY_INDEX"
index_name = "durable-claw-memory"

[[vectorize]]
binding = "DOCUMENT_INDEX"
index_name = "durable-claw-documents"
```

Create metadata indexes for the filters before writing vectors:

```sh
npx wrangler vectorize create-metadata-index durable-claw-memory --property-name=user_namespace --type=string
npx wrangler vectorize create-metadata-index durable-claw-memory --property-name=type --type=string
npx wrangler vectorize create-metadata-index durable-claw-memory --property-name=conversation_id --type=string
npx wrangler vectorize create-metadata-index durable-claw-documents --property-name=user_namespace --type=string
npm run types
```

Memory metadata is also stored in an exactly enumerable R2 inventory, so listing and forgetting do not depend on a vector query's top-K limit. The coordinator's local inventory controls recall tiers and deletion barriers. Without `MEMORY_INDEX`, ordinary chat and files remain available and semantic memory is unavailable. Without `DOCUMENT_INDEX`, document search falls back to filename matching.

## Deploy your installation

Create your own control database and workspace bucket:

```sh
npx wrangler d1 create durable-claw-control
npx wrangler r2 bucket create durable-claw-workspace
```

Replace the zero database ID in `wrangler.toml` with the ID returned by the command. Set your model IDs in `[vars]` and store production secrets with `wrangler secret put NAME`. Do not commit `.dev.vars`, secret values, account identifiers, or private data.

```sh
npx wrangler d1 migrations apply durable-claw-control --remote
npm run check
npm test
npm run test:workers
npm run build
npm run deploy
```

`build` bundles the client and runs a Worker dry run. Only `deploy` publishes the Worker. The `v1` Durable Object migration is retained; `v2` adds research objects and `v3` adds native identity storage. Do not rename an existing object binding/class or rewrite migration history during an upgrade.

## Authentication and integrations

The default token intentionally represents one owner in one workspace. For multiple users, attach an `AUTH` service binding implementing the [authentication contract](api.md#authentication-service). Identity comes from authentication; the public API does not accept caller-selected owner or workspace IDs.

For production device access, use the built-in [Cloudflare Access authentication](access-security.md). The browser automatically recognizes its Access session. Device keys authorize only device traffic; they never grant owner administration or approval access.

For direct email/password and passkey sign-in, enable [native authentication](native-auth.md). Credentials and sessions stay in a dedicated Durable Object. Initial setup uses the verified owner’s GitHub login; a recent passkey login can recover a password.

Apply the new D1 migrations, then use **Connections** in the web app to link Telegram to your current conversation and create a private pairing code for each Mac. Follow [Telegram setup and plugin authoring](messaging.md) and [Mac installation](device-daemon.md). The daemon requires Node.js 22.12 or newer and runs as the logged-in user. Bash has that user's full permissions, and each execution needs approval in the web app or through the linked Telegram approval buttons. See [device APIs and recovery semantics](devices-api.md).

Connect Gmail and other Google services through the [external service connector setup](service-connectors.md). A native TypeScript port of gogcli runs entirely inside a credential Durable Object, which owns OAuth and invocation recovery. Generic commands require exact web approval.

The included retrieval adapter is scoped to private workspace files. Implement `RetrievalAdapter` to connect application records, retaining authorization before reranking and hydration. Implement observers and inbox publication for your application through the documented interfaces. Remote MCP tools are optional and require explicit approval for execution.

## Development checks

For web browsing, follow [browser setup and behavior](browsing.md) to configure Browser Run and review the available engines.

The included `CODE_LOADER` binding enables isolated script execution. See [code execution](code-execution.md) for the script format, limits, and optional disablement. Scripts use no additional secrets or deployment namespaces.

```sh
npm run format:check
npm run check
npm run check:connectors
npm run check:vendor
npm test
npm run test:smoke
npm run test:device
npm run test:workers
npm run test:identity
npm run test:connectors
npm run build
npm run build:connectors
npm audit
```

The tests cover SQLite ordering/provenance, duplicate callbacks, restart recovery, deadlines, cancellation races, partial provider errors, credential and scope checks, MCP session behavior, exact memory enumeration, browser reconnect/approval behavior, device command recovery, native password/passkey sessions, and Google connector authorization. Native tests recreate objects against real local workerd storage; they do not claim to force a production eviction.
