import { csv, list, mapped } from "./other-helpers";
import {
  required,
  segment,
  type Command,
  type Data,
  type HandlerMap,
  type Runtime,
} from "./types";

export const classroomHandlers: HandlerMap = {};
const course = (input: Command) => `courses/${segment(input.positionals[0])}`;
const courseFields = {
  name: "name",
  owner: "ownerId",
  section: "section",
  "description-heading": "descriptionHeading",
  description: "description",
  room: "room",
  state: "courseState",
};
const commonFields = {
  title: "title",
  description: "description",
  text: "text",
  state: "state",
  scheduled: "scheduledTime",
  topic: "topicId",
  "max-points": "maxPoints",
  type: "workType",
};
async function mutate(
  runtime: Runtime,
  path: string,
  body: Data,
  create: boolean,
): Promise<Data> {
  if (!Object.keys(body).length) throw new Error("No updates specified");
  return runtime.json("classroom", path, {
    method: create ? "POST" : "PATCH",
    body,
    query: create ? {} : { updateMask: Object.keys(body).join(",") },
  });
}
function dueFields(flags: Data): Data {
  let date = flags["due-date"],
    time = flags["due-time"];
  if (flags.due) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(flags.due)) date = flags.due;
    else {
      const instant = new Date(flags.due);
      if (!Number.isFinite(instant.getTime()))
        throw new Error("Invalid due date");
      date = instant.toISOString().slice(0, 10);
      time = instant.toISOString().slice(11, 23);
    }
  }
  if (time && !date) throw new Error("Due time requires a due date");
  const result: Data = {};
  if (date) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (
      !match ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date
    )
      throw new Error("Invalid due date");
    result.dueDate = { year: +match[1], month: +match[2], day: +match[3] };
  }
  if (time) {
    const match = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/.exec(time);
    if (!match || +match[1] > 23 || +match[2] > 59 || +(match[3] ?? 0) > 59)
      throw new Error("Invalid due time");
    result.dueTime = {
      hours: +match[1],
      minutes: +match[2],
      seconds: +(match[3] ?? 0),
      nanos: +(match[4] ?? "0").padEnd(9, "0"),
    };
  }
  return result;
}
classroomHandlers["classroom.courses.list"] = (c, r) =>
  list(r, "classroom", "courses", "courses", c, {
    studentId: c.flags.student,
    teacherId: c.flags.teacher,
    courseStates: csv(c.flags.state).map((state) => state.toUpperCase()),
  });
classroomHandlers["classroom.courses.get"] = async (c, r) => ({
  course: await r.json("classroom", course(c)),
});
classroomHandlers["classroom.courses.url"] = async (c, r) => {
  const result = await r.json("classroom", course(c));
  return { id: result.id, url: result.alternateLink };
};
classroomHandlers["classroom.courses.delete"] = async (c, r) => {
  await r.json("classroom", course(c), { method: "DELETE" });
  return { deleted: true, courseId: c.positionals[0] };
};
for (const action of ["create", "update"])
  classroomHandlers[`classroom.courses.${action}`] = async (c, r) => {
    const body = mapped(c.flags, courseFields, ["state"]);
    if (action === "create") {
      required(body.name, "name");
      required(body.ownerId, "owner");
    }
    return {
      course: await mutate(
        r,
        action === "create" ? "courses" : course(c),
        body,
        action === "create",
      ),
    };
  };
for (const action of ["archive", "unarchive"])
  classroomHandlers[`classroom.courses.${action}`] = async (c, r) => ({
    course: await mutate(
      r,
      course(c),
      { courseState: action === "archive" ? "ARCHIVED" : "ACTIVE" },
      false,
    ),
  });
for (const action of ["join", "leave"])
  classroomHandlers[`classroom.courses.${action}`] = async (c, r) => {
    const role = String(c.flags.role ?? "student").toLowerCase();
    if (!["student", "teacher"].includes(role))
      throw new Error("Role must be student or teacher");
    const user = c.flags.user ?? "me",
      path = `${course(c)}/${role}s`;
    if (action === "join")
      return {
        [role]: await r.json("classroom", path, {
          method: "POST",
          body: { userId: user },
          query: { enrollmentCode: c.flags["enrollment-code"] },
        }),
      };
    await r.json("classroom", `${path}/${segment(user)}`, { method: "DELETE" });
    return { removed: true, courseId: c.positionals[0], userId: user };
  };
for (const [group, resource, responseKey, listKey] of [
  ["coursework", "courseWork", "coursework", "courseWork"],
  ["materials", "courseWorkMaterials", "material", "courseWorkMaterial"],
  ["announcements", "announcements", "announcement", "announcements"],
  ["topics", "topics", "topic", "topic"],
]) {
  const base = (c: Command) => `${course(c)}/${resource}`;
  classroomHandlers[`classroom.${group}.list`] = async (c, r) => {
    const result = await list(
      r,
      "classroom",
      base(c),
      listKey,
      c,
      {
        orderBy: c.flags["order-by"],
        ...(group === "coursework"
          ? { courseWorkStates: csv(c.flags.state).map((v) => v.toUpperCase()) }
          : group === "materials"
            ? {
                courseWorkMaterialStates: csv(c.flags.state).map((v) =>
                  v.toUpperCase(),
                ),
              }
            : group === "announcements"
              ? {
                  announcementStates: csv(c.flags.state).map((v) =>
                    v.toUpperCase(),
                  ),
                }
              : {}),
      },
      "pageSize",
      c.flags.topic ? (item) => item.topicId === c.flags.topic : undefined,
    );
    return { [group]: result[listKey], nextPageToken: result.nextPageToken };
  };
  classroomHandlers[`classroom.${group}.get`] = async (c, r) => ({
    [responseKey]: await r.json(
      "classroom",
      `${base(c)}/${segment(c.positionals[1])}`,
    ),
  });
  classroomHandlers[`classroom.${group}.delete`] = async (c, r) => {
    await r.json("classroom", `${base(c)}/${segment(c.positionals[1])}`, {
      method: "DELETE",
    });
    return { deleted: true, courseId: c.positionals[0], id: c.positionals[1] };
  };
  for (const action of ["create", "update"])
    classroomHandlers[`classroom.${group}.${action}`] = async (c, r) => {
      const body = mapped(
        c.flags,
        group === "topics" ? { name: "name" } : commonFields,
        ["state", "type"],
      );
      if (group === "coursework") Object.assign(body, dueFields(c.flags));
      if (action === "create")
        required(
          body[
            group === "topics"
              ? "name"
              : group === "announcements"
                ? "text"
                : "title"
          ],
          group === "topics"
            ? "name"
            : group === "announcements"
              ? "text"
              : "title",
        );
      return {
        [responseKey]: await mutate(
          r,
          base(c) +
            (action === "update" ? `/${segment(c.positionals[1])}` : ""),
          body,
          action === "create",
        ),
      };
    };
  if (group === "coursework" || group === "announcements")
    classroomHandlers[`classroom.${group}.assignees`] = async (c, r) => {
      const add = csv(c.flags["add-student"]),
        remove = csv(c.flags["remove-student"]);
      const mode = String(
        c.flags.mode ??
          (add.length || remove.length ? "INDIVIDUAL_STUDENTS" : ""),
      )
        .toUpperCase()
        .replaceAll("-", "_");
      if (
        !["ALL_STUDENTS", "INDIVIDUAL_STUDENTS"].includes(mode) ||
        (mode === "ALL_STUDENTS" && (add.length || remove.length))
      )
        throw new Error("Invalid assignee changes");
      return {
        [responseKey]: await r.json(
          "classroom",
          `${base(c)}/${segment(c.positionals[1])}:modifyAssignees`,
          {
            method: "POST",
            body: {
              assigneeMode: mode,
              ...(add.length || remove.length
                ? {
                    modifyIndividualStudentsOptions: {
                      addStudentIds: add,
                      removeStudentIds: remove,
                    },
                  }
                : {}),
            },
          },
        ),
      };
    };
}
for (const role of ["students", "teachers"]) {
  const base = (c: Command) => `${course(c)}/${role}`;
  classroomHandlers[`classroom.${role}.list`] = (c, r) =>
    list(r, "classroom", base(c), role, c);
  classroomHandlers[`classroom.${role}.get`] = async (c, r) => ({
    [role.slice(0, -1)]: await r.json(
      "classroom",
      `${base(c)}/${segment(c.positionals[1])}`,
    ),
  });
  classroomHandlers[`classroom.${role}.add`] = async (c, r) => ({
    [role.slice(0, -1)]: await r.json("classroom", base(c), {
      method: "POST",
      body: { userId: c.positionals[1] },
      query: { enrollmentCode: c.flags["enrollment-code"] },
    }),
  });
  classroomHandlers[`classroom.${role}.remove`] = async (c, r) => {
    await r.json("classroom", `${base(c)}/${segment(c.positionals[1])}`, {
      method: "DELETE",
    });
    return {
      removed: true,
      courseId: c.positionals[0],
      userId: c.positionals[1],
    };
  };
}
classroomHandlers["classroom.roster"] = async (c, r) => {
  const result: Data = { courseId: c.positionals[0] };
  let size = 0;
  for (const role of ["students", "teachers"])
    if (c.flags[role] || (!c.flags.students && !c.flags.teachers)) {
      const found = await list(r, "classroom", `${course(c)}/${role}`, role, {
        ...c,
        flags: { ...c.flags, "fail-empty": false },
      });
      result[role] = found[role];
      result[`${role}NextPageToken`] = found.nextPageToken;
      size += found[role].length;
    }
  if (c.flags["fail-empty"] && !size) throw new Error("No roster entries");
  return result;
};
classroomHandlers["classroom.profile.get"] = async (c, r) => ({
  profile: await r.json(
    "classroom",
    `userProfiles/${segment(c.positionals[0])}`,
  ),
});
for (const [family, resource, key] of [
  ["guardians", "guardians", "guardian"],
  ["guardian-invitations", "guardianInvitations", "invitation"],
]) {
  const base = (c: Command) =>
    `userProfiles/${segment(c.positionals[0])}/${resource}`;
  classroomHandlers[`classroom.${family}.list`] = async (c, r) => {
    const result = await list(r, "classroom", base(c), resource, c, {
      invitedEmailAddress: c.flags.email,
      states: csv(c.flags.state).map((v) => v.toUpperCase()),
    });
    return {
      [family === "guardians" ? "guardians" : "invitations"]: result[resource],
      nextPageToken: result.nextPageToken,
    };
  };
  classroomHandlers[`classroom.${family}.get`] = async (c, r) => ({
    [key]: await r.json("classroom", `${base(c)}/${segment(c.positionals[1])}`),
  });
  if (family === "guardians")
    classroomHandlers["classroom.guardians.delete"] = async (c, r) => {
      await r.json("classroom", `${base(c)}/${segment(c.positionals[1])}`, {
        method: "DELETE",
      });
      return { deleted: true };
    };
  else
    classroomHandlers["classroom.guardian-invitations.create"] = async (
      c,
      r,
    ) => ({
      invitation: await r.json("classroom", base(c), {
        method: "POST",
        body: { invitedEmailAddress: required(c.flags.email, "email") },
      }),
    });
}
classroomHandlers["classroom.invitations.list"] = (c, r) =>
  list(r, "classroom", "invitations", "invitations", c, {
    courseId: c.flags.course,
    userId: c.flags.user,
  });
classroomHandlers["classroom.invitations.get"] = async (c, r) => ({
  invitation: await r.json(
    "classroom",
    `invitations/${segment(c.positionals[0])}`,
  ),
});
classroomHandlers["classroom.invitations.create"] = async (c, r) => ({
  invitation: await r.json("classroom", "invitations", {
    method: "POST",
    body: {
      courseId: c.positionals[0],
      userId: c.positionals[1],
      role: String(c.flags.role ?? "STUDENT").toUpperCase(),
    },
  }),
});
classroomHandlers["classroom.invitations.accept"] = async (c, r) => {
  await r.json("classroom", `invitations/${segment(c.positionals[0])}:accept`, {
    method: "POST",
    body: {},
  });
  return { accepted: true };
};
classroomHandlers["classroom.invitations.delete"] = async (c, r) => {
  await r.json("classroom", `invitations/${segment(c.positionals[0])}`, {
    method: "DELETE",
  });
  return { deleted: true };
};
const submissions = (c: Command) =>
  `${course(c)}/courseWork/${segment(c.positionals[1])}/studentSubmissions`;
classroomHandlers["classroom.submissions.list"] = (c, r) =>
  list(r, "classroom", submissions(c), "studentSubmissions", c, {
    userId: c.flags.user,
    states: csv(c.flags.state).map((v) => v.toUpperCase()),
    late: c.flags.late
      ? (({ late: "LATE_ONLY", "not-late": "NOT_LATE_ONLY" } as Data)[
          c.flags.late
        ] ?? String(c.flags.late).toUpperCase())
      : undefined,
  });
classroomHandlers["classroom.submissions.get"] = async (c, r) => ({
  submission: await r.json(
    "classroom",
    `${submissions(c)}/${segment(c.positionals[2])}`,
  ),
});
classroomHandlers["classroom.submissions.grade"] = async (c, r) => {
  const body = mapped(c.flags, {
    draft: "draftGrade",
    assigned: "assignedGrade",
  });
  for (const key of Object.keys(body)) {
    body[key] = Number(body[key]);
    if (!Number.isFinite(body[key])) throw new Error("Invalid grade");
  }
  return {
    submission: await mutate(
      r,
      `${submissions(c)}/${segment(c.positionals[2])}`,
      body,
      false,
    ),
  };
};
for (const [action, suffix] of [
  ["reclaim", "reclaim"],
  ["return", "return"],
  ["turn-in", "turnIn"],
])
  classroomHandlers[`classroom.submissions.${action}`] = async (c, r) => {
    await r.json(
      "classroom",
      `${submissions(c)}/${segment(c.positionals[2])}:${suffix}`,
      { method: "POST", body: {} },
    );
    return {
      [action]: true,
      courseId: c.positionals[0],
      courseworkId: c.positionals[1],
      submissionId: c.positionals[2],
    };
  };
