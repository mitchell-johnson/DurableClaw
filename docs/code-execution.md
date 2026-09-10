# Code execution

The foreground assistant can call `execute_code` to write and run JavaScript for calculations, parsing, and data transformations, then use the returned result in its answer. Scripts are single-use: they do not become deployed applications or scheduled jobs.

## Platform choice

Research checked on 10 September 2026. [Workers for Platforms](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/) supports hosted user applications through dispatch namespaces. For this one-off execution tool, we use Cloudflare's [Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/), rather than uploading and deleting a deployment for every script. No containers or Cloudflare management API token are needed.

The [Worker Loader API](https://developers.cloudflare.com/dynamic-workers/api-reference/) provides `load()` for fresh one-off Workers. Each run receives only its own module and explicit JSON input, with an empty environment. The source is compiled inside the child Worker, never evaluated in the assistant's coordinator.

## Script format

Call `execute_code` with `code` and optional `input_json` (a JSON-encoded string, default `"null"`). The module must export a default function accepting the decoded input. It can be async and must return a JSON-serializable value. An undefined return becomes null.

```javascript
export default async function (input) {
  console.log("Processing", input.length, "rows");
  return {
    total: input.reduce((sum, row) => sum + row.amount, 0),
    count: input.length,
  };
}
```

For example, pass `input_json: '[{"amount":12},{"amount":8}]'`. The returned `output` contains `result`, `logs`, and `logs_truncated`, or an `error`. Import-time logs are captured too. Compilation or runtime failures can instead produce a top-level tool error. Outputs are untrusted data; the normal tool-output sanitizer may replace prompt-injection markers, so this is not a byte-exact file-transfer interface.

This tool supports JavaScript and standard Worker APIs, not a shell, Python, npm installation, TypeScript compilation, or a persistent filesystem. Read relevant workspace data with existing tools and pass it explicitly. Saving a result uses the normal approved file-writing tool.

## Access and limits

Network access is denied using [globalOutbound: null](https://developers.cloudflare.com/dynamic-workers/usage/egress-control/). Scripts receive no storage, browser, loader, service, or credential bindings. They cannot use code execution to bypass another tool's approval. Pure computation runs without a confirmation dialog, but requires current owner authorization and respects persona tool policy. Background research agents do not receive this tool.

| Limit                     | Value                                |
| ------------------------- | ------------------------------------ |
| Source / JSON input       | 32,000 characters each               |
| CPU                       | 1,000 ms per invocation              |
| Caller deadline           | 10 seconds, including output reading |
| Result                    | 24,000 JSON characters               |
| Console capture           | 8,000 characters / 40 entries        |
| Entire response           | 48,000 bytes, enforced by the parent |
| Concurrent calls          | One per live owner coordinator       |
| Calls per foreground turn | Eight                                |

CPU and subrequest limits are passed to the platform using [custom resource limits](https://developers.cloudflare.com/dynamic-workers/usage/limits/); subrequests are set to zero. The child-side result/log limits aid ordinary scripts but are not a trust boundary. The parent independently bounds the response stream. Cloudflare's plan limits still apply.

Stop and the caller deadline abort the request and stop waiting, including stalled output. They are not a promise of immediate isolate termination; the platform CPU limit remains the backstop. No script is automatically retried or resumed after cancellation or coordinator reconstruction. The concurrency gate and per-turn allowance are not persistent account-wide billing quotas.

## Setup and verification

The main and test Wrangler configurations include:

```toml
[[worker_loaders]]
binding = "CODE_LOADER"
```

No namespace creation or migration is required. Removing this binding disables the tool. Regenerate types with `npm run types` after configuration changes. Dynamic Workers currently require Workers Paid. Each `load()` invocation counts as a new Dynamic Worker for billing, in addition to request and CPU usage; this is not just CPU-based billing. Review [Dynamic Workers pricing](https://developers.cloudflare.com/dynamic-workers/pricing/) before deployment.

Run `npm run check`, `npm test`, `npm run test:workers`, and `npm run build`. Native tests exercise real local Worker loading, computation, logs, fresh state, blocked network access, empty bindings, and tool registration. Unit tests cover authorization, policy, limits, cancellation, output bounds, and failure cleanup. Local tests do not establish production CPU enforcement or billing behavior.

After deployment, ask the assistant to sum `[1,2,3]` using a script, print a log, and return the total. Check the result is 6. Verify a network request fails and that disabling `execute_code` in the persona removes it. Hosted smoke testing and production deployment must be performed separately.
