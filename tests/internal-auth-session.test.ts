import { describe, expect, it } from "vitest";
import {
  createInternalAuthHeaders,
  readInternalAuth,
} from "../src/utils/internalAuth";

const principal = {
  userId: "owner",
  organizationId: "default",
  tenantBinding: "default",
  role: "owner",
};
const secret = "test-only-session-envelope-secret";
describe("signed native session references", () => {
  it("preserves the opaque reference and detects session substitution", async () => {
    const headers = await createInternalAuthHeaders(
      { ...principal, identitySessionId: "session_123-abc" } as any,
      secret,
    );
    expect(
      await readInternalAuth(new Request("https://agent", { headers }), {
        INTERNAL_AUTH_SECRET: secret,
      }),
    ).toMatchObject({ identitySessionId: "session_123-abc" });
    headers["X-Internal-Auth"] = headers["X-Internal-Auth"].replace(
      "session_123-abc",
      "session_other",
    );
    expect(
      await readInternalAuth(new Request("https://agent", { headers }), {
        INTERNAL_AUTH_SECRET: secret,
      }),
    ).toBeNull();
  });
  it.each([null, 1, "", "x".repeat(129), "cookie=value", "session/id"])(
    "rejects malformed signed session reference %j",
    async (identitySessionId) => {
      const headers = await createInternalAuthHeaders(
        { ...principal, identitySessionId } as any,
        secret,
      );
      expect(
        await readInternalAuth(new Request("https://agent", { headers }), {
          INTERNAL_AUTH_SECRET: secret,
        }),
      ).toBeNull();
    },
  );
  it("continues accepting legacy envelopes without a native session", async () => {
    const headers = await createInternalAuthHeaders(principal, secret);
    expect(
      await readInternalAuth(new Request("https://agent", { headers }), {
        INTERNAL_AUTH_SECRET: secret,
      }),
    ).toMatchObject(principal);
  });
});
