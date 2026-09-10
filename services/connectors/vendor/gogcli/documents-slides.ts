import { renderSlidey } from "./documents-slidey";
import { imageLifecycle } from "./documents-assets";
import { marked } from "marked";
import {
  type Command,
  type Data,
  type Runtime,
  type HandlerMap,
  segment,
} from "./types";
import {
  flags,
  integer,
  id,
  mask,
  color,
  pt,
  copyDocument,
  exportDocument,
  attachParent,
  rangeText,
  textStyle,
  uuid,
} from "./documents-common";

const root = (c: Command) => `presentations/${id(c.positionals[0])}`;
const get = (c: Command, r: Runtime) => r.json("slides", root(c));
function flattenElements(page: Data): Data[] {
  return (page.pageElements ?? []).flatMap((e: Data) => [
    e,
    ...(e.elementGroup ? flattenElements(e.elementGroup) : []),
  ]);
}
function page(meta: Data, pageId: string): Data {
  const p = (meta.slides ?? []).find((s: Data) => s.objectId === pageId);
  if (!p) throw new Error("Slide not found");
  return p;
}
function element(meta: Data, objectId: string): Data {
  const e = (meta.slides ?? [])
    .flatMap(flattenElements)
    .find((e: Data) => e.objectId === objectId);
  if (!e) throw new Error("Page element not found");
  return e;
}
async function batch(
  c: Command,
  r: Runtime,
  requests: Data[],
  meta?: Data,
): Promise<any> {
  if (!requests.length) throw new Error("No changes requested");
  return r.json("slides", root(c) + ":batchUpdate", {
    method: "POST",
    body: {
      requests,
      ...(meta?.revisionId
        ? { writeControl: { requiredRevisionId: meta.revisionId } }
        : {}),
    },
  });
}
function cell(f: Data): Data {
  return {
    rowIndex: integer(f.row, "row"),
    columnIndex: integer(f.col, "col"),
  };
}
function tableRange(f: Data): Data {
  return {
    location: cell(f),
    rowSpan: integer(f["row-span"] ?? 1, "row-span", 1),
    columnSpan: integer(f["col-span"] ?? 1, "col-span", 1),
  };
}
function transform(f: Data): Data {
  return {
    scaleX: 1,
    scaleY: 1,
    translateX: Number(f.x ?? 0),
    translateY: Number(f.y ?? 0),
    unit: f.unit ?? "PT",
  };
}
function shapeProps(f: Data, pageId: string): Data {
  return {
    pageObjectId: pageId,
    size: {
      width: { magnitude: Number(f.width ?? 100), unit: f.unit ?? "PT" },
      height: { magnitude: Number(f.height ?? 100), unit: f.unit ?? "PT" },
    },
    transform: transform(f),
  };
}
function objectText(e: Data): string {
  return (e.shape?.text?.textElements ?? [])
    .map((t: Data) => t.textRun?.content ?? "")
    .join("");
}
function requireTable(meta: Data, objectId: string, f: Data): Data {
  const e = element(meta, objectId);
  if (!e.table) throw new Error("Element is not a table");
  if (f.row !== undefined && integer(f.row, "row") >= e.table.rows)
    throw new Error("Table row out of bounds");
  if (f.col !== undefined && integer(f.col, "col") >= e.table.columns)
    throw new Error("Table column out of bounds");
  if (
    (f.row ?? 0) + (f["row-span"] ?? 1) > e.table.rows ||
    (f.col ?? 0) + (f["col-span"] ?? 1) > e.table.columns
  )
    throw new Error("Table range exceeds bounds");
  return e.table;
}
export function imageDimensions(bytes: Uint8Array): {
  width: number;
  height: number;
  mime: string;
} {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && v.getUint32(0) === 0x89504e47)
    return {
      width: v.getUint32(16),
      height: v.getUint32(20),
      mime: "image/png",
    };
  if (bytes.length >= 10 && String.fromCharCode(...bytes.slice(0, 3)) === "GIF")
    return {
      width: v.getUint16(6, true),
      height: v.getUint16(8, true),
      mime: "image/gif",
    };
  if (bytes[0] === 255 && bytes[1] === 216) {
    for (let i = 2; i + 8 < bytes.length;) {
      if (bytes[i] !== 255) {
        i++;
        continue;
      }
      const marker = bytes[i + 1];
      if (
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
          0xce, 0xcf,
        ].includes(marker)
      )
        return {
          height: v.getUint16(i + 5),
          width: v.getUint16(i + 7),
          mime: "image/jpeg",
        };
      if (marker === 0xd9 || marker === 0xda) break;
      const length = v.getUint16(i + 2);
      if (length < 2) break;
      i += 2 + length;
    }
  }
  throw new Error("Image must be a valid PNG, GIF, or JPEG");
}
export async function uploadImage(
  r: Runtime,
  reference: string,
  f: Data = {},
): Promise<{
  url: string;
  fileId: string;
  width: number;
  height: number;
  fallbackLink?: boolean;
}> {
  const data = r.input(reference),
    size = imageDimensions(data),
    boundary = "dc_" + crypto.randomUUID().replaceAll("-", ""),
    meta = {
      name:
        f.name ??
        reference
          .split("/")
          .pop()
          ?.replace(/^input:/, "") ??
        "image",
      mimeType: size.mime,
      ...(f.parent ? { parents: [f.parent] } : {}),
    };
  const a = new TextEncoder().encode(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${size.mime}\r\n\r\n`,
    ),
    b = new TextEncoder().encode(`\r\n--${boundary}--\r\n`),
    body = new Uint8Array(a.length + data.length + b.length);
  body.set(a);
  body.set(data, a.length);
  body.set(b, a.length + data.length);
  const uploaded = await r.upload("drive-upload", "files", body, {
    query: { uploadType: "multipart", fields: "id" },
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
  });
  try {
    await r.json("drive", `files/${id(uploaded.id)}/permissions`, {
      method: "POST",
      body: { type: "anyone", role: "reader" },
      query: { fields: "id" },
    });
  } catch (error) {
    if (
      f["on-restricted"] === "link" &&
      error instanceof Error &&
      /\(403\)/.test(error.message)
    )
      return {
        url: `https://drive.google.com/file/d/${uploaded.id}/view`,
        fileId: uploaded.id,
        fallbackLink: true,
        ...size,
      };
    throw error;
  }
  return {
    url: `https://drive.google.com/uc?export=download&id=${uploaded.id}`,
    fileId: uploaded.id,
    ...size,
  };
}
async function imageRequest(
  c: Command,
  r: Runtime,
  pageId: string,
  reference?: string,
): Promise<Data> {
  const f = flags(c);
  if (reference && f.url) throw new Error("Choose local image or URL");
  let url = f.url,
    width = Number(f.width ?? 0),
    height = Number(f.height ?? 0);
  if (reference) {
    const uploaded = await uploadImage(r, reference);
    url = uploaded.url;
    if (!width) width = uploaded.width * 0.75;
    if (!height) height = (width * uploaded.height) / uploaded.width;
  }
  if (!url || new URL(url).protocol !== "https:")
    throw new Error("HTTPS image URL required");
  if (!width || !height)
    throw new Error("Width and height required for URL images");
  return {
    createImage: {
      objectId: uuid("image"),
      url,
      elementProperties: shapeProps({ ...f, width, height }, pageId),
    },
  };
}
function notesText(f: Data, r: Runtime): string {
  if (f.notes !== undefined && f["notes-file"])
    throw new Error("Choose notes or notes-file");
  const text = f["notes-file"] ? r.text(f["notes-file"]) : f.notes;
  if (typeof text !== "string") throw new Error("Notes required");
  return text;
}
async function notes(
  c: Command,
  r: Runtime,
  pageId: string,
  text: string,
  meta?: Data,
): Promise<any> {
  meta ??= await get(c, r);
  const target = page(meta!, pageId).slideProperties?.notesPage?.notesProperties
    ?.speakerNotesObjectId;
  if (!target) throw new Error("Slide speaker notes object unavailable");
  return batch(
    c,
    r,
    [
      { deleteText: { objectId: target, textRange: { type: "ALL" } } },
      ...(text
        ? [{ insertText: { objectId: target, text, insertionIndex: 0 } }]
        : []),
    ],
    meta,
  );
}
const h: HandlerMap = {};
h["slides.raw"] = get;
h["slides.info"] = get;
h["slides.copy"] = copyDocument;
h["slides.export"] = exportDocument;
h["slides.create"] = async (c, r) => {
  const f = flags(c);
  if (f.template)
    return copyDocument(
      { ...c, positionals: [f.template, c.positionals[0]] },
      r,
    );
  const result = await r.json("slides", "presentations", {
    method: "POST",
    body: { title: c.positionals[0] },
  });
  await attachParent(r, result.presentationId, f.parent);
  return result;
};
h["slides.list-slides"] = async (c, r) => ({
  slides: (await get(c, r)).slides ?? [],
});
h["slides.read-slide"] = async (c, r) => {
  const s = await r.json(
    "slides",
    root(c) + `/pages/${segment(c.positionals[1])}`,
  );
  return flags(c).detail
    ? s
    : {
        objectId: s.objectId,
        text: flattenElements(s).map(objectText).filter(Boolean),
        pageElements: s.pageElements,
      };
};
h["slides.new-slide"] = async (c, r) => {
  const f = flags(c);
  if (f.layout && f["layout-id"])
    throw new Error("Choose predefined layout or layout-id");
  return batch(c, r, [
    {
      createSlide: {
        objectId: uuid("slide"),
        ...(f.index !== undefined
          ? { insertionIndex: integer(f.index, "index") }
          : {}),
        ...(f.layout || f["layout-id"]
          ? {
              slideLayoutReference: f.layout
                ? { predefinedLayout: f.layout }
                : { layoutId: f["layout-id"] },
            }
          : {}),
      },
    },
  ]);
};
h["slides.delete-slide"] = (c, r) =>
  batch(c, r, [{ deleteObject: { objectId: c.positionals[1] } }]);
for (const op of ["skip-slide", "unskip-slide"])
  h[`slides.${op}`] = (c, r) =>
    batch(c, r, [
      {
        updateSlideProperties: {
          objectId: c.positionals[1],
          slideProperties: { isSkipped: op === "skip-slide" },
          fields: "isSkipped",
        },
      },
    ]);
h["slides.move-slide"] = async (c, r) => {
  const f = flags(c),
    meta = await get(c, r);
  page(meta, c.positionals[1]);
  return batch(
    c,
    r,
    [
      {
        updateSlidesPosition: {
          slideObjectIds: [c.positionals[1]],
          insertionIndex: integer(
            f["to-index"],
            "to-index",
            0,
            meta.slides.length,
          ),
        },
      },
    ],
    meta,
  );
};
h["slides.duplicate-slide"] = async (c, r) => {
  const f = flags(c),
    meta = await get(c, r);
  page(meta, c.positionals[1]);
  const newId = uuid("slide"),
    requests: Data[] = [
      {
        duplicateObject: {
          objectId: c.positionals[1],
          objectIds: { [c.positionals[1]]: newId },
        },
      },
    ];
  if (f["to-index"] !== undefined)
    requests.push({
      updateSlidesPosition: {
        slideObjectIds: [newId],
        insertionIndex: integer(
          f["to-index"],
          "to-index",
          0,
          meta.slides.length + 1,
        ),
      },
    });
  return batch(c, r, requests, meta);
};
h["slides.update-notes"] = (c, r) =>
  notes(c, r, c.positionals[1], notesText(flags(c), r));
h["slides.insert-image"] = async (c, r) =>
  batch(c, r, [await imageRequest(c, r, c.positionals[1], c.positionals[2])]);
h["slides.add-slide"] = async (c, r) => {
  const f = flags(c),
    meta = await get(c, r),
    pageId = uuid("slide");
  const width = meta.pageSize?.width?.magnitude ?? 720,
    height = meta.pageSize?.height?.magnitude ?? 405;
  const requests: Data[] = [
    {
      createSlide: {
        objectId: pageId,
        slideLayoutReference: { predefinedLayout: "BLANK" },
        ...(f.before
          ? {
              insertionIndex: (meta.slides ?? []).findIndex(
                (s: Data) => s.objectId === f.before,
              ),
            }
          : {}),
      },
    },
  ];
  if (requests[0].createSlide.insertionIndex === -1)
    throw new Error("before slide not found");
  requests.push(
    await imageRequest(
      {
        ...c,
        flags: {
          ...f,
          width,
          height,
          unit: meta.pageSize?.width?.unit ?? "PT",
        },
      },
      r,
      pageId,
      c.positionals[1],
    ),
  );
  const result = await batch(c, r, requests, meta);
  if (f.notes !== undefined || f["notes-file"])
    await notes(c, r, pageId, notesText(f, r));
  return { ...result, slideId: pageId };
};
h["slides.replace-slide"] = async (c, r) => {
  const f = flags(c),
    meta = await get(c, r),
    s = page(meta, c.positionals[1]),
    requests = (s.pageElements ?? []).map((e: Data) => ({
      deleteObject: { objectId: e.objectId },
    }));
  requests.push(
    await imageRequest(
      {
        ...c,
        flags: {
          ...f,
          width: meta.pageSize?.width?.magnitude ?? 720,
          height: meta.pageSize?.height?.magnitude ?? 405,
          unit: meta.pageSize?.width?.unit ?? "PT",
        },
      },
      r,
      s.objectId,
      c.positionals[2],
    ),
  );
  const result = await batch(c, r, requests, meta);
  if (f.notes !== undefined || f["notes-file"])
    await notes(c, r, s.objectId, notesText(f, r));
  return result;
};
h["slides.insert-text"] = async (c, r) => {
  const f = flags(c);
  if (c.positionals[2] === "-")
    throw new Error("Use literal text; interactive stdin is unavailable");
  if ((f.row === undefined) !== (f.col === undefined))
    throw new Error("Both row and col required");
  const location = f.row !== undefined ? { cellLocation: cell(f) } : {};
  return batch(c, r, [
    ...(f.replace
      ? [
          {
            deleteText: {
              objectId: c.positionals[1],
              ...location,
              textRange: { type: "ALL" },
            },
          },
        ]
      : []),
    {
      insertText: {
        objectId: c.positionals[1],
        ...location,
        insertionIndex: integer(f["insertion-index"], "insertion-index"),
        text: c.positionals[2],
      },
    },
  ]);
};
h["slides.style-text"] = (c, r) => {
  const f = flags(c),
    style = textStyle(f, true);
  if (!Object.keys(style).length) throw new Error("No text styles requested");
  return batch(c, r, [
    {
      updateTextStyle: {
        objectId: c.positionals[1],
        textRange: rangeText(f.range),
        style,
        fields: mask(style),
      },
    },
  ]);
};
h["slides.link"] = (c, r) => {
  const f = flags(c);
  if (Boolean(f.clear) === Boolean(f.url))
    throw new Error("Choose URL or clear");
  if (f.url && !/^https?:\/\//.test(f.url))
    throw new Error("HTTP(S) link required");
  return batch(c, r, [
    {
      updateTextStyle: {
        objectId: c.positionals[1],
        textRange: rangeText(f.range),
        style: f.clear ? {} : { link: { url: f.url } },
        fields: "link",
      },
    },
  ]);
};
h["slides.bullets"] = (c, r) => {
  const f = flags(c);
  if (Boolean(f.on) === Boolean(f.off)) throw new Error("Choose on or off");
  return batch(c, r, [
    {
      [f.off ? "deleteParagraphBullets" : "createParagraphBullets"]: {
        objectId: c.positionals[1],
        textRange: rangeText(f.range),
        ...(f.off ? {} : { bulletPreset: f.preset }),
      },
    },
  ]);
};
h["slides.locate"] = async (c, r) => {
  const f = flags(c),
    meta = await get(c, r),
    find = f["match-case"] ? c.positionals[1] : c.positionals[1].toLowerCase();
  if (!find) throw new Error("Search text required");
  let found: Data[] = [];
  for (const s of meta.slides ?? []) {
    if (f.page && f.page !== s.objectId) continue;
    for (const e of flattenElements(s)) {
      const text = objectText(e),
        hay = f["match-case"] ? text : text.toLowerCase();
      for (
        let at = hay.indexOf(find);
        at >= 0;
        at = hay.indexOf(find, at + Math.max(find.length, 1))
      )
        found.push({
          pageId: s.objectId,
          objectId: e.objectId,
          startIndex: at,
          endIndex: at + c.positionals[1].length,
          text: text.slice(at, at + c.positionals[1].length),
        });
    }
  }
  if (!f.all)
    found = found.slice(
      integer(f.occurrence ?? 1, "occurrence", 1) - 1,
      integer(f.occurrence ?? 1, "occurrence", 1),
    );
  if (!found.length && f["fail-empty"]) throw new Error("No matches");
  return { matches: found };
};
h["slides.replace-text"] = async (c, r) => {
  const f = flags(c);
  const pages = f.page ?? [];
  if (
    [Boolean(f.object), Boolean(f.all), pages.length > 0].filter(Boolean)
      .length !== 1
  )
    throw new Error(
      "Exactly one explicit replacement scope is required: object, page, or all",
    );
  if (!c.positionals[1]) throw new Error("Find text required");
  if (!f.object)
    return batch(c, r, [
      {
        replaceAllText: {
          containsText: {
            text: c.positionals[1],
            matchCase: f["match-case"] ?? false,
          },
          replaceText: c.positionals[2],
          ...(pages.length ? { pageObjectIds: pages } : {}),
        },
      },
    ]);
  const meta = await get(c, r),
    e = element(meta, f.object),
    text = objectText(e),
    hay = f["match-case"] ? text : text.toLowerCase(),
    needle = f["match-case"]
      ? c.positionals[1]
      : c.positionals[1].toLowerCase();
  const matches: number[] = [];
  for (
    let at = hay.indexOf(needle);
    at >= 0;
    at = hay.indexOf(needle, at + needle.length)
  ) {
    matches.push(at);
  }
  if (!matches.length) return { occurrencesChanged: 0 };
  return batch(
    c,
    r,
    matches.reverse().flatMap((at) => [
      {
        deleteText: {
          objectId: e.objectId,
          textRange: {
            type: "FIXED_RANGE",
            startIndex: at,
            endIndex: at + needle.length,
          },
        },
      },
      ...(c.positionals[2]
        ? [
            {
              insertText: {
                objectId: e.objectId,
                insertionIndex: at,
                text: c.positionals[2],
              },
            },
          ]
        : []),
    ]),
    meta,
  );
};
h["slides.create-from-template"] = async (c, r) => {
  const f = flags(c),
    replacements: Data = f.replacements
      ? JSON.parse(r.text(f.replacements))
      : {};
  for (const pair of f.replace ?? []) {
    const at = pair.indexOf("=");
    if (at < 1) throw new Error("Replacement must be key=value");
    replacements[pair.slice(0, at)] = pair.slice(at + 1);
  }
  if (
    !Object.keys(replacements).length ||
    Object.values(replacements).some((v) => typeof v !== "string")
  )
    throw new Error("String replacements required");
  const created = await copyDocument(c, r);
  const result = await batch(
    { ...c, positionals: [created.id] },
    r,
    Object.entries(replacements).map(([key, value]) => ({
      replaceAllText: {
        containsText: { text: f.exact ? key : `{{${key}}}`, matchCase: true },
        replaceText: value,
      },
    })),
  );
  return { presentationId: created.id, result };
};
h["slides.thumbnail"] = async (c, r) => {
  const f = flags(c),
    thumbnail = await r.json(
      "slides",
      root(c) + `/pages/${segment(c.positionals[1])}/thumbnail`,
      {
        query: {
          "thumbnailProperties.mimeType": String(f.format).toUpperCase(),
          "thumbnailProperties.thumbnailSize": String(f.size).toUpperCase(),
        },
      },
    );
  const result = await r.externalBytes(thumbnail.contentUrl);
  return r.output(
    r.outputName(c, `artifacts/thumbnail.${f.format}`),
    result.bytes,
  );
};
for (const kind of ["shape", "line"])
  h[`slides.element.create-${kind}`] = (c, r) => {
    const f = flags(c),
      objectId = f["object-id"] ?? uuid(kind);
    return batch(c, r, [
      {
        [kind === "shape" ? "createShape" : "createLine"]: {
          objectId,
          elementProperties: shapeProps(f, c.positionals[1]),
          ...(kind === "shape"
            ? { shapeType: f.type }
            : { lineCategory: f.category }),
        },
      },
    ]);
  };
h["slides.element.delete"] = (c, r) =>
  batch(c, r, [{ deleteObject: { objectId: c.positionals[1] } }]);
h["slides.element.alt-text"] = (c, r) => {
  const f = flags(c);
  if (f.title === undefined && f.description === undefined)
    throw new Error("Title or description required");
  return batch(c, r, [
    {
      updatePageElementAltText: {
        objectId: c.positionals[1],
        ...(f.title !== undefined ? { title: f.title } : {}),
        ...(f.description !== undefined ? { description: f.description } : {}),
      },
    },
  ]);
};
h["slides.element.group"] = (c, r) =>
  batch(c, r, [
    {
      groupObjects: {
        childrenObjectIds: c.positionals.slice(1),
        groupObjectId: flags(c)["group-id"] ?? uuid("group"),
      },
    },
  ]);
h["slides.element.ungroup"] = (c, r) =>
  batch(c, r, [{ ungroupObjects: { objectIds: c.positionals.slice(1) } }]);
h["slides.element.z-order"] = (c, r) =>
  batch(c, r, [
    {
      updatePageElementsZOrder: {
        pageElementObjectIds: c.positionals.slice(1),
        operation: flags(c).operation,
      },
    },
  ]);
h["slides.element.transform"] = (c, r) => {
  const f = flags(c),
    transform: Data = {
      scaleX: f["scale-x"] ?? 1,
      scaleY: f["scale-y"] ?? 1,
      shearX: f["shear-x"] ?? 0,
      shearY: f["shear-y"] ?? 0,
      translateX: f["translate-x"] ?? 0,
      translateY: f["translate-y"] ?? 0,
      unit: f.unit,
    };
  if (f.rotate !== undefined) {
    if (f["shear-x"] !== undefined || f["shear-y"] !== undefined)
      throw new Error("Rotation cannot be combined with shear");
    const angle = (Number(f.rotate) * Math.PI) / 180;
    transform.scaleX = Math.cos(angle) * (f["scale-x"] ?? 1);
    transform.scaleY = Math.cos(angle) * (f["scale-y"] ?? 1);
    transform.shearX = -Math.sin(angle) * (f["scale-y"] ?? 1);
    transform.shearY = Math.sin(angle) * (f["scale-x"] ?? 1);
  }
  return batch(c, r, [
    {
      updatePageElementTransform: {
        objectId: c.positionals[1],
        applyMode: f["apply-mode"],
        transform,
      },
    },
  ]);
};
h["slides.element.style"] = (c, r) => {
  const f = flags(c);
  if (
    (f["fill-color"] && f["fill-transparent"]) ||
    (f["outline-color"] && f["outline-transparent"])
  )
    throw new Error("Conflicting fill or outline flags");
  const outline: Data = {};
  if (f["outline-color"])
    outline.outlineFill = {
      solidFill: { color: { rgbColor: color(f["outline-color"]) }, alpha: 1 },
    };
  if (f["outline-transparent"]) outline.propertyState = "NOT_RENDERED";
  if (f["outline-weight"] !== undefined)
    outline.weight = pt(f["outline-weight"]);
  if (f["outline-dash"]) outline.dashStyle = f["outline-dash"];
  const properties: Data = {};
  if (f.kind === "line") {
    if (f["fill-color"] || f["fill-transparent"])
      throw new Error("Line cannot have fill");
    if (outline.outlineFill) properties.lineFill = outline.outlineFill;
    for (const key of ["weight", "dashStyle", "propertyState"])
      if (outline[key] !== undefined) properties[key] = outline[key];
    return batch(c, r, [
      {
        updateLineProperties: {
          objectId: c.positionals[1],
          lineProperties: properties,
          fields: mask(properties),
        },
      },
    ]);
  }
  if (Object.keys(outline).length) properties.outline = outline;
  if (f["fill-color"])
    properties.shapeBackgroundFill = {
      solidFill: { color: { rgbColor: color(f["fill-color"]) }, alpha: 1 },
    };
  if (f["fill-transparent"])
    properties.shapeBackgroundFill = { propertyState: "NOT_RENDERED" };
  if (!Object.keys(properties).length) throw new Error("No style requested");
  return batch(c, r, [
    {
      updateShapeProperties: {
        objectId: c.positionals[1],
        shapeProperties: properties,
        fields: mask(properties),
      },
    },
  ]);
};
h["slides.table.create"] = async (c, r) => {
  const f = flags(c),
    meta = await get(c, r);
  page(meta, c.positionals[1]);
  return batch(
    c,
    r,
    [
      {
        createTable: {
          objectId: f["object-id"] ?? uuid("table"),
          rows: integer(f.rows, "rows", 1),
          columns: integer(f.cols, "cols", 1),
          elementProperties: { pageObjectId: c.positionals[1] },
        },
      },
    ],
    meta,
  );
};
for (const axis of ["row", "column"])
  for (const op of ["insert", "delete", "size"])
    h[`slides.table.${axis}.${op}`] = async (c, r) => {
      const f = flags(c),
        meta = await get(c, r);
      requireTable(meta, c.positionals[1], f);
      const column = axis === "column",
        location = {
          rowIndex: column ? 0 : integer(f.row, "row"),
          columnIndex: column ? integer(f.col, "col") : 0,
        };
      let request: Data;
      if (op === "insert")
        request = {
          [column ? "insertTableColumns" : "insertTableRows"]: {
            tableObjectId: c.positionals[1],
            cellLocation: location,
            number: integer(f.count, "count", 1, 20),
            ...(column
              ? { insertRight: f.right ?? false }
              : { insertBelow: f.below ?? false }),
          },
        };
      else if (op === "delete")
        request = {
          [column ? "deleteTableColumn" : "deleteTableRow"]: {
            tableObjectId: c.positionals[1],
            cellLocation: location,
          },
        };
      else {
        if (column && Number(f.width) < 32)
          throw new Error("Column width must be at least 32 points");
        request = {
          [column ? "updateTableColumnProperties" : "updateTableRowProperties"]:
            {
              objectId: c.positionals[1],
              [column ? "columnIndices" : "rowIndices"]: [
                location[column ? "columnIndex" : "rowIndex"],
              ],
              [column ? "tableColumnProperties" : "tableRowProperties"]: {
                [column ? "columnWidth" : "minRowHeight"]: pt(
                  column ? f.width : f.height,
                ),
              },
              fields: column ? "columnWidth" : "minRowHeight",
            },
        };
      }
      return batch(c, r, [request], meta);
    };
for (const op of ["merge", "unmerge"])
  h[`slides.table.${op}`] = async (c, r) => {
    const f = flags(c),
      meta = await get(c, r);
    requireTable(meta, c.positionals[1], f);
    return batch(
      c,
      r,
      [
        {
          [op === "merge" ? "mergeTableCells" : "unmergeTableCells"]: {
            objectId: c.positionals[1],
            tableRange: tableRange(f),
          },
        },
      ],
      meta,
    );
  };
h["slides.table.cell.style"] = async (c, r) => {
  const f = flags(c),
    meta = await get(c, r);
  requireTable(meta, c.positionals[1], f);
  if (f["fill-color"] && f["fill-transparent"])
    throw new Error("Choose fill or transparent");
  const properties: Data = {};
  if (f["fill-color"])
    properties.tableCellBackgroundFill = {
      solidFill: { color: { rgbColor: color(f["fill-color"]) }, alpha: 1 },
    };
  if (f["fill-transparent"])
    properties.tableCellBackgroundFill = { propertyState: "NOT_RENDERED" };
  if (f["content-align"]) properties.contentAlignment = f["content-align"];
  const requests: Data[] = [];
  if (Object.keys(properties).length)
    requests.push({
      updateTableCellProperties: {
        objectId: c.positionals[1],
        tableRange: { location: cell(f), rowSpan: 1, columnSpan: 1 },
        tableCellProperties: properties,
        fields: mask(properties),
      },
    });
  const style = textStyle(f, true);
  if (Object.keys(style).length)
    requests.push({
      updateTextStyle: {
        objectId: c.positionals[1],
        cellLocation: cell(f),
        textRange: rangeText(f.range),
        style,
        fields: mask(style),
      },
    });
  return batch(c, r, requests, meta);
};
h["slides.table.border.style"] = async (c, r) => {
  const f = flags(c),
    meta = await get(c, r);
  requireTable(meta, c.positionals[1], f);
  if (f.transparent && f["border-color"])
    throw new Error("Choose border color or transparent");
  const p: Data = {};
  if (f["border-color"])
    p.tableBorderFill = {
      solidFill: { color: { rgbColor: color(f["border-color"]) }, alpha: 1 },
    };
  if (f.transparent) p.tableBorderFill = { solidFill: { alpha: 0 } };
  if (f.weight !== undefined) p.weight = pt(f.weight);
  if (f.dash) p.dashStyle = f.dash;
  if (!Object.keys(p).length) throw new Error("Border style required");
  return batch(
    c,
    r,
    [
      {
        updateTableBorderProperties: {
          objectId: c.positionals[1],
          tableRange: tableRange(f),
          borderPosition: f.position,
          tableBorderProperties: p,
          fields: mask(p),
        },
      },
    ],
    meta,
  );
};
function markdownText(tokens: Data[]): string {
  return tokens
    .map((t) =>
      t.type === "text" || t.type === "codespan"
        ? t.text
        : t.type === "image"
          ? (t.text ?? "")
          : t.type === "br"
            ? "\n"
            : t.tokens
              ? markdownText(t.tokens)
              : (t.text ?? ""),
    )
    .join("");
}
h["slides.create-from-markdown"] = async (c, r) => {
  const f = flags(c);
  if (f.content !== undefined && f["content-file"])
    throw new Error("Choose content or content-file");
  const source = f["content-file"] ? r.text(f["content-file"]) : f.content;
  if (typeof source !== "string" || !source.trim())
    throw new Error("Markdown content required");
  // Parse, validate, build all operations, and enforce strict asset handling before creating anything.
  const plan = renderSlidey(source, f);
  const created = (await h["slides.create"](
    { ...c, command: "slides.create", flags: { parent: f.parent } },
    r,
  )) as Data;
  const target = { ...c, positionals: [created.presentationId] };
  await batch(target, r, plan.requests);
  if (plan.speakerNotes.length) {
    const meta = await get(target, r),
      requests: Data[] = [];
    for (const note of plan.speakerNotes) {
      const objectId = page(meta, note.pageId).slideProperties?.notesPage
        ?.notesProperties?.speakerNotesObjectId;
      if (!objectId) throw new Error("Slide speaker notes object unavailable");
      requests.push(
        { deleteText: { objectId, textRange: { type: "ALL" } } },
        { insertText: { objectId, text: note.text, insertionIndex: 0 } },
      );
    }
    await batch(target, r, requests, meta);
  }
  return {
    presentationId: created.presentationId,
    slides: plan.slides,
    warnings: plan.warnings,
    ...(f.debug
      ? { requests: plan.requests, frontmatter: plan.frontmatter }
      : {}),
    ...(f["keep-temp-images"] ? { images: [] } : {}),
  };
};
for (const name of [
  "slides.insert-image",
  "slides.add-slide",
  "slides.replace-slide",
])
  h[name] = imageLifecycle(h[name], "slides");
export const slideHandlers = h;
