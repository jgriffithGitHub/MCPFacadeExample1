// =============================================================================
// The host page: two panes.
//
// LEFT pane: a thin UI over the backend's agent loop. It sends ClientToBackend
//   messages over a WebSocket and renders the BackendToClient messages it gets
//   back. No agent logic lives here.
//
// RIGHT pane: this page acts as an MCP Apps HOST:
//   1. connect an MCP client (in the browser) to the facade
//   2. call the show_monitor tool; its _meta.ui.resourceUri names the view
//   3. read that ui:// resource -> the view's HTML
//   4. load the sandbox proxy iframe (other port = other origin)
//   5. connect an AppBridge to it and hand it the HTML
//   6. from then on, AppBridge answers the view's requests. When the view
//      calls app.callServerTool(...), AppBridge forwards it to the facade
//      with this page's MCP client.
// Adapted from the SDK's examples/basic-host/src/implementation.ts.
// =============================================================================
import {
  AppBridge,
  PostMessageTransport,
  RESOURCE_MIME_TYPE,
  getToolUiResourceUri,
  type McpUiResourceCsp,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { Client, StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";
import type { BackendToClient, ClientToBackend } from "../shared/types.js";

const IMPLEMENTATION = { name: "AttioExample host", version: "0.1.0" };
const SANDBOX_URL = `http://localhost:${Number(location.port) + 1}/sandbox.html`; // 8080 -> 8081

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const chat = $<HTMLDivElement>("chat");
const csvInput = $<HTMLInputElement>("csv");
const facadeInput = $<HTMLInputElement>("facade");
const startBtn = $<HTMLButtonElement>("start");
const continueBtn = $<HTMLButtonElement>("continue");
const stopBtn = $<HTMLButtonElement>("stop");
const rightStatus = $<HTMLDivElement>("right-status");
const frame = $<HTMLIFrameElement>("app-frame");

// Remember the CSV path between reloads (per-browser convenience only).
try {
  csvInput.value = localStorage.getItem("csvPath") ?? "";
} catch {}

// =============================================================================
// LEFT PANE
// =============================================================================
const ws = new WebSocket(`ws://${location.host}/ws`);

function send(msg: ClientToBackend) {
  ws.send(JSON.stringify(msg));
}

function addMessage(kind: string, text: string) {
  const p = document.createElement("div");
  p.className = `msg ${kind}`;
  p.textContent = text;
  chat.append(p);
  chat.scrollTop = chat.scrollHeight;
}

/** Raw JSON dump, collapsed under its label. Hidden when "Show context" is off. */
function addContext(label: string, data: unknown) {
  const details = document.createElement("details");
  details.className = "msg context";
  const summary = document.createElement("summary");
  summary.textContent = label;
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(data, null, 2);
  details.append(summary, pre);
  chat.append(details);
  chat.scrollTop = chat.scrollHeight;
}

const showContext = $<HTMLInputElement>("show-context");
try {
  showContext.checked = localStorage.getItem("showContext") !== "false";
} catch {}
document.body.classList.toggle("show-context", showContext.checked);
showContext.onchange = () => {
  document.body.classList.toggle("show-context", showContext.checked);
  try {
    localStorage.setItem("showContext", String(showContext.checked));
  } catch {}
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data) as BackendToClient;
  switch (msg.type) {
    case "log":
      addMessage("log", msg.text);
      break;
    case "record":
      addMessage("record", `Row ${msg.rowIndex}:\n${JSON.stringify(msg.record, null, 2)}`);
      break;
    case "plan":
      addMessage(
        "plan",
        `Plan for row ${msg.rowIndex}\n\n` +
          `Tools (${msg.plan.toolNames.length}): ${msg.plan.toolNames.join(", ")}\n\n` +
          `Why: ${msg.plan.rationale}\n\n` +
          `Prompt for the executor:\n${msg.plan.prompt}`,
      );
      break;
    case "context":
      addContext(msg.label, msg.data);
      break;
    case "awaiting_continue":
      continueBtn.disabled = false;
      addMessage("log", `Waiting for Continue (row ${msg.rowIndex})...`);
      break;
    case "model":
      addMessage("model", msg.text);
      break;
    case "error":
      addMessage("error", msg.text);
      break;
    case "done":
      addMessage("log", "Done.");
      startBtn.disabled = false;
      stopBtn.disabled = true;
      continueBtn.disabled = true;
      break;
  }
};
ws.onclose = () => addMessage("error", "Lost connection to the backend.");

startBtn.onclick = () => {
  try {
    localStorage.setItem("csvPath", csvInput.value);
  } catch {}
  startBtn.disabled = true;
  stopBtn.disabled = false;
  send({ type: "start", csvPath: csvInput.value, facadeUrl: facadeInput.value });
};
continueBtn.onclick = () => {
  continueBtn.disabled = true;
  send({ type: "continue" });
};
stopBtn.onclick = () => send({ type: "stop" });

// =============================================================================
// RIGHT PANE: the MCP Apps host
// =============================================================================
async function openMonitor() {
  // 1. MCP client in the browser, connected to the facade.
  rightStatus.textContent = "connecting to facade...";
  const client = new Client(IMPLEMENTATION);
  await client.connect(new StreamableHTTPClientTransport(new URL(facadeInput.value)));

  // 2. Find show_monitor and the ui:// resource it points at.
  const { tools } = await client.listTools();
  const tool = tools.find((t) => t.name === "show_monitor");
  if (!tool) throw new Error("Facade has no show_monitor tool");
  const uri = getToolUiResourceUri(tool);
  if (!uri) throw new Error("show_monitor has no _meta.ui.resourceUri");

  // 3. Read the view's HTML (and optional CSP) from the resource.
  const resource = await client.readResource({ uri });
  const content = resource.contents[0];
  if (content.mimeType !== RESOURCE_MIME_TYPE || !("text" in content)) {
    throw new Error(`Unexpected UI resource: ${content.mimeType}`);
  }
  const html = content.text;
  const csp = (content._meta as { ui?: { csp?: McpUiResourceCsp } } | undefined)?.ui?.csp;

  // 4. Load the sandbox proxy and wait for it to say it's ready.
  rightStatus.textContent = "loading sandbox...";
  await loadSandbox(csp);

  // 5. AppBridge: the host side of the view's postMessage protocol.
  const bridge = new AppBridge(
    client,
    IMPLEMENTATION,
    {
      serverTools: client.getServerCapabilities()?.tools, // lets the view call facade tools
      serverResources: client.getServerCapabilities()?.resources,
    },
    { hostContext: { theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light", platform: "web" } },
  );
  // Handlers BEFORE connect.
  bridge.onloggingmessage = (params) => console.info("[view log]", params);
  bridge.onmessage = async (params) => {
    // The view could post a chat message with app.sendMessage(); show it.
    addMessage("log", `[view] ${JSON.stringify(params.content)}`);
    return {};
  };
  const initialized = new Promise<void>((resolve) => (bridge.oninitialized = () => resolve()));

  await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
  await bridge.sendSandboxResourceReady({ html, csp });
  rightStatus.textContent = "waiting for view to initialize...";
  await initialized;

  // 6. Tell the view about "its" tool call, as a real host would.
  bridge.sendToolInput({ arguments: {} });
  const result = (await client.callTool({ name: "show_monitor", arguments: {} })) as CallToolResult;
  bridge.sendToolResult(result);
  rightStatus.textContent = `MCP App: ${tool.title ?? tool.name} (${uri})`;
}

function loadSandbox(csp?: McpUiResourceCsp): Promise<void> {
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
  const ready = new Promise<void>((resolve) => {
    const listener = ({ source, data }: MessageEvent) => {
      if (source === frame.contentWindow && data?.method === "ui/notifications/sandbox-proxy-ready") {
        window.removeEventListener("message", listener);
        resolve();
      }
    };
    window.addEventListener("message", listener);
  });
  const url = new URL(SANDBOX_URL);
  if (csp) url.searchParams.set("csp", JSON.stringify(csp));
  frame.src = url.href;
  return ready;
}

openMonitor().catch((e) => {
  rightStatus.textContent = `MCP App failed to load: ${e instanceof Error ? e.message : String(e)}`;
  console.error(e);
});
