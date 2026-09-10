import type { Command, Data, HandlerMap, Runtime } from "./types";
import { required, segment } from "./types";
import { encode64, list, pages } from "./communications-mail";
const enc = new TextEncoder();
function iso(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid date or time");
  return date.toISOString();
}
function localParts(time: Date, zone: string): number[] {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(time)
      .map((p) => [p.type, p.value]),
  );
  return [p.year, p.month, p.day, p.hour, p.minute, p.second].map(Number);
}
function wallTime(parts: number[], zone: string): Date {
  const desired = Date.UTC(
    parts[0],
    parts[1] - 1,
    parts[2],
    parts[3] || 0,
    parts[4] || 0,
    parts[5] || 0,
  );
  const normalized = new Date(desired);
  if (
    normalized.getUTCFullYear() !== parts[0] ||
    normalized.getUTCMonth() + 1 !== parts[1] ||
    normalized.getUTCDate() !== parts[2] ||
    (parts[3] ?? 0) > 23 ||
    (parts[4] ?? 0) > 59 ||
    (parts[5] ?? 0) > 59
  )
    throw new Error("Invalid calendar date or time");
  let guess = desired;
  for (let i = 0; i < 4; i++) {
    const p = localParts(new Date(guess), zone);
    const shown = Date.UTC(p[0], p[1] - 1, p[2], p[3], p[4], p[5]);
    const next = guess + desired - shown;
    if (next === guess) return new Date(next);
    guess = next;
  }
  throw new Error("Local time does not exist in the selected timezone");
}
const weekdays = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];
function parseTime(value: string, zone: string, now = new Date()): Date {
  const text = required(value, "time")
    .trim()
    .replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  if (/T.*(?:Z|[+-]\d\d:\d\d)$/i.test(text)) return new Date(iso(text));
  if (text.toLowerCase() === "now") return now;
  const p = localParts(now, zone),
    date = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  if (["today", "tomorrow", "yesterday"].includes(text.toLowerCase())) {
    date.setUTCDate(
      date.getUTCDate() +
        (text.toLowerCase() === "tomorrow"
          ? 1
          : text.toLowerCase() === "yesterday"
            ? -1
            : 0),
    );
    return wallTime(
      [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()],
      zone,
    );
  }
  const weekday =
    /^(next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/i.exec(
      text,
    );
  if (weekday) {
    let delta =
      (weekdays.indexOf(weekday[2].toLowerCase()) - date.getUTCDay() + 7) % 7;
    if (!delta || weekday[1]) delta ||= 7;
    date.setUTCDate(date.getUTCDate() + delta);
    return wallTime(
      [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()],
      zone,
    );
  }
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (!match)
    throw new Error("Use RFC3339, a date, today/tomorrow, or a weekday");
  return wallTime(
    match.slice(1).map((v) => Number(v || 0)),
    zone,
  );
}
async function calendarId(r: Runtime, value = "primary"): Promise<string> {
  if (value === "primary" || value.includes("@")) return value;
  const entries = (
    await pages(
      r,
      "calendar",
      "users/me/calendarList",
      "items",
      { all: true },
      { maxResults: 250 },
    )
  ).items;
  if (/^\d+$/.test(value) && entries[Number(value) - 1])
    return entries[Number(value) - 1].id;
  const matches = entries.filter(
    (v: Data) =>
      v.id === value || v.summary === value || v.summaryOverride === value,
  );
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1)
    throw new Error("Calendar name is ambiguous; use its ID");
  return value;
}
async function calendars(c: Command, r: Runtime): Promise<string[]> {
  if (c.flags.all)
    return (
      await pages(
        r,
        "calendar",
        "users/me/calendarList",
        "items",
        { all: true },
        { maxResults: 250 },
      )
    ).items
      .filter((v: Data) => !v.deleted)
      .map((v: Data) => v.id);
  const selected = [
    ...list(c.flags.cal),
    ...list(c.flags.calendars),
    ...list(c.positionals[0]),
  ];
  const result: string[] = [];
  for (const value of selected.length ? selected : ["primary"])
    result.push(await calendarId(r, value));
  return [...new Set(result)];
}
async function timezone(
  r: Runtime,
  id: string,
  explicit?: string,
): Promise<string> {
  const zone =
    explicit ||
    (await r.json("calendar", `calendars/${segment(id)}`)).timeZone ||
    "UTC";
  new Intl.DateTimeFormat("en", { timeZone: zone });
  return zone;
}
function plusDays(date: Date, days: number, zone: string): Date {
  const p = localParts(date, zone),
    value = new Date(Date.UTC(p[0], p[1] - 1, p[2] + days));
  return wallTime(
    [
      value.getUTCFullYear(),
      value.getUTCMonth() + 1,
      value.getUTCDate(),
      p[3],
      p[4],
      p[5],
    ],
    zone,
  );
}
async function range(c: Command, r: Runtime, id = "primary"): Promise<Data> {
  const f = c.flags;
  if (
    [f.today, f.tomorrow, f.week].filter(Boolean).length > 1 ||
    ((f.today || f.tomorrow || f.week) && (f.from || f.to || f.days))
  )
    throw new Error("Choose explicit bounds or one convenience time window");
  if (f.days < 0 || (f.days && f.to))
    throw new Error("Invalid days/time-window combination");
  const absolute = (v: unknown) =>
    typeof v === "string" && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(v);
  const zone =
    f.timezone ||
    (absolute(f.from) && absolute(f.to) ? "UTC" : await timezone(r, id));
  let from = f.from
    ? parseTime(f.from, zone)
    : parseTime(f.tomorrow ? "tomorrow" : "today", zone);
  if (f.week) {
    const target = f["week-start"]
      ? weekdays.findIndex((day) =>
          day.startsWith(String(f["week-start"]).toLowerCase()),
        )
      : 1;
    if (target < 0) throw new Error("Invalid week start");
    const p = localParts(from, zone),
      day = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
    from = plusDays(from, -((day - target + 7) % 7), zone);
  }
  const to = f.to
    ? /^\d{4}-\d{2}-\d{2}$/.test(f.to) ||
      /^(today|tomorrow|yesterday|(?:next )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))$/i.test(
        f.to,
      )
      ? new Date(plusDays(parseTime(f.to, zone), 1, zone).getTime() - 1)
      : parseTime(f.to, zone)
    : plusDays(
        from,
        f.week ? 7 : f.today || f.tomorrow ? 1 : f.days || 7,
        zone,
      );
  if (to <= from) throw new Error("End time must be later than start time");
  return {
    timeMin: from.toISOString(),
    timeMax: to.toISOString(),
    timeZone: zone,
  };
}
const eventTypes: Data = {
  default: "default",
  birthday: "birthday",
  focus: "focusTime",
  "focus-time": "focusTime",
  focustime: "focusTime",
  focus_time: "focusTime",
  "from-gmail": "fromGmail",
  fromgmail: "fromGmail",
  from_gmail: "fromGmail",
  ooo: "outOfOffice",
  "out-of-office": "outOfOffice",
  outofoffice: "outOfOffice",
  out_of_office: "outOfOffice",
  wl: "workingLocation",
  "working-location": "workingLocation",
  workinglocation: "workingLocation",
  working_location: "workingLocation",
};
function eventType(value: string): string {
  const type = eventTypes[value.toLowerCase()];
  if (!type) throw new Error("Invalid event type");
  return type;
}
function properties(value: unknown): Data {
  const result: Data = {};
  for (const item of list(value)) {
    const sep = item.indexOf("=");
    if (sep <= 0) throw new Error("Properties require key=value");
    result[item.slice(0, sep)] = item.slice(sep + 1);
  }
  return result;
}
function decline(value: string): string {
  const mapped = (
    {
      all: "declineAllConflictingInvitations",
      new: "declineOnlyNewConflictingInvitations",
      none: "declineNone",
    } as Data
  )[value];
  if (!mapped) throw new Error("Auto-decline must be all, new or none");
  return mapped;
}
export async function lookupPlace(r: Runtime, f: Data): Promise<Data> {
  const locale = {
    ...(f["place-language"] ? { languageCode: f["place-language"] } : {}),
    ...(f["place-region"] ? { regionCode: f["place-region"] } : {}),
  };
  let place: Data;
  if (f["place-id"])
    place = await r.json(
      "places",
      `places/${segment(String(f["place-id"]).replace(/^places\//, ""))}`,
      {
        query: locale,
        headers: {
          "X-Goog-FieldMask": "id,displayName,formattedAddress,googleMapsUri",
        },
      },
    );
  else {
    const result = await r.json("places", "places:searchText", {
      method: "POST",
      body: {
        textQuery: required(f["location-search"], "location search"),
        ...locale,
      },
      headers: {
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.formattedAddress,places.googleMapsUri",
      },
    });
    place = result.places?.[0];
    if (!place) throw new Error("No matching place");
  }
  return place;
}
async function eventBody(
  c: Command,
  r: Runtime,
  cal: string,
  existing?: Data,
): Promise<Data> {
  const f: Data = { ...c.flags },
    body: Data = {};
  const update = !!existing;
  for (const key of ["with-zoom", "regenerate-zoom", "remove-zoom"])
    if (f[key])
      throw new Error(
        "Zoom meeting integration requires a separately connected Zoom service",
      );
  for (const [flag, key] of Object.entries({
    summary: "summary",
    description: "description",
    location: "location",
    visibility: "visibility",
    transparency: "transparency",
    "event-color": "colorId",
    "guests-can-invite": "guestsCanInviteOthers",
    "guests-can-modify": "guestsCanModify",
    "guests-can-see-others": "guestsCanSeeOtherGuests",
  }))
    if (f[flag] !== undefined) body[key] = f[flag];
  if (f["location-search"] && f["place-id"])
    throw new Error("Choose location search or place ID");
  if (f["location-search"] || f["place-id"]) {
    const place = await lookupPlace(r, f);
    body.location = [place.displayName?.text, place.formattedAddress]
      .filter(Boolean)
      .join(", ");
  }
  if (f.attendees !== undefined)
    body.attendees = list(f.attendees).map((email) => ({ email }));
  if (f["add-attendee"]) {
    const members = body.attendees ?? existing?.attendees ?? [];
    body.attendees = [...members];
    for (const email of list(f["add-attendee"]))
      if (
        !body.attendees.some(
          (a: Data) => a.email.toLowerCase() === email.toLowerCase(),
        )
      )
        body.attendees.push({ email });
  }
  if (f["no-reminders"] && f.reminder)
    throw new Error("Choose reminders or no reminders");
  if (f["no-reminders"]) body.reminders = { useDefault: false, overrides: [] };
  if (f.reminder !== undefined)
    body.reminders = {
      useDefault: false,
      overrides: list(f.reminder).map((value) => {
        const m = /^(popup|email):(\d+)([mhdw]?)$/.exec(value);
        if (!m) throw new Error("Reminder must be popup:10m or email:1d");
        const minutes =
          Number(m[2]) *
          ({ "": 1, m: 1, h: 60, d: 1440, w: 10080 } as Data)[m[3]];
        if (minutes > 40320) throw new Error("Reminder exceeds four weeks");
        return { method: m[1], minutes };
      }),
    };
  if (f.rrule !== undefined)
    body.recurrence = (Array.isArray(f.rrule) ? f.rrule : [f.rrule])
      .filter(Boolean)
      .map((v: string) =>
        /^(RRULE|RDATE|EXDATE|EXRULE):/i.test(v) ? v : "RRULE:" + v,
      );
  if (f.attachment !== undefined)
    body.attachments = list(f.attachment).map((fileUrl) => ({ fileUrl }));
  if (f["private-prop"] !== undefined || f["shared-prop"] !== undefined)
    body.extendedProperties = {
      ...existing?.extendedProperties,
      ...(f["private-prop"] !== undefined
        ? {
            private: {
              ...existing?.extendedProperties?.private,
              ...properties(f["private-prop"]),
            },
          }
        : {}),
      ...(f["shared-prop"] !== undefined
        ? {
            shared: {
              ...existing?.extendedProperties?.shared,
              ...properties(f["shared-prop"]),
            },
          }
        : {}),
    };
  if (f["source-url"] || f["source-title"])
    body.source = { url: f["source-url"], title: f["source-title"] };
  const focus = Object.keys(f).some((k) => k.startsWith("focus-") && f[k]),
    ooo = Object.keys(f).some((k) => k.startsWith("ooo-") && f[k]),
    working = Object.keys(f).some((k) => k.startsWith("working-") && f[k]);
  if ([focus, ooo, working].filter(Boolean).length > 1)
    throw new Error("Choose one event type");
  const type = f["event-type"]
    ? eventType(f["event-type"])
    : focus
      ? "focusTime"
      : ooo
        ? "outOfOffice"
        : working
          ? "workingLocation"
          : undefined;
  if (type) {
    if (["birthday", "fromGmail"].includes(type))
      throw new Error("This event type is read-only");
    body.eventType = type;
  }
  if (type === "focusTime")
    body.focusTimeProperties = {
      autoDeclineMode: "declineAllConflictingInvitations",
      chatStatus: "doNotDisturb",
      ...existing?.focusTimeProperties,
      ...(f["focus-auto-decline"]
        ? { autoDeclineMode: decline(f["focus-auto-decline"]) }
        : {}),
      ...(f["focus-chat-status"] ? { chatStatus: f["focus-chat-status"] } : {}),
      ...(f["focus-decline-message"] !== undefined
        ? { declineMessage: f["focus-decline-message"] }
        : {}),
    };
  if (type === "outOfOffice")
    body.outOfOfficeProperties = {
      autoDeclineMode: "declineAllConflictingInvitations",
      declineMessage: "I am out of office and will respond when I return.",
      ...existing?.outOfOfficeProperties,
      ...(f["ooo-auto-decline"]
        ? { autoDeclineMode: decline(f["ooo-auto-decline"]) }
        : {}),
      ...(f["ooo-decline-message"] !== undefined
        ? { declineMessage: f["ooo-decline-message"] }
        : {}),
    };
  if (type === "workingLocation") {
    const requestedType =
      f["working-location-type"] || existing?.workingLocationProperties?.type;
    const locationType =
      (
        {
          home: "homeOffice",
          office: "officeLocation",
          custom: "customLocation",
        } as Data
      )[requestedType] || requestedType;
    if (
      !["homeOffice", "officeLocation", "customLocation"].includes(locationType)
    )
      throw new Error(
        "Working location type must be homeOffice, officeLocation or customLocation",
      );
    body.workingLocationProperties = {
      type: locationType,
      ...(locationType === "homeOffice"
        ? { homeOffice: {} }
        : locationType === "customLocation"
          ? {
              customLocation: {
                label: required(
                  f["working-custom-label"],
                  "working custom label",
                ),
              },
            }
          : {
              officeLocation: {
                buildingId: f["working-building-id"],
                floorId: f["working-floor-id"],
                deskId: f["working-desk-id"],
                label: f["working-office-label"],
              },
            }),
    };
    body.transparency ||= "transparent";
    body.visibility ||= "public";
  }
  if (!update && !String(body.summary ?? "").trim()) {
    body.summary =
      type === "focusTime"
        ? "Focus Time"
        : type === "outOfOffice"
          ? "Out of office"
          : type === "workingLocation"
            ? body.workingLocationProperties.type === "homeOffice"
              ? "Working from home"
              : body.workingLocationProperties.type === "officeLocation"
                ? "Working from office"
                : body.workingLocationProperties.customLocation.label
            : "";
    if (!body.summary) throw new Error("--summary is required");
  }
  const allDay =
    f["all-day"] !== undefined
      ? f["all-day"]
      : type === "workingLocation" || !!existing?.start?.date;
  const needsZone =
    f.from !== undefined ||
    f.to !== undefined ||
    f.timezone ||
    f["start-timezone"] ||
    f["end-timezone"] ||
    body.recurrence?.length ||
    !update;
  const zone = needsZone
    ? await timezone(
        r,
        cal,
        f.timezone || f["start-timezone"] || existing?.start?.timeZone,
      )
    : "UTC";
  for (const [flag, side] of [
    ["from", "start"],
    ["to", "end"],
  ]) {
    if (
      f[flag] !== undefined ||
      !update ||
      f.timezone ||
      f[`${side}-timezone`] ||
      f["all-day"] !== undefined ||
      body.recurrence?.length
    ) {
      const value =
        f[flag] ?? existing?.[side]?.dateTime ?? existing?.[side]?.date;
      if (!value) throw new Error(`--${flag} is required`);
      const tz = f[`${side}-timezone`] || zone;
      const parsed = parseTime(value, tz);
      if (allDay) {
        const p = localParts(parsed, tz);
        body[side] = {
          date: `${p[0]}-${String(p[1]).padStart(2, "0")}-${String(p[2]).padStart(2, "0")}`,
        };
      } else body[side] = { dateTime: parsed.toISOString(), timeZone: tz };
    }
  }
  const start = body.start ?? existing?.start,
    end = body.end ?? existing?.end;
  if (
    start &&
    end &&
    new Date(end.dateTime || end.date) <= new Date(start.dateTime || start.date)
  )
    throw new Error("Event end must be after its start");
  if (f["with-meet"] || f["regenerate-meet"]) {
    if (
      f["regenerate-meet"] ||
      (!existing?.conferenceData?.entryPoints?.length && !existing?.hangoutLink)
    )
      body.conferenceData = {
        createRequest: {
          requestId: crypto.randomUUID(),
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      };
  }
  return body;
}
function eventQuery(c: Command, body: Data = {}): Data {
  const q: Data = {};
  if (c.flags["send-updates"]) {
    if (!["all", "externalOnly", "none"].includes(c.flags["send-updates"]))
      throw new Error("Invalid send-updates value");
    q.sendUpdates = c.flags["send-updates"];
  }
  if (body.conferenceData) q.conferenceDataVersion = 1;
  if (body.attachments !== undefined) q.supportsAttachments = true;
  return q;
}
async function recurring(
  c: Command,
  r: Runtime,
  cal: string,
  event: Data,
): Promise<{ target: Data; parent?: Data; until?: string }> {
  const scope = c.flags.scope || "all";
  if (!["all", "single", "future"].includes(scope))
    throw new Error("Scope must be all, single or future");
  if (scope === "all") return { target: event };
  const original = required(c.flags["original-start"], "original-start");
  const parentId =
    event.recurringEventId || (event.recurrence?.length ? event.id : undefined);
  if (!parentId) throw new Error("Event is not recurring");
  const start = new Date(iso(original)),
    end = new Date(
      start.getTime() + (original.includes("T") ? 60_000 : 86400_000),
    );
  const result = await pages(
    r,
    "calendar",
    `calendars/${segment(cal)}/events/${segment(parentId)}/instances`,
    "items",
    { all: true },
    {
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      showDeleted: false,
    },
  );
  const target = result.items.find(
    (v: Data) =>
      (v.originalStartTime?.dateTime ||
        v.originalStartTime?.date ||
        v.start?.dateTime ||
        v.start?.date) === original,
  );
  if (!target) throw new Error("No instance has that original start");
  if (scope === "single") return { target };
  const parent =
    event.id === parentId
      ? event
      : await r.json(
          "calendar",
          `calendars/${segment(cal)}/events/${segment(parentId)}`,
        );
  const until = original.includes("T")
    ? new Date(start.getTime() - 1000)
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}Z$/, "Z")
    : new Date(start.getTime() - 86400_000)
        .toISOString()
        .slice(0, 10)
        .replace(/-/g, "");
  return { target, parent, until };
}
function truncated(recurrence: string[], until: string): string[] {
  if (!recurrence?.some((r) => /^RRULE:/i.test(r)))
    throw new Error("Parent has no recurrence rule");
  return recurrence.map((rule) =>
    /^RRULE:/i.test(rule)
      ? "RRULE:" +
        rule
          .slice(6)
          .split(";")
          .filter((p) => !/^(COUNT|UNTIL)=/i.test(p))
          .concat("UNTIL=" + until)
          .join(";")
      : rule,
  );
}
async function mutateEvent(c: Command, r: Runtime): Promise<unknown> {
  const cal = await calendarId(r, c.positionals[0]),
    base = `calendars/${segment(cal)}/events`;
  if (c.command === "calendar.create") {
    const body = await eventBody(c, r, cal);
    return {
      event: await r.json("calendar", base, {
        method: "POST",
        query: eventQuery(c, body),
        body,
      }),
    };
  }
  const event = await r.json(
      "calendar",
      `${base}/${segment(c.positionals[1])}`,
    ),
    resolved = await recurring(c, r, cal, event);
  if (c.command === "calendar.delete") {
    if (resolved.parent) {
      const body = {
        recurrence: truncated(resolved.parent.recurrence, resolved.until!),
      };
      await r.json("calendar", `${base}/${segment(resolved.parent.id)}`, {
        method: "PATCH",
        query: eventQuery(c),
        body,
      });
    } else
      await r.json("calendar", `${base}/${segment(resolved.target.id)}`, {
        method: "DELETE",
        query: eventQuery(c),
      });
    return { deleted: resolved.target.id, scope: c.flags.scope || "all" };
  }
  const body = await eventBody(c, r, cal, resolved.target);
  if (resolved.parent && body.recurrence === undefined) {
    body.recurrence = resolved.parent.recurrence;
    for (const side of ["start", "end"])
      if (!body[side] && resolved.target[side])
        body[side] = {
          ...resolved.target[side],
          ...(resolved.target[side].dateTime
            ? {
                timeZone:
                  resolved.target[side].timeZone ||
                  resolved.parent[side]?.timeZone ||
                  (await timezone(r, cal)),
              }
            : {}),
        };
  }
  const updated = await r.json(
    "calendar",
    `${base}/${segment(resolved.target.id)}`,
    { method: "PATCH", query: eventQuery(c, body), body },
  );
  if (resolved.parent)
    await r.json("calendar", `${base}/${segment(resolved.parent.id)}`, {
      method: "PATCH",
      query: eventQuery(c),
      body: {
        recurrence: truncated(resolved.parent.recurrence, resolved.until!),
      },
    });
  return { event: updated };
}
async function events(c: Command, r: Runtime): Promise<Data> {
  const f = c.flags,
    ids = await calendars(c, r),
    output: Data[] = [];
  let nextPageToken: string | undefined;
  for (const id of ids) {
    const window = await range(c, r, id);
    const query: Data = {
      timeMin: window.timeMin,
      timeMax: window.timeMax,
      maxResults: f.max ?? 10,
      singleEvents: true,
      orderBy: "startTime",
      ...(f.timezone ? { timeZone: f.timezone } : {}),
      ...(f.query ? { q: f.query } : {}),
      ...(f.fields ? { fields: f.fields } : {}),
      ...(f["event-types"]
        ? { eventTypes: list(f["event-types"]).map(eventType) }
        : {}),
      ...(f["private-prop-filter"]
        ? { privateExtendedProperty: list(f["private-prop-filter"]) }
        : {}),
      ...(f["shared-prop-filter"]
        ? { sharedExtendedProperty: list(f["shared-prop-filter"]) }
        : {}),
    };
    const result = await pages(
      r,
      "calendar",
      `calendars/${segment(id)}/events`,
      "items",
      { page: f.page, all: !!f["all-pages"] },
      query,
    );
    nextPageToken = result.nextPageToken;
    for (const e of result.items) {
      output.push({
        ...e,
        calendarId: id,
        ...(f.weekday
          ? {
              startDayOfWeek: new Intl.DateTimeFormat("en-US", {
                weekday: "long",
                timeZone: window.timeZone,
              }).format(new Date(e.start?.dateTime || e.start?.date)),
            }
          : {}),
      });
    }
  }
  if (f.sort) {
    const property = (
      {
        start: "start",
        end: "end",
        summary: "summary",
        updated: "updated",
        calendar: "calendarId",
        created: "created",
      } as Data
    )[f.sort];
    if (!property) throw new Error("Invalid event sort key");
    output.sort((a, b) => {
      const av =
        typeof a[property] === "object"
          ? a[property].dateTime || a[property].date
          : (a[property] ?? "");
      const bv =
        typeof b[property] === "object"
          ? b[property].dateTime || b[property].date
          : (b[property] ?? "");
      return (
        String(av).localeCompare(String(bv)) * (f.order === "desc" ? -1 : 1)
      );
    });
  } else if (f.order === "desc") output.reverse();
  if (f["fail-empty"] && !output.length) throw new Error("No events");
  return { events: output, nextPageToken };
}
async function special(c: Command, r: Runtime): Promise<unknown> {
  const f = c.flags,
    kind = c.command.split(".")[1];
  let extras: Data;
  if (kind === "focus-time")
    extras = {
      "event-type": "focusTime",
      summary: f.summary ?? "Focus Time",
      "focus-auto-decline": f["auto-decline"] ?? "all",
      "focus-chat-status": f["chat-status"] ?? "doNotDisturb",
      "focus-decline-message": f["decline-message"],
    };
  else if (kind === "out-of-office")
    extras = {
      "event-type": "outOfOffice",
      summary: f.summary ?? "Out of office",
      "ooo-auto-decline": f["auto-decline"] ?? "all",
      "ooo-decline-message":
        f["decline-message"] ??
        "I am out of office and will respond when I return.",
    };
  else
    extras = {
      "event-type": "workingLocation",
      summary:
        f.type === "home"
          ? "Working from home"
          : f.type === "office"
            ? `Working from ${f["office-label"] || "office"}`
            : `Working from ${f["custom-label"] || "custom location"}`,
      "all-day": true,
      "working-location-type": f.type,
      "working-building-id": f["building-id"],
      "working-custom-label": f["custom-label"],
      "working-desk-id": f["desk-id"],
      "working-floor-id": f["floor-id"],
      "working-office-label": f["office-label"],
    };
  return mutateEvent(
    {
      ...c,
      command: "calendar.create",
      positionals: [c.positionals[0] || "primary"],
      flags: { ...f, ...extras },
    },
    r,
  );
}
async function respond(c: Command, r: Runtime): Promise<unknown> {
  const cal = await calendarId(r, c.positionals[0]),
    path = `calendars/${segment(cal)}/events/${segment(c.positionals[1])}`,
    event = await r.json("calendar", path),
    attendees: Data[] = event.attendees ?? [];
  const own = attendees.find(
    (v) => v.self || v.email?.toLowerCase() === r.account.toLowerCase(),
  );
  if (!own) throw new Error("The connected account is not an attendee");
  const status =
    c.flags.status || (c.flags.decline ? "declined" : own.responseStatus);
  if (!["accepted", "declined", "tentative", "needsAction"].includes(status))
    throw new Error("Choose accepted, declined, tentative or needsAction");
  own.responseStatus = status;
  if (c.flags.comment !== undefined) own.comment = c.flags.comment;
  return {
    event: await r.json("calendar", path, {
      method: "PATCH",
      query: { sendUpdates: "all" },
      body: { attendees },
    }),
  };
}
async function freebusy(c: Command, r: Runtime): Promise<Data> {
  const ids = await calendars(c, r),
    window = await range(c, r, ids[0]);
  return r.json("calendar", "freeBusy", {
    method: "POST",
    body: {
      timeMin: window.timeMin,
      timeMax: window.timeMax,
      items: ids.map((id) => ({ id })),
    },
  });
}
export const calendarTaskMapHandlers: HandlerMap = {
  "calendar.calendars": (c, r) =>
    pages(r, "calendar", "users/me/calendarList", "items", c.flags, {
      maxResults: c.flags.max ?? 100,
    }),
  "calendar.acl": async (c, r) =>
    pages(
      r,
      "calendar",
      `calendars/${segment(await calendarId(r, c.positionals[0]))}/acl`,
      "items",
      c.flags,
      { maxResults: c.flags.max ?? 100 },
    ),
  "calendar.colors": (_c, r) => r.json("calendar", "colors"),
  "calendar.create-calendar": async (c, r) => ({
    calendar: await r.json("calendar", "calendars", {
      method: "POST",
      body: {
        summary: c.positionals[0],
        ...(c.flags.description !== undefined
          ? { description: c.flags.description }
          : {}),
        ...(c.flags.location !== undefined
          ? { location: c.flags.location }
          : {}),
        ...(c.flags.timezone ? { timeZone: c.flags.timezone } : {}),
      },
    }),
  }),
  "calendar.delete-calendar": async (c, r) => {
    const id = await calendarId(r, c.positionals[0]);
    await r.json("calendar", `calendars/${segment(id)}`, { method: "DELETE" });
    return { deleted: id };
  },
  "calendar.subscribe": async (c, r) => ({
    calendar: await r.json("calendar", "users/me/calendarList", {
      method: "POST",
      body: {
        id: c.positionals[0],
        selected: c.flags.selected ?? true,
        ...(c.flags.hidden !== undefined ? { hidden: c.flags.hidden } : {}),
        ...(c.flags["color-id"] ? { colorId: c.flags["color-id"] } : {}),
      },
    }),
  }),
  "calendar.unsubscribe": async (c, r) => {
    const id = await calendarId(r, c.positionals[0]);
    await r.json("calendar", `users/me/calendarList/${segment(id)}`, {
      method: "DELETE",
    });
    return { removed: id };
  },
  "calendar.event": async (c, r) => ({
    event: await r.json(
      "calendar",
      `calendars/${segment(await calendarId(r, c.positionals[0]))}/events/${segment(c.positionals[1])}`,
      { query: c.flags.timezone ? { timeZone: c.flags.timezone } : {} },
    ),
  }),
  "calendar.raw": async (c, r) =>
    r.json(
      "calendar",
      `calendars/${segment(await calendarId(r, c.positionals[0]))}/events/${segment(c.positionals[1])}`,
    ),
  "calendar.create": mutateEvent,
  "calendar.update": mutateEvent,
  "calendar.delete": mutateEvent,
  "calendar.move": async (c, r) => ({
    event: await r.json(
      "calendar",
      `calendars/${segment(await calendarId(r, c.positionals[0]))}/events/${segment(c.positionals[1])}/move`,
      {
        method: "POST",
        query: {
          destination: await calendarId(r, c.positionals[2]),
          ...eventQuery(c),
        },
      },
    ),
  }),
  "calendar.respond": respond,
  "calendar.propose-time": async (c, r) => {
    const cal = await calendarId(r, c.positionals[0]);
    const result =
      c.flags.decline || c.flags.comment
        ? await respond({ ...c, positionals: [cal, c.positionals[1]] }, r)
        : {};
    return {
      ...(result as Data),
      propose_url:
        "https://calendar.google.com/calendar/u/0/r/proposetime/" +
        encode64(enc.encode(c.positionals[1] + " " + cal)).replace(/=+$/, ""),
      api_limitation:
        "Google Calendar has no API endpoint for proposing a meeting time. Open the URL to choose the proposed time.",
    };
  },
  "calendar.events": events,
  "calendar.search": (c, r) =>
    events(
      {
        ...c,
        positionals: [c.flags.calendar ?? "primary"],
        flags: {
          ...c.flags,
          query: c.positionals.join(" "),
          max: c.flags.max ?? 25,
        },
      },
      r,
    ),
  "calendar.changed": async (c, r) => {
    const ids = await calendars(c, r),
      items: Data[] = [];
    for (const id of ids) {
      const zone = c.flags.weekday ? await timezone(r, id) : "UTC";
      const since = String(c.flags.since || "720h");
      const durationParts = [...since.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)];
      const duration =
        durationParts.map((m) => m[0]).join("") === since
          ? durationParts.reduce(
              (total, m) =>
                total +
                Number(m[1]) *
                  ({ ms: 1, s: 1000, m: 60_000, h: 3600_000 } as Data)[m[2]],
              0,
            )
          : undefined;
      const updatedMin =
        duration === undefined
          ? parseTime(since, "UTC").toISOString()
          : new Date(Date.now() - duration).toISOString();
      const response = await pages(
        r,
        "calendar",
        `calendars/${segment(id)}/events`,
        "items",
        { all: true },
        { updatedMin, maxResults: 250, showDeleted: true, orderBy: "updated" },
      );
      for (const e of response.items)
        items.push({
          ...e,
          calendarId: id,
          ...(c.flags.weekday && e.start
            ? {
                startDayOfWeek: new Intl.DateTimeFormat("en-US", {
                  weekday: "long",
                  timeZone: zone,
                }).format(new Date(e.start.dateTime || e.start.date)),
              }
            : {}),
        });
    }
    if (c.flags["fail-empty"] && !items.length)
      throw new Error("No changed events");
    items.sort((a, b) =>
      String(b.updated ?? "").localeCompare(String(a.updated ?? "")),
    );
    return { events: items.slice(0, c.flags.max ?? 10) };
  },
  "calendar.freebusy": freebusy,
  "calendar.conflicts": async (c, r) => {
    const result = await events(
        { ...c, flags: { ...c.flags, "all-pages": true, max: 2500 } },
        r,
      ),
      conflicts: Data[] = [];
    const busy = result.events.filter(
      (e: Data) =>
        e.status !== "cancelled" &&
        e.transparency !== "transparent" &&
        !(e.attendees ?? []).some(
          (a: Data) => a.self && a.responseStatus === "declined",
        ),
    );
    if (busy.length > 2500)
      throw new Error(
        "Conflict analysis is limited to 2500 busy events; narrow the time range",
      );
    for (let i = 0; i < busy.length; i++)
      for (let j = i + 1; j < busy.length; j++) {
        if (r.signal.aborted) throw new Error("Conflict analysis cancelled");
        const a = busy[i],
          b = busy[j];
        if ((a.iCalUID && a.iCalUID === b.iCalUID) || a.id === b.id) continue;
        const start = Math.max(
            Date.parse(a.start.dateTime || a.start.date),
            Date.parse(b.start.dateTime || b.start.date),
          ),
          end = Math.min(
            Date.parse(a.end.dateTime || a.end.date),
            Date.parse(b.end.dateTime || b.end.date),
          );
        if (start < end) {
          if (conflicts.length >= 1000)
            throw new Error(
              "Conflict analysis is limited to 1000 conflicts; narrow the time range",
            );
          conflicts.push({
            start: new Date(start).toISOString(),
            end: new Date(end).toISOString(),
            events: [a, b],
          });
        }
      }
    return { conflicts };
  },
  "calendar.focus-time": special,
  "calendar.out-of-office": special,
  "calendar.working-location": special,
  "calendar.time": async (c, r) => {
    const zone = await timezone(
        r,
        await calendarId(r, c.flags.calendar ?? "primary"),
        c.flags.timezone,
      ),
      now = new Date();
    return {
      timezone: zone,
      current_time: now.toISOString(),
      formatted: new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        dateStyle: "full",
        timeStyle: "short",
      }).format(now),
    };
  },
  "calendar.users": async (c, r) => {
    const result = await pages(
      r,
      "people",
      "people:listDirectoryPeople",
      "people",
      c.flags,
      {
        readMask: "names,emailAddresses",
        sources: "DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE",
        pageSize: c.flags.max ?? 100,
      },
    );
    const users = result.people
      .map((person: Data) => ({
        email:
          (person.emailAddresses ?? []).find((v: Data) => v.metadata?.primary)
            ?.value || person.emailAddresses?.[0]?.value,
        name:
          (person.names ?? []).find((v: Data) => v.metadata?.primary)
            ?.displayName || person.names?.[0]?.displayName,
      }))
      .filter((person: Data) => person.email);
    if (c.flags["fail-empty"] && !users.length)
      throw new Error("No directory users");
    return { users, nextPageToken: result.nextPageToken };
  },
  "calendar.team": async (c, r) => {
    const lookup = await r.json("groups", "groups:lookup", {
      query: { "groupKey.id": c.positionals[0] },
    });
    const members = await pages(
      r,
      "groups",
      `${lookup.name}/memberships`,
      "memberships",
      { all: true },
      { pageSize: 1000, view: "FULL" },
    );
    const emails = [
      ...new Set(
        members.memberships
          .map((m: Data) => m.preferredMemberKey?.id)
          .filter((email: string) => email?.includes("@")),
      ),
    ];
    if (!emails.length) return { events: [] };
    const command = {
      ...c,
      positionals: [],
      flags: { ...c.flags, cal: emails },
    };
    if (c.flags.freebusy) return freebusy(command, r);
    const result = await events(command, r);
    if (c.flags["no-dedup"]) return result;
    const seen = new Set<string>();
    return {
      events: result.events.filter((e: Data) => {
        const key =
          (e.iCalUID || e.id) + ":" + (e.start?.dateTime || e.start?.date);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    };
  },
};
const taskPath = (c: Command) =>
  `lists/${segment(c.positionals[0])}/tasks${c.positionals[1] ? "/" + segment(c.positionals[1]) : ""}`;
async function taskAdd(c: Command, r: Runtime): Promise<unknown> {
  const f = c.flags;
  required(f.title, "task title");
  const repeats = [f.repeat, f.recur, f["recur-rrule"]].filter(Boolean);
  if (repeats.length > 1) throw new Error("Use one recurrence flag");
  let cadence = String(f.repeat || f.recur || "").toLowerCase(),
    interval = 1;
  if (f["recur-rrule"]) {
    const parts: Data = {};
    for (const item of String(f["recur-rrule"])
      .replace(/^RRULE:/i, "")
      .split(";")) {
      const [key, value] = item.toUpperCase().split("=");
      if (!["FREQ", "INTERVAL"].includes(key) || !value || parts[key])
        throw new Error("Tasks RRULE supports only FREQ and INTERVAL");
      parts[key] = value;
    }
    cadence = parts.FREQ?.toLowerCase();
    interval = Number(parts.INTERVAL || 1);
    if (!Number.isSafeInteger(interval) || interval <= 0)
      throw new Error("Invalid recurrence interval");
  }
  const unit = (
    {
      day: "daily",
      daily: "daily",
      week: "weekly",
      weekly: "weekly",
      month: "monthly",
      monthly: "monthly",
      year: "yearly",
      yearly: "yearly",
      annually: "yearly",
    } as Data
  )[cadence];
  if (cadence && !unit) throw new Error("Invalid task recurrence");
  if (!unit && (f["repeat-count"] || f["repeat-until"]))
    throw new Error("A recurrence cadence is required");
  if (unit && (!f.due || (!f["repeat-count"] && !f["repeat-until"])))
    throw new Error("Recurring tasks require due and a count or end date");
  const count = Number(f["repeat-count"] || 0);
  if (count < 0 || count > 50)
    throw new Error("A task invocation can create at most 50 occurrences");
  const start = f.due ? new Date(iso(f.due)) : undefined,
    until = f["repeat-until"] ? new Date(iso(f["repeat-until"])) : undefined;
  if (
    until &&
    start &&
    /^\d{4}-\d\d-\d\d$/.test(f["repeat-until"]) &&
    f.due.includes("T")
  )
    until.setUTCHours(
      start.getUTCHours(),
      start.getUTCMinutes(),
      start.getUTCSeconds(),
    );
  const due: (string | undefined)[] = [];
  for (let i = 0; ; i++) {
    const date = start ? new Date(start) : undefined;
    if (unit && date) {
      if (unit === "daily" || unit === "weekly")
        date.setUTCDate(
          date.getUTCDate() + i * interval * (unit === "weekly" ? 7 : 1),
        );
      if (unit === "monthly")
        date.setUTCMonth(date.getUTCMonth() + i * interval);
      if (unit === "yearly")
        date.setUTCFullYear(date.getUTCFullYear() + i * interval);
    }
    if (until && date && date > until) break;
    if (due.length >= 50)
      throw new Error("A task invocation can create at most 50 occurrences");
    due.push(date?.toISOString());
    if (!unit || (count && due.length >= count)) break;
  }
  if (!due.length) throw new Error("Recurrence produces no occurrences");
  const tasks: Data[] = [];
  for (const value of due)
    tasks.push(
      await r.json("tasks", taskPath(c), {
        method: "POST",
        query: {
          ...(f.parent ? { parent: f.parent } : {}),
          ...(f.previous ? { previous: f.previous } : {}),
        },
        body: {
          title: f.title,
          ...(f.notes !== undefined ? { notes: f.notes } : {}),
          ...(value ? { due: value } : {}),
        },
      }),
    );
  return unit ? { tasks, count: tasks.length } : { task: tasks[0] };
}
Object.assign(calendarTaskMapHandlers, {
  "tasks.add": taskAdd,
  "tasks.list": (c: Command, r: Runtime) => {
    const q: Data = {
      maxResults: c.flags.max ?? 20,
      showAssigned: c.flags["show-assigned"] ?? true,
      showCompleted: c.flags["show-completed"] ?? true,
      showDeleted: !!c.flags["show-deleted"],
      showHidden: !!c.flags["show-hidden"],
    };
    for (const [flag, key] of Object.entries({
      "completed-max": "completedMax",
      "completed-min": "completedMin",
      "due-max": "dueMax",
      "due-min": "dueMin",
      "updated-min": "updatedMin",
    }))
      if (c.flags[flag]) q[key] = iso(c.flags[flag]);
    return pages(r, "tasks", taskPath(c), "items", c.flags, q);
  },
  "tasks.get": async (c: Command, r: Runtime) => ({
    task: await r.json("tasks", taskPath(c)),
  }),
  "tasks.raw": (c: Command, r: Runtime) => r.json("tasks", taskPath(c)),
  "tasks.update": async (c: Command, r: Runtime) => {
    const body: Data = {};
    for (const key of ["title", "notes", "status"])
      if (c.flags[key] !== undefined) body[key] = c.flags[key];
    if (c.flags.due !== undefined)
      body.due = c.flags.due ? iso(c.flags.due) : null;
    if (!Object.keys(body).length) throw new Error("No task fields to update");
    return {
      task: await r.json("tasks", taskPath(c), { method: "PATCH", body }),
    };
  },
  "tasks.done": async (c: Command, r: Runtime) => ({
    task: await r.json("tasks", taskPath(c), {
      method: "PATCH",
      body: { status: "completed" },
    }),
  }),
  "tasks.undo": async (c: Command, r: Runtime) => ({
    task: await r.json("tasks", taskPath(c), {
      method: "PATCH",
      body: { status: "needsAction", completed: null },
    }),
  }),
  "tasks.delete": async (c: Command, r: Runtime) => {
    await r.json("tasks", taskPath(c), { method: "DELETE" });
    return { deleted: c.positionals[1] };
  },
  "tasks.clear": async (c: Command, r: Runtime) => {
    await r.json("tasks", `lists/${segment(c.positionals[0])}/clear`, {
      method: "POST",
    });
    return { cleared: true };
  },
  "tasks.lists.create": async (c: Command, r: Runtime) => ({
    tasklist: await r.json("tasks", "users/@me/lists", {
      method: "POST",
      body: { title: c.positionals[0] },
    }),
  }),
  "tasks.lists.list": (c: Command, r: Runtime) =>
    pages(r, "tasks", "users/@me/lists", "items", c.flags, {
      maxResults: c.flags.max ?? 100,
    }),
});
async function maps(c: Command, r: Runtime): Promise<unknown> {
  const f = c.flags;
  if (
    f.mode &&
    !["driving", "walking", "bicycling", "transit"].includes(f.mode)
  )
    throw new Error("Invalid travel mode");
  if (f.units && !["metric", "imperial"].includes(f.units))
    throw new Error("Invalid distance units");
  if (c.command.startsWith("maps.places.")) {
    const place = await lookupPlace(r, {
      ...(c.command.endsWith("details")
        ? { "place-id": c.positionals[0] }
        : { "location-search": c.positionals.join(" ") }),
      "place-language": f.language,
      "place-region": f.region,
    });
    return {
      place: {
        id: place.id,
        name: place.displayName?.text,
        formatted_address: place.formattedAddress,
        google_maps_uri: place.googleMapsUri,
      },
    };
  }
  let path = "geocode/json";
  const query: Data = {
    ...(f.language ? { language: f.language } : {}),
    ...(f.region ? { region: f.region } : {}),
  };
  if (c.command === "maps.directions") {
    path = "directions/json";
    query.origin = required(f.origin, "origin");
    query.destination = required(f.destination, "destination");
    if (f.mode) query.mode = f.mode;
  } else if (c.command === "maps.distance") {
    path = "distancematrix/json";
    query.origins = list(required(f.origins, "origins")).join("|");
    query.destinations = list(required(f.destinations, "destinations")).join(
      "|",
    );
    if (f.mode) query.mode = f.mode;
    if (f.units) query.units = f.units;
  } else if (c.command === "maps.reverse-geocode") {
    const lat = Number(required(f.lat, "latitude")),
      lng = Number(required(f.lng, "longitude"));
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    )
      throw new Error("Invalid coordinates");
    query.latlng = `${lat},${lng}`;
  } else query.address = c.positionals.join(" ");
  const result = await r.json("maps", path, { query });
  if (result.status && !["OK", "ZERO_RESULTS"].includes(result.status))
    throw new Error("Google Maps request failed");
  return result;
}
for (const name of [
  "maps.directions",
  "maps.distance",
  "maps.geocode",
  "maps.places.details",
  "maps.places.search",
  "maps.reverse-geocode",
])
  calendarTaskMapHandlers[name] = maps;

async function resolveTasklist(r: Runtime, raw: string): Promise<string> {
  const value = required(raw, "task list").trim();
  if (value.toLowerCase() === "default" || value === "@default")
    return "@default";
  if (value.length >= 16 && !/\s/.test(value)) return value;
  const result = await pages(
    r,
    "tasks",
    "users/@me/lists",
    "items",
    { all: true },
    { maxResults: 1000 },
  );
  const exact = result.items.find((item: Data) => item.id === value);
  if (exact) return exact.id;
  const matches = result.items.filter(
    (item: Data) =>
      String(item.title).trim().toLowerCase() === value.toLowerCase(),
  );
  if (matches.length > 1)
    throw new Error("Task list name is ambiguous; use its ID");
  return matches[0]?.id ?? value;
}
for (const name of Object.keys(calendarTaskMapHandlers).filter(
  (name) => name.startsWith("tasks.") && !name.startsWith("tasks.lists."),
)) {
  const handler = calendarTaskMapHandlers[name];
  calendarTaskMapHandlers[name] = async (command, runtime) =>
    handler(
      {
        ...command,
        positionals: [
          await resolveTasklist(runtime, command.positionals[0]),
          ...command.positionals.slice(1),
        ],
      },
      runtime,
    );
}

function redactCalendarOutput(value: any): any {
  if (typeof value === "string")
    return value.replace(/https?:\/\/[^\s<>"']+/g, (url) =>
      /(?:zoom\.us|zoomgov\.com)/i.test(url)
        ? url.replace(/([?&](?:amp;)?pwd=)[^&#\s]*/gi, "$1REDACTED")
        : url,
    );
  if (Array.isArray(value)) return value.map(redactCalendarOutput);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactCalendarOutput(item),
      ]),
    );
  return value;
}
for (const name of Object.keys(calendarTaskMapHandlers).filter(
  (name) => name.startsWith("calendar.") && name !== "calendar.raw",
)) {
  const handler = calendarTaskMapHandlers[name];
  calendarTaskMapHandlers[name] = async (command, runtime) => {
    const result = await handler(command, runtime);
    return command.flags["include-passwords"]
      ? result
      : redactCalendarOutput(result);
  };
}
