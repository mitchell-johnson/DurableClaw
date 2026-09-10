import type { PreparedProviderRequest, ProviderExecution } from "./providers";

/** Internal heartbeat reads have no caller-selected URL, method, query,
 * body format, credential scope, or write capability. */
export function prepareGmailEventRequest(
  execution: ProviderExecution,
  accessToken: string,
): PreparedProviderRequest | null {
  if (!["gmail_list_events", "gmail_get_event"].includes(execution.operation))
    return null;
  const args = execution.arguments;
  const url = new URL(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages",
  );
  if (execution.operation === "gmail_get_event") {
    url.pathname += `/${args.message_id}`;
    url.searchParams.set("format", "metadata");
    url.searchParams.set(
      "fields",
      "id,threadId,internalDate,labelIds,snippet,payload/headers",
    );
    for (const header of ["From", "Subject"])
      url.searchParams.append("metadataHeaders", header);
  } else {
    // Gmail's second-resolution `after` is exclusive; overlap the lower second
    // rather than lose a message arriving exactly at a checkpoint boundary.
    url.searchParams.set(
      "q",
      `after:${Math.max(0, Number(args.after) - 1)} before:${args.before} -in:sent -in:drafts -in:spam -in:trash`,
    );
    url.searchParams.set("labelIds", "INBOX");
    url.searchParams.set("includeSpamTrash", "false");
    url.searchParams.set("maxResults", String(args.max));
    url.searchParams.set("fields", "messages/id,nextPageToken");
    if (args.page_token)
      url.searchParams.set("pageToken", String(args.page_token));
  }
  return {
    transport: "http",
    result: "json",
    request: new Request(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }),
  };
}
