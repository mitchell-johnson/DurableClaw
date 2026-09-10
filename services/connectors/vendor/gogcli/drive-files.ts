import { createHash } from "node:crypto";
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
  allDriveQuery,
  enumValue,
  FOLDER,
  G,
  id,
  integer,
  mediaType,
  multipart,
  paged,
  pos,
  quote,
  safeName,
} from "./drive-helpers";

export const filePath = (c: Command) => `files/${segment(pos(c))}`;
export const fileFields =
  "id,name,mimeType,size,parents,createdTime,modifiedTime,description,starred,webViewLink,driveId,md5Checksum,version,shortcutDetails,owners,trashed";
const listFields = `nextPageToken,incompleteSearch,files(${fileFields})`;
export const fileGet = (r: Runtime, fileId: string, fields = fileFields) =>
  r.json("drive", `files/${segment(fileId)}`, {
    query: { supportsAllDrives: true, fields },
  });
export const notTrashed = (q: string) =>
  /\btrashed\s*(?:=|!=)\s*(?:true|false)\b/i.test(q)
    ? q
    : q
      ? `${q} and trashed = false`
      : "trashed = false";
export function searchQuery(text: string, raw: boolean): string {
  if (
    raw ||
    /(?:mimeType|name|fullText|trashed|starred|modifiedTime|createdTime|visibility)\s*(?:!=|=|<|>|contains)|'[^']+'\s+in\s+(?:parents|owners|writers)|\bsharedWithMe\b|(?:appProperties|properties)\s+has\s+\{/i.test(
      text,
    )
  )
    return notTrashed(text);
  return notTrashed(`fullText contains '${quote(text)}'`);
}
export const driveList = (c: Command, r: Runtime, q: string) =>
  r.json("drive", "files", {
    query: {
      ...allDriveQuery(c.flags),
      q,
      pageSize: integer(c.flags.max, 20, 1, 1000),
      pageToken: c.flags.page,
      orderBy: "modifiedTime desc",
      fields: c.flags.fields ?? listFields,
    },
  });

export async function walkFiles(
  c: Command,
  r: Runtime,
): Promise<{ root: Data; files: Data[]; truncated: boolean }> {
  const root = await fileGet(r, String(c.flags.parent ?? "root"));
  if (root.mimeType !== FOLDER)
    throw new Error("--parent must identify a folder");
  const defaultDepth =
    c.command === "drive.inventory" ? 0 : c.command === "drive.du" ? 1 : 2;
  const depth = integer(c.flags.depth, defaultDepth, 0, 100);
  const max = integer(
    c.flags.max,
    c.command === "drive.tree" ? 0 : 500,
    0,
    5000,
  );
  const files: Data[] = [];
  const queue = [{ id: root.id, path: root.name ?? "root", depth: 0 }];
  const seen = new Set<string>();
  let truncated = false;
  while (queue.length) {
    const folder = queue.shift()!;
    if (seen.has(folder.id)) continue;
    seen.add(folder.id);
    if (depth && folder.depth >= depth) continue;
    let page: string | undefined;
    const tokens = new Set<string>();
    do {
      const response = await r.json("drive", "files", {
        query: {
          ...allDriveQuery(c.flags),
          q: `'${quote(folder.id)}' in parents and trashed = false`,
          pageSize: 1000,
          pageToken: page,
          fields: listFields,
          orderBy: "folder,name",
        },
      });
      for (const file of response.files ?? []) {
        if (max && files.length >= max) {
          truncated = true;
          return { root, files, truncated };
        }
        const entry = {
          ...file,
          path: folder.path + "/" + file.name,
          depth: folder.depth + 1,
        };
        files.push(entry);
        if (file.mimeType === FOLDER)
          queue.push({ id: file.id, path: entry.path, depth: entry.depth });
      }
      page = response.nextPageToken;
      if (page && tokens.has(page))
        throw new Error("Provider repeated a page token");
      if (page) tokens.add(page);
    } while (page);
  }
  return { root, files, truncated };
}
export function sortReport(files: Data[], sort: string, order: string): Data[] {
  const multiplier =
    enumValue(order, ["asc", "desc"], "asc") === "desc" ? -1 : 1;
  enumValue(
    sort,
    ["path", "name", "size", "files", "modified", "modifiedTime"],
    "path",
  );
  return [...files].sort(
    (a, b) =>
      multiplier *
      (sort === "size" || sort === "files"
        ? Number(a[sort] ?? 0) - Number(b[sort] ?? 0)
        : String(
            a[sort === "modified" ? "modifiedTime" : sort] ?? "",
          ).localeCompare(
            String(b[sort === "modified" ? "modifiedTime" : sort] ?? ""),
          )),
  );
}

export const driveDownload: Handler = async (c, r) => {
  const file = await fileGet(r, pos(c), "id,name,mimeType");
  const formats: Data = {
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown",
    html: "text/html",
    csv: "text/csv",
    png: "image/png",
    docx: mediaType("x.docx"),
    xlsx: mediaType("x.xlsx"),
    pptx: mediaType("x.pptx"),
  };
  let format = c.flags.format ? String(c.flags.format).toLowerCase() : "";
  if (format && !formats[format]) throw new Error("Invalid export format");
  let bytes: Uint8Array;
  if (c.flags.tab) {
    if (file.mimeType !== G + "document")
      throw new Error("--tab requires a Google Doc");
    if (format && !["pdf", "docx", "txt", "md", "html"].includes(format))
      throw new Error("Unsupported tab export format");
    const doc = await r.json("docs", `documents/${segment(pos(c))}`, {
      query: { includeTabsContent: true },
    });
    const flatten = (tabs: Data[]): Data[] =>
      tabs.flatMap((tab) => [tab, ...flatten(tab.childTabs ?? [])]);
    const matches = flatten(doc.tabs ?? []).filter(
      (tab) =>
        tab.documentTab?.tabProperties?.tabId === c.flags.tab ||
        tab.tabProperties?.tabId === c.flags.tab ||
        tab.tabProperties?.title === c.flags.tab,
    );
    if (matches.length !== 1)
      throw new Error("Tab must match one tab ID or title");
    format ||= "pdf";
    const tab =
      matches[0].tabProperties?.tabId ??
      matches[0].documentTab?.tabProperties?.tabId;
    bytes = (
      await r.bytes("docs-web", `document/d/${segment(pos(c))}/export`, {
        query: { format, tab },
      })
    ).bytes;
  } else if (String(file.mimeType).startsWith(G)) {
    if (file.mimeType === G + "site")
      throw new Error("Google Sites cannot be exported; use sites.url");
    const kind = String(file.mimeType).slice(G.length);
    const allowed: Data = {
      document: ["pdf", "docx", "txt", "md", "html"],
      spreadsheet: ["pdf", "csv", "xlsx"],
      presentation: ["pdf", "pptx"],
      drawing: ["png", "pdf"],
    };
    format ||=
      kind === "spreadsheet" ? "csv" : kind === "drawing" ? "png" : "pdf";
    if (!(allowed[kind] ?? ["pdf"]).includes(format))
      throw new Error("Format is not supported for this Google file type");
    bytes = (
      await r.bytes("drive", filePath(c) + "/export", {
        query: { mimeType: formats[format] },
      })
    ).bytes;
  } else {
    if (format)
      throw new Error("Binary Drive files must be downloaded without --format");
    bytes = (
      await r.bytes("drive", filePath(c), {
        query: { alt: "media", supportsAllDrives: true },
      })
    ).bytes;
  }
  const artifact = r.output(
    r.outputName(
      c,
      `artifacts/${safeName(file.name ?? file.id)}${format ? "." + format : ""}`,
    ),
    bytes,
  );
  return { path: artifact.name, size: artifact.bytes };
};

const driveUpload: Handler = async (c, r) => {
  const f = c.flags,
    reference = required(c.positionals[0], "input file");
  if (f["if-version"] !== undefined && !f.replace)
    throw new Error("--if-version requires --replace");
  if (f.replace && (f.parent || f.convert || f["convert-to"]))
    throw new Error("--replace conflicts with --parent and conversion");
  let bytes = r.input(reference);
  const sourceName = reference
    .replace(/^input:/, "")
    .split("/")
    .at(-1)!;
  let name = f.name ?? sourceName;
  const mime = f["mime-type"] ?? mediaType(sourceName);
  if (/\r|\n/.test(mime)) throw new Error("Invalid MIME type");
  const convertTo = f["convert-to"]
    ? enumValue(f["convert-to"], ["doc", "sheet", "slides"], "doc")
    : undefined;
  const convert = Boolean(f.convert || convertTo);
  if (
    f.convert &&
    !convertTo &&
    !/\.(?:docx?|xlsx?|pptx?|csv|txt|html|md)$/i.test(sourceName)
  )
    throw new Error(
      "--convert does not support this file extension; use --convert-to explicitly",
    );
  const metadata: Data = {};
  if (!f.replace || f.name) metadata.name = name;
  if (f.parent) metadata.parents = [id(f.parent)];
  if (convert) {
    const target =
      convertTo ??
      (/\.(?:csv|tsv|xls|xlsx)$/i.test(sourceName)
        ? "sheet"
        : /\.(?:ppt|pptx)$/i.test(sourceName)
          ? "slides"
          : "doc");
    metadata.mimeType =
      G +
      (
        {
          doc: "document",
          sheet: "spreadsheet",
          slides: "presentation",
        } as Data
      )[target];
    if (!f.name)
      metadata.name = String(name).replace(/\.(?:docx?|xlsx?|pptx?|md)$/i, "");
    if (!f["keep-frontmatter"] && mime === "text/markdown")
      bytes = new TextEncoder().encode(
        new TextDecoder()
          .decode(bytes)
          .replace(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)\r?\n/, ""),
      );
  }
  const query: Data = {
    supportsAllDrives: true,
    fields: "id,name,mimeType,size,webViewLink",
    ...(f["keep-revision-forever"] ? { keepRevisionForever: true } : {}),
  };
  let file: Data;
  if (f.replace) {
    const versioned = f["if-version"] !== undefined;
    const existing = await r.json(
      versioned ? "drive-v2" : "drive",
      `files/${segment(id(f.replace))}`,
      {
        query: {
          supportsAllDrives: true,
          fields: versioned ? "id,mimeType,version,etag" : "id,mimeType",
        },
      },
    );
    if (String(existing.mimeType).startsWith(G))
      throw new Error("Cannot replace Google Workspace file content");
    if (versioned) {
      const version = integer(f["if-version"], 0, 1, Number.MAX_SAFE_INTEGER);
      if (
        !existing.etag ||
        !existing.version ||
        Number(existing.version) !== version
      )
        throw new Error(
          "Drive file version conflict; replacement was not attempted",
        );
      file = await multipart(
        r,
        "drive-v2-upload",
        `files/${segment(id(f.replace))}`,
        f.name ? { title: f.name } : {},
        bytes,
        mime,
        {
          method: "PUT",
          query: {
            supportsAllDrives: true,
            fields: "id,title,mimeType,fileSize,alternateLink",
            ...(f["keep-revision-forever"] ? { pinned: true } : {}),
          },
          headers: { "If-Match": existing.etag },
        },
      );
      file = {
        ...file,
        name: file.title,
        size: file.fileSize,
        webViewLink: file.alternateLink,
      };
    } else
      file = await multipart(
        r,
        "drive-upload",
        `files/${segment(id(f.replace))}`,
        metadata,
        bytes,
        mime,
        { method: "PATCH", query },
      );
  } else
    file = await multipart(r, "drive-upload", "files", metadata, bytes, mime, {
      query,
    });
  return {
    file,
    ...(f.replace
      ? { replaced: true, preservedFileId: file.id === id(f.replace) }
      : {}),
  };
};

const syncPush: Handler = async (c, r) => {
  const reference = required(c.positionals[0], "input directory");
  const parent = id(required(c.flags.parent, "--parent"));
  const root = await fileGet(r, parent, "id,mimeType,driveId");
  if (root.mimeType !== FOLDER)
    throw new Error("Sync destination must be a folder");
  if (root.driveId && c.flags["all-drives"] === false)
    throw new Error("Shared drive destination requires --all-drives");
  const entries = r.inputs(reference);
  const folders = new Map<string, string>([["", parent]]);
  const directories = new Set<string>();
  for (const file of entries) {
    const parts = file.name.split("/");
    parts.pop();
    while (parts.length) {
      directories.add(parts.join("/"));
      parts.pop();
    }
  }
  const actions: Data[] = [];
  const remoteChildren = new Map<string, Data[]>();
  async function matches(parentPath: string, name: string): Promise<Data[]> {
    if (!folders.has(parentPath)) return [];
    if (!remoteChildren.has(parentPath)) {
      const found = await paged(
        r,
        "drive",
        "files",
        "files",
        { ...c, flags: { ...c.flags, all: true, max: 1000 } },
        {
          query: {
            ...allDriveQuery({ ...c.flags, drive: root.driveId }),
            q: `'${quote(folders.get(parentPath))}' in parents and trashed = false`,
            fields: listFields,
          },
        },
      );
      remoteChildren.set(parentPath, found.files);
    }
    const found = remoteChildren
      .get(parentPath)!
      .filter((file) => file.name === name);
    if (found.length > 1)
      throw new Error(
        `Ambiguous Drive siblings for ${name}; no sync changes were made`,
      );
    return found;
  }
  for (const path of [...directories].sort(
    (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
  )) {
    const components = path.split("/"),
      name = components.pop()!,
      parentPath = components.join("/");
    const [remote] = await matches(parentPath, name);
    if (remote && remote.mimeType !== FOLDER)
      throw new Error("Sync folder conflicts with a remote file");
    if (remote) folders.set(path, remote.id);
    else
      actions.push({
        action: "create_folder",
        path,
        name,
        parent_path: parentPath,
      });
  }
  for (const entry of entries) {
    const components = entry.name.split("/"),
      name = components.pop()!,
      parentPath = components.join("/");
    const [remote] = await matches(parentPath, name);
    if (
      remote &&
      (remote.mimeType === FOLDER || String(remote.mimeType).startsWith(G))
    )
      throw new Error(
        "Sync binary input conflicts with a Google file or folder",
      );
    const md5 = createHash("md5").update(entry.bytes).digest("hex");
    const same =
      remote &&
      Number(remote.size) === entry.bytes.length &&
      String(remote.md5Checksum ?? "").toLowerCase() === md5;
    actions.push({
      action: same ? "skip_file" : remote ? "update_file" : "create_file",
      path: entry.name,
      name,
      parent_path: parentPath,
      file_id: remote?.id,
      md5,
      bytes: entry.bytes,
      mime: mediaType(name),
    });
  }
  // Validate and plan the full tree before the first mutation.
  for (const action of actions) {
    if (action.action === "skip_file") continue;
    const parentId = folders.get(action.parent_path);
    if (!parentId) throw new Error("Missing resolved sync parent");
    if (action.action === "create_folder") {
      const file = await r.json("drive", "files", {
        method: "POST",
        query: { supportsAllDrives: true, fields: "id,name" },
        body: { name: action.name, mimeType: FOLDER, parents: [parentId] },
      });
      folders.set(action.path, required(file.id, "created folder ID"));
      action.file_id = file.id;
    } else {
      const update = action.action === "update_file";
      const file = await multipart(
        r,
        "drive-upload",
        update ? `files/${segment(action.file_id)}` : "files",
        { name: action.name, ...(!update ? { parents: [parentId] } : {}) },
        action.bytes,
        action.mime,
        {
          method: update ? "PATCH" : "POST",
          query: {
            supportsAllDrives: true,
            fields: "id,name,size,md5Checksum",
          },
        },
      );
      action.file_id = file.id;
    }
  }
  return {
    local_root: reference,
    parent_id: parent,
    actions: actions.map(({ bytes, mime, ...action }) => ({
      ...action,
      ...(bytes ? { size: bytes.length } : {}),
    })),
  };
};

export const driveFileHandlers: HandlerMap = {
  "drive.ls": (c, r) => {
    if (c.flags.all && c.flags.parent)
      throw new Error("--all conflicts with --parent");
    return driveList(
      c,
      r,
      notTrashed(
        [
          c.flags.query,
          !c.flags.all ? `'${quote(c.flags.parent ?? "root")}' in parents` : "",
        ]
          .filter(Boolean)
          .join(" and "),
      ),
    );
  },
  "drive.search": (c, r) => {
    if (c.flags.parent && c.flags["raw-query"])
      throw new Error("--parent conflicts with --raw-query");
    const q = searchQuery(
      required(c.positionals.join(" "), "query"),
      Boolean(c.flags["raw-query"]),
    );
    return driveList(
      c,
      r,
      (c.flags.parent ? `'${quote(c.flags.parent)}' in parents and ` : "") + q,
    );
  },
  "drive.get": async (c, r) => ({
    file: await fileGet(r, pos(c), c.flags.fields ?? fileFields),
  }),
  "drive.raw": (c, r) => fileGet(r, pos(c), c.flags.fields ?? "*"),
  "drive.download": driveDownload,
  "drive.upload": driveUpload,
  "drive.sync.push": syncPush,
  "drive.mkdir": async (c, r) => ({
    folder: await r.json("drive", "files", {
      method: "POST",
      body: {
        name: required(c.positionals[0], "name"),
        mimeType: FOLDER,
        ...(c.flags.parent ? { parents: [id(c.flags.parent)] } : {}),
      },
      query: { supportsAllDrives: true, fields: "id,name,webViewLink" },
    }),
  }),
  "drive.copy": async (c, r) => ({
    file: await r.json("drive", filePath(c) + "/copy", {
      method: "POST",
      body: {
        name: required(c.positionals[1], "new name"),
        ...(c.flags.parent ? { parents: [id(c.flags.parent)] } : {}),
      },
      query: { supportsAllDrives: true, fields: "id,name,webViewLink" },
    }),
  }),
  "drive.rename": async (c, r) => ({
    file: await r.json("drive", filePath(c), {
      method: "PATCH",
      body: { name: required(c.positionals[1], "new name") },
      query: { supportsAllDrives: true, fields: "id,name" },
    }),
  }),
  "drive.move": async (c, r) => {
    const parent = id(required(c.flags.parent, "--parent"));
    const before = await fileGet(r, pos(c), "id,name,parents");
    return {
      file: await r.json("drive", filePath(c), {
        method: "PATCH",
        body: {},
        query: {
          supportsAllDrives: true,
          addParents: parent,
          ...(before.parents?.length
            ? { removeParents: before.parents.join(",") }
            : {}),
          fields: "id,name,parents,webViewLink",
        },
      }),
    };
  },
  "drive.delete": async (c, r) => {
    if (c.flags.permanent)
      await r.json("drive", filePath(c), {
        method: "DELETE",
        query: { supportsAllDrives: true },
      });
    else
      await r.json("drive", filePath(c), {
        method: "PATCH",
        body: { trashed: true },
        query: { supportsAllDrives: true, fields: "id,trashed" },
      });
    return {
      id: pos(c),
      deleted: Boolean(c.flags.permanent),
      trashed: !c.flags.permanent,
    };
  },
  "drive.shortcut.create": async (c, r) => {
    const target = await fileGet(r, pos(c), "id,name,mimeType");
    return {
      file: await r.json("drive", "files", {
        method: "POST",
        body: {
          name: c.flags.name ?? target.name,
          mimeType: G + "shortcut",
          shortcutDetails: { targetId: target.id },
          ...(c.flags.parent ? { parents: [id(c.flags.parent)] } : {}),
        },
        query: { supportsAllDrives: true, fields: fileFields },
      }),
    };
  },
  "drive.url": async (c, r) => {
    const urls = [];
    for (const value of c.positionals) {
      const file = await fileGet(r, id(value), "webViewLink");
      urls.push({
        id: id(value),
        url:
          file.webViewLink ||
          `https://drive.google.com/file/d/${segment(id(value))}/view`,
      });
    }
    return { urls };
  },
  "drive.drives": (c, r) =>
    paged(r, "drive", "drives", "drives", c, {
      query: {
        q: c.flags.query,
        fields: "nextPageToken,drives(id,name,createdTime,capabilities)",
      },
    }),
  "drive.tree": (c, r) => walkFiles(c, r),
  "drive.inventory": async (c, r) => {
    const result = await walkFiles(c, r);
    return {
      ...result,
      files: sortReport(
        result.files,
        String(c.flags.sort ?? "path"),
        String(c.flags.order ?? "asc"),
      ),
    };
  },
  "drive.du": async (c, r) => {
    const result = await walkFiles(
      { ...c, flags: { ...c.flags, depth: 0, max: 0 } },
      r,
    );
    const maxDepth = integer(c.flags.depth, 1, 0, 100);
    const folders = [
      { ...result.root, path: result.root.name, depth: 0 },
      ...result.files.filter((file) => file.mimeType === FOLDER),
    ];
    const rows = folders
      .filter((folder) => !maxDepth || folder.depth <= maxDepth)
      .map((folder) => ({
        ...folder,
        files: result.files.filter(
          (file) =>
            file.path.startsWith(folder.path + "/") && file.mimeType !== FOLDER,
        ).length,
        size: result.files
          .filter(
            (file) =>
              file.path.startsWith(folder.path + "/") &&
              file.mimeType !== FOLDER,
          )
          .reduce((sum, file) => sum + Number(file.size ?? 0), 0),
      }));
    return {
      ...result,
      files: undefined,
      folders: sortReport(
        rows,
        String(c.flags.sort ?? "size"),
        String(c.flags.order ?? "desc"),
      ).slice(0, integer(c.flags.max, 50, 0, 5000) || undefined),
    };
  },
  "sites.list": (c, r) =>
    driveList(
      c,
      r,
      notTrashed(
        `mimeType = '${G}site'` +
          (c.flags.query ? ` and (${c.flags.query})` : ""),
      ),
    ),
  "sites.search": (c, r) =>
    driveList(
      c,
      r,
      `mimeType = '${G}site' and (` +
        searchQuery(
          required(c.positionals.join(" "), "query"),
          Boolean(c.flags["raw-query"]),
        ) +
        ")",
    ),
  "sites.get": async (c, r) => {
    const file = await fileGet(r, pos(c), c.flags.fields ?? fileFields);
    if (file.mimeType && file.mimeType !== G + "site")
      throw new Error("File is not a Google Site");
    return { site: file };
  },
  "sites.url": async (c, r) => {
    const file = await fileGet(r, pos(c), "id,mimeType,webViewLink");
    if (file.mimeType !== G + "site")
      throw new Error("File is not a Google Site");
    return { id: pos(c), url: required(file.webViewLink, "site URL") };
  },
};
