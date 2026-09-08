import { describe, expect, it } from "vitest";
import {
  createInternalAuthHeaders,
  readInternalAuth,
  validateInternalAuth,
} from "../src/utils/internalAuth";
const owner = {
  userId: "user",
  organizationId: "workspace",
  tenantBinding: "workspace",
  role: "member",
};
const secret = "unit-test-only-secret";
const sign = async (value: unknown) => {
  const payload = JSON.stringify(value);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(payload)),
  );
  return validateInternalAuth(
    payload,
    Array.from(signature, (b) => b.toString(16).padStart(2, "0")).join(""),
    secret,
  );
};
describe("signed internal principal envelopes", () => {
  it("accepts freshly signed owner context and rejects tampering and wrong secrets", async () => {
    const headers = await createInternalAuthHeaders(owner, secret);
    const request = new Request("https://service.test", { headers });
    expect(
      await readInternalAuth(request, { INTERNAL_AUTH_SECRET: secret }),
    ).toMatchObject(owner);
    expect(
      await readInternalAuth(request, { INTERNAL_AUTH_SECRET: "wrong" }),
    ).toBeNull();
    headers["X-Internal-Auth"] = headers["X-Internal-Auth"].replace(
      "member",
      "admin",
    );
    expect(
      await readInternalAuth(new Request("https://service.test", { headers }), {
        INTERNAL_AUTH_SECRET: secret,
      }),
    ).toBeNull();
  });
  it.each([
    undefined,
    null,
    "now",
    {},
    Date.now() - 301_000,
    Date.now() + 31_000,
  ])("rejects invalid/stale timestamps even when signed: %j", async (ts) => {
    expect(await sign({ ...owner, ts })).toBeNull();
  });
  it.each([
    null,
    {},
    { ...owner, userId: 123 },
    { ...owner, tenantBinding: "" },
  ])(
    "rejects malformed principal fields even when signed: %j",
    async (fields) => {
      expect(await sign({ ...fields, ts: Date.now() })).toBeNull();
    },
  );
  it("fails closed when a signing secret is unavailable", async () => {
    await expect(createInternalAuthHeaders(owner, "")).rejects.toThrow(
      "required",
    );
    expect(
      await readInternalAuth(new Request("https://service.test"), {}),
    ).toBeNull();
  });
});
