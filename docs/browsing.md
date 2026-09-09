# Internet browsing

DurableClaw uses Cloudflare **Browser Run** (formerly Browser Rendering) to give the foreground assistant a real Chromium browser. The existing model chooses browser actions, sees rendered page text and accessibility information, and continues its normal tool loop.

## Service choice

Research checked against Cloudflare's documentation on 9 September 2026:

| Option                                                                                      | Fit for DurableClaw                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Browser Sessions with Puppeteer](https://developers.cloudflare.com/browser-run/puppeteer/) | Selected: full browser interaction through a native Worker binding, with explicit disconnect/reconnect support. Uses pinned `@cloudflare/puppeteer` 1.4.0.                                                               |
| [Playwright](https://developers.cloudflare.com/browser-run/playwright/)                     | Also supports native Workers. Puppeteer's explicit `disconnect()` and `sessionId()` match this implementation's persisted session metadata.                                                                              |
| [Playwright MCP](https://developers.cloudflare.com/browser-run/playwright/playwright-mcp/)  | Suitable for external MCP clients. The native tools fit DurableClaw's existing model loop and approval UI without another MCP server deployment.                                                                         |
| [Quick Actions](https://developers.cloudflare.com/browser-run/get-started/)                 | Useful for individual scraping, screenshots and PDFs; this feature needs a page that stays open between decisions.                                                                                                       |
| [Kitesurf](https://developers.cloudflare.com/browser-run/kitesurf/)                         | Cloudflare's newer browser designed for agents, currently beta. Its documented limitations include long-running authenticated sessions requiring persistent state, so this integration uses the default Chromium engine. |

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

| Tool               | Input                                                                        | Behavior                                                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser_navigate` | `url`                                                                        | Open an HTTP(S) page and return rendered text, source URL, title, links, accessibility tree, HTTP status and `snapshot_id`. Launches a session only when needed. |
| `browser_read`     | Optional `offset`                                                            | Read the current page and issue a new `snapshot_id`. Use the returned `next_offset` to continue long text or read again when a dynamic page is still loading.    |
| `browser_act`      | Latest `snapshot_id`, ordered `actions`, optional approved `confirmation_id` | Preview the site URL and requested actions, then execute only after durable user approval. Supports clicking, filling, selecting, key presses and scrolling.     |
| `browser_close`    | None                                                                         | Close the conversation's browser and forget its local session record. Reports when remote closure cannot be confirmed.                                           |

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

The first call returns `needs_confirmation` and a server-issued ID. Approval uses the existing confirmation UI/API; the model cannot approve its own actions. All interactions, including filling and scrolling, share this conservative action boundary because site event handlers can change remote state. Reads and opening public pages run directly. The owner's current persona policy applies to all four tool IDs; mutations recheck owner authority after approval. Background research agents do not receive browser tools.

## Session and failure behavior

- Each conversation has its own browser session. Cookies and tabs are never borrowed from another conversation or from an arbitrary account session. Only the session ID, expiry and observed-page metadata are persisted in Durable Object storage; cookies stay in the remote browser.
- Worker connections disconnect after each call. A reconstructed Durable Object can reconnect to its recorded browser while that remote session remains alive. This is session reuse, not permanent persistence of website logins.
- Calls in one conversation serialize; other conversations can use their own sessions independently. Each browser operation has a 45-second deadline and page/element operations use 15-second timeouts. A batch accepts at most eight actions.
- Page text and the accessibility tree are each capped at 12,000 characters; up to 50 bounded links are returned. Tool text uses the existing output sanitizer and is marked as untrusted data.
- An action must match the latest stored snapshot and observed URL. Snapshot invalidation is stored before side effects. A failure reports the number of completed actions and warns that the next action may already have taken effect. Actions are never automatically retried. Snapshot IDs detect intervening observations/navigation, not every asynchronous DOM change a site can make.
- Stop or the operation deadline attempts to close the browser and removes the local session. Deleting a conversation also starts browser cleanup. An action already received by the website may still finish; cancellation cannot undo it.
- Idle sessions expire after ten minutes. Explicit `browser_close` releases resources sooner. If Cloudflare has already terminated a recorded session, close/forget it and navigate again. Read the website before approving any replacement action.

This initial toolset operates on the first browser tab. It does not switch to popups, select iframe contexts, expose arbitrary JavaScript execution, upload/download files, or return screenshots. Public HTTP(S) URLs are validated against the existing internal-host checks; this is not a DNS or browser-subresource firewall. Websites can reject automation, and Cloudflare [identifies browser traffic as automated](https://developers.cloudflare.com/browser-run/puppeteer/).

## Usage limits and smoke check

Browser time continues to accrue while an idle browser remains open. Cloudflare's [current limits](https://developers.cloudflare.com/browser-run/limits/) list ten browser minutes per day and three concurrent browsers on Workers Free. Workers Paid lists 200 concurrent browsers by default. Consult [current pricing](https://developers.cloudflare.com/browser-run/pricing/) for your account before sustained use. The assistant is instructed to close the browser when finished.

After deployment, ask: “Open https://example.com, tell me the page title, and close the browser.” Then use a test page you control to request a fill/click interaction: verify that the preview appears before any website change, approve it, and check the resulting page. Check two conversations use separate sessions, and that Stop and `browser_close` release them. These live checks require an authenticated Cloudflare account and are separate from the mocked browser lifecycle tests.
