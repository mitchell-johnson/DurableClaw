import { expect, it } from "vitest";
import { fitVectorMetadata } from "../src/utils/vectorMetadata";
it("bounds UTF-8 and escaped JSON bytes while retaining identity and original inventory input", () => {
  const input = {
    user_namespace: "scope",
    path: "notes.md",
    text: '😀"'.repeat(5000),
  };
  const bounded = fitVectorMetadata(input);
  expect(
    new TextEncoder().encode(JSON.stringify(bounded)).byteLength,
  ).toBeLessThanOrEqual(9000);
  expect(bounded.user_namespace).toBe("scope");
  expect(bounded.path).toBe("notes.md");
  expect(input.text).toHaveLength(15000);
  expect(JSON.stringify(bounded)).not.toContain("\\ud83d");
});
it("keeps oversized provenance in the full inventory rather than sending invalid vector metadata", () => {
  const input = {
    user_namespace: "scope",
    extra_json: JSON.stringify({ sources: "x".repeat(20000) }),
  };
  expect(fitVectorMetadata(input)).toEqual({ user_namespace: "scope" });
  expect(input.extra_json.length).toBeGreaterThan(20000);
});
