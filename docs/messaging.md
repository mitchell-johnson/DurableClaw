# Messaging plugins and Telegram

Messaging adapters connect private text chats to an owner's DurableClaw conversation. Telegram is the first working adapter. The shared service handles owner linking, conversation dispatch, duplicate delivery protection, and connection revocation. Plugins are reviewed application code shipped with the Worker; they are not downloaded or executed from chat messages.

If a message arrives while the conversation is busy or rate-limited, it is saved in the transcript with an explicit notice that it has not run. Ask the agent to continue with that saved message after the current response finishes. A messaging turn has a 90-second deadline; partial output remains in the conversation and the browser receives the normal stopped event. Interrupted or ambiguous executions are not automatically repeated.

## Working indicator and subagent results

Telegram shows its native **typing…** indicator when an accepted message starts running. DurableClaw refreshes [`sendChatAction`](https://core.telegram.org/bots/api#sendchataction) roughly every four seconds while the foreground turn or any of its subagent batches is still active. The indicator continues after a dispatch acknowledgment while the subagents work. Results are sent back automatically as a separate reply when each batch finishes; you do not need to ask again or keep the browser open.

Activity follows the coordinator's actual work state. Refreshes stop on completion, failure, cancellation/turn deadline, unlinking, or loss of owner authority. Pending batch activity and outbound result jobs survive coordinator reconstruction; an interrupted foreground turn does not leave a permanent typing loop. Telegram clears typing when a message arrives or the last action expires (within five seconds). An acknowledgment can briefly clear it until the next refresh.

Typing is best-effort: calls have a three-second timeout, do not overlap for the same request, and never block the agent's response. Temporary failures back off for 30 seconds; rate limits honor `retry_after` up to one hour. Invalid or blocked destinations stop refreshes. Network delays or provider failures can therefore make the indicator disappear even while work continues; it is not a health guarantee. Typing itself needs no additional secrets or permissions.

## Configure Telegram

1. Create a bot through Telegram's official [BotFather](https://core.telegram.org/bots/tutorial#obtain-your-bot-token). Use one bot per DurableClaw deployment.
2. Apply the control database migrations, including `migrations/0002_messaging.sql` and `migrations/0004_messaging_approvals.sql`, using the deployment procedure in the README.
3. Add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` as Worker **secrets**. Generate the webhook secret with `openssl rand -hex 32`. The implementation requires 32–256 characters from `A-Z`, `a-z`, `0-9`, `_`, and `-`; do not reuse the bot token, browser token, or internal signing key.
4. Deploy the Worker with these secrets. The application reports whether Telegram is configured without exposing secret values.
5. Register `https://YOUR_DOMAIN/api/messaging/webhooks/telegram` with Telegram's [`setWebhook`](https://core.telegram.org/bots/api#setwebhook), passing the identical `secret_token`, `allowed_updates: ["message", "callback_query"]`, and `max_connections: 1`. Existing installations must update `allowed_updates` to receive approval buttons. An example registration script is below. It deliberately does not drop pending messages.
6. If Cloudflare Access protects the domain, create a narrowly scoped Bypass application for the exact webhook path, `/api/messaging/webhooks/telegram`. Telegram cannot complete browser login. This path still requires the verified Telegram webhook secret in the Worker. Keep the application and all owner APIs behind the normal Access policy.
7. In DurableClaw, select the conversation to connect and generate a Telegram linking code. Send the displayed `/start CODE` command in a private chat with your bot before its ten-minute expiry. The bot confirms the connection. Check the sender and chat identifiers shown in the application.

The operator can run the following after setting `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, and `DURABLECLAW_ORIGIN` in their local environment. It makes the explicit webhook registration change. Do not paste real tokens into source files, shell history, or shared logs.

```sh
node --input-type=module <<'JS'
const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_WEBHOOK_SECRET: secret,
  DURABLECLAW_ORIGIN: origin } = process.env;
if (!token || !secret || !origin) throw new Error("Missing configuration");
const base = new URL(origin);
if (base.protocol !== "https:" || base.username || base.password)
  throw new Error("A public HTTPS origin is required");
try {
  const result = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: new URL("/api/messaging/webhooks/telegram", base).href,
      secret_token: secret,
      allowed_updates: ["message", "callback_query"],
      max_connections: 1,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  const data = await result.json();
  if (!result.ok || data.ok !== true) throw new Error();
  console.log("Webhook registered");
} catch {
  console.error("Webhook registration failed; check credentials and configuration.");
  process.exitCode = 1;
}
JS
```

[`getWebhookInfo`](https://core.telegram.org/bots/api#getwebhookinfo) reports delivery errors and pending updates. Do not log the Bot API request URL because it contains the bot token. Rotate a compromised bot token through BotFather, replace the Worker secret, and register the webhook again. Rotate the webhook secret in both the Worker and `setWebhook` together.

## Ownership and action approvals

Only authenticated workspace owners can issue link codes or manage connections. Each owner/workspace can connect one account per provider. Issuing another code replaces the previous code. Codes contain 192 bits of randomness, expire after ten minutes, are stored only as SHA-256 hashes, and are consumed transactionally with the link creation. An existing Telegram identity cannot be reassigned to a different owner by issuing another code; the current owner must unlink it first.

Telegram sender and chat IDs are the authority for the link; display names and usernames are not trusted identities. Only private messages from a human sender whose numeric ID equals the private chat ID are accepted. Groups, channels, bot senders, forwarded messages, edited messages, attachments, and business messages are ignored.

Pending tool actions can be reviewed in Telegram using **Approve** and **Decline** buttons. Each card contains the complete action preview saved by the conversation engine, including the exact proposed arguments, and expires within ten minutes. Approval resumes that saved action; it does not grant permission to a different action. Send `/approvals` to request pending actions in the linked conversation, including actions originally requested in the browser. This command retrieves pending approvals without asking the model to interpret it. The web approval controls remain available. If a complete preview cannot fit Telegram's text limit, review and approve it in the application instead.

File-write cards include the full proposed contents. Google commands with input files include every file's complete readable text; binary files, invalid text, and oversized reviews require the web app. A filename, byte count, or content hash alone never makes those inputs approvable in Telegram.

Ordinary message content enters the conversation as user text. A command such as “approve” never confirms an action. Only a provider-authenticated button event can reach the separate decision endpoint. It must come from the linked human in their private chat, on the exact message sent by the configured bot. Forwarded cards, inline messages, changed links, wrong message IDs, expired buttons, and replays fail closed. Telegram buttons approve pending tool actions; device enrollment and account settings remain in the authenticated application.

The host reauthorizes the linked owner for each conversation dispatch. The conversation engine independently checks the exact current link, owner, workspace, conversation, confirmation expiry, and saved action before applying a decision. A browser decision racing a Telegram decision can win only once. Callback contents are never sent to the model as an approval request.

Button tokens contain 192 bits of randomness and are stored only as SHA-256 hashes. The control database claims each confirmation/link before sending the card and binds the returned provider message ID before accepting a click. Consuming the token and claiming its dispatch are transactional. Neither ambiguous card sends nor ambiguous decision dispatches are retried; use the application to inspect their state. Buttons are removed after consumption where Telegram permits it. Their removal and the callback progress indicator are best-effort; the token remains consumed even if Telegram fails to update the UI.

At most eight cards are sent per response, with a web fallback for additional actions. Each owner/workspace retains at most 128 approval claims for 48 hours, independently of links, so unlinking or provider retries cannot reset a send claim. Expired retention records are cleaned up in bounded batches. The D1 approval records contain only identifiers, hashes, timestamps, and status; action previews and email contents stay in the conversation Durable Object and the destination chat.

Unlinking immediately prevents new messages from being dispatched. A dispatch already accepted can finish; the service checks the link again before sending its result. Messages and replies travel through Telegram, so use the browser conversation for data you do not want transmitted to that provider.

## Delivery and retention

- Every accepted event gets a durable claim **before** calling the agent or sending a reply. Concurrent webhook retries cannot repeat either operation.
- The request ID is a SHA-256 hash of the provider ID and provider event ID. The conversation engine also persists a receipt for this ID.
- The Worker waits for the agent's response and sends a reply through [`sendMessage`](https://core.telegram.org/bots/api#sendmessage), followed by any exact action cards. Replies use plain text, disable link previews, and are shortened to fit Telegram's 4,096-character limit. Approval cards are never shortened. Open the app for the full conversation or actions whose complete details do not fit a card.
- Later subagent results have separate durable jobs and deterministic `reply_…` delivery claims keyed by the original request and stored assistant message ID. The coordinator reauthorizes the owner and resolves the exact link that accepted the original request; unlink/relink cannot redirect a private result to a new chat. Results normally wait for the initial reply to finish, but a stuck webhook stops blocking them after 110 seconds. Preparation errors can retry for up to one hour without re-executing the agent.
- Outbound sends have a ten-second deadline and reject redirects. The service does not automatically retry a failed or ambiguous send, because Telegram does not provide an idempotency key for `sendMessage`.
- A crash or network failure after claiming work can leave a missing reply. The service acknowledges provider retries without rerunning the agent. Check the conversation and delivery status before sending a new request that could repeat work.
- The same no-ambiguous-retry policy applies to later batch replies. A failed provider send is recorded as `send_unknown`; the full result remains in the conversation. Background replies count toward the same retention cap as initial replies.
- Delivery statuses are `processing`, `dispatch_unknown`, `sending`, `sent`, `send_unknown`, and `unlinked`. A `processing` or `sending` record that remains unchanged beyond the dispatch deadline may also represent an interrupted request. No automatic recovery re-executes it.
- Events older than 24 hours or more than five minutes in the future are ignored. Deduplication records last 48 hours, so expired records cannot make old webhook messages executable again. Records survive unlinking and relinking.
- The control database retains at most 1,024 deliveries per owner/workspace, including connection confirmations, across all providers. At capacity it acknowledges and drops new events until records expire; it never discards fresh deduplication records to admit work. Expired codes and delivery records are removed on subsequent linked traffic, code issuance, or delivery-status inspection. Existing conversation retention is managed by the conversation engine.

The control database stores identifiers, ownership, timestamps, and delivery state. It does not store chat content, reply content, bot tokens, or plaintext link codes.

## Owner API

These routes require the usual authenticated owner session and same-origin protections. Response fields use camel case.

| Route                             | Result                                                                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `GET /api/messaging/plugins`      | `{ plugins: [{ id, label, configured }] }`                                                                              |
| `POST /api/messaging/link-codes`  | Body `{ pluginId, conversationId }`; returns `{ pluginId, code, expiresAt, instruction }` with status 201               |
| `GET /api/messaging/links`        | `{ links: [{ id, pluginId, senderId, chatId, conversationId, createdAt }] }`                                            |
| `DELETE /api/messaging/links/:id` | `{ unlinked: true }`; another owner's ID returns 404                                                                    |
| `GET /api/messaging/deliveries`   | The latest 50 owner-scoped records as `{ deliveries: [{ requestId, pluginId, linkId, status, createdAt, updatedAt }] }` |

## Add another messaging plugin

Implement `MessagingPlugin` in `src/channels/` and register it in `messagingRegistry` in `src/channels/service.ts`. Preserve the legacy WhatsApp exports; `WhatsAppChannel` remains an unconnected architecture stub and is not a registered working adapter.

```ts
interface MessagingPlugin {
  readonly id: string; // Stable lowercase identifier; no user input or paths.
  readonly label: string;
  configured(env: MessagingCredentials): boolean;
  receive(
    request: Request,
    env: MessagingCredentials,
  ): Promise<MessagingEvent | MessagingApprovalEvent | null>;
  send(
    env: MessagingCredentials,
    reply: { chatId: string; text: string },
  ): Promise<void>;
  sendApproval?(
    env: MessagingCredentials,
    reply: {
      chatId: string;
      text: string;
      approveData: string;
      declineData: string;
    },
  ): Promise<{ messageId: string }>;
  answerCallback?(
    env: MessagingCredentials,
    reply: { callbackId: string; text: string },
  ): Promise<void>;
  clearApproval?(
    env: MessagingCredentials,
    target: { chatId: string; messageId: string },
  ): Promise<void>;
  sendTyping?(
    env: MessagingCredentials,
    target: { chatId: string },
    signal: AbortSignal,
  ): Promise<void>;
}

interface MessagingEvent {
  kind?: "message";
  eventId: string; // Stable provider update ID, identical on every redelivery.
  senderId: string; // Authenticated stable human account ID.
  chatId: string; // Authenticated private destination ID.
  content: string;
  occurredAt: number; // Provider-authenticated creation time in milliseconds.
}

interface MessagingApprovalEvent {
  kind: "approval";
  eventId: string;
  senderId: string;
  chatId: string;
  callbackId: string;
  messageId: string;
  data: string; // Opaque host-issued callback data, never a confirmation ID.
  occurredAt: number;
}
```

Add the provider's secret bindings to the credentials/environment types and deployment configuration. `receive` must verify the provider's signature or secret before parsing the request, bound the streamed body, and accept only private human-authored messages or authenticated approval callbacks with a verified message origin. The shared handler additionally bounds identifiers and content and validates event age. If the provider uses a different account-linking command, normalize it to `/start CODE`. Plugins must not derive sender identity from display names or content, dynamically load executable code, or interpret chat messages as application approvals.

`send` must use the provider's fixed HTTPS API destination, reject redirects, enforce body/time limits, avoid secrets in errors, and return only when delivery succeeds or fails. Do not add implicit retries for operations without provider idempotency. Add tests for provider forgery, group/bot rejection, duplicate events, and recipient isolation. The existing `example` adapter in the shared service tests exercises the same linking and dispatch logic without Telegram-specific assumptions.

`sendTyping` is optional. Implement it only for ephemeral activity, honor the abort signal, and sanitize provider failures. `MessagingActivityError` communicates a safe status and retry delay without leaking provider URLs or tokens. The coordinator schedules activity; adapters must not create their own unbounded timers or send persistent loading messages.

Approval capabilities are optional; text-only plugins receive a web fallback. `sendApproval` must send the entire preview without truncation or formatting interpretation, place the supplied callback data on the corresponding buttons, and return the provider's stable message ID. It must never retry an ambiguous send. The Telegram callback data is ASCII and fits its 64-byte limit. `answerCallback` and `clearApproval` are optional, bounded, best-effort UI updates. Their errors must be generic and contain no provider tokens or action content.

The host routes `/api/messaging/webhooks/:plugin` before browser authentication, delegates to `handleMessagingWebhook`, and supplies `MessagingDispatch`. The dispatch receives authoritative `channel: { linkId, pluginId, senderId, chatId }` from the current D1 link. Verified callbacks additionally receive `approval: { confirmationId, decision }` and fixed placeholder content, never user-supplied decision text. The callback must route these to the separate decision endpoint, reauthorize the stored owner, bind the request to the owner's conversation, enforce its deadline, and persist its own idempotency receipt. Replies have shape `{ text, approvals?: [{ confirmationId, toolName, preview, expiresAt }] }`; previews must come from trusted saved confirmation state. Owner routes call `handleMessagingOwnerRequest` only after authentication and same-origin checks.
