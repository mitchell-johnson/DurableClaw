import { expect, it } from "vitest";
import { gmailProvider } from "../../services/connectors/src/providers";
import { googleProvider } from "../../services/connectors/src/google";

for (const provider of [gmailProvider, googleProvider]) {
  it(`${provider.id} limits event polling to a fixed inbox GET without generic command approval`, () => {
    const execution = provider.validateOperation("gmail_list_events", {
      after: 1_800_000_000,
      before: 1_800_003_600,
      max: 20,
      page_token: "next-page",
    });
    expect(provider.requiresConfirmation(execution)).toBe(false);
    const prepared = provider.prepareExecution(execution, "private-token");
    const url = new URL(prepared.request.url);
    expect(prepared.transport).toBe("http");
    expect(prepared.request.method).toBe("GET");
    expect(url.origin).toBe("https://gmail.googleapis.com");
    expect(url.pathname).toBe("/gmail/v1/users/me/messages");
    expect(url.searchParams.get("labelIds")).toBe("INBOX");
    expect(url.searchParams.get("q")).toBe(
      "after:1799999999 before:1800003600 -in:sent -in:drafts -in:spam -in:trash",
    );
    expect(url.searchParams.get("pageToken")).toBe("next-page");
    expect(url.searchParams.get("maxResults")).toBe("20");
    expect(url.searchParams.get("fields")).toBe("messages/id,nextPageToken");
    expect(prepared.request.headers.get("Authorization")).toBe(
      "Bearer private-token",
    );
  });
  it(`${provider.id} restricts message event reads to metadata fields and closed schemas`, () => {
    const execution = provider.validateOperation("gmail_get_event", {
      message_id: "a1b2",
    });
    const prepared = provider.prepareExecution(execution, "private-token");
    const url = new URL(prepared.request.url);
    expect(url.pathname).toBe("/gmail/v1/users/me/messages/a1b2");
    expect(url.searchParams.get("format")).toBe("metadata");
    expect(url.searchParams.getAll("metadataHeaders")).toEqual([
      "From",
      "Subject",
    ]);
    expect(url.searchParams.get("fields")).toBe(
      "id,threadId,internalDate,labelIds,snippet,payload/headers",
    );
    expect(() =>
      provider.validateOperation("gmail_get_event", {
        message_id: "a1b2",
        format: "full",
      }),
    ).toThrow();
    expect(() =>
      provider.validateOperation("gmail_get_event", {
        message_id: "../settings",
      }),
    ).toThrow();
    expect(() =>
      provider.validateOperation("gmail_list_events", { after: 10, before: 9 }),
    ).toThrow();
    expect(() =>
      provider.validateOperation("gmail_list_events", {
        after: 10,
        before: 20,
        query: "in:sent",
      }),
    ).toThrow();
    expect(() =>
      provider.validateOperation("gmail_list_events", {
        after: 10,
        before: 20,
        max: 21,
      }),
    ).toThrow();
  });
}
it("enforces the selected Gmail grant for internal heartbeat reads", () => {
  const execution = googleProvider.validateOperation("gmail_list_events", {
    after: 10,
    before: 20,
  });
  expect(() =>
    googleProvider.authorizeExecution!(execution, ["drive"]),
  ).toThrow();
  expect(() =>
    googleProvider.authorizeExecution!(execution, ["gmail"]),
  ).not.toThrow();
});
