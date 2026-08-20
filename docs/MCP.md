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

One command, if you installed with the installer:

```bash
gitmir mcp add          # every project
gitmir mcp add-here     # or pin it to this repo, in a .mcp.json you commit
```

It registers at **user scope** on purpose. `claude mcp add` defaults to `local`, which
stores the registration in whichever directory you happened to run it from — so somebody
who runs it once and then opens their editor in a project finds nothing there and
reasonably concludes it did not work. At user scope the server is available everywhere and
answers about whichever folder the editor was opened in.

All twelve skills arrive with it, as prompts — most clients surface those as slash
commands — and as tools the agent can call on its own. Nothing is pasted.

Point another MCP client at `mcp.ts` in this repository instead:

```json
{
  "mcpServers": {
    "gitmir": {
      "command": "node",
      "args": ["/path/to/gitmir-local/mcp.ts",
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
node mcp-check.ts examples/refund-shop history
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
| `gitmir_history` | How has the product changed? Compares two versions of the model and names what was gained, lost and renamed. Reads the versions your repository already holds — nothing is stored for it. |
| `gitmir_flag` | Record that the code does not do what the product says. Written at the moment it is noticed, in one call — a finding described only in a reply is gone when the conversation ends. |
| `gitmir_design` | What somebody declared the product should become, and how much of it exists. Each element lists what it has to end up doing. Call it before starting work and again after rebuilding the model — an element is done only when the model records every relationship the design declared, not when code appears. |
| `gitmir_attention` | What needs a person right now, worked out from the model: the code having moved past it, deviations whose files have since changed, planned work reaching further than its ticket says, tasks queued without approval, parts nobody owns. Each item says what closes it. Call it at the start of a session instead of asking what to do. |
| `gitmir_findings` | What is already known to be wrong, what was accepted on purpose and by whom, and what needs re-checking because the code has moved since. |
| `gitmir_accept_finding` | Record the decision: accepted (needs a name and a reason), fixed, or reopened. |
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

### Saying what it is doing

`gitmir_progress` exists because the person watching the dashboard cannot see the
chat. Building a model takes minutes, and for all of them the screen would
otherwise say "waiting" with nothing behind it. The agent reports `started`,
`reading`, `writing`, `done` — and, the one that matters, `blocked`, with the
question it is waiting on.

That last case is the one that strands people: the agent stopped to ask something
perfectly reasonable, and the person is looking at a different window entirely. A
`blocked` report puts the question on the screen they are already watching.

It writes one line to `.gitmir/progress.json` and nothing else, and the dashboard
deletes it the moment the model appears — a status line that outlives its job stops
being believed. Nothing depends on it: pasted in as plain text with no tools at
all, the procedure writes the same file itself.

That is the whole reason those two are tools rather than prompts. A prompt is
user-controlled: it appears as a slash command and waits to be typed. A tool is
model-controlled, so the agent can reach for the procedure the moment it finds
it needs one.

`gitmir_setup` only ever creates folders and a list entry. It never touches code.

## Every answer leaves a line

The server appends one line to `.gitmir/usage.jsonl` for each answer it serves:
the tool, what was asked, the size of the answer, how many model objects it
covered, and how big the files are that those objects live in.

That last pair is the point. It is not an estimate of what an agent would
otherwise have read — it is a measurement of this repository: these objects, these
files, this many bytes. The dashboard's first screen adds them up, and anybody can
read the file and check the arithmetic.

Nothing is sent anywhere. The record exists so the no-telemetry claim is
checkable instead of merely stated.

## Where a finding lives, and why not in the model

`gitmir_flag` writes one file into `.gitmir/findings/` — deliberately next to the model
rather than inside it.

The model is derived from code and rebuilt whole. A rebuild on a real project dropped an
entity, an area and two lifecycles; a person's judgement written into the same files would
eventually be thrown away the same way. A finding is not an extraction — it is somebody's
reading of the gap between two descriptions of the product, and it has to outlive every
rebuild of one of them.

It is also not a task. A task is work somebody intends to do. Half of these are never
worked at all: they are accepted, on purpose, by somebody who writes down why — and that
signed decision is the part worth keeping.

Findings carry the files they were read from. When one of those files changes, the finding
says **re-check** rather than continuing to assert something about code that has moved.

## Where the history comes from

`gitmir_history` answers "what changed last month" from the versions of
`.gitmir/model` in your project's own git log. Nothing is stored for it, and that
is the point: a repository that ran for a year before it ever saw GitMir already
has the record, dated, attached to the commit message that says what was being
done at the time.

The consequence is a requirement: **commit `.gitmir/model`**. A project that
ignores it has one version — the current one — and no way to see a rebuild
quietly drop an entity. The tool says which of those two situations you are in
rather than returning an empty answer.

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

The server also serves all twelve skills as MCP **prompts** — most clients surface
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
| `gitmir_model` · `gitmir_navigate` · `gitmir_impact` · `gitmir_queue` · `gitmir_history` · `gitmir_findings` · `gitmir_attention` · `gitmir_design` · `gitmir_skills` · `gitmir_skill` | yes | no | yes | no |
| `gitmir_flag` | no | no | **yes** | no |
| `gitmir_accept_finding` | no | **yes** | no | no |
| `gitmir_setup` | no | no | **yes** | no |
| `gitmir_create_task` | no | no | **no** | no |
| `gitmir_approve` | no | **yes** | no | no |

`gitmir_create_task` is not idempotent because calling it twice queues the work twice.
`gitmir_flag` is idempotent because flagging the same rule on the same object updates the record rather than writing a second copy — which is what a re-audit should do. `gitmir_accept_finding` is destructive because reopening drops the signature off a decision somebody made.

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
- **No pagination cursors.** Fifteen tools and twelve prompts fit in one response. A
  `cursor` is accepted and ignored rather than rejected, so a paginating client works.
