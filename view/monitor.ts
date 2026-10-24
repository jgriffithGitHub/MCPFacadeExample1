// =============================================================================
// The MCP App view: runs inside the right-pane iframe.
//
// It never talks to the facade directly. Every call goes:
//   view --postMessage--> host page (AppBridge) --MCP--> facade
// The `App` object hides that: app.callServerTool(...) looks like an ordinary
// async call.
//
// What it does:
//   - every POLL_MS, call get_call_log({ since_id }) and merge the entries
//   - render each entry as raw JSON
//   - entries with status "awaiting_ack" get an Acknowledge button that calls
//     acknowledge_error({ call_id })
// =============================================================================
import { App } from "@modelcontextprotocol/ext-apps";
import type { CallLogEntry } from "../shared/types.js";

const POLL_MS = 1000;

const statusEl = document.getElementById("status")!;
const entriesEl = document.getElementById("entries")!;

// Entries by id. Map keeps insertion order, so rendering is oldest-first.
// Merging (set by id) means if the facade sends an entry again with a new
// status, the newer copy replaces the old one.
const entries = new Map<number, CallLogEntry>();
let sinceId = 0;

const app = new App({ name: "Attio call monitor", version: "0.1.0" });

// Register handlers BEFORE connect(): the host may send these right away.
app.ontoolinput = (params) => console.info("[view] tool input", params);
app.ontoolresult = (result) => console.info("[view] tool result", result);
app.onteardown = async () => {
  stopPolling();
  return {};
};
app.onerror = console.error;

let timer: ReturnType<typeof setInterval> | undefined;
function stopPolling() {
  if (timer) clearInterval(timer);
}

async function poll() {
  try {
    const result = await app.callServerTool({ name: "get_call_log", arguments: { since_id: sinceId } });
    const newEntries = ((result.structuredContent as { entries?: CallLogEntry[] })?.entries ?? []);
    for (const e of newEntries) {
      entries.set(e.id, e);
      sinceId = Math.max(sinceId, e.id);
    }
    statusEl.textContent = `polling every ${POLL_MS} ms · ${entries.size} calls · last poll ${new Date().toLocaleTimeString()}`;
    if (newEntries.length) render();
  } catch (e) {
    statusEl.textContent = `poll failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function render() {
  entriesEl.replaceChildren(
    ...[...entries.values()].map((entry) => {
      const div = document.createElement("div");
      div.className = `entry ${entry.status}`;

      const head = document.createElement("div");
      head.className = "head";
      head.textContent = `#${entry.id} ${entry.tool_name} [${entry.status}]`;

      const pre = document.createElement("pre");
      pre.textContent = JSON.stringify(entry, null, 2);

      div.append(head, pre);

      if (entry.status === "awaiting_ack") {
        const btn = document.createElement("button");
        btn.textContent = "Acknowledge";
        btn.onclick = async () => {
          btn.disabled = true;
          await app.callServerTool({ name: "acknowledge_error", arguments: { call_id: entry.id } });
          await poll();
        };
        div.append(btn);
      }
      return div;
    }),
  );
  window.scrollTo(0, document.body.scrollHeight);
}

app.connect().then(() => {
  statusEl.textContent = "connected";
  poll();
  timer = setInterval(poll, POLL_MS);
});
