/**
 * NanoChatAgent - The core Durable Object for DurableClaw.
 *
 * A minimal AI agent running at the edge, extending AIChatAgent from
 * the Cloudflare Agents SDK. Each instance manages its own SQLite-backed
 * conversation state, group memory, execution log, and R2 workspace.
 */

import { AIChatAgent } from "agents/ai-chat-agent";
import type { OnChatMessageOptions } from "@cloudflare/ai-chat";
import { getSchedulePrompt } from "agents/schedule";
import {
  streamText,
  convertToModelMessages,
  tool,
  stepCountIs,
  type StreamTextOnFinishCallback,
  type ToolSet,
} from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

import type { Env } from "../env";
import { initSchema } from "./schema";
import { GroupMemory } from "./memory";

const SYSTEM_PROMPT_BASE = `You are DurableClaw, a minimal AI agent running at the edge on Cloudflare Durable Objects.

You are helpful, concise, and technically capable. You have access to persistent group memory, a file workspace backed by R2 storage, and the ability to schedule tasks for future execution.

Key capabilities:
- Store and recall persistent memories across conversations using memory_store and memory_recall
- List, read, and write files in your R2 workspace using list_files, read_file, and write_file
- Schedule tasks for future execution using schedule_task

When using tools, explain what you are doing and report results clearly.`;

export class NanoChatAgent extends AIChatAgent<Env> {
  // Keep the last 500 messages in SQLite storage
  maxPersistedMessages = 500;

  private memory!: GroupMemory;

  /**
   * Called when the Durable Object is first instantiated or wakes from hibernation.
   * Initializes the SQLite schema and group memory manager.
   */
  async onStart(): Promise<void> {
    initSchema(this.ctx.storage.sql);
    this.memory = new GroupMemory(this.ctx.storage.sql);
  }

  /**
   * Handle an incoming chat message from the client.
   *
   * Builds the system prompt with group memory context and scheduling info,
   * creates the Anthropic provider, defines tools, and streams the response.
   */
  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions,
  ): Promise<Response | undefined> {
    // Ensure schema and memory are initialized (defensive, in case onStart hasn't run)
    if (!this.memory) {
      initSchema(this.ctx.storage.sql);
      this.memory = new GroupMemory(this.ctx.storage.sql);
    }

    const anthropic = createAnthropic({
      apiKey: this.env.ANTHROPIC_API_KEY,
    });

    const model = this.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

    // Build system prompt with memory context and scheduling awareness
    const memoryContext = this.memory.getContext();
    const scheduleContext = getSchedulePrompt({ date: new Date() });

    const systemParts = [SYSTEM_PROMPT_BASE];
    if (memoryContext) {
      systemParts.push(memoryContext);
    }
    systemParts.push(scheduleContext);
    const systemPrompt = systemParts.join("\n\n");

    // Convert UI messages to model messages for the API call
    const modelMessages = await convertToModelMessages(this.messages);

    const result = streamText({
      model: anthropic(model),
      system: systemPrompt,
      messages: modelMessages,
      tools: this.buildTools(),
      stopWhen: stepCountIs(10),
      onFinish,
      abortSignal: options?.abortSignal,
    });

    return result.toUIMessageStreamResponse();
  }

  /**
   * Execute a task that was previously scheduled via the schedule_task tool.
   *
   * This method is called by the Agents SDK scheduler when a delayed
   * task fires. It logs the execution and stores a note in group memory.
   */
  async executeScheduledTask(description: string): Promise<void> {
    // Ensure memory is initialized
    if (!this.memory) {
      initSchema(this.ctx.storage.sql);
      this.memory = new GroupMemory(this.ctx.storage.sql);
    }

    const timestamp = new Date().toISOString();
    this.memory.set(
      `scheduled_task_result_${timestamp}`,
      `Task executed: ${description}`,
    );

    // Log the execution
    const logId = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      `INSERT INTO execution_log (id, tool_name, input, output, status, created_at, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      logId,
      "scheduled_task",
      JSON.stringify({ description }),
      JSON.stringify({ result: "completed", timestamp }),
      "success",
      Date.now(),
      0,
    );
  }

  /**
   * Build the set of tools available to the agent.
   */
  private buildTools(): ToolSet {
    const memory = this.memory;
    const sql = this.ctx.storage.sql;
    const workspace = this.env.WORKSPACE;
    const agent = this;

    return {
      memory_store: tool({
        description:
          "Store a persistent memory that will be available across all future conversations in this group. Use this to remember important facts, preferences, or context.",
        inputSchema: z.object({
          key: z.string().describe("A descriptive key for the memory"),
          value: z.string().describe("The value to store"),
        }),
        execute: async ({ key, value }) => {
          const start = Date.now();
          try {
            memory.set(key, value);
            const result = `Stored memory: ${key} = ${value}`;
            logToolExecution(sql, "memory_store", { key, value }, result, "success", Date.now() - start);
            return result;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logToolExecution(sql, "memory_store", { key, value }, message, "error", Date.now() - start);
            throw error;
          }
        },
      }),

      memory_recall: tool({
        description:
          "Recall a previously stored memory by its key. Returns the stored value or indicates the key was not found.",
        inputSchema: z.object({
          key: z.string().describe("The key of the memory to recall"),
        }),
        execute: async ({ key }) => {
          const start = Date.now();
          const value = memory.get(key);
          const result = value !== null
            ? `Memory found: ${key} = ${value}`
            : `No memory found for key: ${key}`;
          logToolExecution(sql, "memory_recall", { key }, result, "success", Date.now() - start);
          return result;
        },
      }),

      list_files: tool({
        description:
          "List files in the R2 workspace. Optionally filter by a path prefix.",
        inputSchema: z.object({
          prefix: z
            .string()
            .optional()
            .describe("Optional path prefix to filter files"),
        }),
        execute: async ({ prefix }) => {
          const start = Date.now();
          try {
            const listOptions: R2ListOptions = {};
            if (prefix) {
              listOptions.prefix = prefix;
            }
            const listed = await workspace.list(listOptions);
            const files = listed.objects.map((obj) => ({
              key: obj.key,
              size: obj.size,
              uploaded: obj.uploaded.toISOString(),
            }));
            const result = JSON.stringify(files, null, 2);
            logToolExecution(sql, "list_files", { prefix }, result, "success", Date.now() - start);
            return files.length > 0
              ? `Found ${files.length} file(s):\n${result}`
              : "No files found in workspace.";
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logToolExecution(sql, "list_files", { prefix }, message, "error", Date.now() - start);
            throw error;
          }
        },
      }),

      read_file: tool({
        description: "Read the contents of a file from the R2 workspace.",
        inputSchema: z.object({
          path: z.string().describe("The file path/key to read"),
        }),
        execute: async ({ path }) => {
          const start = Date.now();
          try {
            const object = await workspace.get(path);
            if (!object) {
              const result = `File not found: ${path}`;
              logToolExecution(sql, "read_file", { path }, result, "success", Date.now() - start);
              return result;
            }
            const content = await object.text();
            logToolExecution(
              sql,
              "read_file",
              { path },
              `Read ${content.length} characters`,
              "success",
              Date.now() - start,
            );
            return content;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logToolExecution(sql, "read_file", { path }, message, "error", Date.now() - start);
            throw error;
          }
        },
      }),

      write_file: tool({
        description:
          "Write content to a file in the R2 workspace. Creates or overwrites the file.",
        inputSchema: z.object({
          path: z.string().describe("The file path/key to write"),
          content: z.string().describe("The content to write to the file"),
        }),
        execute: async ({ path, content }) => {
          const start = Date.now();
          try {
            await workspace.put(path, content);
            const result = `Successfully wrote ${content.length} characters to ${path}`;
            logToolExecution(sql, "write_file", { path, content_length: content.length }, result, "success", Date.now() - start);
            return result;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logToolExecution(sql, "write_file", { path }, message, "error", Date.now() - start);
            throw error;
          }
        },
      }),

      schedule_task: tool({
        description:
          "Schedule a task to be executed in the future. The task description will be passed to the executeScheduledTask handler after the specified delay.",
        inputSchema: z.object({
          description: z
            .string()
            .describe("A description of the task to be executed"),
          delaySeconds: z
            .number()
            .positive()
            .describe("Number of seconds to delay before executing the task"),
        }),
        execute: async ({ description, delaySeconds }) => {
          const start = Date.now();
          try {
            await agent.schedule(
              delaySeconds,
              "executeScheduledTask",
              description,
            );
            const result = `Task scheduled: "${description}" will run in ${delaySeconds} seconds`;
            logToolExecution(sql, "schedule_task", { description, delaySeconds }, result, "success", Date.now() - start);
            return result;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logToolExecution(sql, "schedule_task", { description, delaySeconds }, message, "error", Date.now() - start);
            throw error;
          }
        },
      }),
    };
  }
}

/**
 * Log a tool execution to the execution_log SQLite table.
 */
function logToolExecution(
  sql: SqlStorage,
  toolName: string,
  input: Record<string, unknown>,
  output: string,
  status: string,
  durationMs: number,
): void {
  const id = crypto.randomUUID();
  sql.exec(
    `INSERT INTO execution_log (id, tool_name, input, output, status, created_at, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    toolName,
    JSON.stringify(input),
    output,
    status,
    Date.now(),
    durationMs,
  );
}
