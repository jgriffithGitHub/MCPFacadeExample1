// =============================================================================
// A tiny fake "Attio" MCP server for testing, no auth, in-memory records.
//
//   npm run start:fake     runs this on :3005 and points the facade at it
//
// FORCING AN ERROR: any call whose arguments contain the text "FAIL" anywhere
// returns a tool error (isError: true). Put FAIL in a CSV cell (e.g. a
// company name) to exercise the facade's hold-and-acknowledge path.
//
// These tools only roughly imitate Attio's. Check your attio_tool_list.txt
// for the real names and schemas.
// =============================================================================
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import type { Request, Response } from "express";
import { z } from "zod";

const PORT = 3005;
type FakeRecord = { id: string; object: "companies" | "people"; values: Record<string, unknown> };
const records: FakeRecord[] = [];
let nextId = 1;

const objectSchema = z.enum(["companies", "people"]);

function reply(data: unknown, args: unknown): CallToolResult {
  if (JSON.stringify(args).includes("FAIL")) {
    return { isError: true, content: [{ type: "text", text: "Fake Attio error: value rejected (argument contained FAIL)" }] };
  }
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function createServer() {
  const server = new McpServer({ name: "fake-attio", version: "0.0.1" });

  server.registerTool(
    "search-records",
    {
      description: "Search records of an object (companies or people) by a text query.",
      inputSchema: z.object({ object: objectSchema, query: z.string() }),
    },
    async (args) => {
      const q = args.query.toLowerCase();
      const hits = records.filter((r) => r.object === args.object && JSON.stringify(r.values).toLowerCase().includes(q));
      return reply(hits, args);
    },
  );

  server.registerTool(
    "create-record",
    {
      description: "Create a record of an object with attribute values.",
      inputSchema: z.object({ object: objectSchema, values: z.record(z.string(), z.unknown()) }),
    },
    async (args) => {
      if (JSON.stringify(args).includes("FAIL")) return reply(null, args);
      const rec: FakeRecord = { id: `rec_${nextId++}`, object: args.object, values: args.values };
      records.push(rec);
      return reply(rec, args);
    },
  );

  server.registerTool(
    "update-record",
    {
      description: "Update attribute values of an existing record by id.",
      inputSchema: z.object({ record_id: z.string(), values: z.record(z.string(), z.unknown()) }),
    },
    async (args) => {
      const rec = records.find((r) => r.id === args.record_id);
      if (!rec) return { isError: true, content: [{ type: "text", text: `No record ${args.record_id}` }] };
      if (JSON.stringify(args).includes("FAIL")) return reply(null, args);
      Object.assign(rec.values, args.values);
      return reply(rec, args);
    },
  );

  return server;
}

const app = createMcpExpressApp({ host: "localhost" });
app.all("/mcp", async (req: Request, res: Response) => {
  const server = createServer();
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
app.listen(PORT, () => console.log(`[fake-attio] http://localhost:${PORT}/mcp`));
