// =============================================================================
// Shared data shapes. Everything in this app passes one of these around.
// =============================================================================

// -----------------------------------------------------------------------------
// 1. CallLogEntry: one record per tool call that passes through the facade.
//
//    TODO(Jeff): this is a STARTING POINT copied from the architecture doc.
//    It is yours to redesign. Three pieces of code depend on it:
//      - facade/call-log.ts  creates and updates entries
//      - facade/server.ts    returns them from the get_call_log tool
//      - view/monitor.ts     renders them and shows Acknowledge when
//                            status === "awaiting_ack"
//    If you rename `id` or `status`, update the view's render() to match.
// -----------------------------------------------------------------------------
export type CallStatus =
  | "pending" //       forwarded to Attio, no answer yet
  | "ok" //            Attio answered without error
  | "error" //         Attio answered with an error (already acknowledged or never paused)
  | "awaiting_ack" //  error is being held until the user clicks Acknowledge
  | "acknowledged"; // user clicked Acknowledge; the error went back to the model

export interface CallLogEntry {
  id: number; //                      increasing; the view polls with "since_id"
  tool_name: string; //               e.g. "search-records"
  arguments: Record<string, unknown>; // exactly what the model sent
  status: CallStatus;
  started_at: string; //              ISO timestamp
  finished_at?: string;
  result?: unknown; //                the CallToolResult from Attio (raw)
  error?: string; //                  message when status is error/awaiting_ack/acknowledged
}

// -----------------------------------------------------------------------------
// 2. Messages between the left pane (browser) and the backend (Node), sent
//    as JSON over a WebSocket. A "discriminated union": the `type` field
//    tells you which shape you have, and TypeScript narrows on it in a switch.
// -----------------------------------------------------------------------------

/** Browser -> backend */
export type ClientToBackend =
  | { type: "start"; csvPath: string; facadeUrl: string }
  | { type: "continue" } //  user approved the plan for the current row
  | { type: "stop" };

/** Backend -> browser */
export type BackendToClient =
  | { type: "log"; text: string } //                          plain line in the chat pane
  | { type: "record"; rowIndex: number; record: CsvRecord } // the row just read
  | { type: "plan"; rowIndex: number; text: string } //        model's plan for that row
  | { type: "awaiting_continue"; rowIndex: number } //         enables the Continue button
  | { type: "model"; text: string } //                         any other model text
  | { type: "done" }
  | { type: "error"; text: string };

/** One CSV row: header name -> cell value (same as Python's csv.DictReader). */
export type CsvRecord = Record<string, string>;

// -----------------------------------------------------------------------------
// 3. Timeouts
// -----------------------------------------------------------------------------
/**
 * How long the agent's MCP client waits for ONE tool call to the facade.
 * The MCP SDK default is 60 seconds. When the facade holds an error until you
 * click Acknowledge, the agent's call stays open the whole time, so the default
 * would time out if you took longer than a minute. 30 minutes is generous.
 */
export const TOOL_CALL_TIMEOUT_MS = 30 * 60 * 1000;
