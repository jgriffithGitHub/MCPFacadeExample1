// =============================================================================
// Facade entry point: connect to Attio once, then serve MCP over HTTP.
//
//   http://localhost:3001/mcp             MCP endpoint (agent + host + view)
//   http://localhost:3001/oauth/callback  where Attio redirects after login
// =============================================================================
import "dotenv/config";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import type { Tool } from "@modelcontextprotocol/server";
import cors from "cors";
import type { Request, Response } from "express";
import { completeOAuth, connectToAttio } from "./attio-connection.js";
import { createServer } from "./server.js";

const PORT = parseInt(process.env.FACADE_PORT ?? "3001", 10);
const ATTIO_MCP_URL = process.env.ATTIO_MCP_URL ?? "https://mcp.attio.com/mcp";
const CALLBACK_URL = `http://localhost:${PORT}/oauth/callback`;

const app = createMcpExpressApp({ host: "localhost" });
app.use(cors()); // the host page (port 8080) calls this server from the browser

// OAuth redirect target. Must be listening BEFORE we connect to Attio.
app.get("/oauth/callback", (req: Request, res: Response) => {
  completeOAuth(new URLSearchParams(req.url.split("?")[1] ?? ""));
  res.send("Attio login complete. You can close this tab.");
});

// Filled in once Attio is connected; until then /mcp answers 503.
let attio: Awaited<ReturnType<typeof connectToAttio>> | undefined;
let attioTools: Tool[] = [];

app.all("/mcp", async (req: Request, res: Response) => {
  if (!attio) {
    res.status(503).json({ error: "Facade is still connecting to Attio" });
    return;
  }
  // Stateless mode: a fresh server + transport per HTTP request.
  const server = createServer(attio, attioTools);
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("[facade] MCP error:", error);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

app.listen(PORT, async (err?: Error) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`[facade] listening on http://localhost:${PORT}/mcp`);
  console.log(`[facade] connecting to ${ATTIO_MCP_URL} ...`);
  try {
    attio = await connectToAttio(ATTIO_MCP_URL, CALLBACK_URL);
    attioTools = (await attio.listTools()).tools;
    console.log(`[facade] Attio connected; proxying ${attioTools.length} tools:`);
    console.log("         " + attioTools.map((t) => t.name).join(", "));
  } catch (e) {
    console.error("[facade] Could not connect to Attio:", e);
    process.exit(1);
  }
});
