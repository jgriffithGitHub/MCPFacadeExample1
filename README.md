# AttioExample

A two-pane app for learning MCP Apps. The left pane runs an agent that updates
Attio from a CSV. The right pane is an MCP App that shows every call the agent
makes and holds errors until you acknowledge them.

```
Browser (host page, :8080)                     Node processes
┌───────────────┬───────────────────┐
│ LEFT pane     │ RIGHT pane        │
│ CSV, Start,   │ iframe (:8081)    │
│ Continue,     │  └ MCP App view   │
│ chat log      │    (monitor.ts)   │
└──────┬────────┴─────────┬─────────┘
       │ WebSocket        │ postMessage → AppBridge → MCP
┌──────┴──────────┐       │
│ backend (:8080) │       │
│ agent loop      │       │
└──────┬──────────┘       │
       │ MCP              │ MCP
┌──────┴──────────────────┴──────────┐
│ facade (:3001)                     │
│ proxied Attio tools + call log +   │
│ show_monitor + app-only tools      │
└──────┬─────────────────────────────┘
       │ MCP + OAuth
   Attio (or dev/fake-attio.ts on :3005)
```

## Run it

Requires Node 20+.

```
npm install
copy .env.example .env      (then put your ANTHROPIC_API_KEY in .env)

npm run start:fake          safe: fake Attio, no login, in-memory records
npm start                   real Attio (browser login the first time)
```

Open http://localhost:8080, enter a CSV path, click **Start**.

`npm run start:fake` is the place to begin. Put the text `FAIL` in any CSV cell
(e.g. an AgencyName) and the fake server returns an error for that call, which
exercises the hold-and-acknowledge path.

The first `npm start` opens your browser to log in to Attio. Tokens are saved
in `.oauth/attio.json`; delete that folder to log in again.

## What's yours to write (search for `TODO(Jeff)`)

As delivered, the app runs end to end but the agent doesn't call the model
yet, and the facade forwards calls without recording them. The plumbing around
those gaps is done and tested.

| File | What | Shapes explained in the file |
|---|---|---|
| `shared/types.ts` | `CallLogEntry`: a starting point, redesign it freely | the entry, the WebSocket messages |
| `facade/call-log.ts` | store entries; `waitForAck` / `acknowledge` | how one request waits for another |
| `facade/server.ts` → `forwardToAttio` | record, forward, on error hold until acknowledged | `CallToolResult`, the two ways Attio fails |
| `backend/agent.ts` → `runPlanPhase` | one model call, no tools → plan text | `Message.content` blocks |
| `backend/agent.ts` → `runUpdatePhase` | the tool-use loop | the `messages` array, turn by turn |

A suggested order: `runPlanPhase` (see the model talk), then `runUpdatePhase`
(the agent works and calls go through the facade), then `call-log.ts` +
`forwardToAttio` (the right pane comes alive).

## Things worth knowing

- **Where MCP Apps actually happen:** `facade/server.ts` (the tool with
  `_meta.ui.resourceUri`, the `ui://` resource, the `visibility: ["app"]`
  tools), `view/monitor.ts` (the `App` object, `callServerTool`), and
  `host/host.ts` (the host side: reading the resource, the sandbox,
  `AppBridge`).
- **The host enforces visibility.** `visibility: ["app"]` is only a label. The
  host is supposed to keep those tools away from the model, and here the host
  is your backend: `toolsForModel()` in `backend/agent.ts` does the filtering.
- **The held-call timeout.** While the facade holds an error, the agent's MCP
  call stays open. The SDK's default request timeout is 60 seconds, so the
  agent passes a 30-minute timeout (`TOOL_CALL_TIMEOUT_MS`). This was tested
  with a 70-second wait before acknowledging.
- **A polling gotcha (found in testing).** If `get_call_log` returns only
  entries with `id > since_id`, the view never learns that an *older* entry
  changed status (e.g. `awaiting_ack` → `acknowledged`). The view merges
  entries by id, so re-sending an updated entry works. How you decide what to
  re-send is up to you.

  Update: 10/29 - One decision that was made was to block the client until
  an error is acknowledged. This handles one use case, but not all issues
  need to block processing. If, for example, the acknowledgement is being used
  simply to require a person to say "Yes, I saw it.", then other processing
  could continue while waiting. The only way to handle this is to use
  notifications.
  
- **Two iframes.** `host/sandbox.ts` is the SDK's outer sandbox proxy (port
  8081 = different origin), which loads the view into an inner iframe. It's
  copied unchanged from the SDK's `examples/basic-host`.
- **The fake server's tools aren't Attio's.** Check your `attio_tool_list.txt`
  for the real names and schemas. The agent code doesn't care; it passes
  whatever tools the facade offers.

## Layout

```
shared/types.ts          data shapes used everywhere
facade/main.ts           HTTP server, OAuth callback, startup
facade/attio-connection.ts  OAuth client + token file
facade/server.ts         tools, resource, forwarding (TODO)
facade/call-log.ts       call log (TODO)
view/monitor.{html,ts}   the MCP App (right pane)
host/index.html, host.ts the two-pane host page
host/sandbox.{html,ts}   sandbox proxy (from the SDK)
backend/main.ts          serves the page, sandbox origin, WebSocket
backend/agent.ts         agent loop (phases TODO)
dev/fake-attio.ts        fake Attio for testing
```
