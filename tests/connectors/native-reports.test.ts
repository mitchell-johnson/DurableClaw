import { describe, expect, it, vi } from "vitest";
import catalog from "../../services/connectors/vendor/gogcli/catalog.json";
import { reportHandlers } from "../../services/connectors/vendor/gogcli/reports";
import type {
  Data,
  Runtime,
} from "../../services/connectors/vendor/gogcli/types";

function fixture(responses: Data[] = []) {
  const json = vi.fn(
    async (_api: string, _path: string, _options?: unknown): Promise<any> =>
      responses.shift() ?? {},
  );
  const runtime = {
    account: "owner@example.com",
    signal: new AbortController().signal,
    json,
    jsonInput: (value: unknown) => JSON.parse(String(value)),
  } as Runtime;
  const run = async (
    command: string,
    positionals: string[] = [],
    flags: Data = {},
  ) => {
    expect(reportHandlers[command], `handler for ${command}`).toBeTypeOf(
      "function",
    );
    return reportHandlers[command](
      { command, positionals, flags, files: [], output_files: [] },
      runtime,
    );
  };
  return { json, runtime, run };
}

describe("native reporting and YouTube command ports", () => {
  it("implements exactly the 49 pinned reporting and YouTube commands", () => {
    const expected = catalog.commands
      .filter((c) =>
        ["adsense", "analytics", "searchconsole", "youtube"].includes(
          c.service,
        ),
      )
      .map((c) => c.command)
      .sort();
    expect(expected).toHaveLength(49);
    expect(Object.keys(reportHandlers).sort()).toEqual(expected);
  });

  it.each([
    [
      "adsense.accounts.list",
      [],
      {},
      "adsense",
      "accounts",
      { query: { pageSize: 50 } },
    ],
    ["adsense.accounts.get", ["pub"], {}, "adsense", "accounts/pub", undefined],
    [
      "adsense.adclients.list",
      ["pub"],
      {},
      "adsense",
      "accounts/pub/adclients",
      { query: { pageSize: 50 } },
    ],
    [
      "adsense.adclients.get",
      ["accounts/pub/adclients/a"],
      {},
      "adsense",
      "accounts/pub/adclients/a",
      undefined,
    ],
    [
      "adsense.adunits.list",
      ["accounts/pub/adclients/a"],
      {},
      "adsense",
      "accounts/pub/adclients/a/adunits",
      { query: { pageSize: 50 } },
    ],
    [
      "adsense.adunits.get",
      ["accounts/pub/adclients/a/adunits/u"],
      {},
      "adsense",
      "accounts/pub/adclients/a/adunits/u",
      undefined,
    ],
    [
      "adsense.adunits.linkedcustomchannels",
      ["accounts/pub/adclients/a/adunits/u"],
      {},
      "adsense",
      "accounts/pub/adclients/a/adunits/u:listLinkedCustomChannels",
      { query: { pageSize: 50 } },
    ],
    [
      "adsense.customchannels.list",
      ["accounts/pub/adclients/a"],
      {},
      "adsense",
      "accounts/pub/adclients/a/customchannels",
      { query: { pageSize: 50 } },
    ],
    [
      "adsense.customchannels.get",
      ["accounts/pub/adclients/a/customchannels/c"],
      {},
      "adsense",
      "accounts/pub/adclients/a/customchannels/c",
      undefined,
    ],
    [
      "adsense.customchannels.linkedadunits",
      ["accounts/pub/adclients/a/customchannels/c"],
      {},
      "adsense",
      "accounts/pub/adclients/a/customchannels/c:listLinkedAdUnits",
      { query: { pageSize: 50 } },
    ],
    [
      "adsense.urlchannels.list",
      ["accounts/pub/adclients/a"],
      {},
      "adsense",
      "accounts/pub/adclients/a/urlchannels",
      { query: { pageSize: 50 } },
    ],
    [
      "adsense.urlchannels.get",
      ["accounts/pub/adclients/a/urlchannels/u"],
      {},
      "adsense",
      "accounts/pub/adclients/a/urlchannels/u",
      undefined,
    ],
    [
      "adsense.policyissues.list",
      ["pub"],
      {},
      "adsense",
      "accounts/pub/policyIssues",
      { query: { pageSize: 50 } },
    ],
    [
      "adsense.policyissues.get",
      ["accounts/pub/policyIssues/p"],
      {},
      "adsense",
      "accounts/pub/policyIssues/p",
      undefined,
    ],
    [
      "adsense.payments.list",
      ["pub"],
      {},
      "adsense",
      "accounts/pub/payments",
      undefined,
    ],
    [
      "adsense.sites.list",
      ["pub"],
      {},
      "adsense",
      "accounts/pub/sites",
      { query: { pageSize: 50 } },
    ],
    [
      "adsense.sites.get",
      ["accounts/pub/sites/s"],
      {},
      "adsense",
      "accounts/pub/sites/s",
      undefined,
    ],
    [
      "adsense.reports.saved.list",
      ["pub"],
      {},
      "adsense",
      "accounts/pub/reports/saved",
      { query: { pageSize: 50 } },
    ],
    [
      "searchconsole.sites.get",
      ["sc-domain:example.com"],
      {},
      "searchconsole",
      "sites/sc-domain%3Aexample.com",
      undefined,
    ],
    [
      "searchconsole.sitemaps.list",
      ["sc-domain:example.com"],
      { "sitemap-index": "https://example.com/index.xml" },
      "searchconsole",
      "sites/sc-domain%3Aexample.com/sitemaps",
      { query: { sitemapIndex: "https://example.com/index.xml" } },
    ],
    [
      "searchconsole.sitemaps.get",
      ["sc-domain:example.com", "https://example.com/map.xml"],
      {},
      "searchconsole",
      "sites/sc-domain%3Aexample.com/sitemaps/https%3A%2F%2Fexample.com%2Fmap.xml",
      undefined,
    ],
    [
      "youtube.activities.list",
      [],
      { mine: true },
      "youtube",
      "activities",
      { query: { part: "snippet,contentDetails", mine: true, maxResults: 25 } },
    ],
    [
      "youtube.channels.list",
      [],
      { id: "c1,c2", page: "next" },
      "youtube",
      "channels",
      {
        query: {
          part: "snippet,statistics,contentDetails",
          id: "c1,c2",
          maxResults: 25,
          pageToken: "next",
        },
      },
    ],
    [
      "youtube.comments.list",
      [],
      { "channel-id": "c1" },
      "youtube",
      "commentThreads",
      { query: { part: "snippet", channelId: "c1", maxResults: 25 } },
    ],
    [
      "youtube.playlists.list",
      [],
      { "channel-id": "c1" },
      "youtube",
      "playlists",
      {
        query: {
          part: "snippet,contentDetails",
          channelId: "c1",
          maxResults: 25,
        },
      },
    ],
    [
      "youtube.playlists.delete",
      ["p1"],
      {},
      "youtube",
      "playlists",
      { method: "DELETE", query: { id: "p1" } },
    ],
  ] as [string, string[], Data, string, string, Data | undefined][])(
    "routes %s with the API's actual resource spelling",
    async (command, args, flags, api, path, options) => {
      const f = fixture();
      await f.run(command, args, flags);
      expect(f.json.mock.calls[0]).toEqual(
        options ? [api, path, options] : [api, path],
      );
    },
  );

  it("pages AdSense child accounts and keeps the continuation when all is disabled", async () => {
    const f = fixture([
      { accounts: [{ name: "one" }], nextPageToken: "next" },
      { accounts: [{ name: "two" }] },
    ]);
    expect(
      await f.run("adsense.accounts.children", ["pub-123"], {
        max: 2,
        all: true,
      }),
    ).toMatchObject({ accounts: [{ name: "one" }, { name: "two" }] });
    expect(f.json).toHaveBeenNthCalledWith(
      1,
      "adsense",
      "accounts/pub-123:listChildAccounts",
      { query: { pageSize: 2 } },
    );
    expect(f.json).toHaveBeenNthCalledWith(
      2,
      "adsense",
      "accounts/pub-123:listChildAccounts",
      { query: { pageSize: 2, pageToken: "next" } },
    );
  });

  it.each([
    [
      "adsense.adclients.adcode",
      "accounts/pub/adclients/a",
      "accounts/pub/adclients/a/adcode",
    ],
    [
      "adsense.adunits.adcode",
      "accounts/pub/adclients/a/adunits/u",
      "accounts/pub/adclients/a/adunits/u/adcode",
    ],
    [
      "adsense.reports.saved.get",
      "accounts/pub/reports/r",
      "accounts/pub/reports/r/saved",
    ],
  ])("uses the concrete REST endpoint for %s", async (command, name, path) => {
    const f = fixture();
    await f.run(command, [name]);
    expect(f.json).toHaveBeenCalledWith("adsense", path);
  });

  it("queries AdSense dates, repeated filters, dimensions and metrics explicitly", async () => {
    const f = fixture([{ rows: [{ cells: [] }] }]);
    await f.run("adsense.reports.query", ["pub-123"], {
      from: "2026-08-01",
      to: "2026-08-31",
      metrics: "clicks,estimated_earnings",
      dimensions: "date,country_code",
      filter: ["COUNTRY_CODE==US", "AD_CLIENT_ID==a"],
      "order-by": ["+DATE", "-CLICKS"],
      currency: "USD",
      language: "en",
      timezone: "ACCOUNT_TIME_ZONE",
      max: 50,
    });
    expect(f.json).toHaveBeenCalledWith(
      "adsense",
      "accounts/pub-123/reports:generate",
      {
        query: {
          "startDate.year": 2026,
          "startDate.month": 8,
          "startDate.day": 1,
          "endDate.year": 2026,
          "endDate.month": 8,
          "endDate.day": 31,
          metrics: ["CLICKS", "ESTIMATED_EARNINGS"],
          dimensions: ["DATE", "COUNTRY_CODE"],
          filters: ["COUNTRY_CODE==US", "AD_CLIENT_ID==a"],
          orderBy: ["+DATE", "-CLICKS"],
          currencyCode: "USD",
          languageCode: "en",
          reportingTimeZone: "ACCOUNT_TIME_ZONE",
          limit: 50,
        },
      },
    );
  });

  it("supports saved report generation and rejects invalid AdSense ranges before I/O", async () => {
    const f = fixture();
    await f.run("adsense.reports.saved.query", ["accounts/pub/reports/r"], {
      "date-range": "MONTH_TO_DATE",
    });
    expect(f.json).toHaveBeenCalledWith(
      "adsense",
      "accounts/pub/reports/r/saved:generate",
      { query: { dateRange: "MONTH_TO_DATE" } },
    );
    f.json.mockClear();
    await expect(
      f.run("adsense.reports.query", ["pub"], { from: "2026-08-01" }),
    ).rejects.toThrow(/both|to/);
    await expect(
      f.run("adsense.reports.query", ["pub"], {
        from: "2026-08-02",
        to: "2026-08-01",
      }),
    ).rejects.toThrow(/date|range/i);
    await expect(
      f.run("adsense.reports.query", ["pub"], { timezone: "Pacific/Fiji" }),
    ).rejects.toThrow();
    expect(f.json).not.toHaveBeenCalled();
  });

  it("builds Analytics reports with string int64 limits and supports account summary paging", async () => {
    const f = fixture([
      { rows: [] },
      { accountSummaries: [{ account: "accounts/a" }] },
    ]);
    await f.run("analytics.report", ["123"], {
      from: "30daysAgo",
      to: "yesterday",
      dimensions: "date,country",
      metrics: "activeUsers,eventCount",
      max: 250,
      offset: 100,
    });
    expect(f.json).toHaveBeenNthCalledWith(
      1,
      "analyticsdata",
      "properties/123:runReport",
      {
        method: "POST",
        body: {
          dateRanges: [{ startDate: "30daysAgo", endDate: "yesterday" }],
          dimensions: [{ name: "date" }, { name: "country" }],
          metrics: [{ name: "activeUsers" }, { name: "eventCount" }],
          limit: "250",
          offset: "100",
        },
      },
    );
    await f.run("analytics.accounts", [], { page: "cursor" });
    expect(f.json).toHaveBeenNthCalledWith(
      2,
      "analyticsadmin",
      "accountSummaries",
      { query: { pageSize: 50, pageToken: "cursor" } },
    );
  });

  it("normalizes Search Console dimensions and preserves colons inside filter expressions", async () => {
    const f = fixture();
    await f.run("searchconsole.query", ["https://example.com/"], {
      from: "2026-08-01",
      to: "2026-08-31",
      dimensions: "query,search-appearance",
      filter: ["page:contains:https://example.com/blog:", "country:equals:usa"],
      type: "google-news",
      "data-state": "hourly_all",
      aggregation: "by-page",
      max: 75,
      offset: 10,
    });
    expect(f.json).toHaveBeenCalledWith(
      "searchconsole",
      "sites/https%3A%2F%2Fexample.com%2F/searchAnalytics/query",
      {
        method: "POST",
        body: {
          startDate: "2026-08-01",
          endDate: "2026-08-31",
          dimensions: ["QUERY", "SEARCH_APPEARANCE"],
          type: "GOOGLE_NEWS",
          dataState: "HOURLY_ALL",
          aggregationType: "BY_PAGE",
          rowLimit: 75,
          startRow: 10,
          dimensionFilterGroups: [
            {
              groupType: "AND",
              filters: [
                {
                  dimension: "PAGE",
                  operator: "CONTAINS",
                  expression: "https://example.com/blog:",
                },
                { dimension: "COUNTRY", operator: "EQUALS", expression: "usa" },
              ],
            },
          ],
        },
      },
    );
  });

  it("lets a Search Console JSON request override query flags and validates the request", async () => {
    const f = fixture();
    const request = JSON.stringify({
      startDate: "2026-08-01",
      endDate: "2026-08-31",
      searchType: "image",
      dimensions: ["device"],
      dimensionFilterGroups: [
        {
          filters: [
            {
              dimension: "device",
              operator: "not-equals",
              expression: "MOBILE",
            },
          ],
        },
      ],
    });
    await f.run(
      "searchconsole.searchanalytics.query",
      ["sc-domain:example.com"],
      { request, from: "ignored", to: "ignored", max: -1 },
    );
    expect(f.json.mock.calls[0][2]).toMatchObject({
      method: "POST",
      body: {
        type: "IMAGE",
        searchType: "IMAGE",
        rowLimit: 1000,
        dimensions: ["DEVICE"],
        dimensionFilterGroups: [
          { groupType: "AND", filters: [{ operator: "NOT_EQUALS" }] },
        ],
      },
    });
    f.json.mockClear();
    await expect(
      f.run("searchconsole.query", ["sc-domain:example.com"], {
        request: JSON.stringify({
          startDate: "2026-02-30",
          endDate: "2026-03-01",
        }),
      }),
    ).rejects.toThrow();
    await expect(
      f.run("searchconsole.query", ["sc-domain:example.com"], {
        from: "2026-08-01",
        to: "2026-08-31",
        filter: ["query:bad:value"],
      }),
    ).rejects.toThrow();
    expect(f.json).not.toHaveBeenCalled();
  });

  it("encodes website and sitemap URLs as resource segments for each mutation", async () => {
    const f = fixture();
    const site = "https://example.com/",
      feed = "https://example.com/map.xml?a=1";
    await f.run("searchconsole.sitemaps.submit", [site, feed]);
    await f.run("searchconsole.sitemaps.delete", [site, feed]);
    const path =
      "sites/https%3A%2F%2Fexample.com%2F/sitemaps/https%3A%2F%2Fexample.com%2Fmap.xml%3Fa%3D1";
    expect(f.json).toHaveBeenNthCalledWith(1, "searchconsole", path, {
      method: "PUT",
    });
    expect(f.json).toHaveBeenNthCalledWith(2, "searchconsole", path, {
      method: "DELETE",
    });
  });

  it("fails empty report/list requests when requested", async () => {
    const f = fixture([{ rows: [] }, { alerts: [] }, { siteEntry: [] }]);
    await expect(
      f.run("analytics.report", ["123"], { "fail-empty": true }),
    ).rejects.toThrow(/No results/);
    await expect(
      f.run("adsense.alerts.list", ["pub"], { "fail-empty": true }),
    ).rejects.toThrow(/No results/);
    await expect(
      f.run("searchconsole.sites.list", [], { "fail-empty": true }),
    ).rejects.toThrow(/No results/);
  });

  it("pages YouTube playlist items using maxResults and detects repeated page tokens", async () => {
    const f = fixture([
      { items: [{ id: "i1" }], nextPageToken: "next" },
      { items: [{ id: "i2" }] },
    ]);
    expect(
      await f.run("youtube.playlists.items.list", [], {
        "playlist-id": "p1",
        max: 10,
        all: true,
      }),
    ).toMatchObject({ items: [{ id: "i1" }, { id: "i2" }] });
    expect(f.json).toHaveBeenNthCalledWith(2, "youtube", "playlistItems", {
      query: {
        part: "snippet,contentDetails",
        playlistId: "p1",
        maxResults: 10,
        pageToken: "next",
      },
    });
    const loop = fixture([
      { items: [], nextPageToken: "same" },
      { items: [], nextPageToken: "same" },
    ]);
    await expect(
      loop.run("youtube.subscriptions.list", [], { all: true }),
    ).rejects.toThrow(/repeated/);
  });

  it("creates playlists and adds at position zero without dropping explicit falsey values", async () => {
    const f = fixture();
    await f.run("youtube.playlists.create", [], {
      title: "Playlist",
      description: "Notes",
      privacy: "unlisted",
    });
    expect(f.json).toHaveBeenNthCalledWith(1, "youtube", "playlists", {
      method: "POST",
      query: { part: "snippet,status" },
      body: {
        snippet: { title: "Playlist", description: "Notes" },
        status: { privacyStatus: "unlisted" },
      },
    });
    await f.run("youtube.playlists.add", [], {
      "playlist-id": "p1",
      "video-id": "v1",
      position: 0,
    });
    expect(f.json.mock.calls[1][2]).toMatchObject({
      method: "POST",
      body: {
        snippet: {
          playlistId: "p1",
          position: 0,
          resourceId: { kind: "youtube#video", videoId: "v1" },
        },
      },
    });
  });

  it("resolves a video within its approved playlist before deleting exactly its item", async () => {
    const f = fixture([{ items: [{ id: "resolved-item" }] }]);
    expect(
      await f.run("youtube.playlists.remove", [], {
        "playlist-id": "p1",
        "video-id": "v1",
      }),
    ).toMatchObject({ removed: true, itemId: "resolved-item" });
    expect(f.json).toHaveBeenNthCalledWith(1, "youtube", "playlistItems", {
      query: { part: "id", playlistId: "p1", videoId: "v1", maxResults: 1 },
    });
    expect(f.json).toHaveBeenNthCalledWith(2, "youtube", "playlistItems", {
      method: "DELETE",
      query: { id: "resolved-item" },
    });
    const missing = fixture([{ items: [] }]);
    await expect(
      missing.run("youtube.playlists.remove", [], {
        "playlist-id": "p1",
        "video-id": "v1",
      }),
    ).rejects.toThrow(/not found/);
    expect(missing.json).toHaveBeenCalledTimes(1);
  });

  it("subscribes and resolves the owner's channel subscription before deleting", async () => {
    const f = fixture([{}, { items: [{ id: "subscription" }] }]);
    await f.run("youtube.subscriptions.subscribe", [], {
      "channel-id": "channel",
    });
    expect(f.json).toHaveBeenNthCalledWith(1, "youtube", "subscriptions", {
      method: "POST",
      query: { part: "snippet" },
      body: {
        snippet: {
          resourceId: { kind: "youtube#channel", channelId: "channel" },
        },
      },
    });
    await f.run("youtube.subscriptions.unsubscribe", [], {
      "channel-id": "channel",
    });
    expect(f.json).toHaveBeenNthCalledWith(2, "youtube", "subscriptions", {
      query: { part: "id", mine: true, forChannelId: "channel", maxResults: 1 },
    });
    expect(f.json).toHaveBeenNthCalledWith(3, "youtube", "subscriptions", {
      method: "DELETE",
      query: { id: "subscription" },
    });
  });

  it("rejects conflicting YouTube targets before any network request", async () => {
    const f = fixture();
    for (const [command, flags] of [
      ["youtube.channels.list", { id: "a", mine: true }],
      ["youtube.activities.list", {}],
      ["youtube.videos.list", { id: "v1", chart: "mostPopular", region: "US" }],
      ["youtube.videos.list", { chart: "mostPopular" }],
      ["youtube.videos.list", { id: "v1", parts: "all,snippet" }],
      ["youtube.comments.list", { "video-id": "v1", "channel-id": "c1" }],
      ["youtube.playlists.remove", { "item-id": "i1", "video-id": "v1" }],
      ["youtube.subscriptions.unsubscribe", { id: "s1", "channel-id": "c1" }],
      ["youtube.playlists.create", { title: "p", privacy: "bad" }],
      ["youtube.subscriptions.list", { max: 51 }],
    ] as [string, Data][])
      await expect(f.run(command, [], flags)).rejects.toThrow();
    expect(f.json).not.toHaveBeenCalled();
  });

  it("expands video parts and filters search results to the requested kinds", async () => {
    const f = fixture([
      {},
      { items: [{ id: { videoId: "v" } }, { id: { channelId: "c" } }] },
    ]);
    await f.run("youtube.videos.list", [], {
      "my-rating": "like",
      parts: "all",
    });
    expect(f.json.mock.calls[0][2]).toMatchObject({
      query: {
        myRating: "like",
        part: expect.stringContaining("paidProductPlacementDetails"),
      },
    });
    expect(
      await f.run("youtube.search.list", ["query"], {
        type: "video",
        order: "date",
        "channel-id": "c",
      }),
    ).toMatchObject({ items: [{ id: { videoId: "v" } }] });
    expect(f.json.mock.calls[1][2]).toMatchObject({
      query: {
        q: "query",
        part: "snippet",
        type: "video",
        order: "date",
        channelId: "c",
      },
    });
  });
});
