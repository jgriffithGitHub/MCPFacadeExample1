// =============================================================================
// The facade MCP server: what the agent and the view both talk to.
//
// It exposes three kinds of tools:
//   1. PROXIED tools: one per Attio tool, same name/description/schema.
//      The model calls these; each call is forwarded to Attio.
//   2. show_monitor: the MCP App tool. Its _meta.ui.resourceUri tells the host
//      "render ui://attio-monitor/monitor.html when you call me".
//   3. APP-ONLY tools (visibility ["app"]): get_call_log and acknowledge_error.
//      Only the view calls these. The host must not show them to the model;
//      see toolsForModel() in backend/agent.ts.
// Plus one resource: the view's HTML, built by vite into dist/view/monitor.html.
// =============================================================================
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import {
  fromJsonSchema,
  McpServer,
  type CallToolResult,
  type JsonSchemaType,
  type ReadResourceResult,
  type Tool,
} from "@modelcontextprotocol/server";
import type { Client } from "@modelcontextprotocol/client";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import * as callLog from "./call-log.js";

const MONITOR_URI = "ui://attio-monitor/monitor.html";
const MONITOR_HTML = path.resolve("dist/view/monitor.html");

/**
 * Build a server instance. Called once per HTTP request (stateless mode).
 * `attio` is the one shared client connected at startup; `attioTools` is the
 * tool list fetched from Attio at startup.
 */
export function createFacadeServer(attio: Client, attioTools: Tool[]): McpServer {
  const server = new McpServer({ name: "attio-facade", version: "0.1.0" });
  // ---------------------------------------------------------------------------
  // 1. Proxied Attio tools
  // ---------------------------------------------------------------------------
  for (const tool of attioTools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        // Attio gives us plain JSON Schema; the SDK wants a schema object it
        // can validate with. fromJsonSchema() wraps one in the other.
        inputSchema: fromJsonSchema(tool.inputSchema as JsonSchemaType),
        annotations: tool.annotations,
      },
      async (args): Promise<CallToolResult> => forwardToAttio(attio, tool.name, args as Record<string, unknown>),
    );
  }

  // ---------------------------------------------------------------------------
  // 2. The MCP App tool. The host calls this once at startup to open the view.
  // ---------------------------------------------------------------------------
  registerAppTool(
    server,
    "show_monitor",
    {
      title: "Show Attio call monitor",
      description: "Opens the live monitor of calls this facade forwards to Attio.",
      inputSchema: z.object({}),
      _meta: { ui: { resourceUri: MONITOR_URI } },
    },
    async (): Promise<CallToolResult> => ({
      // Text fallback for hosts that can't render MCP Apps.
      content: [{ type: "text", text: "Attio call monitor opened." }],
    }),
  );

  // ---------------------------------------------------------------------------
  // 3. App-only tools, called by the view
  // ---------------------------------------------------------------------------
  registerAppTool(
    server,
    "get_call_log",
    {
      description: "Call-log entries newer than since_id. Used by the monitor view to poll.",
      inputSchema: z.object({ since_id: z.number().default(0) }),
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ since_id }): Promise<CallToolResult> => {
      const entries = callLog.getEntriesSince(since_id);
      return {
        content: [{ type: "text", text: `${entries.length} entries` }],
        // structuredContent is the machine-readable part; the view reads this.
        structuredContent: { entries },
      };
    },
  );

  registerAppTool(
    server,
    "acknowledge_error",
    {
      description: "Releases a held error so it is returned to the model.",
      inputSchema: z.object({ call_id: z.number() }),
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ call_id }): Promise<CallToolResult> => {
      const released = callLog.acknowledge(call_id);
      return {
        content: [{ type: "text", text: released ? "acknowledged" : "nothing was waiting" }],
        structuredContent: { released },
      };
    },
  );

  // ---------------------------------------------------------------------------
  // The view's HTML, as an MCP resource
  // ---------------------------------------------------------------------------
  registerAppResource(
    server,
    "Attio call monitor",
    MONITOR_URI,
    { mimeType: RESOURCE_MIME_TYPE, },
    async (): Promise<ReadResourceResult> => ({
      contents: [{ uri: MONITOR_URI, mimeType: RESOURCE_MIME_TYPE, text: await fs.readFile(MONITOR_HTML, "utf-8") }],
    }),
  );

  return server;
}

// =============================================================================
// Forwarding: the heart of the facade.
//
// TODO(Jeff): right now this is a pure pass-through: forward, return. Build
// the monitoring around it using call-log.ts:
//
//   1. entry = recordStart(name, args)          -> the view sees "pending"
//   2. result = await attio.callTool(...)       -> already written below
//   3. Attio reports failure in TWO ways, so handle both:
//        a. result.isError === true   (a tool-level error, e.g. bad field)
//        b. callTool throws           (transport/protocol error, e.g. network)
//   4. on success: updateEntry(entry.id, { status: "ok", result, finished_at })
//   5. on error:   updateEntry(... status "awaiting_ack", error ...)
//                  await waitForAck(entry.id)      <- the pause
//                  updateEntry(... status "acknowledged" ...)
//                  return the error to the model as a CallToolResult with
//                  isError: true (don't throw; the model should see it)
//
// Shapes you'll touch:
//   CallToolResult = { content: ContentBlock[], structuredContent?: object,
//                      isError?: boolean }
//   ContentBlock (usually) = { type: "text", text: string }
// =============================================================================
async function forwardToAttio(
  attio: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {

  const entry = callLog.recordStart(name, args);

  console.log("[facade] forwardToAttio called: entry key = " + entry.id);  
  const result = (await attio.callTool({ name, arguments: args })) as CallToolResult;

  if(result.isError)
  {
    const text = result.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    console.log("Attio reported error: " + text);
    callLog.updateEntry(entry.id, { status: "awaiting_ack", result: text });  

    const ackResult = await callLog.waitForAck(entry.id) as void;
    callLog.updateEntry(entry.id, { status: "acknowledged", finished_at:new Date() });
  }
  else
  {
    callLog.updateEntry(entry.id, { status: "ok", result, finished_at:new Date() });  
  }

  return result;
}
