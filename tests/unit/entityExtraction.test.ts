import { describe, it, expect } from "vitest";
import { extractEntities } from "../../src/durable-objects/assistant/entityExtraction";
import {
  resolveReasoningEffort,
  isResponseDepth,
} from "../../src/durable-objects/assistant/responseDepth";
import { isDreamIntervalHours } from "../../src/durable-objects/assistant/dreamSettings";

describe("generic reference extraction", () => {
  it("requires explicit references in returned data instead of inferring IDs or tool arguments", () => {
    const result = extractEntities(
      "get_document",
      { entity_type: "document", entity_id: "argument-id" },
      {
        arbitrary: { id: "unguessed-id", name: "Document" },
        references: [
          { entity_type: "document", entity_id: "returned-id" },
          { entity_type: "document", entity_id: "returned-id" },
        ],
      },
    );
    expect(result).toEqual([
      { entity_type: "document", entity_id: "returned-id" },
    ]);
  });
  it("handles JSON results, cycles and hostile depth with bounded work", () => {
    const cycle: any = { entity_type: "document", entity_id: "a" };
    cycle.next = cycle;
    expect(extractEntities("", {}, cycle)).toHaveLength(1);
    expect(
      extractEntities(
        "",
        {},
        JSON.stringify({ entity_type: "file", entity_id: "b" }),
      ),
    ).toHaveLength(1);
    expect(
      extractEntities(
        "",
        {},
        Array.from({ length: 2000 }, (_, i) => ({
          entity_type: "file",
          entity_id: String(i),
        })),
      ),
    ).toHaveLength(100);
    expect(
      extractEntities("", {}, { entity_type: "invalid type", entity_id: "a" }),
    ).toEqual([]);
  });
});
describe("persona settings", () => {
  it("maps only explicit response-depth values and valid opt-in dream intervals", () => {
    expect(resolveReasoningEffort("fast")).toBe("low");
    expect(resolveReasoningEffort("thorough")).toBe("high");
    for (const value of [null, "max", "default", 1]) {
      expect(resolveReasoningEffort(value)).toBeUndefined();
      expect(isResponseDepth(value)).toBe(false);
    }
    for (const value of [12, 24, 48])
      expect(isDreamIntervalHours(value)).toBe(true);
    for (const value of [null, 0, 13, "24", Infinity])
      expect(isDreamIntervalHours(value)).toBe(false);
  });
});
