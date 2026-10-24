// =============================================================================
// The call log: the facade's memory of every tool call it forwarded.
//
// TODO(Jeff): this whole module is yours. The function signatures below are
// the contract the rest of the code calls; the bodies are placeholders that
// keep the app running (nothing is recorded, nothing pauses) until you fill
// them in.
//
// Where the state lives: module-level variables in this file. The facade
// builds a new McpServer for every HTTP request (stateless mode, see main.ts),
// so state can't live on the server object. A module-level variable is shared
// by every request: the agent's calls and the view's polling see the same log.
//
// Things to decide:
//   - How do you store entries? (an array, since ids increase, works well)
//   - What does getEntriesSince return when the view first loads (sinceId = 0)?
//   - waitForAck: how does one request wait for something a DIFFERENT request
//     does later? Hint: a Promise whose `resolve` function you keep in a
//     Map<number, () => void>, keyed by entry id. acknowledge(id) looks up
//     that resolve function and calls it.
// =============================================================================
import type { CallLogEntry } from "../shared/types.js";

/** Create an entry when a call starts. Returns it so the caller knows its id. */
export function recordStart(toolName: string, args: Record<string, unknown>): CallLogEntry {
  // TODO(Jeff): create the entry, store it, return it.
  return {
    id: 0,
    tool_name: toolName,
    arguments: args,
    status: "pending",
    started_at: new Date().toISOString(),
  };
}

/** Update an entry. `changes` holds only the fields that changed. */
export function updateEntry(id: number, changes: Partial<CallLogEntry>): void {
  // TODO(Jeff): find the entry and apply the changes.
}

/** Entries with id > sinceId, oldest first. The view polls this. */
export function getEntriesSince(sinceId: number): CallLogEntry[] {
  // TODO(Jeff): return the new entries.
  // Note: the view only re-renders entries it receives, so if an OLD entry's
  // status changes (pending -> ok), think about how the view learns that.
  return [];
}

/** Resolves when acknowledge(id) is called. The forwarding handler awaits this. */
export function waitForAck(id: number): Promise<void> {
  // TODO(Jeff): return a Promise that stays pending until acknowledge(id).
  return Promise.resolve();
}

/** Called by the acknowledge_error tool. Returns false if nothing was waiting. */
export function acknowledge(id: number): boolean {
  // TODO(Jeff): release the waiter for this id, update the entry's status.
  return false;
}
