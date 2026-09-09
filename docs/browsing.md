# Internet browsing

DurableClaw uses Cloudflare **Browser Run** (formerly Browser Rendering) to give the foreground assistant a browser, preferring **Kitesurf** for new tasks and using **Chromium** when a task needs the full browser environment. The existing model chooses browser actions, sees rendered page text and accessibility information, and continues its normal tool loop.

## Service choice

Research checked against Cloudflare's documentation on 9 September 2026:

| Option                                                                                      | Fit for DurableClaw                                                                                                                                                  |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Browser Sessions with Puppeteer](https://developers.cloudflare.com/browser-run/puppeteer/) | Both engines use the native Worker binding and pinned `@cloudflare/puppeteer` 1.4.0. Chromium supports session-ID reconnection; Kitesurf uses a live CDP connection. |
| [Playwright](https://developers.cloudflare.com/browser-run/playwright/)                     | Also supports native Workers. Puppeteer's explicit `disconnect()` and `sessionId()` match this implementation's persisted session metadata.                          |
| [Playwright MCP](https://developers.cloudflare.com/browser-run/playwright/playwright-mcp/)  | Suitable for external MCP clients. The native tools fit DurableClaw's existing model loop and approval UI without another MCP server deployment.                     |
| [Quick Actions](https://developers.cloudflare.com/browser-run/get-started/)                 | Useful for individual scraping, screenshots and PDFs; this feature needs a page that stays open between decisions.                                                   |
| [Kitesurf](https://developers.cloudflare.com/browser-run/kitesurf/)                         | Preferred for ordinary browsing and short interactions. Chromium is selected for persistent authenticated or resumable tasks, video/WebGL, or incompatible sites.    |

## Browser selection

`browser_navigate` accepts `engine: "auto" | "kitesurf" | "chromium"`:

| Selection        | Behavior                                                                                                                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto` (default) | A new session starts with Kitesurf. If Kitesurf fails to start, try Chromium once before navigating anywhere. An existing session retains its engine and state. |
| `kitesurf`       | Explicitly choose Kitesurf, with no automatic Chromium startup fallback.                                                                                        |
| `chromium`       | Use the full browser for persistent authentication, restart recovery, video/WebGL requirements, or pages that Kitesurf cannot handle.                           |

The agent receives this selection policy in its system prompt and tool description. If page rendering or a protocol operation is incompatible with Kitesurf, it can reopen the URL using Chromium, inspect the new page, and request fresh approval for any interactions. Website actions and failed navigations are **not** automatically replayed on another engine.

An explicit change of engine closes the old browser and discards its cookies, form state and snapshots; a new approval cannot reuse the previous page. Results report `browser_engine`, `session_recoverable`, and, when relevant, `session_reset` or `fallback_reason`. Close the browser when the task ends so the next task starts with Kitesurf again.

The pinned [Cloudflare Puppeteer client](https://github.com/cloudflare/puppeteer/blob/main/packages/puppeteer-core/src/cloudflare/PuppeteerWorkers.ts) supports `puppeteer.launch(binding, { browser: "kitesurf" })`. Its Kitesurf transport acquires the browser on WebSocket connection and has no reconnectable session ID. We therefore retain that live connection within the owner DO; we never persist the client's placeholder `"unknown"` session ID. Kitesurf is ephemeral, so select Chromium when a task must survive connection loss or an object restart.

## Configuration

The repository's `wrangler.toml` includes:

```toml
[browser]
binding = "BROWSER"
```

Keep `nodejs_compat` and the existing compatibility date (2026-08-15). Cloudflare's Puppeteer client requires 2025-09-15 or later. The binding supplies access to the service; no additional browser API key or account ID is passed to the model.

For an existing installation, install the updated lockfile, preserve your deployment-specific database and model settings, and deploy normally:

```sh
npm ci
npm run types
npm run check
npm test
npm run test:workers
npm run build
npm run deploy
```

No new Durable Object class or migration is required. Removing `[browser]` omits the browser tools. Existing unit/workerd test configurations do not contact a remote browser. To exercise Cloudflare's hosted browser from local development, add `remote = true` to `[browser]`, authenticate Wrangler, and run `npm run dev`; those browser calls use your account quota. See Cloudflare's [local development guidance](https://developers.cloudflare.com/browser-run/features/reuse-sessions/).

## Tools

| Tool               | Input                                                                        | Behavior                                                                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser_navigate` | `url`, optional `engine`                                                     | Open an HTTP(S) page and return engine, rendered text, source URL, title, links, accessibility tree, HTTP status and `snapshot_id`. Defaults to Kitesurf for a new session. |
| `browser_read`     | Optional `offset`                                                            | Read the current page and issue a new `snapshot_id`. Use the returned `next_offset` to continue long text or read again when a dynamic page is still loading.               |
| `browser_act`      | Latest `snapshot_id`, ordered `actions`, optional approved `confirmation_id` | Preview the site URL and requested actions, then execute only after durable user approval. Supports clicking, filling, selecting, key presses and scrolling.                |
| `browser_close`    | None                                                                         | Close the conversation's browser and forget its local session record. Reports when remote closure cannot be confirmed.                                                      |

Actions use Puppeteer selectors, for example `aria/Search` for a control's accessible name or `input[name="q"]` for CSS. A form interaction can be reviewed as one batch:

```json
{
  "snapshot_id": "copy-from-the-latest-browser-result",
  "actions": [
    {
      "type": "fill",
      "selector": "input[name=\"q\"]",
      "value": "Cloudflare Workers"
    },
    { "type": "press", "selector": "input[name=\"q\"]", "key": "Enter" }
  ]
}
```

The first call returns `needs_confirmation` and a server-issued ID. Approval uses the existing confirmation UI/API; the model cannot approve its own actions. The preview preserves the exact URL and action arguments, including text that the page-result sanitizer would filter. The action schema declares each action's required fields and limits. All interactions, including filling and scrolling, share this conservative action boundary because site event handlers can change remote state. Reads and opening public pages run directly. The owner's current persona policy applies to all four tool IDs; mutations recheck owner authority after approval. Background research agents do not receive browser tools.

## Session and failure behavior

- Each conversation has its own browser session. Cookies and tabs are never borrowed from another conversation or from an arbitrary account session. Engine, expiry and observed-page metadata are persisted in Durable Object storage; Chromium also has a durable remote session ID. Cookies stay in the remote browser.
- Chromium connections disconnect after each call and can reconnect after DO reconstruction while the remote session remains alive. Kitesurf keeps its live connection between calls, with a ten-minute idle cleanup timer serialized through the same operation queue. Kitesurf cannot reconnect after a disconnect or reconstruction: reads/actions return an explicit session-ended error. Only navigation can start a replacement; no actions are replayed.
- Calls in one conversation serialize; other conversations can use their own sessions independently. Each browser operation has a 45-second deadline and page/element operations use 15-second timeouts. A batch accepts at most eight actions.
- Page text and the accessibility tree are each capped at 12,000 characters; up to 50 bounded links are returned. Tool text uses the existing output sanitizer and is marked as untrusted data.
- An action must match the latest stored snapshot and observed URL. Snapshot invalidation is stored before side effects. A batch stops before its next action if the observed page origin changes; the new site requires a fresh read and approval. A failure reports the number of completed actions and warns that the next action may already have taken effect. Actions are never automatically retried. Snapshot IDs detect intervening observations/navigation, not every asynchronous DOM change a site can make.
- Stop or the operation deadline attempts to close the browser and removes the local session. Deleting a conversation also starts browser cleanup. An action already received by the website may still finish; cancellation cannot undo it.
- Both engines have ten-minute idle cleanup, and Cloudflare can terminate sessions earlier. Explicit `browser_close` releases resources sooner. If a browser has ended, navigate again, selecting Chromium for work that needs session recovery. Read the website before approving any replacement action.

This initial toolset operates on the first browser tab. It does not switch to popups, select iframe contexts, expose arbitrary JavaScript execution, upload/download files, or return screenshots. Before page work, the tool installs request interception and bypasses service workers so observed network requests, including redirect hops and subresources, pass the existing public HTTP(S)/internal-host checks before being sent. If interception is unsupported, the page closes and the operation fails; the agent can explicitly select Chromium. This is not a DNS or full network firewall: it cannot resolve public hostnames to private addresses, police other tabs or background service workers, or enforce interception while Chromium's CDP connection is detached. Websites can reject automation, and Cloudflare [identifies browser traffic as automated](https://developers.cloudflare.com/browser-run/puppeteer/).

## Usage limits and smoke check

Cloudflare currently offers [Kitesurf beta for free](https://developers.cloudflare.com/browser-run/kitesurf/) within account limits; this can change. Chromium browser time continues to accrue while an idle browser remains open. Cloudflare's [current limits](https://developers.cloudflare.com/browser-run/limits/) list ten browser minutes per day and three concurrent browsers on Workers Free. Workers Paid lists 200 concurrent browsers by default. Consult [current pricing](https://developers.cloudflare.com/browser-run/pricing/) for your account before sustained use. The assistant is instructed to close the browser when finished.

After deployment, ask: “Open https://example.com, tell me the page title, and close the browser.” Verify that the result reports `browser_engine: "kitesurf"` (or an explicit startup fallback). Ask for a fresh page with `engine: "chromium"` and check that the result reports Chromium. Then use a test page you control to request a fill/click interaction: verify that the preview appears before any website change, approve it, and check the resulting page. Check two conversations use separate sessions, engine switches require a new snapshot/approval, and Stop and `browser_close` release both engine types. Verify that Chromium can reconnect after DO reconstruction and that Kitesurf reports its ephemeral session as ended. These live checks require an authenticated Cloudflare account and are separate from the mocked browser lifecycle tests.
