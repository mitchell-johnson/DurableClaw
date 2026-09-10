import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { CodeRunner } from "../../src/services/code/CodeRunner";

const loader = (env as any).CODE_LOADER as WorkerLoader;
describe("isolated code execution on workerd", () => {
  it("executes agent-written modules and returns data and console output", async () => {
    const result = await new CodeRunner(loader).run(
      `export default async input => { console.log("rows", input.length); return input.reduce((a,b) => a+b,0); }`,
      "[1,2,3]",
    );
    expect(result.output).toEqual({
      result: 6,
      logs: [{ level: "log", text: "rows 3" }],
      logs_truncated: false,
    });
  });
  it("blocks network and exposes no parent credentials or storage", async () => {
    const result = await new CodeRunner(loader).run(
      `import { env } from "cloudflare:workers"; export default async () => { let blocked=false; try { await fetch("https://example.com"); } catch { blocked=true; } return { blocked, bindings: Object.keys(env) }; }`,
    );
    expect((result.output as any).result).toEqual({
      blocked: true,
      bindings: [],
    });
  });
  it("creates fresh state for every invocation", async () => {
    const runner = new CodeRunner(loader);
    const code = "let count=0; export default () => ++count;";
    for (let i = 0; i < 2; i++)
      expect((await runner.run(code)).output).toMatchObject({ result: 1 });
  });
  it("returns script errors and rejects oversized results", async () => {
    expect(
      (
        await new CodeRunner(loader).run(
          'export default () => { throw new Error("bad data"); }',
        )
      ).output,
    ).toMatchObject({ error: "Error: bad data" });
    expect(
      (
        await new CodeRunner(loader).run(
          'export default () => "x".repeat(25000)',
        )
      ).output,
    ).toMatchObject({ error: expect.stringContaining("24000") });
  });
  it("bounds console output including module initialization logs", async () => {
    const result = await new CodeRunner(loader).run(
      'console.log("loaded"); export default () => { for(let i=0;i<100;i++)console.log("x".repeat(1000)); return null; }',
    );
    const output = result.output as any;
    expect(output.logs[0].text).toBe("loaded");
    expect(output.logs_truncated).toBe(true);
    expect(
      output.logs.reduce((n: number, l: any) => n + l.text.length, 0),
    ).toBeLessThanOrEqual(8000);
  });
  it("registers the foreground tool but excludes research agents", async () => {
    const ns = (env as any).NANO_CHAT_AGENT;
    const stub = ns.get(ns.idFromName(crypto.randomUUID()));
    await runInDurableObject(stub, async (agent: any) => {
      agent.context = { user_id: "owner", tenant_binding: "default" };
      expect((await agent.ensureTools("code-test")).execute_code).toBeDefined();
      expect(agent.allowedResearchToolIds()).not.toContain("execute_code");
    });
  });
});
