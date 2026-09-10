import { list, mapped } from "./other-helpers";
import {
  required,
  segment,
  type Command,
  type Data,
  type HandlerMap,
} from "./types";
export const administrationHandlers: HandlerMap = {};
function email(value: unknown): string {
  const address = required(value, "email").trim();
  if (!/^[^\s<>@]+@[^\s<>@]+$/.test(address))
    throw new Error("Invalid email address");
  return address;
}
for (const kind of ["users", "groups"])
  administrationHandlers[`admin.${kind}.list`] = (c, r) =>
    list(
      r,
      "admin",
      kind,
      kind,
      c,
      c.flags.domain ? { domain: c.flags.domain } : { customer: "my_customer" },
      "maxResults",
    );
administrationHandlers["admin.users.get"] = (c, r) =>
  r.json("admin", `users/${segment(c.positionals[0])}`);
administrationHandlers["admin.users.delete"] = async (c, r) => {
  await r.json("admin", `users/${segment(c.positionals[0])}`, {
    method: "DELETE",
  });
  return { deleted: true, email: c.positionals[0] };
};
administrationHandlers["admin.users.suspend"] = (c, r) =>
  r.json("admin", `users/${segment(c.positionals[0])}`, {
    method: "PATCH",
    body: { suspended: true },
  });
administrationHandlers["admin.users.create"] = async (c, r) => {
  const f = c.flags,
    primaryEmail = email(c.positionals[0]);
  if (f.admin)
    throw new Error("Assign administrator roles separately after creation");
  const generated = !String(f.password ?? "").trim();
  let hashFunction = String(f["hash-function"] ?? "").trim();
  if (hashFunction) {
    hashFunction =
      hashFunction.toLowerCase() === "crypt"
        ? "crypt"
        : hashFunction.toUpperCase();
    if (!["MD5", "SHA-1", "crypt"].includes(hashFunction) || generated)
      throw new Error(
        "A valid password hash and hash-function are required together",
      );
  }
  const password = generated
    ? "Aa1!" +
      [...crypto.getRandomValues(new Uint8Array(24))]
        .map(
          (byte) =>
            "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"[
              byte & 63
            ],
        )
        .join("")
    : String(f.password).trim();
  const body: Data = {
    primaryEmail,
    name: {
      givenName: required(f.given, "given").trim(),
      familyName: required(f.family, "family").trim(),
    },
    password,
    changePasswordAtNextLogin: !!f["change-password"] || generated,
    ...mapped(f, {
      "org-unit": "orgUnitPath",
      "recovery-email": "recoveryEmail",
      "recovery-phone": "recoveryPhone",
      suspended: "suspended",
      archived: "archived",
    }),
    ...(hashFunction ? { hashFunction } : {}),
  };
  if (body.recoveryEmail) email(body.recoveryEmail);
  let user = await r.json("admin", "users", { method: "POST", body });
  if (f.suspended || f.archived)
    user = await r.json(
      "admin",
      `users/${segment(user.primaryEmail || primaryEmail)}`,
      {
        method: "PATCH",
        body: { suspended: !!f.suspended, archived: !!f.archived },
      },
    );
  return {
    email: user.primaryEmail,
    id: user.id,
    suspended: !!user.suspended,
    archived: !!user.archived,
    ...(generated ? { generatedPassword: password } : {}),
  };
};
const members = (c: Command) => `groups/${segment(c.positionals[0])}/members`;
administrationHandlers["admin.groups.members.list"] = (c, r) =>
  list(r, "admin", members(c), "members", c, {}, "maxResults");
administrationHandlers["admin.groups.members.add"] = (c, r) => {
  const role = String(c.flags.role ?? "MEMBER").toUpperCase();
  if (!["OWNER", "MANAGER", "MEMBER"].includes(role))
    throw new Error("Invalid group role");
  return r.json("admin", members(c), {
    method: "POST",
    body: { email: email(c.positionals[1]), role },
  });
};
administrationHandlers["admin.groups.members.remove"] = async (c, r) => {
  await r.json("admin", `${members(c)}/${segment(c.positionals[1])}`, {
    method: "DELETE",
  });
  return { removed: true };
};
const orgPath = (c: Command) =>
  "customer/my_customer/orgunits/" +
  c.positionals[0].replace(/^\/+/, "").split("/").map(segment).join("/");
administrationHandlers["admin.orgunits.list"] = (c, r) =>
  r.json("admin", "customer/my_customer/orgunits", {
    query: { orgUnitPath: c.flags.parent, type: c.flags.type },
  });
administrationHandlers["admin.orgunits.get"] = (c, r) =>
  r.json("admin", orgPath(c));
administrationHandlers["admin.orgunits.create"] = (c, r) =>
  r.json("admin", "customer/my_customer/orgunits", {
    method: "POST",
    body: {
      name: required(c.positionals[0], "name").trim(),
      parentOrgUnitPath: c.flags.parent || "/",
      description: c.flags.description ?? "",
    },
  });
administrationHandlers["admin.orgunits.update"] = (c, r) => {
  const body: Data = {};
  for (const [flag, field] of Object.entries({
    name: "name",
    parent: "parentOrgUnitPath",
    description: "description",
  }))
    if (c.flags[flag] !== undefined) body[field] = String(c.flags[flag]).trim();
  if (!Object.keys(body).length) throw new Error("No updates specified");
  return r.json("admin", orgPath(c), { method: "PUT", body });
};
administrationHandlers["admin.orgunits.delete"] = async (c, r) => {
  await r.json("admin", orgPath(c), { method: "DELETE" });
  return { deleted: true, path: c.positionals[0] };
};
administrationHandlers["groups.list"] = async (c, r) => {
  const query = `member_key_id == '${r.account.replaceAll("'", "\\'")}' && ('cloudidentity.googleapis.com/groups.discussion_forum' in labels || 'cloudidentity.googleapis.com/groups.dynamic' in labels)`;
  const found = await list(
    r,
    "groups",
    "groups/-/memberships:searchTransitiveGroups",
    "memberships",
    c,
    { query },
  );
  return {
    groups: found.memberships.map((item: Data) => ({
      groupName: item.groupKey?.id,
      displayName: item.displayName,
      role: String(item.relationType ?? "").toLowerCase(),
    })),
    nextPageToken: found.nextPageToken,
  };
};
administrationHandlers["groups.members"] = async (c, r) => {
  const group = await r.json("groups", "groups:lookup", {
    query: { "groupKey.id": c.positionals[0] },
  });
  if (!/^groups\/[^/]+$/.test(group.name))
    throw new Error("Invalid group resource");
  const found = await list(
    r,
    "groups",
    `${group.name}/memberships`,
    "memberships",
    c,
  );
  return {
    members: found.memberships
      .filter((member: Data) => member.preferredMemberKey)
      .map((member: Data) => ({
        email: member.preferredMemberKey.id,
        role:
          ["OWNER", "MANAGER", "MEMBER"].find((role) =>
            member.roles?.some((entry: Data) => entry.name === role),
          ) ?? "MEMBER",
        type: member.type,
      })),
    nextPageToken: found.nextPageToken,
  };
};
const noteName = (value: string) =>
  (value.startsWith("notes/") ? value : `notes/${value}`)
    .split("/")
    .map(segment)
    .join("/");
administrationHandlers["keep.list"] = (c, r) =>
  list(r, "keep", "notes", "notes", c, { filter: c.flags.filter });
administrationHandlers["keep.get"] = async (c, r) => ({
  note: await r.json("keep", noteName(c.positionals[0])),
});
administrationHandlers["keep.search"] = async (c, r) => {
  const query = required(c.positionals[0], "query").trim().toLowerCase();
  const found = await list(r, "keep", "notes", "notes", {
    ...c,
    flags: { ...c.flags, all: true },
  });
  const notes = found.notes.filter(
    (note: Data) =>
      String(note.title ?? "")
        .toLowerCase()
        .includes(query) ||
      String(note.body?.text?.text ?? "")
        .toLowerCase()
        .includes(query),
  );
  return { notes, query: c.positionals[0], count: notes.length };
};
administrationHandlers["keep.create"] = async (c, r) => {
  const text = String(c.flags.text ?? "").trim(),
    items = c.flags.item ?? [];
  if ((!text && !items.length) || (text && items.length))
    throw new Error("Provide text or checklist items exclusively");
  if (items.some((item: string) => !item.trim()))
    throw new Error("Checklist items cannot be empty");
  return {
    note: await r.json("keep", "notes", {
      method: "POST",
      body: {
        title: String(c.flags.title ?? "").trim(),
        body: text
          ? { text: { text } }
          : {
              list: {
                listItems: items.map((item: string) => ({
                  text: { text: item.trim() },
                })),
              },
            },
      },
    }),
  };
};
administrationHandlers["keep.delete"] = async (c, r) => {
  const name = noteName(c.positionals[0]);
  await r.json("keep", name, { method: "DELETE" });
  return { deleted: true, name };
};
administrationHandlers["keep.attachment"] = async (c, r) => {
  const name = c.positionals[0];
  if (!/^notes\/[^/]+\/attachments\/[^/]+$/.test(name))
    throw new Error("Invalid attachment name");
  const file = await r.bytes("keep", name.split("/").map(segment).join("/"), {
    query: { mimeType: c.flags["mime-type"], alt: "media" },
  });
  const output = r.output(r.outputName(c), file.bytes);
  return { downloaded: true, path: output.name, bytes: output.bytes };
};
