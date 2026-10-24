// =============================================================================
// Backend entry point.
//
//   http://localhost:8080          the host page (dist/host/index.html)
//   ws://localhost:8080/ws         left pane <-> agent loop
//   http://localhost:8081          the sandbox proxy, on a SEPARATE port so it
//                                  is a different origin from the host page
//                                  (required by the MCP Apps spec)
// =============================================================================
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import type { McpUiResourceCsp } from "@modelcontextprotocol/ext-apps";
import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { BackendToClient, ClientToBackend } from "../shared/types.js";
import { connectToFacade, readCsv, runAgent, toolsForModel, type AgentContext } from "./agent.js";

const HOST_PORT = parseInt(process.env.HOST_PORT ?? "8080", 10);
const SANDBOX_PORT = parseInt(process.env.SANDBOX_PORT ?? "8081", 10);
const MODEL = process.env.MODEL ?? "claude-haiku-4-5";
const DIST = path.resolve("dist/host");

// ---------------------------------------------------------------------------
// Host page + WebSocket
// ---------------------------------------------------------------------------
const hostApp = express();
hostApp.get("/", (_req, res) => res.sendFile(path.join(DIST, "index.html")));
const httpServer = createServer(hostApp);
const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

wss.on("connection", (ws: WebSocket) => {
  const emit = (msg: BackendToClient) => ws.send(JSON.stringify(msg));

  // Per-connection run state.
  let stopped = false;
  let releaseContinue: (() => void) | undefined;
  let running = false;

  ws.on("message", async (raw) => {
    const msg = JSON.parse(raw.toString()) as ClientToBackend;
    switch (msg.type) {
      case "continue":
        releaseContinue?.();
        releaseContinue = undefined;
        break;

      case "stop":
        stopped = true;
        releaseContinue?.();
        emit({ type: "log", text: "Stopping after the current step..." });
        break;

      case "start": {
        if (running) return;
        running = true;
        stopped = false;
        try {
          const records = readCsv(msg.csvPath);
          emit({ type: "log", text: `Read ${records.length} rows from ${msg.csvPath}` });

          const facade = await connectToFacade(msg.facadeUrl);
          const { tools } = await facade.listTools();
          const modelTools = toolsForModel(tools);
          emit({ type: "log", text: `Facade offers ${tools.length} tools; ${modelTools.length} shown to the model.` });

          const ctx: AgentContext = {
            anthropic: new Anthropic(), // reads ANTHROPIC_API_KEY from the environment
            model: MODEL,
            facade,
            tools: modelTools,
            emit,
            waitForContinue: () => new Promise<void>((resolve) => (releaseContinue = resolve)),
            isStopped: () => stopped,
          };
          await runAgent(ctx, records);
          await facade.close();
        } catch (e) {
          emit({ type: "error", text: e instanceof Error ? (e.stack ?? e.message) : String(e) });
        } finally {
          running = false;
          emit({ type: "done" });
        }
        break;
      }
    }
  });
});

httpServer.listen(HOST_PORT, () => console.log(`[backend] host page: http://localhost:${HOST_PORT}`));

// ---------------------------------------------------------------------------
// Sandbox proxy server (copied in spirit from the SDK's basic-host serve.ts).
// The view's CSP is set as an HTTP header here, from the ?csp= query param.
// ---------------------------------------------------------------------------
function sanitize(domains?: string[]) {
  return (domains ?? []).filter((d) => typeof d === "string" && !/[;\r\n'" ]/.test(d));
}
function buildCspHeader(csp?: McpUiResourceCsp) {
  const res = sanitize(csp?.resourceDomains).join(" ");
  const conn = sanitize(csp?.connectDomains).join(" ");
  return [
    "default-src 'self' 'unsafe-inline'",
    `script-src 'self' 'unsafe-inline' blob: data: ${res}`.trim(),
    `style-src 'self' 'unsafe-inline' blob: data: ${res}`.trim(),
    `img-src 'self' data: blob: ${res}`.trim(),
    `font-src 'self' data: blob: ${res}`.trim(),
    `connect-src 'self' ${conn}`.trim(),
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
  ].join("; ");
}

const sandboxApp = express();
sandboxApp.get(["/", "/sandbox.html"], (req, res) => {
  let csp: McpUiResourceCsp | undefined;
  if (typeof req.query.csp === "string") {
    try {
      csp = JSON.parse(req.query.csp);
    } catch {}
  }
  res.setHeader("Content-Security-Policy", buildCspHeader(csp));
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(DIST, "sandbox.html"));
});
sandboxApp.listen(SANDBOX_PORT, () => console.log(`[backend] sandbox:   http://localhost:${SANDBOX_PORT}`));
