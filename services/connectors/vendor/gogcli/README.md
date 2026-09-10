# gogcli native Cloudflare port

Native TypeScript port of the Google API command surface in [openclaw/gogcli](https://github.com/openclaw/gogcli/tree/29a5adfb3e90e2829ee75141773f148464bc801e), upstream revision `29a5adfb3e90e2829ee75141773f148464bc801e`. Original source is MIT licensed; see `LICENSE`. The port is maintained in [mitchell-johnson/gogcli](https://github.com/mitchell-johnson/gogcli/tree/codex/durableclaw-connector/cloudflare).

All 542 canonical commands execute in-process within a Cloudflare Durable Object. `index.ts` validates that the static catalog and handler registry match exactly. No Go executable, filesystem subprocess, Docker runtime or external execution service is used. `nodejs_compat` supplies MD5 hashing for Drive synchronization; document parsing and RE2 regular expressions use pure JavaScript dependencies.

## Host contract

`executeNative(request, fetcher)` is an **internal function**, not a public Worker handler. The host must authenticate and authorize the owner, verify selected Google service grants, obtain exact action approval, reserve a durable invocation ID, and supply the correct short-lived credential before calling it. Do not expose it on a public route. The native library does not store refresh tokens, select accounts, grant permissions to its caller, or manage OAuth consent.

The private request paths are `POST /catalog` and `POST /execute`. Catalog requests contain only `service`, `command`, `cursor` and `limit` filters. Execute requests contain `operation`, `arguments`, `access_token`, optional `account_email` and optional `maps_api_key`; `gog_execute` additionally requires the host's `confirmed: true`. That boolean is an assertion from the trusted host, not an approval mechanism. Google operation arguments are the canonical `command`, string `positionals`, typed `flags`, `files` and `output_files` shown by the catalog.

Native handlers receive a restricted `Runtime`, not credentials or raw fetch. The runtime uses fixed Google API bases, strips credentials across media redirects, enforces deadlines and response limits, and never retries writes. Google Discovery metadata is fetched publicly; actual API calls carry the invocation's token. The host must enforce service selection for Discovery calls as well as canonical commands. Google still enforces enabled APIs, OAuth scopes, account permissions and organization policies.

## Runtime adaptations

- Local files become declared in-memory capabilities: `input:NAME`, `output:NAME`, and JSON `@input:NAME`. File names cannot address host paths. Returned file bytes are base64 artifacts for the host to store privately. Commands using stdout return structured JSON or text within `output`.
- Commands have a 30-second deadline, at most 100 provider requests, 4 MiB aggregate input/output artifacts, 1 MiB JSON output and 32 MiB cumulative response data. There are at most eight input files, eight output declarations and 32 returned artifacts. Pagination returns provider continuation tokens; operations requesting all pages can hit the bounded invocation limit.
- Poll/watch commands return a bounded snapshot and state/continuation for another invocation. They do not create local listeners or an unbounded loop. Terminal columns, colors, pretty-printing and overwrite prompts become structured results and deterministic memory artifacts.
- Credential/configuration commands, local daemons, shell hooks, browser launches, tracking-server setup and separate Zoom authorization are excluded. `catalog.json` lists excluded commands and unavailable flags. This is a Google API port, not a local shell interpreter.
- The host must make image-sharing effects visible during approval. Local image insertion follows gogcli's Google Drive upload flow, which grants anyone-with-the-link read permission for Google to fetch an image. An invocation uploads at most eight images. Docs removes temporary permission and retains the private source on success; Slides removes temporary source images. Cleanup has a separate three-second deadline and 16 narrow deletion/revocation requests. A failed revocation still attempts to delete an orphaned upload. Failed cleanup returns bounded `cleanup_required` file IDs and a boolean indicating whether public read permission may remain, including when the command itself fails. The host must retain those diagnostics with its durable invocation receipt for owner recovery. Network failure or abrupt process termination can interrupt cleanup; this is not an atomic Google transaction.
- Markdown transformations run in the DO. Optional Mermaid/FontAwesome executable rendering follows upstream's unavailable-renderer behavior: structured warnings and skipped optional assets, or a preflight error in strict mode. No private document content is sent to an external rendering service. Slidey title/center/columns/boxes/arrows, text styles, lists, tables, image links and speaker notes become editable Google objects using portable layout geometry; OS fonts and native renderer pixels are not emulated. Nested structural image/table content within a Markdown table cell requires a dedicated insertion command and is rejected explicitly rather than dropped.

## Updating

Regenerate the command catalog from the pinned upstream binary's `gog schema --json` output:

```sh
python3 generate-catalog.py schema.json catalog.json
```

Review new commands, scopes, file modes, flags and runtime controls before accepting an upstream update. A catalog match alone is insufficient: retain behavioral request tests for mutation order, defaults, selected resources, pagination, MIME, document indices and API request schemas. Native tests use fake Google endpoints and never access a real account.

The consuming application records the exact fork commit and file hashes in its separate vendor manifest so the manifest does not self-reference its own commit.
