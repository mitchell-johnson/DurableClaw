import { enumValue, integer } from "./drive-helpers";
import {
  required,
  type Command,
  type Data,
  type HandlerMap,
  type Runtime,
} from "./types";

const csv = (value: unknown) =>
  String(value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const text = (value: unknown) => String(value ?? "").trim();
const need = (value: unknown, flag: string) => required(text(value), flag);
function exactlyOne(values: unknown[], names: string): void {
  if (values.filter(Boolean).length !== 1)
    throw new Error(`Choose exactly one of ${names}`);
}
function channel(c: Command): Data {
  const channelId = text(c.flags["channel-id"]),
    mine = !!c.flags.mine;
  exactlyOne([channelId, mine], "--channel-id or --mine");
  return channelId ? { channelId } : { mine: true };
}
async function youtubeList(
  c: Command,
  r: Runtime,
  path: string,
  query: Data,
  defaultMax = 25,
): Promise<Data> {
  const maxResults = integer(c.flags.max, defaultMax, 1, 50),
    items: Data[] = [];
  let page = c.flags.page,
    response: Data = {};
  const seen = new Set<string>();
  do {
    r.signal.throwIfAborted();
    response = await r.json("youtube", path, {
      query: { ...query, maxResults, ...(page ? { pageToken: page } : {}) },
    });
    items.push(...(response.items ?? []));
    if (items.length > 5000)
      throw new Error("Result exceeds 5000 items; use page tokens");
    page = response.nextPageToken;
    if (!c.flags.all || !page) break;
    if (seen.has(page)) throw new Error("Provider repeated a page token");
    seen.add(page);
  } while (page);
  return { items, nextPageToken: page ?? "" };
}

export const youtubeHandlers: HandlerMap = {
  "youtube.activities.list": (c, r) =>
    youtubeList(c, r, "activities", {
      part: "snippet,contentDetails",
      ...channel(c),
    }),
  "youtube.playlists.list": (c, r) =>
    youtubeList(c, r, "playlists", {
      part: "snippet,contentDetails",
      ...channel(c),
    }),
  "youtube.channels.list": (c, r) => {
    const ids = csv(c.flags.id),
      mine = !!c.flags.mine;
    exactlyOne([ids.length, mine], "--id or --mine");
    return youtubeList(c, r, "channels", {
      part: "snippet,statistics,contentDetails",
      ...(ids.length ? { id: ids.join(",") } : { mine: true }),
    });
  },
  "youtube.comments.list": (c, r) => {
    const videoId = text(c.flags["video-id"]),
      channelId = text(c.flags["channel-id"]);
    exactlyOne([videoId, channelId], "--video-id or --channel-id");
    return youtubeList(c, r, "commentThreads", {
      part: "snippet",
      ...(videoId ? { videoId } : { channelId }),
    });
  },
  "youtube.videos.list": (c, r) => {
    const f = c.flags,
      ids = csv(f.id),
      chart = text(f.chart),
      myRating = text(f["my-rating"]);
    exactlyOne([ids.length, chart, myRating], "--id, --chart or --my-rating");
    const query: Data = {};
    if (ids.length) query.id = ids.join(",");
    else if (chart) {
      query.chart = enumValue(chart, ["mostPopular"], "mostPopular");
      query.regionCode = need(f.region, "region");
    } else query.myRating = enumValue(myRating, ["like", "dislike"], "like");
    let parts = csv(f.parts);
    if (!parts.length) parts = ["snippet", "contentDetails", "statistics"];
    if (parts.includes("all")) {
      if (parts.length !== 1)
        throw new Error("--parts all cannot be combined with explicit parts");
      parts = [
        "contentDetails",
        "id",
        "liveStreamingDetails",
        "localizations",
        "paidProductPlacementDetails",
        "player",
        "recordingDetails",
        "snippet",
        "statistics",
        "status",
        "topicDetails",
      ];
    }
    return youtubeList(c, r, "videos", { part: parts.join(","), ...query });
  },
  "youtube.search.list": async (c, r) => {
    const types = csv(c.flags.type ?? "video");
    if (!types.length)
      throw new Error("type requires video, channel, or playlist");
    for (const type of types)
      enumValue(type, ["video", "channel", "playlist"], "video");
    const result = await youtubeList(c, r, "search", {
      part: "snippet",
      q: need(c.positionals[0], "query"),
      type: types.join(","),
      order: text(c.flags.order ?? "relevance"),
      ...(text(c.flags["channel-id"])
        ? { channelId: text(c.flags["channel-id"]) }
        : {}),
    });
    result.items = result.items.filter((item: Data) => {
      const id = item.id ?? {};
      const type = id.videoId
        ? "video"
        : id.channelId
          ? "channel"
          : id.playlistId
            ? "playlist"
            : String(id.kind ?? "").replace(/^youtube#/, "");
      return types.includes(type);
    });
    return result;
  },
  "youtube.playlists.items.list": (c, r) =>
    youtubeList(
      c,
      r,
      "playlistItems",
      {
        part: "snippet,contentDetails",
        playlistId: need(c.flags["playlist-id"], "playlist-id"),
      },
      50,
    ),
  "youtube.playlists.create": (c, r) =>
    r.json("youtube", "playlists", {
      method: "POST",
      query: { part: "snippet,status" },
      body: {
        snippet: {
          title: need(c.flags.title, "title"),
          description: text(c.flags.description),
        },
        status: {
          privacyStatus: enumValue(
            c.flags.privacy,
            ["private", "public", "unlisted"],
            "private",
          ),
        },
      },
    }),
  "youtube.playlists.add": (c, r) => {
    const position = integer(c.flags.position, -1, -1, Number.MAX_SAFE_INTEGER);
    return r.json("youtube", "playlistItems", {
      method: "POST",
      query: { part: "snippet" },
      body: {
        snippet: {
          playlistId: need(c.flags["playlist-id"], "playlist-id"),
          resourceId: {
            kind: "youtube#video",
            videoId: need(c.flags["video-id"], "video-id"),
          },
          ...(position >= 0 ? { position } : {}),
        },
      },
    });
  },
  "youtube.playlists.remove": async (c, r) => {
    let itemId = text(c.flags["item-id"]);
    const videoId = text(c.flags["video-id"]);
    exactlyOne([itemId, videoId], "--item-id or --video-id");
    if (videoId) {
      const playlistId = need(c.flags["playlist-id"], "playlist-id");
      const found = await r.json("youtube", "playlistItems", {
        query: { part: "id", playlistId, videoId, maxResults: 1 },
      });
      itemId = text(found.items?.[0]?.id);
      if (!itemId)
        throw new Error(`Video ${videoId} not found in playlist ${playlistId}`);
    }
    await r.json("youtube", "playlistItems", {
      method: "DELETE",
      query: { id: itemId },
    });
    return { removed: true, itemId };
  },
  "youtube.playlists.delete": async (c, r) => {
    const playlistId = need(c.positionals[0], "playlist-id");
    await r.json("youtube", "playlists", {
      method: "DELETE",
      query: { id: playlistId },
    });
    return { deleted: true, playlistId };
  },
  "youtube.subscriptions.list": (c, r) =>
    youtubeList(c, r, "subscriptions", { part: "snippet", mine: true }, 50),
  "youtube.subscriptions.subscribe": (c, r) =>
    r.json("youtube", "subscriptions", {
      method: "POST",
      query: { part: "snippet" },
      body: {
        snippet: {
          resourceId: {
            kind: "youtube#channel",
            channelId: need(c.flags["channel-id"], "channel-id"),
          },
        },
      },
    }),
  "youtube.subscriptions.unsubscribe": async (c, r) => {
    let subscriptionId = text(c.flags.id);
    const channelId = text(c.flags["channel-id"]);
    exactlyOne([subscriptionId, channelId], "--id or --channel-id");
    if (channelId) {
      const found = await r.json("youtube", "subscriptions", {
        query: {
          part: "id",
          mine: true,
          forChannelId: channelId,
          maxResults: 1,
        },
      });
      subscriptionId = text(found.items?.[0]?.id);
      if (!subscriptionId)
        throw new Error(`Not subscribed to channel ${channelId}`);
    }
    await r.json("youtube", "subscriptions", {
      method: "DELETE",
      query: { id: subscriptionId },
    });
    return { unsubscribed: true, subscriptionId };
  },
};
