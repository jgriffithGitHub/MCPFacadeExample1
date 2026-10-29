// =============================================================================
// The agent: reads the CSV, and for each row runs two phases against Claude.
//
//   Phase 1 (plan):    the PLANNER sees the record and ALL facade tools, but
//                      can't call any of them. It answers with a Plan: which
//                      tools are needed, and the prompt the executor should
//                      get. ("Subagent-based progressive tool discovery" in
//                      the MCP client best practices.)
//   Approval:          record + Plan are shown in the left pane; Continue.
//   Phase 2 (execute): the EXECUTOR gets the planner's prompt and ONLY the
//                      chosen tools, and runs the tool-use loop.
//
// This replaces LangChain's create_agent/ainvoke from the Python baseline.
// =============================================================================
import Anthropic from "@anthropic-ai/sdk";
import { Client, StreamableHTTPClientTransport, type CallToolResult, type Tool } from "@modelcontextprotocol/client";
import { getToolUiResourceUri } from "@modelcontextprotocol/ext-apps/app-bridge";
import { parse } from "csv-parse/sync";
import fs from "node:fs";
import { TOOL_CALL_TIMEOUT_MS, type BackendToClient, type CsvRecord, type Plan } from "../shared/types.js";

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
    ctx.emit({ type: "plan", rowIndex: i, plan });

    ctx.emit({ type: "awaiting_continue", rowIndex: i });
    await ctx.waitForContinue();
    if (ctx.isStopped()) break;

    await runUpdatePhase(ctx, record, plan);
  }
}

// =============================================================================
// Phase 1: planning
// =============================================================================

/**
 * The trick that lets the planner SEE every tool without CALLING any:
 *
 *   tools:       [...all 47 facade tools, submit_plan]
 *   tool_choice: { type: "tool", name: "submit_plan" }
 *
 * tool_choice forces the model to answer with exactly one call to
 * submit_plan, so there's no tool loop: one request, one response. Seeing the
 * full tool definitions (with their schemas) lets the planner write a prompt
 * that matches what the tools actually accept.
 *
 * submit_plan is never sent to the facade. It exists only to give the
 * planner's answer a fixed SHAPE: its input_schema is the Plan type. The
 * "enum" on toolNames means the model can only name tools that really exist.
 *
 * The response's content will hold one block:
 *   { type: "tool_use", name: "submit_plan", id, input: { rationale, toolNames, prompt } }
 * and `input` is our Plan.
 */
function submitPlanTool(available: Anthropic.Tool[]): Anthropic.Tool {
  return {
    name: "submit_plan",
    description: "Submit the execution plan for this record. This is the only tool you may call.",
    input_schema: {
      type: "object",
      properties: {
        rationale: {
          type: "string",
          description: "Briefly: what the executor must do for this record, and why each chosen tool is needed.",
        },
        toolNames: {
          type: "array",
          items: { type: "string", enum: available.map((t) => t.name) },
          description: "The smallest set of tools the executor needs. It will have no others.",
        },
        prompt: {
          type: "string",
          description:
            "Complete instructions for the executor, which sees only this prompt, the system rules and the chosen tools. " +
            "Include the record's values, the exact attribute slugs and value formats to use, and the order of steps.",
        },
      },
      required: ["rationale", "toolNames", "prompt"],
    },
  };
}

const PLANNER_INSTRUCTIONS =
  "\n\nYou are the PLANNER. Do not perform the task. Decide which of the available tools a separate " +
  "executor will need to create or update this record in Attio, and write the prompt the executor will receive. " +
  "Choose as few tools as will reliably do the job. Respond only by calling submit_plan.";

async function runPlanPhase(ctx: AgentContext, record: CsvRecord): Promise<Plan> {
  const request: Anthropic.MessageCreateParamsNonStreaming = {
    model: ctx.model,
    max_tokens: 4000,
    system: SYSTEM_PROMPT + PLANNER_INSTRUCTIONS,
    tools: [...ctx.tools, submitPlanTool(ctx.tools)],
    tool_choice: { type: "tool", name: "submit_plan" },
    messages: [
      {
        role: "user",
        content: "Plan the create-or-update of this CSV record in Attio:\n" + JSON.stringify(record, null, 2),
      },
    ],
  };
  // The tool list is huge; log the request without it.
  ctx.emit({ type: "context", label: "plan request (tools omitted)", data: { ...request, tools: `${request.tools!.length} tools` } });

  const response = await ctx.anthropic.messages.create(request);
  ctx.emit({ type: "context", label: "plan response", data: response });

  const call = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "submit_plan",
  );
  if (!call) throw new Error("Planner did not call submit_plan");
  return call.input as Plan;
}

// =============================================================================
// Phase 2: execution (the tool-use loop)
// =============================================================================

/**
 * The data that drives the loop is the `messages` array. It only grows:
 *
 *   [ { role: "user",      content: plan.prompt + the CSV record },
 *     { role: "assistant", content: response.content },        <- ALL blocks, as returned:
 *                                                                  text AND tool_use
 *     { role: "user",      content: [tool_result, tool_result] }, <- one per tool_use,
 *                                                                  matched by tool_use_id
 *     ... ]
 *
 * Two rules the API enforces:
 *   - every tool_use in an assistant turn must be answered by a tool_result
 *     with the same id in the very next user turn;
 *   - content can't be empty, so never rebuild the assistant turn from its
 *     text alone (a turn with only tool calls has no text).
 */
const MAX_ITERATIONS = 10;

async function runUpdatePhase(ctx: AgentContext, record: CsvRecord, plan: Plan): Promise<void> {
  // Only the tools the planner chose.
  const tools = ctx.tools.filter((t) => plan.toolNames.includes(t.name));
  // The planner's prompt, plus the raw record, so the executor works from the
  // CSV's values even if the planner paraphrased one.
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: plan.prompt + "\n\nThe CSV record, exactly as read:\n" + JSON.stringify(record, null, 2) },
  ];

  for (let iteration = 1; iteration <= MAX_ITERATIONS && !ctx.isStopped(); iteration++) {
    const request: Anthropic.MessageCreateParamsNonStreaming = {
      model: ctx.model,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    };
    ctx.emit({ type: "context", label: `execute request #${iteration}`, data: request });

    const response = await ctx.anthropic.messages.create(request);
    ctx.emit({ type: "context", label: `execute response #${iteration}`, data: response });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (text) ctx.emit({ type: "model", text });

    // The assistant turn goes back into the transcript exactly as returned.
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason !== "tool_use") {
      ctx.emit({ type: "log", text: `Row finished (stop_reason: ${response.stop_reason}, ${iteration} model calls).` });
      return;
    }

    // Run every tool_use in this turn; collect one tool_result per call.
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      try {
        console.log("[host server] - callFacadeTool called: " + block.name);
        results.push(await callFacadeTool(ctx, block));
        console.log("[host server] - callFacadeTool returned: " + block.name);
      } catch (err) {
        // Transport/protocol failure: tell the model rather than crashing.
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: `Error calling ${block.name}: ${err instanceof Error ? err.message : String(err)}`,
          is_error: true,
        });
      }
    }
    messages.push({ role: "user", content: results });
  }
  ctx.emit({ type: "error", text: `Stopped after ${MAX_ITERATIONS} model calls while Claude was still calling tools.` });
}
