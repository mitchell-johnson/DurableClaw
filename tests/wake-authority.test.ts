import { expect, it, vi } from "vitest";
import { createObservers } from "../src/services/proactive/observers";
it("denied authority cannot read events or advance observer cursors", async () => {
  const prepare = vi.fn();
  const writeCursor = vi.fn();
  const readCursor = vi.fn();
  await expect(
    createObservers()[0].observe({
      db: { prepare },
      securedDb: { prepare },
      user: {
        id: "owner",
        role: "none",
        permissions: [
          {
            user_id: "owner",
            resource_type: "workspace",
            permission_type: "none",
          },
        ],
      },
      workspaceId: "default",
      readCursor,
      writeCursor,
      nowMs: 0,
    }),
  ).rejects.toThrow("permission");
  expect(prepare).not.toHaveBeenCalled();
  expect(readCursor).not.toHaveBeenCalled();
  expect(writeCursor).not.toHaveBeenCalled();
});
