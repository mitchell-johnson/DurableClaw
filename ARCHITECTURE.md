# DurableClaw Architecture

DurableClaw is the NanoClaw AI agent framework rebuilt on Cloudflare Durable Objects. It replaces the original monolithic Node.js application with a single Durable Object that runs at the edge, providing persistent AI conversations with built-in memory, file storage, and task scheduling.

## Design Decisions

### Single Durable Object over Microservice Topology

The original plan.md proposed two architectures:
1. **5-Object Microservice Topology** — separate DOs for orchestration, state, tools, scheduler, and channels
2. **Single DO Architecture** — consolidate everything into one class

**Decision: Single DO.** The microservice topology adds inter-DO RPC overhead, complex coordination, and debugging difficulty for no meaningful benefit at this stage. A single DO instance per conversation gives us:
- Zero-latency access to SQLite state (no network hops)
- Simpler error handling and transaction guarantees
- Easier debugging with one execution context
- Natural scaling since each conversation is already isolated in its own DO

This can be decomposed later if any component needs independent scaling, but premature distribution creates more problems than it solves.

### Extending AIChatAgent (Cloudflare Agents SDK)

Rather than building from scratch on raw `DurableObject`, we extend `AIChatAgent<Env>` from the `agents` package. This gives us:
- **Automatic message persistence** — `this.messages` is a `UIMessage[]` backed by SQLite (`cf_agents_state` table), managed by the SDK
- **WebSocket management** — hibernatable WebSocket connections with automatic reconnection
- **Scheduling** — `this.schedule()` API for delayed task execution via the Alarms API
- **Routing** — `routeAgentRequest()` handles WebSocket upgrade and HTTP routing to DO instances

Our application-specific tables (`group_memory`, `archived_messages`, `conversation_summaries`, `memory_meta`, `execution_log`) sit alongside the SDK's internal tables in the same SQLite database.

### Vercel AI SDK v6 over Workers AI

NanoClaw is specifically an Anthropic Claude agent. We use:
- **`@ai-sdk/anthropic`** — provider for Claude models
- **`ai` (Vercel AI SDK v6)** — `streamText()`, `tool()` with Zod schemas, `convertToModelMessages()`, `stepCountIs()` stop condition
- **`@cloudflare/ai-chat`** — chat-specific hooks (`useAgentChat`) wrapping the AI SDK with WebSocket transport

This gives us full control over the Claude model and prompt while benefiting from the AI SDK's tool execution loop and streaming infrastructure.

### R2 for File Storage

Files are stored in an R2 bucket (`durable-claw-workspace`) accessed via the `WORKSPACE` binding. The agent has tools to list, read, and write files directly. The `R2Workspace` class provides a higher-level abstraction with prefix-based namespace isolation for cases where multiple agents share a bucket.

### SQLite for State, Not KV

Durable Object SQLite (`this.ctx.storage.sql`) provides:
- Relational queries (vs KV's key-prefix scanning)
- Transactional writes
- Up to 10GB per DO instance
- Zero-latency access (same V8 isolate)

We use several custom tables:
- `group_memory` — persistent key-value store for cross-conversation context
- `archived_messages` — durable archive of chat messages for summary generation
- `conversation_summaries` — condensed long-term memory over archived chat windows
- `memory_meta` — metadata for recurring summary maintenance
- `execution_log` — audit trail of all tool executions with timing data

### V8 Isolate Security Model

The original NanoClaw used Linux containers for sandboxing. DurableClaw trades this for V8 isolate-level sandboxing:
- Each DO runs in its own V8 isolate with memory limits
- No filesystem access (R2 replaces local filesystem)
- No process spawning
- Network access limited to `fetch()`

This is a weaker isolation boundary than OS-level containers, but sufficient for the agent's needs since all "dangerous" operations (file I/O, scheduling) are mediated through defined tools.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Cloudflare Edge                           │
│                                                             │
│  ┌──────────────┐    ┌──────────────────────────────────┐   │
│  │ Static Assets│    │      Worker (server.ts)           │   │
│  │  (Vite SPA)  │    │                                    │   │
│  │  index.html  │◄───│  /api/*  → API routes              │   │
│  │  *.js, *.css │    │  /agents/* → routeAgentRequest()   │   │
│  └──────────────┘    │  else   → env.ASSETS.fetch()       │   │
│                      └────────────┬───────────────────────┘   │
│                                   │ WebSocket                  │
│                      ┌────────────▼───────────────────────┐   │
│                      │   NanoChatAgent (Durable Object)    │   │
│                      │                                      │   │
│                      │  ┌─────────────┐  ┌──────────────┐  │   │
│                      │  │  SQLite DB   │  │  AI SDK v6   │  │   │
│                      │  │             │  │              │  │   │
│                      │  │ group_memory│  │ streamText() │  │   │
│                      │  │ summaries   │  │ generateText()│ │   │
│                      │  │ exec_log    │  │ tool()       │  │   │
│                      │  │ cf_agents_* │  │ Claude API   │  │   │
│                      │  └─────────────┘  └──────────────┘  │   │
│                      │                                      │   │
│                      │  Tools: memory_store, memory_recall  │   │
│                      │         list_files, read_file,       │   │
│                      │         write_file, schedule_task    │   │
│                      └────────────┬───────────────────────┘   │
│                                   │                            │
│                      ┌────────────▼───────────────────────┐   │
│                      │        R2 Bucket (WORKSPACE)        │   │
│                      │    durable-claw-workspace            │   │
│                      └────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## Project Structure

```
durable-claw/
├── index.html              # Vite entry HTML
├── package.json            # Dependencies and scripts
├── tsconfig.json           # TypeScript config (ES2022, DOM, Workers types)
├── vite.config.ts          # Vite build config (React plugin)
├── wrangler.toml           # Cloudflare Workers deployment config
├── .dev.vars.example       # Template for secret environment variables
├── .gitignore
├── src/
│   ├── server.ts           # Worker entrypoint (routing)
│   ├── env.ts              # TypeScript Env interface (bindings)
│   ├── client.tsx          # React entry point
│   ├── app.tsx             # Chat UI (useAgent + useAgentChat)
│   ├── styles.css          # Global styles
│   ├── agent/
│   │   ├── index.ts        # NanoChatAgent DO class
│   │   ├── schema.ts       # SQLite schema initialization
│   │   └── memory.ts       # GroupMemory key-value wrapper
│   ├── storage/
│   │   ├── r2-workspace.ts # R2Workspace class (prefix-namespaced)
│   │   └── index.ts        # Barrel export
│   └── channels/
│       ├── whatsapp.ts     # WhatsApp channel (architecture placeholder)
│       └── index.ts        # Barrel export
└── dist/                   # Vite build output (static assets)
```

## Request Flow

### Chat Message

1. Browser opens WebSocket via `useAgent({ agent: "nano-chat-agent", name: sessionId })`
2. `routeAgentRequest()` in `server.ts` routes the WebSocket upgrade to the correct DO instance
3. `useAgentChat` sends messages over the WebSocket
4. `NanoChatAgent.onChatMessage()` fires:
   - Archives the current persisted chat window into `archived_messages`
   - Builds system prompt with summary memory + group memory + schedule context
   - Converts UI messages to model messages
   - Calls `streamText()` with Claude model and tool definitions
   - Streams response back via `result.toUIMessageStreamResponse()`
5. AI SDK handles the tool execution loop (up to 10 steps):
   - Claude decides to use a tool → SDK calls the tool's `execute` function
   - Tool result is sent back to Claude → Claude continues reasoning
   - Each tool execution is logged to `execution_log`
6. Final response streams back to the browser

### Static Assets

1. Request arrives at the Worker
2. `routeAgentRequest()` returns null (not an agent request)
3. `env.ASSETS.fetch(request)` serves static files from the Vite build
4. `not_found_handling = "single-page-application"` returns `index.html` for unmatched paths

### Scheduled Tasks

1. Agent calls `schedule_task` tool → `this.schedule(delaySeconds, "executeScheduledTask", description)`
2. Cloudflare Alarms API fires after the delay
3. `executeScheduledTask(description)` runs:
   - Stores a completion record in group memory
   - Logs the execution to `execution_log`

### Summary Maintenance

1. `onStart()` ensures a recurring interval schedule exists for `runMemoryMaintenance`
2. The maintenance callback archives any recent chat messages that are not already mirrored into `archived_messages`
3. Older archived windows, excluding the recent raw-chat buffer, are summarized with Claude
4. Summaries are written into `conversation_summaries`
5. Future chat turns inject the newest summaries into the system prompt as long-term memory

## Tools

| Tool | Description | Storage |
|------|-------------|---------|
| `memory_store` | Persist key-value pairs across conversations | SQLite `group_memory` |
| `memory_recall` | Retrieve stored memories by key | SQLite `group_memory` |
| `list_files` | List files in R2 workspace with optional prefix | R2 `WORKSPACE` |
| `read_file` | Read file content from R2 | R2 `WORKSPACE` |
| `write_file` | Write/overwrite files in R2 | R2 `WORKSPACE` |
| `schedule_task` | Schedule delayed task execution | Alarms API |

All tool executions are logged to `execution_log` with input, output, status, and timing data.

## Frontend

React SPA using inline styles (dark theme, terminal aesthetic):
- **`useAgent`** from `agents/react` — manages WebSocket connection to the DO
- **`useAgentChat`** from `@cloudflare/ai-chat/react` — wraps AI SDK's `useChat` with WebSocket transport
- Session ID from URL hash (bookmarkable) or localStorage
- Renders message parts: text (with code block highlighting), tool invocations (with state indicators)
- Connection status indicator (connecting/connected/closing/disconnected)

## Configuration

### wrangler.toml Bindings

| Binding | Type | Purpose |
|---------|------|---------|
| `AI` | Workers AI | Cloudflare AI binding (available but unused; we use Anthropic directly) |
| `ASSETS` | Fetcher | Static asset serving |
| `NANO_CHAT_AGENT` | Durable Object | The agent DO namespace |
| `WORKSPACE` | R2 Bucket | File storage |
| `ANTHROPIC_MODEL` | Var | Default model ID (`claude-sonnet-4-6`) |

### Secrets (`.dev.vars`)

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude access |

## WhatsApp Channel (Future)

Architecture is defined in `src/channels/whatsapp.ts` for WhatsApp integration via the Baileys library. This is currently a placeholder pending:
1. Validation that Baileys runs in Workers with `nodejs_compat`
2. QR code authentication flow design
3. Auth state persistence to R2

If Baileys cannot run in Workers, the fallback is an external WhatsApp gateway service that bridges messages to the DO via HTTP/WebSocket.

## Development

```bash
# Install dependencies
npm install

# Create .dev.vars from template
cp .dev.vars.example .dev.vars
# Edit .dev.vars to add your ANTHROPIC_API_KEY

# Start development server
npm run dev

# Type check
npm run check

# Build (frontend + worker dry-run)
npm run build

# Deploy to Cloudflare
npm run deploy
```

### Prerequisites

- Node.js 18+
- Cloudflare account with R2 enabled
- R2 bucket named `durable-claw-workspace` created via dashboard or `wrangler r2 bucket create durable-claw-workspace`
- Anthropic API key set as a secret: `wrangler secret put ANTHROPIC_API_KEY`
