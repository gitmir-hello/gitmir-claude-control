# The MCP server — the model, inside your editor

The dashboard draws your product model for a person. The MCP server serves the same
model, as text, to whatever agent you already work in — Claude Code, Cursor, or
anything else that speaks [MCP](https://modelcontextprotocol.io).

Both read the same files on disk and share the same arithmetic (`lib/impact.js`), so
they cannot answer the same question two different ways.

## Where it runs

On your machine, as a subprocess your editor starts. It speaks
[stdio](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) —
JSON-RPC over stdin and stdout.

- **No port, no network.** Nothing is served, nothing is uploaded.
- **The dashboard does not need to be running.** They are two programs reading the
  same files.
- **ide.gitmir.com is not involved.** It stores no business logic by design, so
  there would be nothing there to read.

## Setup

Point your MCP client at `mcp.ts` in this repository:

```json
{
  "mcpServers": {
    "gitmir": {
      "command": "node",
      "args": ["/path/to/gitmir-claude-control/mcp.ts",
               "--project", "/path/to/your/project"]
    }
  }
}
```

`--project` is optional — without it the server uses the directory your client
launched it in, and every tool also takes a `project` argument that wins over both.
That is how one entry can answer about several repositories.

> The config file's location and key names are set by your client, not by the MCP
> spec. The shape above is what most clients use; check your client's own docs for
> where the file lives.

Requires Node 22.18+ — the same requirement as the dashboard, and for the same
reason: Node runs the TypeScript directly, so there is nothing to build.

## The tools

| Tool | Answers |
|---|---|
| `gitmir_model` | What is this product? Areas, business objects, functions, endpoints, screens, events, processes, lifecycles. Summary by default; pass `dimension` or `q` for detail. |
| `gitmir_navigate` | What is this one thing, and what breaks if it changes? Walks the id links both ways — inbound is the direction that gets forgotten. |
| `gitmir_impact` | What would this change reach, and how risky is it? Takes `ids`, or a `task` file name from the queue. Returns the downstream objects, the areas, the user journeys, and the risk with its arithmetic. |
| `gitmir_queue` | What work is planned, what does each task touch, what is approved? |

Every answer opens with how fresh the model is. If the code has moved since the model
was built, the answer says **STALE** and names the file that moved most recently — the
dashboard shows that as an amber banner, and in your editor there is no banner, so it
travels in the text instead.

## It needs a model

The server reads `.gitmir/model/` — the id-linked map of your product that the
`gitmir-model` skill builds from your code. **A project without one has nothing to
answer from**, and every tool will say so and point at the skill rather than return an
empty result.

Building it is one pass over the repository. After that the MCP server, the dashboard,
and the task queue all read the same model.

To see it working before pointing it at your own code, use
[`examples/refund-shop`](../examples/refund-shop) — an invented shop with a model and
two planned tasks.

## What it does not do

- **No writes yet.** Creating and approving tasks happens in the dashboard. Those are
  the next tools.
- **No repository reading.** It answers from the model. If the model is wrong, the
  answer is wrong — which is why freshness is in every response.
- **No skills yet.** MCP has a prompts primitive; carrying the skills through it, so
  `gitmir-model` can be run without copy-paste, is the step after writes.
