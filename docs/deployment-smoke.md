# Live deployment integration test

After both Workers are deployed, run the bounded smoke harness from the repository with Node.js 22.12 or later and `npm ci` dependencies installed. It uses the deployed configuration and sends one short turn through the actual authenticated Durable Object WebSocket flow, including a model tool call and the model's response to its result. The turn incurs the configured model's normal usage charge.

Use a private regular file containing the installation's owner bearer token or Cloudflare Access application token. The file must have no group or other permissions (for example mode `0600`). Keep credentials out of shell arguments and repository files. For a bearer-token installation:

```sh
SMOKE_AUTH_FILE=/private/path/owner-token node scripts/smoke-deployment.mjs https://your-deployment.example
```

For a deployment protected by Cloudflare Access, authenticate through the installation's normal Access policy and supply its short-lived application token. Specify the exact team hostname, without a URL scheme or path:

```sh
SMOKE_AUTH_MODE=access SMOKE_ACCESS_TEAM_DOMAIN=your-team.cloudflareaccess.com SMOKE_AUTH_FILE=/private/path/access-application-token node scripts/smoke-deployment.mjs https://your-deployment.example
```

Access mode sends the application token as the documented `CF_Authorization` cookie to the edge, including on WebSocket handshakes. Access then supplies the assertion that the Worker verifies. The global team-session token is not an application token. See [Cloudflare's authorization-cookie documentation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/).

Alternatively provide `SMOKE_AUTH_TOKEN` through your secret manager's environment injection. Supply exactly one credential source. The harness does not log in, create credentials, or change Access policies. Health and static checks authenticate in Access mode and still require an actual `200` application response. The explicit missing/forged credential probes accept `401`, `403`, or a `302` only to the configured team's exact `/cdn-cgi/access/login/<application-host>` path. Any `redirect_url` must return to the tested application path. Other redirects fail, and no redirects are followed. The authenticated application session must report `auth_mode: "access"`; ticket replay must reach the application and return `401`. Bearer mode retains strict `401` authentication rejection.

The harness checks public health, the built frontend and CSP, missing/forged authentication, cross-origin rejection, authenticated owner access, device and messaging D1 registries, and the private connector service binding. It then creates a uniquely named `smoke-…` conversation, obtains a one-use socket ticket, and requires exactly one `list_service_connections({})` call followed by a random marker. It verifies the successful tool result, model completion, and persisted user/assistant messages, rejects ticket replay, and deletes only that conversation. This tests the model's handling of a tool-result round trip, including Gemini reasoning signatures when configured. The first message labels the conversation as a deployment smoke test.

All work has a 100-second deadline with 20 seconds reserved for cleanup. HTTP responses and WebSocket traffic have size limits. If a model attempts any tool besides that one metadata listing, the run fails and requests cancellation. The harness never approves tools, starts Google consent, sends service messages, enrolls devices, runs device commands, or changes the workspace persona. It does not verify live Google operations without a connected account and explicit test scope.

Standard output is JSON Lines with fixed check names and pass/fail codes. The completion record contains only marker-match/completion booleans; credentials, tickets, model text, and registry contents are never printed. Exit status is zero only when every check and cleanup pass. A cleanup failure reports the generated smoke conversation ID so an operator can remove that specific conversation; it never prints a preexisting conversation ID.

```sh
node --test scripts/smoke-deployment.test.mjs
```

These deterministic transport tests check the harness lifecycle and failure cleanup. They do not replace running the script against the deployed HTTPS origin.
