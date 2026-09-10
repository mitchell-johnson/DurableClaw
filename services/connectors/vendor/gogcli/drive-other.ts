// Semantic port of gogcli forms, Meet, Apps Script and Photos commands.
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
  safeName,
} from "./drive-helpers";

const formPath = (c: Command) => `forms/${segment(pos(c))}`;
const formEdit = (value: string) =>
  `https://docs.google.com/forms/d/${segment(value)}/edit`;
const formBatch = (
  r: Runtime,
  path: string,
  requests: Data[],
  includeFormInResponse = true,
) =>
  r.json("forms", path + ":batchUpdate", {
    method: "POST",
    body: { requests, includeFormInResponse },
  });
const addQuestion: Handler = async (c, r) => {
  const f = c.flags;
  const title = required(f.title, "--title").trim();
  const type = enumValue(
    f.type,
    [
      "text",
      "paragraph",
      "radio",
      "checkbox",
      "dropdown",
      "scale",
      "date",
      "time",
    ],
    "text",
  );
  const question: Data = { required: Boolean(f.required) };
  switch (type) {
    case "text":
    case "paragraph":
      question.textQuestion = { paragraph: type === "paragraph" };
      break;
    case "radio":
    case "checkbox":
    case "dropdown": {
      const options = list(f.option);
      if (!options.length) throw new Error("Choice questions require --option");
      question.choiceQuestion = {
        type: { radio: "RADIO", checkbox: "CHECKBOX", dropdown: "DROP_DOWN" }[
          type
        ],
        options: options.map((value) => ({ value })),
      };
      break;
    }
    case "scale":
      question.scaleQuestion = {
        low: integer(f["scale-low"], 1, 0, 1),
        high: integer(f["scale-high"], 5, 2, 10),
        lowLabel: f["scale-low-label"] ?? "",
        highLabel: f["scale-high-label"] ?? "",
      };
      break;
    case "date":
      question.dateQuestion = {
        includeTime: Boolean(f["include-time"]),
        includeYear: Boolean(f["include-year"]),
      };
      break;
    case "time":
      question.timeQuestion = { duration: Boolean(f.duration) };
      break;
  }
  const correct = list(f.correct)
    .map((s) => s.trim())
    .filter(Boolean);
  const points = integer(f.points, 0);
  if (correct.length || points) {
    if (
      !correct.length ||
      !points ||
      !["text", "radio", "checkbox", "dropdown"].includes(type)
    )
      throw new Error(
        "Quiz grading needs --correct and positive --points on a text or choice question",
      );
    question.grading = {
      pointValue: points,
      correctAnswers: { answers: correct.map((value) => ({ value })) },
    };
  }
  let index = integer(f.index, -1, -1);
  if (index === -1)
    index = ((await r.json("forms", formPath(c))).items ?? []).length;
  const response = await formBatch(r, formPath(c), [
    {
      createItem: {
        item: {
          title,
          description: f.description ?? "",
          questionItem: { question },
        },
        location: { index },
      },
    },
  ]);
  return {
    created: true,
    form_id: pos(c),
    title,
    type,
    index,
    form: response.form,
    edit_url: formEdit(pos(c)),
  };
};
const deleteQuestion: Handler = async (c, r) => {
  const index = integer(pos(c, 1), 0);
  const form = await r.json("forms", formPath(c));
  if (index >= (form.items ?? []).length)
    throw new Error("Question index is out of range");
  await formBatch(
    r,
    formPath(c),
    [{ deleteItem: { location: { index } } }],
    false,
  );
  return { deleted: true, form_id: pos(c), index };
};
const moveQuestion: Handler = async (c, r) => {
  const oldIndex = integer(pos(c, 1), 0),
    newIndex = integer(pos(c, 2), 0);
  await formBatch(
    r,
    formPath(c),
    [
      {
        moveItem: {
          originalLocation: { index: oldIndex },
          newLocation: { index: newIndex },
        },
      },
    ],
    false,
  );
  return {
    moved: true,
    form_id: pos(c),
    old_index: oldIndex,
    new_index: newIndex,
  };
};
const getForm: Handler = async (c, r) => ({
  form: await r.json("forms", formPath(c)),
  edit_url: formEdit(pos(c)),
});

async function meetSpace(c: Command, r: Runtime): Promise<Data> {
  const input = required(c.positionals[0], "meeting code")
    .replace(/^https:\/\/meet\.google\.com\//, "")
    .split("?")[0];
  return r.json("meet", resource(input, "spaces"));
}
const access = (value: unknown, fallback: string) =>
  enumValue(
    String(value ?? fallback).toUpperCase(),
    ["OPEN", "TRUSTED", "RESTRICTED"],
    fallback.toUpperCase(),
  );
async function photoDownload(
  c: Command,
  r: Runtime,
  picker: boolean,
): Promise<unknown> {
  let media: Data;
  if (picker) {
    const response = await paged(
      r,
      "photospicker",
      "mediaItems",
      "mediaItems",
      { ...c, flags: { all: true, max: 100 } },
      { query: { sessionId: pos(c) } },
    );
    media = response.mediaItems.find((item: Data) => item.id === pos(c, 1));
    if (!media) throw new Error("Media item is not in this picker session");
  } else media = await r.json("photos", `mediaItems/${segment(pos(c))}`);
  const video = picker ? media.type === "VIDEO" : Boolean(c.flags.video);
  const state = picker
    ? media.mediaFile?.mediaFileMetadata?.videoMetadata?.processingStatus
    : media.mediaMetadata?.video?.status;
  if (video && state && state !== "READY")
    throw new Error("Video is not ready");
  const base = required(
    picker ? media.mediaFile?.baseUrl : media.baseUrl,
    "media base URL",
  );
  const result = await r.externalBytes(
    base + (video ? "=dv" : "=d"),
    picker ? "photos-picker" : undefined,
  );
  const artifact = r.output(
    r.outputName(
      c,
      `artifacts/${safeName(picker ? media.mediaFile?.filename : media.filename, "media")}`,
    ),
    result.bytes,
  );
  return {
    mediaItemId: media.id,
    ...(picker ? { sessionId: pos(c) } : {}),
    path: artifact.name,
    bytes: artifact.bytes,
  };
}

export const driveOtherHandlers: HandlerMap = {
  "forms.get": getForm,
  "forms.raw": async (c, r) => r.json("forms", formPath(c)),
  "forms.create": async (c, r) => {
    let form = await r.json("forms", "forms", {
      method: "POST",
      body: { info: { title: required(c.flags.title, "--title") } },
    });
    if (c.flags.description) {
      const response = await formBatch(r, `forms/${segment(form.formId)}`, [
        {
          updateFormInfo: {
            info: { description: c.flags.description },
            updateMask: "description",
          },
        },
      ]);
      form = response.form ?? {
        ...form,
        info: { ...form.info, description: c.flags.description },
      };
    }
    return { created: true, form, edit_url: formEdit(form.formId) };
  },
  "forms.update": async (c, r) => {
    const requests: Data[] = [];
    const info: Data = {};
    for (const field of ["title", "description"])
      if (c.flags[field]) info[field] = String(c.flags[field]).trim();
    if (Object.keys(info).length)
      requests.push({
        updateFormInfo: { info, updateMask: Object.keys(info).join(",") },
      });
    if (c.flags.quiz !== undefined) {
      const isQuiz =
        enumValue(String(c.flags.quiz), ["true", "false"], "false") === "true";
      requests.push({
        updateSettings: {
          settings: { quizSettings: { isQuiz } },
          updateMask: "quizSettings.isQuiz",
        },
      });
    }
    if (!requests.length)
      throw new Error("Set --title, --description or --quiz");
    const response = await formBatch(r, formPath(c), requests);
    return {
      updated: true,
      form_id: pos(c),
      form: response.form,
      edit_url: formEdit(pos(c)),
    };
  },
  "forms.add-question": addQuestion,
  "forms.questions.add": addQuestion,
  "forms.delete-question": deleteQuestion,
  "forms.questions.delete": deleteQuestion,
  "forms.move-question": moveQuestion,
  "forms.questions.move": moveQuestion,
  "forms.publish": async (c, r) => {
    const published = !c.flags.unpublish;
    const accepting = published && c.flags["accepting-responses"] !== false;
    const response = await r.json(
      "forms",
      formPath(c) + ":setPublishSettings",
      {
        method: "POST",
        body: {
          updateMask: "publish_state",
          publishSettings: {
            publishState: {
              isPublished: published,
              isAcceptingResponses: accepting,
            },
          },
        },
      },
    );
    const form = await r.json("forms", formPath(c));
    return {
      form_id: pos(c),
      published,
      accepting_responses: accepting,
      publish_settings: response.publishSettings,
      form,
      edit_url: formEdit(pos(c)),
      responder_url: form.responderUri,
    };
  },
  "forms.responses.list": (c, r) =>
    paged(
      r,
      "forms",
      formPath(c) + "/responses",
      "responses",
      c,
      { query: { filter: c.flags.filter } },
      20,
    ),
  "forms.responses.get": async (c, r) => ({
    response: await r.json(
      "forms",
      `${formPath(c)}/responses/${segment(pos(c, 1))}`,
    ),
  }),
  "forms.watch.create": async (c, r) => ({
    watch: await r.json("forms", formPath(c) + "/watches", {
      method: "POST",
      body: {
        watch: {
          target: { topic: { topicName: required(c.flags.topic, "--topic") } },
          eventType: enumValue(
            c.flags["event-type"],
            ["RESPONSES", "SCHEMA"],
            "RESPONSES",
          ),
        },
      },
    }),
  }),
  "forms.watch.list": (c, r) => r.json("forms", formPath(c) + "/watches"),
  "forms.watch.delete": async (c, r) => {
    await r.json("forms", `${formPath(c)}/watches/${segment(pos(c, 1))}`, {
      method: "DELETE",
    });
    return { deleted: true, watch_id: pos(c, 1) };
  },
  "forms.watch.renew": async (c, r) => ({
    watch: await r.json(
      "forms",
      `${formPath(c)}/watches/${segment(pos(c, 1))}:renew`,
      { method: "POST", body: {} },
    ),
  }),

  "meet.create": async (c, r) => ({
    space: await r.json("meet", "spaces", {
      method: "POST",
      body: { config: { accessType: access(c.flags.access, "trusted") } },
    }),
  }),
  "meet.get": async (c, r) => ({ space: await meetSpace(c, r) }),
  "meet.update": async (c, r) => {
    const type = access(required(c.flags.access, "--access"), "trusted");
    const space = await meetSpace(c, r);
    return {
      space: await r.json("meet", resource(space.name, "spaces"), {
        method: "PATCH",
        query: { updateMask: "config.access_type" },
        body: { name: space.name, config: { accessType: type } },
      }),
    };
  },
  "meet.end": async (c, r) => {
    const space = await meetSpace(c, r);
    await r.json(
      "meet",
      resource(space.name, "spaces") + ":endActiveConference",
      { method: "POST", body: {} },
    );
    return { ended: true, space: space.name };
  },
  "meet.history": async (c, r) => {
    const space = await meetSpace(c, r);
    return paged(
      r,
      "meet",
      "conferenceRecords",
      "conferenceRecords",
      c,
      { query: { filter: `space.name = ${JSON.stringify(space.name)}` } },
      20,
    );
  },
  "meet.participants": async (c, r) => {
    const space = await meetSpace(c, r);
    let conference = c.flags.conference
      ? resource(c.flags.conference, "conferenceRecords")
      : space.activeConference?.conferenceRecord;
    if (!conference) {
      const records = await r.json("meet", "conferenceRecords", {
        query: {
          filter: `space.name = ${JSON.stringify(space.name)}`,
          pageSize: 1,
        },
      });
      conference = records.conferenceRecords?.[0]?.name;
    }
    if (!conference) {
      if (c.flags["fail-empty"]) throw new Error("No conference found");
      return { participants: [], nextPageToken: "" };
    }
    return paged(
      r,
      "meet",
      resource(conference, "conferenceRecords") + "/participants",
      "participants",
      c,
      {},
      50,
    );
  },

  "appscript.get": async (c, r) => ({
    project: await r.json("appscript", `projects/${segment(pos(c))}`),
    editor_url: `https://script.google.com/d/${segment(pos(c))}/edit`,
  }),
  "appscript.content": async (c, r) => ({
    content: await r.json("appscript", `projects/${segment(pos(c))}/content`),
  }),
  "appscript.create": async (c, r) => {
    const project = await r.json("appscript", "projects", {
      method: "POST",
      body: {
        title: required(c.flags.title, "--title"),
        ...(c.flags["parent-id"] ? { parentId: id(c.flags["parent-id"]) } : {}),
      },
    });
    return {
      created: true,
      project,
      editor_url: `https://script.google.com/d/${segment(project.scriptId)}/edit`,
    };
  },
  "appscript.run": async (c, r) => {
    const parameters = r.jsonInput(c.flags.params ?? "[]");
    if (!Array.isArray(parameters))
      throw new Error("--params must be a JSON array");
    return {
      operation: await r.json("appscript", `scripts/${segment(pos(c))}:run`, {
        method: "POST",
        body: {
          function: required(c.positionals[1], "function"),
          parameters,
          devMode: Boolean(c.flags["dev-mode"]),
        },
      }),
    };
  },
  "appscript.deployments": (c, r) =>
    paged(
      r,
      "appscript",
      `projects/${segment(pos(c))}/deployments`,
      "deployments",
      c,
    ),
  "appscript.versions": (c, r) =>
    paged(
      r,
      "appscript",
      `projects/${segment(pos(c))}/versions`,
      "versions",
      c,
    ),
  "appscript.pull": async (c, r) => {
    const directory = required(c.positionals[1], "output directory").replace(
      /^output:/,
      "",
    );
    const content = await r.json(
      "appscript",
      `projects/${segment(pos(c))}/content`,
    );
    const seen = new Set<string>();
    const files = (content.files ?? []).map((file: Data) => {
      const ext =
        ({ SERVER_JS: ".gs", HTML: ".html", JSON: ".json" } as Data)[
          file.type
        ] ?? "";
      const name = safeName(String(file.name) + ext);
      if (seen.has(name.toLowerCase()))
        throw new Error("Apps Script output filenames collide");
      seen.add(name.toLowerCase());
      return {
        name: `${directory}/${name}`,
        source: String(file.source ?? ""),
      };
    });
    return {
      pulled: true,
      dir: directory,
      files: files.map((file: Data) => r.output(file.name, file.source)),
    };
  },

  "photos.list": (c, r) =>
    paged(r, "photos", "mediaItems", "mediaItems", c, {}, 25),
  "photos.get": async (c, r) => ({
    mediaItem: await r.json("photos", `mediaItems/${segment(pos(c))}`),
  }),
  "photos.download": (c, r) => photoDownload(c, r, false),
  "photos.search": async (c, r) => {
    const f = c.flags;
    const filters: Data = {};
    if (f["include-archived"]) filters.includeArchivedMedia = true;
    const mediaType = enumValue(
      f["media-type"],
      ["ALL_MEDIA", "PHOTO", "VIDEO"],
      "ALL_MEDIA",
    );
    if (mediaType !== "ALL_MEDIA")
      filters.mediaTypeFilter = { mediaTypes: [mediaType] };
    if (f.from || f.to)
      filters.dateFilter = {
        ranges: [
          {
            ...(f.from ? { startDate: date(f.from) } : {}),
            ...(f.to ? { endDate: date(f.to) } : {}),
          },
        ],
      };
    if (f.album && Object.keys(filters).length)
      throw new Error(
        "Google Photos album search cannot be combined with filters",
      );
    return r.json("photos", "mediaItems:search", {
      method: "POST",
      body: {
        pageSize: integer(f.max, 25, 1, 100),
        ...(f.page ? { pageToken: f.page } : {}),
        ...(f.album ? { albumId: f.album } : {}),
        orderBy: `MediaMetadata.creation_time${enumValue(f.order, ["asc", "desc"], "desc") === "desc" ? " desc" : ""}`,
        ...(Object.keys(filters).length ? { filters } : {}),
      },
    });
  },
  "photos.picker.create": async (c, r) => ({
    session: await r.json("photospicker", "sessions", {
      method: "POST",
      body: integer(c.flags["max-items"], 0, 0, 2000)
        ? { pickingConfig: { maxItemCount: String(c.flags["max-items"]) } }
        : {},
    }),
  }),
  "photos.picker.get": async (c, r) => ({
    session: await r.json("photospicker", `sessions/${segment(pos(c))}`),
  }),
  "photos.picker.delete": async (c, r) => {
    await r.json("photospicker", `sessions/${segment(pos(c))}`, {
      method: "DELETE",
    });
    return { deleted: true, sessionId: pos(c) };
  },
  "photos.picker.list": (c, r) =>
    paged(
      r,
      "photospicker",
      "mediaItems",
      "mediaItems",
      c,
      { query: { sessionId: pos(c) } },
      50,
    ),
  "photos.picker.download": (c, r) => photoDownload(c, r, true),
  "photos.picker.wait": async (c, r) => {
    const timeout = duration(c.flags.timeout, 0);
    const session = await r.json("photospicker", `sessions/${segment(pos(c))}`);
    return {
      session,
      ready: Boolean(session.mediaItemsSet),
      ...(session.mediaItemsSet
        ? {}
        : {
            continuation: {
              command: "photos.picker.wait",
              positionals: [pos(c)],
              poll_after_ms: duration(
                session.pollingConfig?.pollInterval,
                5000,
              ),
              timeout_ms:
                timeout || duration(session.pollingConfig?.timeoutIn, 300000),
            },
            note: "Cloud execution performs one poll. Resume after the provider interval; no background wait was started.",
          }),
    };
  },
};
