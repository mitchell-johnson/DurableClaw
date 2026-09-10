import {
  date,
  enumValue,
  integer,
  list,
  paged,
  resource,
} from "./drive-helpers";
import {
  required,
  segment,
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
const name = (c: Command) =>
  required(c.positionals[0]?.trim(), "resource name")
    .split("/")
    .map(segment)
    .join("/");
const account = (c: Command) => resource(c.positionals[0], "accounts");
const property = (c: Command) => resource(c.positionals[0], "properties");
const nonempty = (c: Command, result: Data, key: string) => {
  if (c.flags["fail-empty"] && !result[key]?.length)
    throw new Error("No results");
  return result;
};
function dateRange(from: unknown, to: unknown): [Data, Data] {
  if (!from || !to) throw new Error("Both from and to dates are required");
  const start = date(from),
    end = date(to);
  if (String(to) < String(from))
    throw new Error("Invalid date range: end precedes start");
  return [start, end];
}

function adsenseReport(c: Command, saved: boolean): Data {
  const f = c.flags,
    query: Data = {};
  if (f.from || f.to) {
    const [start, end] = dateRange(f.from, f.to);
    for (const [prefix, value] of [
      ["startDate", start],
      ["endDate", end],
    ] as const)
      for (const key of ["year", "month", "day"])
        query[`${prefix}.${key}`] = value[key];
  } else
    query.dateRange = required(
      String(f["date-range"] ?? "LAST_7_DAYS")
        .trim()
        .toUpperCase(),
      "date-range",
    );
  if (f.currency) query.currencyCode = String(f.currency).trim();
  if (f.language) query.languageCode = String(f.language).trim();
  if (f.timezone)
    query.reportingTimeZone = enumValue(
      String(f.timezone).trim().toUpperCase(),
      ["ACCOUNT_TIME_ZONE", "GOOGLE_TIME_ZONE"],
      "ACCOUNT_TIME_ZONE",
    );
  if (!saved) {
    query.metrics = csv(
      f.metrics ?? "ESTIMATED_EARNINGS,CLICKS,IMPRESSIONS",
    ).map((v) => v.toUpperCase());
    if (!query.metrics.length)
      throw new Error("At least one metric is required");
    const dimensions = csv(f.dimensions ?? "DATE").map((v) => v.toUpperCase());
    if (dimensions.length) query.dimensions = dimensions;
    for (const [flag, key] of [
      ["filter", "filters"],
      ["order-by", "orderBy"],
    ]) {
      const values = list(f[flag])
        .map((v) => v.trim())
        .filter(Boolean);
      if (values.length) query[key] = values;
    }
    const max = integer(f.max, 0, 0, Number.MAX_SAFE_INTEGER);
    if (max) query.limit = max;
  }
  return query;
}

export const dataReportHandlers: HandlerMap = {
  "adsense.accounts.list": (c, r) =>
    paged(r, "adsense", "accounts", "accounts", c, {}, 50),
  "adsense.accounts.children": (c, r) =>
    paged(
      r,
      "adsense",
      `${account(c)}:listChildAccounts`,
      "accounts",
      c,
      {},
      50,
    ),
  "adsense.accounts.get": (c, r) => r.json("adsense", account(c)),
  "adsense.adclients.list": (c, r) =>
    paged(r, "adsense", `${account(c)}/adclients`, "adClients", c, {}, 50),
  "adsense.adclients.get": (c, r) => r.json("adsense", name(c)),
  "adsense.adclients.adcode": (c, r) => r.json("adsense", `${name(c)}/adcode`),
  "adsense.adunits.list": (c, r) =>
    paged(r, "adsense", `${name(c)}/adunits`, "adUnits", c, {}, 50),
  "adsense.adunits.get": (c, r) => r.json("adsense", name(c)),
  "adsense.adunits.adcode": (c, r) => r.json("adsense", `${name(c)}/adcode`),
  "adsense.adunits.linkedcustomchannels": (c, r) =>
    paged(
      r,
      "adsense",
      `${name(c)}:listLinkedCustomChannels`,
      "customChannels",
      c,
      {},
      50,
    ),
  "adsense.customchannels.list": (c, r) =>
    paged(
      r,
      "adsense",
      `${name(c)}/customchannels`,
      "customChannels",
      c,
      {},
      50,
    ),
  "adsense.customchannels.get": (c, r) => r.json("adsense", name(c)),
  "adsense.customchannels.linkedadunits": (c, r) =>
    paged(r, "adsense", `${name(c)}:listLinkedAdUnits`, "adUnits", c, {}, 50),
  "adsense.urlchannels.list": (c, r) =>
    paged(r, "adsense", `${name(c)}/urlchannels`, "urlChannels", c, {}, 50),
  "adsense.urlchannels.get": (c, r) => r.json("adsense", name(c)),
  "adsense.policyissues.list": (c, r) =>
    paged(
      r,
      "adsense",
      `${account(c)}/policyIssues`,
      "policyIssues",
      c,
      {},
      50,
    ),
  "adsense.policyissues.get": (c, r) => r.json("adsense", name(c)),
  "adsense.sites.list": (c, r) =>
    paged(r, "adsense", `${account(c)}/sites`, "sites", c, {}, 50),
  "adsense.sites.get": (c, r) => r.json("adsense", name(c)),
  "adsense.alerts.list": async (c, r) =>
    nonempty(
      c,
      await r.json("adsense", `${account(c)}/alerts`, {
        query: c.flags.language ? { languageCode: c.flags.language } : {},
      }),
      "alerts",
    ),
  "adsense.payments.list": async (c, r) =>
    nonempty(c, await r.json("adsense", `${account(c)}/payments`), "payments"),
  "adsense.reports.saved.list": (c, r) =>
    paged(
      r,
      "adsense",
      `${account(c)}/reports/saved`,
      "savedReports",
      c,
      {},
      50,
    ),
  "adsense.reports.saved.get": (c, r) => r.json("adsense", `${name(c)}/saved`),
  "adsense.reports.saved.query": async (c, r) =>
    nonempty(
      c,
      await r.json("adsense", `${name(c)}/saved:generate`, {
        query: adsenseReport(c, true),
      }),
      "rows",
    ),
  "adsense.reports.query": async (c, r) => {
    const query = adsenseReport(c, false),
      result = nonempty(
        c,
        await r.json("adsense", `${account(c)}/reports:generate`, { query }),
        "rows",
      );
    return {
      ...result,
      account: account(c),
      dimensions: query.dimensions ?? [],
      metrics: query.metrics,
      total_matched_rows: result.totalMatchedRows,
    };
  },
  "analytics.accounts": (c, r) =>
    paged(
      r,
      "analyticsadmin",
      "accountSummaries",
      "accountSummaries",
      c,
      {},
      50,
    ),
  "analytics.report": async (c, r) => {
    const f = c.flags,
      metrics = csv(f.metrics ?? "activeUsers"),
      dimensions = csv(f.dimensions ?? "date");
    if (!metrics.length) throw new Error("At least one metric is required");
    const from = required(String(f.from ?? "7daysAgo").trim(), "from"),
      to = required(String(f.to ?? "today").trim(), "to");
    const result = nonempty(
      c,
      await r.json("analyticsdata", `${property(c)}:runReport`, {
        method: "POST",
        body: {
          dateRanges: [{ startDate: from, endDate: to }],
          ...(dimensions.length
            ? { dimensions: dimensions.map((name) => ({ name })) }
            : {}),
          metrics: metrics.map((name) => ({ name })),
          limit: String(integer(f.max, 100, 1, Number.MAX_SAFE_INTEGER)),
          offset: String(integer(f.offset, 0, 0, Number.MAX_SAFE_INTEGER)),
        },
      }),
      "rows",
    );
    return {
      ...result,
      property: property(c),
      from,
      to,
      dimensions,
      metrics,
      row_count: result.rowCount,
    };
  },
};

const dimensions = [
  "DATE",
  "QUERY",
  "PAGE",
  "COUNTRY",
  "DEVICE",
  "SEARCH_APPEARANCE",
  "HOUR",
];
const operators = [
  "EQUALS",
  "NOT_EQUALS",
  "CONTAINS",
  "NOT_CONTAINS",
  "INCLUDING_REGEX",
  "EXCLUDING_REGEX",
];
const normalize = (value: unknown, allowed: string[]) => {
  const compact = (s: string) => s.trim().replace(/[_-]/g, "").toUpperCase();
  const matched = allowed.find(
    (v) => compact(v) === compact(String(value ?? "")),
  );
  if (!matched) throw new Error(`Expected one of ${allowed.join(", ")}`);
  return matched;
};
function filter(value: Data): Data {
  return {
    dimension: normalize(value.dimension, dimensions),
    operator: normalize(value.operator, operators),
    expression: required(
      typeof value.expression === "string"
        ? value.expression.trim()
        : undefined,
      "filter expression",
    ),
  };
}
function queryBody(c: Command, r: Runtime): Data {
  const f = c.flags;
  let raw: Data;
  if (f.request) {
    const parsed = r.jsonInput(f.request);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("request must be a JSON object");
    raw = parsed;
  } else {
    raw = {
      startDate: f.from,
      endDate: f.to,
      dimensions: csv(f.dimensions ?? "QUERY"),
      type: f.type ?? "WEB",
      rowLimit: integer(f.max, 1000, 1, 25000),
      startRow: f.offset ?? 0,
      aggregationType: f.aggregation,
      dataState: f["data-state"],
    };
    const filters = list(f.filter).map((text) => {
      const match = text.trim().match(/^([^:]+):([^:]*):(.*)$/s);
      if (!match)
        throw new Error("filter requires dimension:operator:expression");
      return filter({
        dimension: match[1],
        operator: match[2],
        expression: match[3],
      });
    });
    if (filters.length)
      raw.dimensionFilterGroups = [{ groupType: "AND", filters }];
  }
  dateRange(raw.startDate, raw.endDate);
  const type = normalize(raw.type || raw.searchType || "WEB", [
    "WEB",
    "IMAGE",
    "VIDEO",
    "NEWS",
    "DISCOVER",
    "GOOGLE_NEWS",
  ]);
  const body: Data = {
    startDate: raw.startDate,
    endDate: raw.endDate,
    type,
    ...(f.request ? { searchType: type } : {}),
    rowLimit: integer(raw.rowLimit || 1000, 1000, 1, 25000),
    startRow: integer(raw.startRow, 0, 0, Number.MAX_SAFE_INTEGER),
  };
  if (raw.dimensions !== undefined) {
    if (!Array.isArray(raw.dimensions))
      throw new Error("request.dimensions must be an array");
    body.dimensions = raw.dimensions.map((value) =>
      normalize(value, dimensions),
    );
  }
  if (raw.aggregationType)
    body.aggregationType = normalize(raw.aggregationType, [
      "AUTO",
      "BY_PROPERTY",
      "BY_PAGE",
      "BY_NEWS_SHOWCASE_PANEL",
    ]);
  if (raw.dataState)
    body.dataState = normalize(raw.dataState, ["FINAL", "ALL", "HOURLY_ALL"]);
  if (raw.dimensionFilterGroups !== undefined) {
    if (!Array.isArray(raw.dimensionFilterGroups))
      throw new Error("request.dimensionFilterGroups must be an array");
    body.dimensionFilterGroups = raw.dimensionFilterGroups
      .filter(Boolean)
      .map((group: Data) => {
        if (!Array.isArray(group.filters ?? []))
          throw new Error("request filters must be an array");
        return {
          groupType: normalize(group.groupType || "AND", ["AND"]),
          filters: (group.filters ?? []).filter(Boolean).map(filter),
        };
      });
  }
  return body;
}
const site = (c: Command) =>
  `sites/${segment(required(c.positionals[0]?.trim(), "siteUrl"))}`;
const sitemap = (c: Command) =>
  `${site(c)}/sitemaps/${segment(required(c.positionals[1]?.trim(), "feedpath"))}`;
const query = async (c: Command, r: Runtime) =>
  nonempty(
    c,
    await r.json("searchconsole", `${site(c)}/searchAnalytics/query`, {
      method: "POST",
      body: queryBody(c, r),
    }),
    "rows",
  );
export const searchReportHandlers: HandlerMap = {
  "searchconsole.query": query,
  "searchconsole.searchanalytics.query": query,
  "searchconsole.sites.list": async (c, r) =>
    nonempty(c, await r.json("searchconsole", "sites"), "siteEntry"),
  "searchconsole.sites.get": (c, r) => r.json("searchconsole", site(c)),
  "searchconsole.sitemaps.list": async (c, r) =>
    nonempty(
      c,
      await r.json("searchconsole", `${site(c)}/sitemaps`, {
        query: c.flags["sitemap-index"]
          ? { sitemapIndex: c.flags["sitemap-index"] }
          : {},
      }),
      "sitemap",
    ),
  "searchconsole.sitemaps.get": (c, r) => r.json("searchconsole", sitemap(c)),
  "searchconsole.sitemaps.submit": async (c, r) => {
    await r.json("searchconsole", sitemap(c), { method: "PUT" });
    return {
      submitted: true,
      siteUrl: c.positionals[0],
      feedpath: c.positionals[1],
    };
  },
  "searchconsole.sitemaps.delete": async (c, r) => {
    await r.json("searchconsole", sitemap(c), { method: "DELETE" });
    return {
      deleted: true,
      siteUrl: c.positionals[0],
      feedpath: c.positionals[1],
    };
  },
};
