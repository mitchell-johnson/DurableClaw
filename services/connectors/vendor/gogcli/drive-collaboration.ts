import {
  required,
  segment,
  type Command,
  type Data,
  type Handler,
  type HandlerMap,
  type Runtime,
} from "./types";
import {
  date,
  duration,
  enumValue,
  id,
  integer,
  list,
  paged,
  pos,
  resource,
} from "./drive-helpers";
import { fileGet, filePath, walkFiles } from "./drive-files";

const permFields =
  "nextPageToken,permissions(id,type,role,emailAddress,domain,displayName,allowFileDiscovery,deleted,expirationTime,permissionDetails(permissionType,role,inherited,inheritedFrom))";
const permissionPath = (fileId: string, permissionId: string) =>
  `files/${segment(fileId)}/permissions/${segment(permissionId)}`;
const email = (value: unknown) => {
  const text = required(value, "email");
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(text))
    throw new Error("Invalid email address");
  return text;
};
const role = (value: unknown) =>
  enumValue(value, ["reader", "writer", "commenter"], "reader");
async function scanPermissions(c: Command, r: Runtime): Promise<Data> {
  if (c.flags.file && c.flags.parent)
    throw new Error("--file conflicts with --parent");
  let items: Data[],
    truncated = false;
  if (c.flags.file) items = [await fileGet(r, id(c.flags.file))];
  else {
    const tree = await walkFiles(c, r);
    items = [tree.root, ...tree.files];
    truncated = tree.truncated;
  }
  const permissions: Data[] = [];
  for (const file of items) {
    const page = await paged(
      r,
      "drive",
      `files/${segment(file.id)}/permissions`,
      "permissions",
      { ...c, flags: { all: true, max: 100 } },
      { query: { supportsAllDrives: true, fields: permFields } },
    );
    for (const permission of page.permissions)
      permissions.push({
        file,
        permission,
        inherited: (permission.permissionDetails ?? []).some(
          (detail: Data) => detail.inherited,
        ),
      });
  }
  return { permissions, truncated, scannedFileCount: items.length };
}
const audit: Handler = async (c, r) => {
  if (c.flags["public-only"] && c.flags["external-only"])
    throw new Error("--public-only conflicts with --external-only");
  const user =
    c.command === "drive.audit.user"
      ? email(c.positionals[0]).toLowerCase()
      : undefined;
  const domains = (
    list(c.flags["internal-domain"]).length
      ? list(c.flags["internal-domain"])
      : [r.account.split("@")[1] ?? ""]
  ).map((value) => value.toLowerCase());
  const scan = await scanPermissions(c, r);
  const findings: Data[] = [];
  for (const { file, permission: p, inherited } of scan.permissions) {
    const external =
      ["user", "group", "domain"].includes(p.type) &&
      !domains.includes(
        String(p.domain ?? p.emailAddress?.split("@")[1] ?? "").toLowerCase(),
      );
    const reasons = user
      ? String(p.emailAddress ?? "").toLowerCase() === user
        ? ["user"]
        : []
      : p.type === "anyone"
        ? ["public"]
        : external
          ? ["external"]
          : [];
    if (
      !reasons.length ||
      (c.flags["public-only"] && !reasons.includes("public")) ||
      (c.flags["external-only"] && !reasons.includes("external"))
    )
      continue;
    findings.push({
      fileId: file.id,
      fileName: file.name,
      path: file.path,
      mimeType: file.mimeType,
      webViewLink: file.webViewLink,
      ownerEmails: (file.owners ?? []).map((owner: Data) => owner.emailAddress),
      permissionId: p.id,
      permissionType: p.type,
      role: p.role,
      email: p.emailAddress,
      domain: p.domain,
      displayName: p.displayName,
      allowFileDiscovery: p.allowFileDiscovery,
      deleted: p.deleted,
      expirationTime: p.expirationTime,
      reasons,
      inherited,
    });
  }
  return {
    findings,
    findingCount: findings.length,
    scannedFileCount: scan.scannedFileCount,
    truncated: scan.truncated,
    ...(user ? { user } : { internalDomains: domains }),
    ...(c.flags["fail-found"] && findings.length
      ? { failed: true, exitCode: 3 }
      : {}),
  };
};
const bulk: Handler = async (c, r) => {
  const remove = c.command === "drive.bulk.remove-public";
  let from: string | undefined, to: string | undefined;
  if (!remove) {
    from = role(required(c.flags.from, "--from"));
    to = role(required(c.flags.to, "--to"));
    if (from === to) throw new Error("--from and --to must differ");
  }
  const scan = await scanPermissions(c, r);
  const plans = scan.permissions.filter(({ permission: p }: Data) =>
    remove
      ? p.type === "anyone"
      : p.role === from &&
        (!c.flags.type || p.type === String(c.flags.type).toLowerCase()) &&
        (!c.flags.target ||
          String(p.emailAddress ?? p.domain ?? p.type).toLowerCase() ===
            String(c.flags.target).toLowerCase()),
  );
  const actions = [];
  // The scan completes before the first mutation. Inherited permissions are
  // reported but left for the owning parent to change, matching gogcli.
  for (const { file, permission, inherited } of plans) {
    if (!inherited)
      await r.json("drive", permissionPath(file.id, permission.id), {
        method: remove ? "DELETE" : "PATCH",
        query: {
          supportsAllDrives: true,
          ...(!remove ? { fields: "id,role" } : {}),
        },
        ...(!remove ? { body: { role: to } } : {}),
      });
    actions.push({
      fileId: file.id,
      permissionId: permission.id,
      action: remove ? "remove" : "updateRole",
      inherited,
      skipped: inherited,
      ...(to ? { newRole: to } : {}),
    });
  }
  return { actions, truncated: scan.truncated };
};
const commentPath = (c: Command, withId = true) =>
  `${filePath(c)}/comments${withId ? "/" + segment(pos(c, 1)) : ""}`;
const commentFields =
  "id,content,quotedFileContent,createdTime,modifiedTime,resolved,deleted,author,replies";
const reply: Handler = async (c, r) => {
  const action = c.command.endsWith("resolve")
    ? "resolve"
    : c.command.endsWith("reopen")
      ? "reopen"
      : c.flags.action;
  if (action !== undefined) enumValue(action, ["resolve", "reopen"], "resolve");
  const content =
    c.command === "drive.comments.reply"
      ? required(c.positionals[2], "reply content")
      : (c.flags.message ?? "");
  return {
    reply: await r.json("drive", commentPath(c) + "/replies", {
      method: "POST",
      query: { fields: "id,content,action,createdTime,modifiedTime,author" },
      body: { ...(content ? { content } : {}), ...(action ? { action } : {}) },
    }),
  };
};
function labelFields(c: Command, r: Runtime): Data[] {
  const fields: Data[] = [];
  const keys: Data = {
    text: "setTextValues",
    selection: "setSelectionValues",
    integer: "setIntegerValues",
    date: "setDateValues",
    user: "setUserValues",
  };
  for (const [flag, api] of Object.entries(keys))
    for (const assignment of list(c.flags[flag])) {
      const cut = assignment.indexOf("=");
      if (cut < 1) throw new Error("Label fields require field=value");
      const fieldId = assignment.slice(0, cut).trim();
      if (!fieldId) throw new Error("Empty label field ID");
      const values = assignment
        .slice(cut + 1)
        .split(",")
        .map((value) => value.trim());
      for (const value of values) {
        if (flag === "integer" && !/^-?\d+$/.test(value))
          throw new Error("Invalid integer label value");
        if (flag === "date") date(value);
        if (flag === "user") email(value);
      }
      fields.push({ fieldId, [api]: values });
    }
  for (const fieldId of list(c.flags.unset))
    fields.push({
      fieldId: required(fieldId.trim(), "field ID"),
      unsetValues: true,
    });
  if (c.flags["fields-json"]) {
    const values = r.jsonInput(c.flags["fields-json"]);
    if (!values || typeof values !== "object" || Array.isArray(values))
      throw new Error("--fields-json must be an object");
    for (const [fieldId, value] of Object.entries(values)) {
      if (!fieldId.trim()) throw new Error("Empty field key");
      if (value === null) fields.push({ fieldId, unsetValues: true });
      else if (typeof value === "number") {
        if (!Number.isSafeInteger(value))
          throw new Error("Label integers must be safe whole numbers");
        fields.push({ fieldId, setIntegerValues: [String(value)] });
      } else if (
        ["string", "boolean"].includes(typeof value) ||
        Array.isArray(value)
      )
        fields.push({
          fieldId,
          setTextValues: Array.isArray(value)
            ? value.map(String)
            : [String(value)],
        });
      else throw new Error("Unsupported label field value");
    }
  }
  return fields;
}
const changesList: Handler = async (c, r) => {
  let page = required(c.flags.token ?? c.flags.page, "--token or --page");
  const changes: Data[] = [];
  const seen = new Set<string>();
  let next = page;
  do {
    if (seen.has(page)) throw new Error("Provider repeated a changes token");
    seen.add(page);
    const response = await r.json("drive", "changes", {
      query: {
        pageToken: page,
        pageSize: integer(c.flags.max, 100, 1, 1000),
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        includeRemoved: c.flags["include-removed"] !== false,
        driveId: c.flags.drive,
        fields:
          "nextPageToken,newStartPageToken,changes(kind,type,removed,time,fileId,driveId,file(id,name,mimeType,modifiedTime,trashed,webViewLink))",
      },
    });
    changes.push(...(response.changes ?? []));
    if (changes.length > 5000)
      throw new Error("Too many changes; narrow or paginate the request");
    next = response.nextPageToken ?? response.newStartPageToken;
    if (!next)
      throw new Error("Changes response omitted its continuation token");
    if (!c.flags.all || !response.nextPageToken) break;
    page = response.nextPageToken;
  } while (page);
  if (!changes.length && c.flags["fail-empty"]) throw new Error("No changes");
  return { changes, nextPageToken: next };
};

export const driveCollaborationHandlers: HandlerMap = {
  "drive.share": async (c, r) => {
    const f = c.flags;
    if (f.email && f.domain) throw new Error("Ambiguous share target");
    const type = enumValue(
      f.to,
      ["anyone", "user", "domain"],
      f.email ? "user" : f.domain ? "domain" : "",
    );
    if (type === "anyone" && (f.email || f.domain))
      throw new Error("Anyone sharing cannot include an email or domain");
    if (type === "user" && (f.domain || f.discoverable))
      throw new Error("User sharing conflicts with domain or discoverable");
    if (type === "domain" && f.email)
      throw new Error("Domain sharing conflicts with email");
    const body: Data = {
      type,
      role: role(f.role),
      ...(type === "user"
        ? { emailAddress: email(f.email) }
        : { allowFileDiscovery: Boolean(f.discoverable) }),
    };
    if (type === "domain") {
      const domain = required(f.domain, "--domain");
      if (
        !/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(
          domain,
        ) ||
        domain.length > 253
      )
        throw new Error("Invalid share domain");
      body.domain = domain;
    }
    const permission = await r.json("drive", `${filePath(c)}/permissions`, {
      method: "POST",
      query: {
        supportsAllDrives: true,
        sendNotificationEmail: Boolean(f.notify),
        fields: "id,type,role,emailAddress,domain,allowFileDiscovery",
      },
      body,
    });
    const file = await fileGet(r, pos(c), "webViewLink");
    return {
      permission,
      permissionId: permission.id,
      link:
        file.webViewLink ??
        `https://drive.google.com/file/d/${segment(pos(c))}/view`,
    };
  },
  "drive.unshare": async (c, r) => {
    await r.json("drive", permissionPath(pos(c), pos(c, 1)), {
      method: "DELETE",
      query: { supportsAllDrives: true },
    });
    return { removed: true, fileId: pos(c), permissionId: pos(c, 1) };
  },
  "drive.permissions": (c, r) =>
    paged(r, "drive", `${filePath(c)}/permissions`, "permissions", c, {
      query: { supportsAllDrives: true, fields: permFields },
    }),
  "drive.audit.sharing": audit,
  "drive.audit.user": audit,
  "drive.bulk.remove-public": bulk,
  "drive.bulk.update-role": bulk,
  "drive.comments.list": (c, r) =>
    paged(r, "drive", commentPath(c, false), "comments", c, {
      query: {
        startModifiedTime: c.flags.since,
        fields: `nextPageToken,comments(${c.flags["include-quoted"] ? commentFields : commentFields.replace("quotedFileContent,", "")})`,
      },
    }),
  "drive.comments.get": async (c, r) => ({
    comment: await r.json("drive", commentPath(c), {
      query: { fields: commentFields },
    }),
  }),
  "drive.comments.create": async (c, r) => ({
    comment: await r.json("drive", commentPath(c, false), {
      method: "POST",
      query: { fields: commentFields },
      body: {
        content: required(c.positionals[1], "comment content"),
        ...(c.flags.quoted
          ? {
              quotedFileContent: {
                mimeType: "text/plain",
                value: c.flags.quoted,
              },
            }
          : {}),
      },
    }),
  }),
  "drive.comments.update": async (c, r) => ({
    comment: await r.json("drive", commentPath(c), {
      method: "PATCH",
      query: { fields: commentFields },
      body: { content: required(c.positionals[2], "comment content") },
    }),
  }),
  "drive.comments.delete": async (c, r) => {
    await r.json("drive", commentPath(c), { method: "DELETE" });
    return { deleted: true, commentId: pos(c, 1) };
  },
  "drive.comments.reply": reply,
  "drive.comments.resolve": reply,
  "drive.comments.reopen": reply,
  "drive.revisions.list": (c, r) =>
    paged(
      r,
      "drive",
      `${filePath(c)}/revisions`,
      "revisions",
      c,
      {
        query: {
          fields:
            "nextPageToken,revisions(id,mimeType,modifiedTime,keepForever,published,publishAuto,publishedOutsideDomain,lastModifyingUser,originalFilename,md5Checksum,size,exportLinks)",
        },
      },
      200,
    ),
  "drive.revisions.get": async (c, r) => ({
    revision: await r.json(
      "drive",
      `${filePath(c)}/revisions/${segment(pos(c, 1))}`,
      { query: { fields: "*" } },
    ),
  }),
  "drive.labels.list": (c, r) =>
    paged(
      r,
      "drivelabels",
      "labels",
      "labels",
      c,
      {
        query: {
          customer: c.flags.customer,
          languageCode: c.flags.language,
          view: c.flags.view ?? "LABEL_VIEW_BASIC",
          minimumRole: c.flags["minimum-role"],
          publishedOnly: c.flags["published-only"] !== false,
          useAdminAccess: Boolean(c.flags["admin-access"]),
          fields: c.flags.fields,
        },
      },
      50,
    ),
  "drive.labels.get": async (c, r) => ({
    label: await r.json("drivelabels", resource(pos(c), "labels"), {
      query: {
        languageCode: c.flags.language,
        view: c.flags.view ?? "LABEL_VIEW_FULL",
        useAdminAccess: Boolean(c.flags["admin-access"]),
        fields: c.flags.fields,
      },
    }),
  }),
  "drive.labels.file.list": (c, r) =>
    r.json("drive", `${filePath(c)}/listLabels`, {
      query: {
        maxResults: integer(c.flags.max, 100, 1),
        pageToken: c.flags.page,
        fields: c.flags.fields ?? "labels(id,revisionId,fields),nextPageToken",
      },
    }),
  "drive.labels.file.apply": (c, r) =>
    r.json("drive", `${filePath(c)}/modifyLabels`, {
      method: "POST",
      query: { fields: "modifiedLabels(id,revisionId,fields)" },
      body: {
        labelModifications: [
          {
            labelId: pos(c, 1).replace(/^labels\//, ""),
            fieldModifications: labelFields(c, r),
          },
        ],
      },
    }),
  "drive.labels.file.remove": (c, r) =>
    r.json("drive", `${filePath(c)}/modifyLabels`, {
      method: "POST",
      query: { fields: "modifiedLabels(id,revisionId,fields)" },
      body: {
        labelModifications: [
          { labelId: pos(c, 1).replace(/^labels\//, ""), removeLabel: true },
        ],
      },
    }),
  "drive.changes.start-token": (c, r) =>
    r.json("drive", "changes/startPageToken", {
      query: { supportsAllDrives: true, driveId: c.flags.drive },
    }),
  "drive.changes.list": changesList,
  "drive.changes.watch": async (c, r) => {
    const url = new URL(required(c.flags["webhook-url"], "--webhook-url"));
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error("Webhook URL must be HTTPS without credentials");
    const expiration = integer(
      c.flags["expiration-ms"],
      0,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    return r.json("drive", "changes/watch", {
      method: "POST",
      query: {
        pageToken: required(c.flags.token, "--token"),
        supportsAllDrives: true,
        driveId: c.flags.drive,
      },
      body: {
        id: c.flags["channel-id"] ?? crypto.randomUUID(),
        type: "web_hook",
        address: url.href,
        ...(c.flags["channel-token"]
          ? { token: c.flags["channel-token"] }
          : {}),
        ...(expiration ? { expiration: String(expiration) } : {}),
      },
    });
  },
  "drive.changes.stop": async (c, r) => {
    await r.json("drive", "channels/stop", {
      method: "POST",
      body: { id: pos(c), resourceId: pos(c, 1) },
    });
    return { stopped: true };
  },
  "drive.changes.poll": async (c, r) => {
    const stateRef = required(c.flags["state-file"], "--state-file");
    const interval = duration(c.flags.interval, 60000);
    if (interval <= 0) throw new Error("--interval must be positive");
    const iterations = integer(c.flags["max-iterations"], 0, 0, 10000);
    let state: Data;
    if (stateRef.startsWith("input:")) {
      state = r.jsonInput(stateRef);
      if (
        state.version !== 1 ||
        ![undefined, "", "drive_changes_poll"].includes(state.kind) ||
        !state.page_token
      )
        throw new Error("Invalid Drive poll state");
      if (c.flags.drive && state.drive_id !== c.flags.drive)
        throw new Error("State drive does not match --drive");
    } else if (stateRef.startsWith("output:")) {
      const initial = await r.json("drive", "changes/startPageToken", {
        query: { supportsAllDrives: true, driveId: c.flags.drive },
      });
      state = {
        page_token: required(initial.startPageToken, "start token"),
        drive_id: c.flags.drive,
      };
    } else
      throw new Error(
        "Use input:state.json to resume or output:state.json to initialize",
      );
    const response = (await changesList(
      {
        ...c,
        flags: {
          ...c.flags,
          drive: c.flags.drive ?? state.drive_id,
          token: state.page_token,
          all: true,
        },
      },
      r,
    )) as Data;
    const next = {
      version: 1,
      kind: "drive_changes_poll",
      page_token: response.nextPageToken,
      drive_id: state.drive_id,
      updated_at: new Date().toISOString(),
    };
    const artifact = r.output(
      stateRef.replace(/^(input|output):/, ""),
      JSON.stringify(next),
    );
    return {
      kind: "drive_changes",
      pageToken: state.page_token,
      nextPageToken: response.nextPageToken,
      changes: c.flags["filter-file"]
        ? response.changes.filter(
            (change: Data) => change.fileId === id(c.flags["filter-file"]),
          )
        : response.changes,
      state_file: artifact.name,
      ...(iterations === 1
        ? {}
        : {
            continuation: {
              poll_after_ms: interval,
              remaining_iterations: iterations > 1 ? iterations - 1 : 0,
              state_file: artifact.name,
            },
            note: "One bounded poll completed. Attach the updated state as input and resume after the interval; no background loop was started.",
          }),
    };
  },
  "drive.activity.query": async (c, r) => {
    const f = c.flags;
    if (f.file && f.folder) throw new Error("--file conflicts with --folder");
    const filters: string[] = [];
    if (f.from) filters.push(`time >= ${JSON.stringify(f.from)}`);
    if (f.to) filters.push(`time <= ${JSON.stringify(f.to)}`);
    if (f.actions) {
      const aliases: Data = {
        label: "APPLIED_LABEL_CHANGE",
        share: "PERMISSION_CHANGE",
        dlp: "DLP_CHANGE",
        settings: "SETTINGS_CHANGE",
      };
      const actions = String(f.actions)
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean)
        .map(
          (value) =>
            aliases[value] ??
            enumValue(
              value.toUpperCase(),
              [
                "APPLIED_LABEL_CHANGE",
                "COMMENT",
                "CREATE",
                "DELETE",
                "DLP_CHANGE",
                "EDIT",
                "MOVE",
                "PERMISSION_CHANGE",
                "REFERENCE",
                "RENAME",
                "RESTORE",
                "SETTINGS_CHANGE",
              ],
              "EDIT",
            ),
        );
      if (actions.length)
        filters.push(
          `detail.action_detail_case:${actions.length === 1 ? actions[0] : "(" + actions.join(" ") + ")"}`,
        );
    }
    if (f.filter) filters.push(f.filter);
    const body: Data = {
      pageSize: integer(f.max, 10, 1),
      filter: filters.join(" AND "),
      ...(f.file
        ? { itemName: "items/" + String(f.file).replace(/^items\//, "") }
        : {}),
      ...(f.folder
        ? { ancestorName: "items/" + String(f.folder).replace(/^items\//, "") }
        : {}),
      ...(f.consolidate ? { consolidationStrategy: { legacy: {} } } : {}),
    };
    const activities: Data[] = [];
    let page = f.page;
    const seen = new Set<string>();
    do {
      const result = await r.json("driveactivity", "activity:query", {
        method: "POST",
        body: { ...body, ...(page ? { pageToken: page } : {}) },
      });
      activities.push(...(result.activities ?? []));
      page = result.nextPageToken;
      if (!f.all || !page) break;
      if (seen.has(page) || activities.length > 5000)
        throw new Error("Activity pagination exceeded safe bounds");
      seen.add(page);
    } while (page);
    if (f["fail-empty"] && !activities.length) throw new Error("No activity");
    return { activities, nextPageToken: page ?? "" };
  },
};
