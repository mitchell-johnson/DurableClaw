# API and integration contracts

All `/api/agent/*`, `/api/events`, `/api/inbox`, `/api/socket-ticket`, and legacy-import requests require authentication. `/api/health` is public. Cross-origin browser requests are rejected; no wildcard CORS policy is installed.

## HTTP endpoints

| Method / path                                                     | Purpose                                                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `POST /api/agent/init`                                            | Ensure a conversation: `{ "conversation_id": "chosen-id", "pageContext": "optional text" }` |
| `GET /api/agent/conversations`                                    | List owned conversations                                                                    |
| `GET /api/agent/conversations/:id`                                | Conversation metadata                                                                       |
| `GET /api/agent/conversations/:id/messages`                       | Paginated message history                                                                   |
| `DELETE /api/agent/conversations/:id`                             | Cancel work and delete a conversation                                                       |
| `GET/PUT/DELETE /api/agent/persona`                               | Read, update, or reset preferences                                                          |
| `GET /api/agent/memories`                                         | Memory inventory; supports type, conversation, cursor and limit                             |
| `DELETE /api/agent/memories/:id`                                  | Forget one memory and dependent provenance                                                  |
| `POST /api/agent/memories/forget-all`                             | Start durable full forgetting; JSON body required by the endpoint                           |
| `POST /api/agent/conversations/:id/confirmations/:confirmationId` | `{ "decision": "confirmed" }` or `"declined"`                                               |
| `GET /api/agent/activity/wakes`                                   | Proactive run list                                                                          |
| `GET /api/agent/activity/wakes/:id`                               | Signals, research tasks, and synthesis transcript                                           |
| `POST /api/events`                                                | Submit an event for the authenticated owner/workspace                                       |
| `GET /api/inbox`                                                  | Recent durable notifications and proposed follow-ups                                        |
| `POST /api/socket-ticket`                                         | Mint a 30-second, single-use ticket for `{ "conversation_id": "id" }`                       |

The public router uses an explicit endpoint allowlist. Internal research results, memory-tier checks, initialization authority, and reconciliation surfaces cannot be selected through arbitrary proxy paths.

Example event:

```json
{
  "kind": "file.updated",
  "resource_id": "notes/project.md",
  "summary": "The project notes changed.",
  "salience": "medium"
}
```

Events are assigned the authenticated user/workspace. An observer reads them in sequence, and a wake stores cursors and dedupe keys. Build application observers with the same authorization invariant.

## WebSocket frames

Connect to `/api/agent/connect?conversation_id=id&ticket=opaque-ticket`. Tokens never go in socket URLs. A reconnect mints a new ticket. The socket is permanently bound to its conversation through a hibernating attachment.

Send:

```json
{
  "type": "message",
  "request_id": "unique-request-id",
  "content": "Research these documents."
}
```

`{ "type": "cancel", "request_id": "unique-request-id" }` stops one foreground request and its associated research. Omitting `request_id` stops the conversation's research batches as well. `{ "type": "clear" }` clears conversation messages. The browser transport filters stale request frames and independently upserts background deliveries by their stable message ID.

The complete frame vocabulary lives in `src/agent-core/protocol.ts` and `src/hooks/useAgentChat.ts`.

## Persona and MCP

A partial persona update may contain `identity_override`, `persona`, `enabled_tools`, `disabled_tools`, `reasoning_effort`, `memory_enabled`, `memory_settings`, `wake_interval_minutes`, `dream_interval_hours`, and `mcp_servers`. A denylist takes precedence. Response depth is `fast`, `thorough`, or null.

Example MCP configuration:

```json
{
  "mcp_servers": [
    {
      "name": "documents",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_SERVER_TOKEN" }
    }
  ]
}
```

The example host is a placeholder. Set `MCP_CREDENTIALS_SECRET` before providing headers. The server encrypts headers before SQLite persistence; the returned configuration contains an opaque `headers_encrypted` field, never plaintext credentials. Saving that field unchanged retains credentials. Replacing `headers` rotates them. Removing a server drops its configuration and invalidates discovery cache.

MCP tools use stable `mcp_<server>_<tool>_<hash>` aliases capped below 64 characters. Every remote execution uses the same server-issued approval mechanism as file mutations. The approval is bound to conversation, tool, exact canonical arguments, expiry, and single consumption. A model-supplied `confirmation_id` alone is insufficient. MCP model calls use `{ "arguments": { ...remoteInput }, "confirmation_id": "optional-approval-id" }`. The complete remote input schema is preserved inside `arguments` as a separate JSON Schema resource, including its definitions, references and root constraints. An existing schema `$id` is retained; schemas without one receive a stable neutral resource id so local references keep resolving within the remote schema. A remote property named `confirmation_id` remains ordinary data inside `arguments` and is included in the approval hash. Only the contents of `arguments` are sent to the MCP server, which validates its schema. The outer approval field is never forwarded.

## Authentication service

For multi-user deployments, add a trusted `AUTH` service binding. Its handlers must implement:

- `POST https://auth.internal/authenticate`: receive the original Authorization and Cookie headers; return `{ "userId": "id", "workspaceId": "id", "role": "owner" }` only for an active authenticated session.
- `POST https://auth.internal/authorize`: receive `{ "userId": "id", "workspaceId": "id" }` from the trusted Worker binding and return the current matching principal only when access remains valid.

Non-2xx, invalid principal data, or mismatched identities fail closed. IDs must contain 1–128 ASCII letters, digits, `_`, or `-`. The built-in file adapter gives `owner` write access and other authorized roles read access. Replace that policy together with your application's authorization adapter when additional roles are needed. Do not expose a trusted service's identity-only authorization endpoint publicly.

## Retrieval adapter

`RetrievalAdapter` defines `search`, `authorize`, `hydrate`, and `schema`. The built-in implementation lists and reads only the authenticated owner's R2 prefix. Semantic retrieval uses a separate document index and rechecks authorization after asynchronous search/reranking. Integrations must filter unauthorized hits before sending text to a reranker or model.

Custom tools must close over server-resolved identity and conversation state. Never expose owner/workspace IDs as model parameters. Mutations should use `defineConfirmTool`; research children must receive only the read-only factory.

Memory pagination advances over scanned inventory records, including records hidden by local staging or deletion rules. A response can contain an empty `memories` array and a non-null `next_cursor`; continue until the cursor is null.
