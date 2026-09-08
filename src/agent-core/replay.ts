import type { AgentMessageRow } from "./history";
import type { FrameSink } from "./protocol";

/**
 * Replay stored history to a freshly-connected socket.
 *
 * Ported verbatim from NanoChatAgent.replayHistory. Walks rows
 * chronologically and emits per-tool `history_tool_result` events matched to
 * the assistant turn they were generated under. The client (see
 * `useAssistantChat.ts`) accepts `{turn, toolName, rawJson}` and indexes
 * `turn` against its `messages` array — turn is the GLOBAL index a message
 * occupies (both user and assistant rows count). We track that count here so
 * tool-result widgets attach to the correct assistant bubble.
 *
 * Emission order matters: `assistant_message` first (client `messages` grows
 * to N+1), then tool-result events for that turn carrying `turn = N`.
 */
export function replayHistory(
  send: FrameSink,
  rows: AgentMessageRow[],
  options: { includeMessageIds?: boolean } = {},
): void {
  // clientMessagesLen mirrors what the client's `messages` array length will
  // be after each event we send. We increment for user and assistant
  // messages — but NOT tool rows (tool results don't push a new message in
  // the client).
  let clientMessagesLen = 0;
  // The turn index of the most recently emitted assistant message. Used as
  // the `turn` field for any tool-result rows that follow it.
  let lastAssistantTurn = -1;
  // Whether the current turn has already emitted a visible assistant bubble.
  // Reset on every user row; set when a non-empty assistant row is emitted.
  // Guards the empty-content branch: a trailing pure tool-call step in a turn
  // that already produced text must keep its tool results attached to that
  // earlier bubble (live merges the whole turn into one bubble), not re-point
  // at the next index — which ends up occupied by the following user message,
  // hiding the widgets.
  let turnHasBubble = false;
  for (const row of rows) {
    if (row.role === "user") {
      send({
        type: "history_user_message",
        content: row.content,
        ...(options.includeMessageIds ? { message_id: row.message_id } : {}),
      });
      clientMessagesLen++;
      turnHasBubble = false;
    } else if (row.role === "assistant") {
      if (row.content) {
        // DurableClaw stores a stop marker in durable history, while its current
        // client renders that marker from metadata. Remove only the exact
        // terminal suffix, and keep legacy callers' replay frames unchanged.
        const stoppedSuffix = "\n\n_(Stopped)_";
        const stopped =
          !!options.includeMessageIds && row.content.endsWith(stoppedSuffix);
        send({
          type: "assistant_message",
          content: stopped
            ? row.content.slice(0, -stoppedSuffix.length)
            : row.content,
          ...(options.includeMessageIds ? { message_id: row.message_id } : {}),
          ...(stopped ? { stopped: true } : {}),
        });
        lastAssistantTurn = clientMessagesLen;
        clientMessagesLen++;
        turnHasBubble = true;
      } else if (!turnHasBubble) {
        // Empty content (pure tool-call turn): the client renders nothing, so
        // point lastAssistantTurn at the NEXT position — the index the turn's
        // final text message will occupy — so the tool-result rows that follow
        // attach to it. This mirrors how the live stream works (currentTurnRef
        // is captured at assistant_start, before any text).
        lastAssistantTurn = clientMessagesLen;
      }
    } else if (row.role === "tool") {
      if (lastAssistantTurn < 0) {
        // Orphan tool row before any assistant turn — drop it; the client has
        // no widget anchor for it.
        continue;
      }
      let output: unknown = row.content;
      try {
        output = JSON.parse(row.content);
      } catch {
        // Non-JSON tool output — keep the raw string so the widget renderer
        // can at least display it.
      }
      const rawJson =
        typeof output === "string" ? output : JSON.stringify(output);
      send({
        type: "history_tool_result",
        turn: lastAssistantTurn,
        toolName: row.tool_name ?? "",
        rawJson,
      });
    }
  }
}
