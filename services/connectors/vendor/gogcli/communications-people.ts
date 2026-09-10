import type { Command, Data, HandlerMap, Runtime } from "./types";
import { required, segment } from "./types";
import { list, pages } from "./communications-mail";
const readMask =
  "names,emailAddresses,phoneNumbers,birthdays,organizations,urls,biographies,addresses,genders,userDefined,relations,metadata";
const profileMask = "names,emailAddresses,photos,organizations,relations";
const mutable = [
  "addresses",
  "biographies",
  "birthdays",
  "calendarUrls",
  "clientData",
  "emailAddresses",
  "events",
  "externalIds",
  "genders",
  "imClients",
  "interests",
  "locales",
  "locations",
  "memberships",
  "miscKeywords",
  "names",
  "nicknames",
  "occupations",
  "organizations",
  "phoneNumbers",
  "relations",
  "sipAddresses",
  "urls",
  "userDefined",
];
const personPath = (id: string) =>
  `people/${segment(required(id, "person ID").replace(/^people\//, ""))}`;
const primary = (items: Data[] = []) =>
  items.find((i) => i.metadata?.primary) ?? items[0] ?? {};
function compact(p: Data): Data {
  return {
    resource: p.resourceName,
    name:
      primary(p.names).displayName ||
      [primary(p.names).givenName, primary(p.names).familyName]
        .filter(Boolean)
        .join(" "),
    email: primary(p.emailAddresses).value,
    phone: primary(p.phoneNumbers).value,
    birthday: primary(p.birthdays).date,
  };
}
async function searchContacts(
  r: Runtime,
  query: string,
  max: number,
  mask = readMask,
): Promise<Data[]> {
  await r.json("people", "people:searchContacts", {
    query: { query: "", readMask: mask, pageSize: 1 },
  });
  const result = await r.json("people", "people:searchContacts", {
    query: { query, readMask: mask, pageSize: max },
  });
  return (result.results ?? []).map((p: Data) => p.person).filter(Boolean);
}
async function contact(
  r: Runtime,
  id: string,
  mask = readMask,
): Promise<Data | undefined> {
  if (id.startsWith("people/"))
    return r.json("people", personPath(id), { query: { personFields: mask } });
  const found = await searchContacts(r, id, 10, mask);
  return (
    found.find((p) =>
      (p.emailAddresses ?? []).some(
        (e: Data) => e.value.toLowerCase() === id.toLowerCase(),
      ),
    ) ?? found[0]
  );
}
function fieldArray(v: unknown): string[] {
  return (Array.isArray(v) ? v : v === undefined || v === "" ? [] : [v]).map(
    String,
  );
}
function pair(v: string): [string, string] {
  const split = v.indexOf("=");
  if (split < 1 || !v.slice(split + 1)) throw new Error("Expected key=value");
  return [v.slice(0, split), v.slice(split + 1)];
}
function buildContact(f: Data, original: Data = {}): Data {
  const body: Data = {};
  if (f.given !== undefined || f.family !== undefined)
    body.names = [
      {
        ...primary(original.names),
        ...(f.given !== undefined ? { givenName: f.given } : {}),
        ...(f.family !== undefined ? { familyName: f.family } : {}),
      },
    ];
  for (const [flag, name] of Object.entries({
    email: "emailAddresses",
    phone: "phoneNumbers",
    gender: "genders",
  }))
    if (f[flag] !== undefined) body[name] = f[flag] ? [{ value: f[flag] }] : [];
  if (f.org !== undefined || f.title !== undefined)
    body.organizations = [
      {
        ...primary(original.organizations),
        ...(f.org !== undefined ? { name: f.org } : {}),
        ...(f.title !== undefined ? { title: f.title } : {}),
      },
    ];
  if (f.url !== undefined)
    body.urls = fieldArray(f.url).map((value) => ({ value }));
  if (f.address !== undefined)
    body.addresses = fieldArray(f.address)
      .flatMap((v) => v.split(";"))
      .map((formattedValue) => ({ formattedValue }));
  if (f.custom !== undefined)
    body.userDefined = fieldArray(f.custom).map((v) => {
      const [key, value] = pair(v);
      return { key, value };
    });
  if (f.relation !== undefined)
    body.relations = fieldArray(f.relation).map((v) => {
      const [type, person] = pair(v);
      return { type, person };
    });
  if (f.note !== undefined && f.notes !== undefined)
    throw new Error("Use one note flag");
  const note = f.note ?? f.notes;
  if (note !== undefined)
    body.biographies = note ? [{ value: note, contentType: "TEXT_PLAIN" }] : [];
  if (f.birthday !== undefined) {
    if (!f.birthday) body.birthdays = [];
    else {
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(f.birthday) ||
        Number.isNaN(Date.parse(f.birthday))
      )
        throw new Error("Birthday must be YYYY-MM-DD");
      const [year, month, day] = f.birthday.split("-").map(Number);
      body.birthdays = [{ date: { year, month, day } }];
    }
  }
  return body;
}
async function updateContact(c: Command, r: Runtime): Promise<unknown> {
  const f = c.flags,
    path = personPath(c.positionals[0]);
  const old = await r.json("people", path, {
    query: { personFields: readMask },
  });
  let fields: Data;
  if (f["from-file"]) {
    const loaded = r.jsonInput(r.text(f["from-file"])),
      input = loaded.contact ?? loaded;
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Contact JSON must be an object");
    if (input.resourceName && input.resourceName !== old.resourceName)
      throw new Error("Contact JSON belongs to another contact");
    if (!f["ignore-etag"] && input.etag !== old.etag)
      throw new Error("Contact changed since export; fetch it again");
    fields = Object.fromEntries(
      Object.entries(input).filter(([key]) => mutable.includes(key)),
    );
    if (
      Object.keys(f).some(
        (key) =>
          !["from-file", "ignore-etag"].includes(key) &&
          f[key] !== undefined &&
          f[key] !== false,
      )
    )
      throw new Error("JSON updates cannot be combined with field flags");
  } else fields = buildContact(f, old);
  const mask = Object.keys(fields);
  if (!mask.length) throw new Error("No contact fields to update");
  const body = { ...old, ...fields };
  return {
    contact: await r.json("people", `${path}:updateContact`, {
      method: "PATCH",
      query: { updatePersonFields: mask.join(",") },
      body,
    }),
  };
}
function vcard(person: Data, groups: Data): string {
  const escape = (v: unknown) =>
    String(v ?? "")
      .replace(/\\/g, "\\\\")
      .replace(/\r?\n/g, "\\n")
      .replace(/,/g, "\\,")
      .replace(/;/g, "\\;");
  const name = primary(person.names),
    org = primary(person.organizations),
    birth = primary(person.birthdays).date;
  const lines = [
    "BEGIN:VCARD",
    "VERSION:4.0",
    `FN:${escape(name.displayName || [name.givenName, name.familyName].filter(Boolean).join(" "))}`,
    `N:${[name.familyName, name.givenName, name.middleName, name.honorificPrefix, name.honorificSuffix].map(escape).join(";")}`,
  ];
  const type = (v: unknown) =>
    v ? ";TYPE=" + String(v).replace(/[^a-zA-Z0-9_-]/g, "") : "";
  for (const [field, property] of [
    ["emailAddresses", "EMAIL"],
    ["phoneNumbers", "TEL"],
    ["urls", "URL"],
  ])
    for (const item of person[field] ?? [])
      lines.push(`${property}${type(item.type)}:${escape(item.value)}`);
  for (const a of person.addresses ?? [])
    lines.push(
      `ADR${type(a.type)}:${[a.poBox, a.extendedAddress, a.streetAddress || a.formattedValue, a.city, a.region, a.postalCode, a.country || a.countryCode].map(escape).join(";")}`,
    );
  if (birth)
    lines.push(
      `BDAY:${birth.year ? String(birth.year).padStart(4, "0") : "--"}${birth.year ? "-" : ""}${String(birth.month).padStart(2, "0")}-${String(birth.day).padStart(2, "0")}`,
    );
  if (org.name) lines.push(`ORG:${escape(org.name)};${escape(org.department)}`);
  if (org.title) lines.push(`TITLE:${escape(org.title)}`);
  if (primary(person.biographies).value)
    lines.push(`NOTE:${escape(primary(person.biographies).value)}`);
  if (person.nicknames?.length)
    lines.push(
      `NICKNAME:${person.nicknames.map((v: Data) => escape(v.value)).join(",")}`,
    );
  const categories = (person.memberships ?? [])
    .map(
      (m: Data) => groups[m.contactGroupMembership?.contactGroupResourceName],
    )
    .filter(Boolean);
  if (categories.length)
    lines.push(`CATEGORIES:${categories.map(escape).join(",")}`);
  lines.push("END:VCARD");
  return (
    lines
      .map((line) => {
        let out = "",
          chunk = "";
        for (const char of line) {
          if (new TextEncoder().encode(chunk + char).length > 74) {
            out += chunk + "\r\n ";
            chunk = "";
          }
          chunk += char;
        }
        return out + chunk;
      })
      .join("\r\n") + "\r\n"
  );
}
async function exportContacts(c: Command, r: Runtime): Promise<unknown> {
  const f = c.flags,
    selector = c.positionals[0];
  if ([!!selector, !!f.query, !!f.all].filter(Boolean).length !== 1)
    throw new Error("Select a contact, query, or all contacts");
  const mask = readMask + ",memberships,nicknames";
  let contacts: Data[];
  if (f.all)
    contacts = (
      await pages(r, "people", "people/me/connections", "connections", f, {
        personFields: mask,
        pageSize: f["page-size"] ?? 1000,
      })
    ).connections;
  else if (f.query)
    contacts = await searchContacts(r, f.query, f.max ?? 30, mask);
  else {
    const found = await contact(r, selector, mask);
    contacts = found ? [found] : [];
  }
  const groups: Data = {};
  if (contacts.some((c) => c.memberships?.length)) {
    const groupList = await pages(
      r,
      "people",
      "contactGroups",
      "contactGroups",
      { all: true },
      { pageSize: 1000 },
    );
    for (const group of groupList.contactGroups)
      groups[group.resourceName] = group.name;
  }
  const content = contacts.map((c) => vcard(c, groups)).join("");
  return f.out && f.out !== "-"
    ? {
        ...r.output(r.outputName(c, "contacts.vcf"), content),
        contacts: contacts.length,
      }
    : { format: "vcard", content, contacts: contacts.length };
}
function sourceEtag(p: Data): string | undefined {
  return p.metadata?.sources?.find((s: Data) => s.type === "CONTACT")?.etag;
}
function stable(value: any): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + stable(value[key]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
function matchKeys(p: Data, matching: string[]): Set<string> {
  const keys = new Set<string>();
  for (const kind of matching) {
    const values =
      kind === "email"
        ? (p.emailAddresses ?? []).map((v: Data) =>
            String(v.value).toLowerCase(),
          )
        : kind === "phone"
          ? (p.phoneNumbers ?? []).map((v: Data) =>
              String(v.canonicalForm || v.value).replace(/\D/g, ""),
            )
          : (p.names ?? []).map((v: Data) =>
              String(
                v.displayName ||
                  [v.givenName, v.familyName].filter(Boolean).join(" "),
              ).toLowerCase(),
            );
    for (const value of values.filter(Boolean)) keys.add(kind + ":" + value);
  }
  return keys;
}
async function dedupe(c: Command, r: Runtime): Promise<unknown> {
  const f = c.flags,
    matching = list(f.match ?? "email,phone");
  if (
    !matching.length ||
    matching.some((m) => !["email", "phone", "name"].includes(m))
  )
    throw new Error("Match must contain email, phone or name");
  const mask = [...mutable, "metadata", "photos", "coverPhotos", "skills"].join(
    ",",
  );
  const selected = [...new Set(list(f.resource))];
  if (f.max < 0 || (f.max && selected.length))
    throw new Error(
      "--max cannot be combined with --resource and must be nonnegative",
    );
  let all: Data[] = [];
  if (selected.length) {
    for (const id of selected) {
      if (!/^people\/[^/]+$/.test(id))
        throw new Error("Use exact people resource names");
      all.push(
        await r.json("people", personPath(id), {
          query: { personFields: mask },
        }),
      );
    }
  } else {
    let token: string | undefined;
    const seen = new Set<string>();
    do {
      if (token && seen.has(token))
        throw new Error("Provider repeated a page token");
      if (token) seen.add(token);
      const response = await r.json("people", "people/me/connections", {
        query: {
          personFields: mask,
          pageSize: f.max ? Math.min(f.max - all.length, 1000) : 1000,
          ...(token ? { pageToken: token } : {}),
        },
      });
      all.push(...(response.connections ?? []));
      token = response.nextPageToken;
    } while (token && (!f.max || all.length < f.max));
    if (f.max) all = all.slice(0, f.max);
  }
  const parent = all.map((_, i) => i),
    find = (i: number): number =>
      parent[i] === i ? i : (parent[i] = find(parent[i]));
  const seen = new Map<string, number>();
  all.forEach((p, i) => {
    for (const kind of matching) {
      const vals =
        kind === "email"
          ? (p.emailAddresses ?? []).map((v: Data) =>
              String(v.value).toLowerCase(),
            )
          : kind === "phone"
            ? (p.phoneNumbers ?? []).map((v: Data) =>
                String(v.canonicalForm || v.value).replace(/\D/g, ""),
              )
            : (p.names ?? []).map((v: Data) =>
                String(
                  v.displayName ||
                    [v.givenName, v.familyName].filter(Boolean).join(" "),
                ).toLowerCase(),
              );
      for (const value of vals.filter(Boolean)) {
        const key = kind + ":" + value;
        if (seen.has(key)) parent[find(i)] = find(seen.get(key)!);
        else seen.set(key, i);
      }
    }
  });
  const map = new Map<number, Data[]>();
  all.forEach((p, i) => {
    const root = find(i);
    map.set(root, [...(map.get(root) ?? []), p]);
  });
  const groups = [...map.values()].filter((g) => g.length > 1);
  if (f["fail-empty"] && !groups.length)
    throw new Error("No duplicate contacts");
  if (!f.apply)
    return {
      scanned: all.length,
      groups: groups.map((members) => ({
        primary: members[0].resourceName,
        members: members.map(compact),
      })),
    };
  const plans: { body: Data; remove: Data[]; mask: string }[] = [];
  for (const group of groups) {
    const fresh: Data[] = [];
    for (const p of group)
      fresh.push(
        await r.json("people", personPath(p.resourceName), {
          query: { personFields: mask, sources: "READ_SOURCE_TYPE_CONTACT" },
        }),
      );
    const connected = new Set([0]),
      connectedKeys = matchKeys(fresh[0], matching);
    let progress = true;
    while (progress) {
      progress = false;
      for (let i = 1; i < fresh.length; i++)
        if (!connected.has(i)) {
          const keys = matchKeys(fresh[i], matching);
          if ([...keys].some((key) => connectedKeys.has(key))) {
            connected.add(i);
            for (const key of keys) connectedKeys.add(key);
            progress = true;
          }
        }
    }
    if (connected.size !== fresh.length)
      throw new Error("Contacts no longer match the duplicate preview");
    const body: Data = {
      resourceName: fresh[0].resourceName,
      etag: fresh[0].etag,
      metadata: fresh[0].metadata,
    };
    for (const p of fresh)
      if (!sourceEtag(p))
        throw new Error("A contact is missing its source ETag");
    for (const p of fresh.slice(1))
      if (
        (p.photos ?? []).some((v: Data) => !v.default) ||
        p.coverPhotos?.length ||
        p.skills?.length
      )
        throw new Error(
          "Duplicate has nonmergeable photo or profile data; merge it in Google Contacts",
        );
    for (const field of mutable) {
      const unique = new Map<string, Data>();
      for (const p of fresh)
        for (const item of p[field] ?? []) {
          const clean = { ...item };
          delete clean.metadata;
          delete clean.formattedType;
          delete clean.displayName;
          delete clean.displayNameLastFirst;
          const key =
            field === "emailAddresses"
              ? String(clean.value).toLowerCase()
              : field === "phoneNumbers"
                ? String(clean.value).replace(/\D/g, "")
                : stable(clean);
          if (!unique.has(key)) unique.set(key, clean);
        }
      if (
        ["names", "biographies", "birthdays", "genders"].includes(field) &&
        unique.size > 1
      )
        throw new Error(
          `Duplicate contacts conflict in ${field}; resolve before merging`,
        );
      if (unique.size) body[field] = [...unique.values()];
    }
    plans.push({
      body,
      remove: fresh.slice(1),
      mask: mutable.filter((field) => body[field]).join(","),
    });
  }
  let deleted = 0;
  for (const plan of plans) {
    await r.json(
      "people",
      `${personPath(plan.body.resourceName)}:updateContact`,
      {
        method: "PATCH",
        query: {
          updatePersonFields: plan.mask,
          personFields: "metadata",
          sources: "READ_SOURCE_TYPE_CONTACT",
        },
        body: plan.body,
      },
    );
    for (const p of plan.remove) {
      const latest = await r.json("people", personPath(p.resourceName), {
        query: {
          personFields: "metadata",
          sources: "READ_SOURCE_TYPE_CONTACT",
        },
      });
      if (sourceEtag(latest) !== sourceEtag(p))
        throw new Error("Duplicate changed during merge and was not deleted");
      await r.json("people", `${personPath(p.resourceName)}:deleteContact`, {
        method: "DELETE",
      });
      deleted++;
    }
  }
  return {
    scanned: all.length,
    groupsMerged: plans.length,
    contactsDeleted: deleted,
  };
}
export const peopleHandlers: HandlerMap = {
  "contacts.create": async (c, r) => {
    required(c.flags.given, "given name");
    return {
      contact: await r.json("people", "people:createContact", {
        method: "POST",
        body: buildContact(c.flags),
      }),
    };
  },
  "contacts.update": updateContact,
  "contacts.delete": async (c, r) => {
    await r.json("people", `${personPath(c.positionals[0])}:deleteContact`, {
      method: "DELETE",
    });
    return { deleted: c.positionals[0] };
  },
  "contacts.get": async (c, r) => {
    const found = await contact(r, c.positionals[0]);
    return found ? { contact: found } : { found: false };
  },
  "contacts.raw": async (c, r) =>
    (await contact(
      r,
      c.positionals[0],
      c.flags["person-fields"] || readMask,
    )) ?? { found: false },
  "contacts.list": async (c, r) => {
    const result = await pages(
      r,
      "people",
      "people/me/connections",
      "connections",
      c.flags,
      { pageSize: c.flags.max ?? 100, personFields: readMask },
    );
    return {
      contacts: result.connections.map(compact),
      nextPageToken: result.nextPageToken,
    };
  },
  "contacts.search": async (c, r) => ({
    contacts: (
      await searchContacts(r, c.positionals.join(" "), c.flags.max ?? 50)
    ).map(compact),
  }),
  "contacts.directory.list": async (c, r) => {
    const result = await pages(
      r,
      "people",
      "people:listDirectoryPeople",
      "people",
      c.flags,
      {
        readMask: "names,emailAddresses",
        sources: "DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE",
        pageSize: c.flags.max ?? 50,
      },
    );
    return { ...result, people: result.people.map(compact) };
  },
  "contacts.directory.search": async (c, r) => {
    const result = await pages(
      r,
      "people",
      "people:searchDirectoryPeople",
      "people",
      c.flags,
      {
        query: c.positionals.join(" "),
        readMask: "names,emailAddresses",
        sources: "DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE",
        pageSize: c.flags.max ?? 50,
      },
    );
    return { ...result, people: result.people.map(compact) };
  },
  "contacts.other.list": async (c, r) => {
    const result = await pages(
      r,
      "people",
      "otherContacts",
      "otherContacts",
      c.flags,
      {
        readMask: "names,emailAddresses,phoneNumbers",
        pageSize: c.flags.max ?? 100,
      },
    );
    return {
      contacts: result.otherContacts.map(compact),
      nextPageToken: result.nextPageToken,
    };
  },
  "contacts.other.search": async (c, r) => {
    const result = await r.json("people", "otherContacts:search", {
      query: {
        query: c.positionals.join(" "),
        readMask: "names,emailAddresses,phoneNumbers",
        pageSize: c.flags.max ?? 50,
      },
    });
    return {
      contacts: (result.results ?? []).map((p: Data) => compact(p.person)),
    };
  },
  "contacts.export": exportContacts,
  "contacts.dedupe": dedupe,
  "people.get": async (c, r) => ({
    person: await r.json("people", personPath(c.positionals[0]), {
      query: { personFields: profileMask },
    }),
  }),
  "people.me": async (_c, r) => ({
    person: await r.json("people", "people/me", {
      query: { personFields: profileMask },
    }),
  }),
  "people.raw": async (c, r) =>
    r.json("people", personPath(c.positionals[0]), {
      query: { personFields: c.flags["person-fields"] || profileMask },
    }),
  "people.relations": async (c, r) => {
    const person = await r.json(
      "people",
      personPath(c.positionals[0] || "me"),
      { query: { personFields: "relations,names" } },
    );
    return {
      relations: (person.relations ?? []).filter(
        (v: Data) => !c.flags.type || v.type === c.flags.type,
      ),
    };
  },
  "people.search": async (c, r) => {
    const result = await pages(
      r,
      "people",
      "people:searchDirectoryPeople",
      "people",
      c.flags,
      {
        query: c.positionals.join(" "),
        readMask: "names,emailAddresses",
        sources: [
          "DIRECTORY_SOURCE_TYPE_DOMAIN_CONTACT",
          "DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE",
        ],
        pageSize: c.flags.max ?? 50,
      },
    );
    return { ...result, people: result.people.map(compact) };
  },
};
