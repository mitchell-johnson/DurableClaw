import { describe, expect, it, vi } from "vitest";
import { administrationHandlers } from "../../services/connectors/vendor/gogcli/administration";
import { classroomHandlers } from "../../services/connectors/vendor/gogcli/classroom";
import {
  commands,
  parseCommand,
} from "../../services/connectors/vendor/gogcli/catalog";
import { NativeRuntime } from "../../services/connectors/vendor/gogcli/runtime";
import type { Data } from "../../services/connectors/vendor/gogcli/types";

function fixture(responses: unknown[] = []) {
  const fetcher = vi.fn(async (_request: Request) =>
    Response.json(responses.shift() ?? {}),
  );
  const handlers = { ...administrationHandlers, ...classroomHandlers };
  const run = async (
    command: string,
    positionals: string[] = [],
    flags: Data = {},
  ) => {
    const input = parseCommand({ command, positionals, flags });
    return handlers[command](
      input,
      new NativeRuntime(input, {
        accessToken: "test-access-secret",
        account: "owner@example.com",
        fetch: fetcher,
      }),
    );
  };
  return { fetcher, run };
}
describe("Classroom, Admin, Groups and Keep native commands", () => {
  it("covers all 81 upstream command leaves exactly", () => {
    const expected = commands
      .filter((command) =>
        ["admin", "groups", "keep", "classroom"].includes(command.service),
      )
      .map((command) => command.command)
      .sort();
    expect(
      Object.keys({ ...administrationHandlers, ...classroomHandlers }).sort(),
    ).toEqual(expected);
    expect(expected).toHaveLength(81);
  });
  it("creates coursework with UTC due fields and uses update masks preserving a zero grade", async () => {
    const h = fixture([{ id: "work" }, { assignedGrade: 0 }]);
    await h.run("classroom.coursework.create", ["course"], {
      title: "Assignment",
      due: "2026-09-10T00:30:00+12:00",
      "max-points": 0,
    });
    const create = h.fetcher.mock.calls[0][0];
    expect(create.url).toBe(
      "https://classroom.googleapis.com/v1/courses/course/courseWork",
    );
    expect(create.method).toBe("POST");
    expect(await create.json()).toMatchObject({
      title: "Assignment",
      workType: "ASSIGNMENT",
      maxPoints: 0,
      dueDate: { year: 2026, month: 9, day: 9 },
      dueTime: { hours: 12, minutes: 30 },
    });
    await h.run(
      "classroom.submissions.grade",
      ["course", "work", "submission"],
      { assigned: "0" },
    );
    const update = h.fetcher.mock.calls[1][0];
    expect(new URL(update.url).searchParams.get("updateMask")).toBe(
      "assignedGrade",
    );
    expect(await update.json()).toEqual({ assignedGrade: 0 });
  });
  it("validates invalid dates and empty changes before any mutation", async () => {
    const h = fixture();
    for (const flags of [
      { title: "Assignment", "due-date": "2026-02-30" },
      { title: "Assignment", "due-time": "12:00" },
    ])
      await expect(
        h.run("classroom.coursework.create", ["course"], flags),
      ).rejects.toThrow();
    await expect(
      h.run("classroom.submissions.grade", ["course", "work", "submission"]),
    ).rejects.toThrow();
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it("paginates coursework with stable output keys and provider continuation", async () => {
    const h = fixture([
      { courseWork: [{ id: "first" }], nextPageToken: "next" },
      { courseWork: [{ id: "second" }] },
    ]);
    expect(
      await h.run("classroom.coursework.list", ["course"], {
        all: true,
        max: 1,
        state: "published",
      }),
    ).toEqual({
      coursework: [{ id: "first" }, { id: "second" }],
      nextPageToken: "",
    });
    expect(
      new URL(h.fetcher.mock.calls[1][0].url).searchParams.get("pageToken"),
    ).toBe("next");
    expect(
      new URL(h.fetcher.mock.calls[0][0].url).searchParams.get(
        "courseWorkStates",
      ),
    ).toBe("PUBLISHED");
  });
  it("applies topic filtering across bounded pages and returns a usable cursor", async () => {
    const h = fixture([
      {
        courseWorkMaterial: [{ id: "x", topicId: "other" }],
        nextPageToken: "p2",
      },
      {
        courseWorkMaterial: [{ id: "match", topicId: "wanted" }],
        nextPageToken: "p3",
      },
    ]);
    expect(
      await h.run("classroom.materials.list", ["c"], {
        topic: "wanted",
        max: 1,
        "scan-pages": 2,
      }),
    ).toEqual({
      materials: [{ id: "match", topicId: "wanted" }],
      nextPageToken: "p3",
    });
  });
  it("modifies exact individual assignees and rejects contradictory changes", async () => {
    const h = fixture();
    await h.run("classroom.coursework.assignees", ["c", "w"], {
      "add-student": ["a", "b"],
      "remove-student": ["d"],
    });
    expect(h.fetcher.mock.calls[0][0].url).toContain(
      "/courseWork/w:modifyAssignees",
    );
    expect(await h.fetcher.mock.calls[0][0].json()).toEqual({
      assigneeMode: "INDIVIDUAL_STUDENTS",
      modifyIndividualStudentsOptions: {
        addStudentIds: ["a", "b"],
        removeStudentIds: ["d"],
      },
    });
    await expect(
      h.run("classroom.coursework.assignees", ["c", "w"], {
        mode: "ALL_STUDENTS",
        "add-student": ["a"],
      }),
    ).rejects.toThrow();
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });
  it("keeps roster roles separate and guardian list aliases compatible", async () => {
    const h = fixture([
      { students: [], nextPageToken: "students-page" },
      { teachers: [{ userId: "t" }] },
      { guardianInvitations: [{ invitationId: "i" }] },
    ]);
    expect(
      await h.run("classroom.roster", ["c"], { "fail-empty": true }),
    ).toEqual({
      courseId: "c",
      students: [],
      studentsNextPageToken: "students-page",
      teachers: [{ userId: "t" }],
      teachersNextPageToken: "",
    });
    expect(
      await h.run("classroom.guardian-invitations.list", ["s"], {
        email: "guardian@example.com",
      }),
    ).toEqual({ invitations: [{ invitationId: "i" }], nextPageToken: "" });
  });
  it.each(["return", "reclaim", "turn-in"])(
    "dispatches submission action %s once",
    async (action) => {
      const h = fixture();
      await h.run(`classroom.submissions.${action}`, ["c", "w", "s"]);
      const request = h.fetcher.mock.calls[0][0];
      expect(request.method).toBe("POST");
      expect(request.url).toContain(
        `studentSubmissions/s:${action === "turn-in" ? "turnIn" : action}`,
      );
      expect(h.fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("creates an Admin user with generated password and a separate state patch", async () => {
    const h = fixture([
      { primaryEmail: "new@example.com", id: "new" },
      { primaryEmail: "new@example.com", id: "new", suspended: true },
    ]);
    const result = (await h.run("admin.users.create", ["new@example.com"], {
      given: "New",
      family: "User",
      suspended: true,
    })) as Data;
    expect(result.generatedPassword.length).toBeGreaterThanOrEqual(16);
    const first = (await h.fetcher.mock.calls[0][0].json()) as Data;
    expect(first.name).toEqual({ givenName: "New", familyName: "User" });
    expect(first.changePasswordAtNextLogin).toBe(true);
    expect(first.password).toBe(result.generatedPassword);
    expect(h.fetcher.mock.calls[1][0].method).toBe("PATCH");
    await expect(
      h.run("admin.users.create", ["new@example.com"], {
        given: "New",
        family: "User",
        admin: true,
      }),
    ).rejects.toThrow();
    expect(h.fetcher).toHaveBeenCalledTimes(2);
  });
  it("updates nested orgunits and preserves explicit empty descriptions", async () => {
    const h = fixture();
    await h.run("admin.orgunits.update", ["/Engineering/Platform"], {
      description: "",
    });
    const request = h.fetcher.mock.calls[0][0];
    expect(request.method).toBe("PUT");
    expect(request.url).toBe(
      "https://admin.googleapis.com/admin/directory/v1/customer/my_customer/orgunits/Engineering/Platform",
    );
    expect(await request.json()).toEqual({ description: "" });
  });
  it("looks up a group before listing memberships with role precedence", async () => {
    const h = fixture([
      { name: "groups/g" },
      {
        memberships: [
          {
            preferredMemberKey: { id: "member@example.com" },
            roles: [{ name: "MEMBER" }, { name: "OWNER" }],
            type: "USER",
          },
        ],
      },
    ]);
    expect(await h.run("groups.members", ["group@example.com"])).toEqual({
      members: [{ email: "member@example.com", role: "OWNER", type: "USER" }],
      nextPageToken: "",
    });
    expect(
      new URL(h.fetcher.mock.calls[0][0].url).searchParams.get("groupKey.id"),
    ).toBe("group@example.com");
    expect(h.fetcher.mock.calls[1][0].url).toContain("/groups/g/memberships");
  });
  it("builds Keep checklists and searches title/text across pages", async () => {
    const h = fixture([
      { name: "notes/n" },
      { notes: [{ title: "Find Me" }], nextPageToken: "p" },
      {
        notes: [
          { body: { text: { text: "find again" } } },
          { title: "unrelated" },
        ],
      },
    ]);
    await h.run("keep.create", [], {
      title: "Checklist",
      item: ["one", "two"],
    });
    expect(await h.fetcher.mock.calls[0][0].json()).toEqual({
      title: "Checklist",
      body: {
        list: {
          listItems: [{ text: { text: "one" } }, { text: { text: "two" } }],
        },
      },
    });
    const result = (await h.run("keep.search", ["find"])) as Data;
    expect(result.count).toBe(2);
    expect(h.fetcher).toHaveBeenCalledTimes(3);
    await expect(
      h.run("keep.create", [], { text: "both", item: ["one"] }),
    ).rejects.toThrow();
  });
});
