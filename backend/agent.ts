// =============================================================================
// The agent: reads the CSV, and for each row runs two phases against Claude.
//
//   Phase 1 (plan):   model gets the record, NO tools. Returns text: the data
//                     it read and its plan. Shown in the left pane; then we
//                     wait for the Continue button.
//   Phase 2 (update): model gets the record + the facade's tools. Runs the
//                     tool-use loop until the model stops asking for tools.
//
// This replaces LangChain's create_agent/ainvoke from the Python baseline.
// The loop that LangChain hid is now yours to write (runUpdatePhase).
// =============================================================================
import Anthropic from "@anthropic-ai/sdk";
import { Client, StreamableHTTPClientTransport, type CallToolResult, type Tool } from "@modelcontextprotocol/client";
import { getToolUiResourceUri } from "@modelcontextprotocol/ext-apps/app-bridge";
import { parse } from "csv-parse/sync";
import fs from "node:fs";
import { TOOL_CALL_TIMEOUT_MS, type BackendToClient, type CsvRecord } from "../shared/types.js";

// Carried over from mcpTest.py.
export const SYSTEM_PROMPT =
  "You are a CRM assistant. Help the user manage contacts. " +
  "The CRM has two objects: Companies and People." +
  "Before creating a contact, see if a record exists for the company and then check for a record for the person. " +
  "Companies can have multiple locations. This database has fields for 'Primary Location' but we will ignore the term 'Primary' and treat that as 'location', and there will be a company record for each 'location'. " +
  "People work for companies at locations, and a person can work for multiple companies, so there may be multple records for a person." +
  "The CSV record has these columns: AgencyName,ContactName,Street,City,State,Zip,Phone,Fax,Email,Website. " +
  "THe country is always 'United States of America' and the country code is '+1'. You may use these as defaults. " +
  "You may add a country code of '+1' to the phone and fax numbers if they are missing. " +
  "The AgencyName, Street, City, State, Zip, Domain and Website fields belong to the company. " +
  "If the record provides a Website, use that to populate the Domain field. " +
  "The Email and Phone fields belong to the person, not the company. " +
  "For companies, a record matches if the company name and location match. " +
  "Do not create a person record if the ContactName field is blank." +
  "For a person, a record exists if the first name, last name, and company match. " +
  "For both types, if a record exists, update it but if the record doesn't exist, create it. " +
  "Make sure the person is associated with the company. " +
  "You will need to parse the ContactName into first and last name. " +
  "Never invent contact information. If a field is blank or missing, leave it blank. " +
  "Do not use the Internet to fill in any missing information, such as 'Description' or 'Industry'. ";

/** Everything a phase needs, handed in by backend/main.ts. */
export interface AgentContext {
  anthropic: Anthropic;
  model: string;
  facade: Client; //                 MCP client connected to the facade
  tools: Anthropic.Tool[]; //        facade tools, already converted for Claude
  emit: (msg: BackendToClient) => void; // send a message to the left pane
  waitForContinue: () => Promise<void>; // resolves when the user clicks Continue
  isStopped: () => boolean; //       true after the user clicks Stop
}

// =============================================================================
// Scaffolding (written for you)
// =============================================================================

export function readCsv(csvPath: string): CsvRecord[] {
  return parse(fs.readFileSync(csvPath), { columns: true, skip_empty_lines: true, bom: true });
}

export async function connectToFacade(url: string): Promise<Client> {
  const client = new Client({ name: "attio-example-agent", version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

/**
 * Which facade tools the MODEL may see, converted to Claude's tool format.
 *
 * The host's job per the MCP Apps spec: tools with _meta.ui.visibility ["app"]
 * are for the view only (get_call_log, acknowledge_error). We also leave out
 * show_monitor: it opens UI, which is the host page's job, not the model's.
 *
 * The two shapes, side by side:
 *   MCP Tool:       { name, description?, inputSchema: {type:"object", ...}, _meta? }
 *   Anthropic.Tool: { name, description?, input_schema: {type:"object", ...} }
 * Same JSON Schema, different key name (inputSchema vs input_schema).
 */
export function toolsForModel(tools: Tool[]): Anthropic.Tool[] {
  return tools
    .filter((t) => {
      const visibility = (t._meta?.ui as { visibility?: string[] } | undefined)?.visibility;
      const appOnly = visibility !== undefined && !visibility.includes("model");
      return !appOnly && !getToolUiResourceUri(t);
    })
    .map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }));
}

/**
 * Call one facade tool on the model's behalf, and turn the MCP result into the
 * tool_result block Claude expects back.
 *
 *   Claude asks:  ToolUseBlock       { type: "tool_use", id, name, input }
 *   MCP returns:  CallToolResult     { content: [{type:"text", text}, ...], isError? }
 *   Claude gets:  ToolResultBlockParam { type: "tool_result", tool_use_id: id,
 *                                        content: string, is_error? }
 * The tool_use_id is how Claude matches each result to the request it made.
 *
 * Note the long timeout: if the facade is holding an error for you to
 * acknowledge, this call stays open until you click (see TOOL_CALL_TIMEOUT_MS).
 */
export async function callFacadeTool(
  ctx: AgentContext,
  toolUse: Anthropic.ToolUseBlock,
): Promise<Anthropic.ToolResultBlockParam> {
  const result = (await ctx.facade.callTool(
    { name: toolUse.name, arguments: toolUse.input as Record<string, unknown> },
    { timeout: TOOL_CALL_TIMEOUT_MS },
  )) as CallToolResult;
  const text = result.content
    .map((block) => (block.type === "text" ? block.text : JSON.stringify(block)))
    .join("\n");
  return { type: "tool_result", tool_use_id: toolUse.id, content: text, is_error: result.isError ?? false };
}

/** The outer loop: one pass per CSV row. */
export async function runAgent(ctx: AgentContext, records: CsvRecord[]) {
  for (let i = 0; i < records.length && !ctx.isStopped(); i++) {
    const record = records[i];
    ctx.emit({ type: "record", rowIndex: i, record });

    const plan = await runPlanPhase(ctx, record);
    ctx.emit({ type: "plan", rowIndex: i, text: plan });

    ctx.emit({ type: "awaiting_continue", rowIndex: i });
    await ctx.waitForContinue();
    if (ctx.isStopped()) break;

    await runUpdatePhase(ctx, record);
  }
}

// =============================================================================
// TODO(Jeff): the two phases.
// =============================================================================

/**
 * Phase 1: ask for the data read + plan. No tools. Return the plan text.
 *
 * One call: ctx.anthropic.messages.create({ model, max_tokens, system, messages })
 *   messages: Anthropic.MessageParam[] = [{ role: "user", content: "..." }]
 * The response is an Anthropic.Message. Its `content` is an ARRAY of blocks:
 *   [{ type: "text", text: "..." }, ...]
 * Join the text blocks for the plan.
 *
 * Design question: should phase 2 see phase 1's plan? If yes, phase 2 starts
 * from this conversation instead of a fresh one. Then you'd return the
 * messages too, not just the text.
 */
async function runPlanPhase(ctx: AgentContext, record: CsvRecord): Promise<string> {
  return `TODO(Jeff): runPlanPhase not written yet.\nRecord: ${JSON.stringify(record)}`;
}

/**
 * Phase 2: the tool-use loop. What LangChain's create_agent did for you.
 *
 * The data that drives the loop is the `messages` array. It only grows:
 *
 *   [ { role: "user",      content: "Please create or update ... {record}" },
 *     { role: "assistant", content: [ text?, tool_use, tool_use, ... ] },   <- response.content
 *     { role: "user",      content: [ tool_result, tool_result, ... ] },    <- one per tool_use
 *     { role: "assistant", content: [ ... ] },
 *     ... ]
 *
 * Each turn:
 *   1. response = await ctx.anthropic.messages.create({ ..., tools: ctx.tools, messages })
 *   2. push { role: "assistant", content: response.content } onto messages
 *   3. if response.stop_reason !== "tool_use": the model is done; stop
 *   4. for each block in response.content with block.type === "tool_use":
 *        result = await callFacadeTool(ctx, block)   <- goes through the facade,
 *                                                       so the right pane sees it
 *   5. push { role: "user", content: [all those tool_result blocks] }
 *   6. go to 1
 *
 * Use ctx.emit({ type: "model", text }) to show the model's text in the left
 * pane, and ctx.isStopped() to bail out. Consider a max-turns guard too.
 */
async function runUpdatePhase(ctx: AgentContext, record: CsvRecord): Promise<void> {
  ctx.emit({ type: "log", text: `TODO(Jeff): runUpdatePhase not written yet (${ctx.tools.length} tools available).` });
}
