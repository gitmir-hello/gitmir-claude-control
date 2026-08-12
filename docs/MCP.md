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

- **No port, nothing uploaded.** The server listens on nothing. The one exception
  to "no network" is `gitmir_setup`, which asks a dashboard running on this machine
  to add the folder — and writes the list itself when nothing answers.
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

## Seeing it work before you wire it up

An MCP server has no screen, which makes a broken setup hard to tell from a working
one. `mcp-check.ts` speaks the protocol and prints the answer for a person:

```
node mcp-check.ts examples/refund-shop init      # handshake — version, name, what it offers
node mcp-check.ts examples/refund-shop tools     # the tools and their behaviour hints
node mcp-check.ts examples/refund-shop model     # what this product is
node mcp-check.ts examples/refund-shop impact 010-partial-refund.md
node mcp-check.ts                                # every command
```

It starts `mcp.ts` as a subprocess and stops it again — the same thing your editor
does. Point it at your own project and you see exactly what an agent would read.

Three of its commands write: `new`, `approve`, `withdraw`. The rest only read.

## The tools

| Tool | Answers |
|---|---|
| `gitmir_setup` | Prepares a project: puts it on the dashboard, creates the task queue, and says what is still missing. Call it the first time you touch a project, or whenever another tool says there is no model. |
| `gitmir_skills` · `gitmir_skill` | The written procedures and their full text. Prompts only fire when a person types a slash command; these are tools, so the agent can fetch a procedure and follow it on its own. |
| `gitmir_model` | What is this product? Areas, business objects, functions, endpoints, screens, events, processes, lifecycles. Summary by default; pass `dimension` or `q` for detail. |
| `gitmir_navigate` | What is this one thing, and what breaks if it changes? Walks the id links both ways — inbound is the direction that gets forgotten. |
| `gitmir_impact` | What would this change reach, and how risky is it? Takes `ids`, or a `task` file name from the queue. Returns the downstream objects, the areas, the user journeys, and the risk with its arithmetic. |
| `gitmir_queue` | What work is planned, what does each task touch, what is approved? |
| `gitmir_create_task` | Turn a finding into queued work. Refuses to write a task with no `verify` steps — a requirement you cannot check is a wish, not a task — and shows the impact of what it just wrote. |
| `gitmir_approve` | Record that a task is approved to run, or withdraw it. Writes the `Approved:` line that travels with the task. |

Every answer opens with how fresh the model is. If the code has moved since the model
was built, the answer says **STALE** and names the file that moved most recently — the
dashboard shows that as an amber banner, and in your editor there is no banner, so it
travels in the text instead.

## Setting a project up without doing it by hand

Connect the server, then tell your agent *set this project up with GitMir*. It
calls `gitmir_setup`, which registers the folder with the dashboard — asking a
running one over its own API, or writing the list itself if nothing answers —
creates `tasks/todo|inprogress|verify|done`, and reports what is left. If the
model is missing it says so and points at `gitmir_skill("gitmir-model")`, which
hands back the procedure in full for the agent to carry out.

That is the whole reason those two are tools rather than prompts. A prompt is
user-controlled: it appears as a slash command and waits to be typed. A tool is
model-controlled, so the agent can reach for the procedure the moment it finds
it needs one.

`gitmir_setup` only ever creates folders and a list entry. It never touches code.

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

## The skills, without copy-paste

The server also serves all eleven skills as MCP **prompts** — most clients surface
those as slash commands. So `gitmir-model` is one command away in the same session
that just told you there is no model, instead of a trip to the dashboard to copy text.

Each prompt takes an optional `note` for the run ("focus on `src/`", "the spreadsheet
is the source"), and the project path is filled in for you.

Prompts are user-controlled by design, which is the right shape here: nobody wants an
agent deciding on its own to re-model the repository.

## What each tool admits about itself

Every tool carries the spec's behaviour hints, and they are literal — a client may skip
its confirmation prompt on the strength of one, so a hint that shades the truth is worse
than no hint at all.

| Tool | read-only | destructive | idempotent | open world |
|---|---|---|---|---|
| `gitmir_model` · `gitmir_navigate` · `gitmir_impact` · `gitmir_queue` · `gitmir_skills` · `gitmir_skill` | yes | no | yes | no |
| `gitmir_setup` | no | no | **yes** | no |
| `gitmir_create_task` | no | no | **no** | no |
| `gitmir_approve` | no | **yes** | no | no |

`gitmir_create_task` is not idempotent because calling it twice queues the work twice.
`gitmir_approve` is marked destructive because `withdraw` removes a line from a file
that exists — even though the common path only adds one. Nothing here is open-world:
the only thing any tool touches is this machine's own `.gitmir/` and `tasks/` folders.

## What it does not do

- **No repository reading.** It answers from the model. If the model is wrong, the
  answer is wrong — which is why freshness is in every response.
- **No structured content.** The spec allows a machine-readable object alongside the
  text. The consumer here is a model reading prose, and the arithmetic it needs is in
  the prose already; a second serialization would double the payload to serve client
  code that does not exist yet.
- **No pagination cursors.** Six tools and eleven prompts fit in one response. A
  `cursor` is accepted and ignored rather than rejected, so a paginating client works.
