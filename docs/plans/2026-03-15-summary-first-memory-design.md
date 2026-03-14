# Summary-First Memory Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add summary-first long-term memory that archives chat history into Durable Object SQLite, periodically summarizes older conversation windows, and injects those summaries back into the agent prompt.

**Architecture:** Keep all memory state inside the existing Durable Object SQLite database. The agent will mirror chat messages into an archive table, create rolling summaries for older windows on a recurring schedule, and use summaries plus explicit key-value memory when building the system prompt while keeping recent raw messages for short-term context.

**Tech Stack:** Cloudflare Durable Objects, Agents SDK scheduling, SQLite-backed storage, Anthropic via AI SDK, Vitest for unit tests

### Task 1: Test Harness And Summary Helper Tests

**Files:**
- Modify: `package.json`
- Create: `tests/agent/summary-memory.test.ts`

**Step 1: Write the failing test**

Add tests for message normalization, summary window selection, and summary context formatting.

**Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL because the summary memory module does not exist yet.

**Step 3: Write minimal implementation**

Create `src/agent/summary-memory.ts` with the helper functions needed by the tests.

**Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS

### Task 2: Durable Object Summary Storage

**Files:**
- Modify: `src/agent/schema.ts`
- Create: `src/agent/summary-memory.ts`

**Step 1: Write the failing test**

Expand helper tests to cover archived message selection and prompt context rules.

**Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL on new behavior expectations.

**Step 3: Write minimal implementation**

Add archive, summary, and metadata tables plus the storage wrapper methods.

**Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS

### Task 3: Agent Integration And Periodic Maintenance

**Files:**
- Modify: `src/agent/index.ts`

**Step 1: Write the failing test**

Add tests for the helper behavior that the agent relies on for periodic summarization thresholds and summary prompt formatting.

**Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL on the new helper expectations.

**Step 3: Write minimal implementation**

Sync persisted chat messages into the archive, lower the recent-message retention window, ensure a recurring schedule exists, and add a maintenance callback that summarizes old archived windows.

**Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS

### Task 4: Verification And Documentation

**Files:**
- Modify: `ARCHITECTURE.md`

**Step 1: Verify implementation**

Run: `npm test`
Expected: PASS

Run: `npm run check`
Expected: PASS

**Step 2: Document behavior**

Update architecture notes to explain the new summary-first memory flow and scheduled maintenance.
