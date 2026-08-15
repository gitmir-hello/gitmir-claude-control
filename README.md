<div align="center">

# GITMIR Claude Control

**See what a change will reach — before you let the agent make it.**

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-2fd8ff.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.18-2fd8ff.svg)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/runtime_deps-0-2fd8ff.svg)](#requirements)
[![Runs 100% local](https://img.shields.io/badge/runs-100%25_local-2fd8ff.svg)](SECURITY.md)
[![Telemetry](https://img.shields.io/badge/telemetry-none-2fd8ff.svg)](SECURITY.md)
[![by GITMIR](https://img.shields.io/badge/by-gitmir.com-2fd8ff.svg)](https://gitmir.com)

<br>

<img src="docs/img/impact-risk.png" alt="Business risk HIGH — reaches 72% of the product, 21 of 29 points, with every component of the score listed" width="920">

</div>

---

## The problem

Your agent can write the change. It cannot tell you what else depends on the code it is
about to touch, and neither can a diff — a diff shows files, not consequences.

So you approve on instinct. The refund function looked isolated; it turned out to sit on
the same lifecycle as payouts, and you found out in staging.

## What this gives you

A dashboard that reads your repository once and builds a model of the **product** — areas,
business objects, server functions, API endpoints, screens, events, processes, lifecycles —
linked by stable ids. Then it answers three questions your repo cannot.

### 1. What will this task change?

<img src="docs/img/impact-what.png" alt="A task's direct changes and the counts within two hops" width="900">

The task names the ids it will change. Everything within two hops is walked from the
model's own links — not declared by anyone, not guessed by an LLM.

`DECLARED` means the task said so on its `Touches:` line. If it didn't, the badge turns
amber and says the numbers came from what the task merely mentions — so you know how much
to trust them.

### 2. How much of the product does that reach — and why?

Risk is a **share of the product**, not a point score. 21 of 29 possible points is "most
of it" in a nine-module product and "a corner" in a ninety-module one, so the same change
does not get the same label in both.

Every component is on screen with its count and its weight. You can disagree with a
weight, change it, and see what moves. Two of the seven lines above are what usually
decides the call: **sensitive data reached** (money, credentials, personal data — marked
in the model, not inferred) and **user journeys affected** (someone walks through these;
breaking one is visible to them).

### 3. Where does it land?

<img src="docs/img/impact-graph.jpg" alt="Changes, the areas they reach, and the user journeys running through those areas" width="900">

Left to right: **what the task changes** → **the areas that reaches**, each stating how
much of it is in reach → **the journeys that run through those areas**.

On a real task, one hop out reaches over a hundred objects, so an area is a container
rather than a claim: **click it and it opens in place**, showing exactly which of its
objects are in reach. Esc goes back.

**Approve this change** writes an `Approved:` line into the task file. It travels with the
task, and whoever runs it sees it — including Claude, which is told never to edit that line
and to say so out loud before running something unapproved.

---

## 60 seconds

```bash
curl -fsSL https://raw.githubusercontent.com/gitmir-hello/gitmir-claude-control/main/install.sh | bash     # macOS · Linux
gitmir
```

<details>
<summary>Windows · npm · from a clone</summary>

```powershell
irm https://raw.githubusercontent.com/gitmir-hello/gitmir-claude-control/main/install.ps1 | iex            # Windows
gitmir
```

```bash
npm i -g github:gitmir-hello/gitmir-claude-control  # if you would rather npm did it
```

```bash
git clone https://github.com/gitmir-hello/gitmir-claude-control.git
cd gitmir-claude-control && node server.ts          # no installer at all
```

The installer clones into `~/.gitmir/claude-control` and links one command onto your
PATH. It downloads nothing from a package registry — Node runs the TypeScript directly,
the renderer is written for this project, and the fonts are in the repository. Run it
again to update, or `gitmir update`.

</details>

`gitmir` starts the dashboard and opens **http://localhost:4599** → add a project folder →
**▶ Run Claude** → paste the **`gitmir-model`** skill. Claude reads the repo, writes
`.gitmir/model/`, and every view above has something in it. No account, no build step, no
runtime dependencies.

| | |
|---|---|
| `gitmir` | start it and open the browser |
| `gitmir mcp add` | register the MCP server with the Claude Code CLI, so your agent answers from the same model |
| `gitmir status` | Node version, port, what is missing |
| `gitmir update` | pull the latest, and restart if it was running |

Want to look before pointing it at your own code? Add
[`examples/refund-shop`](examples/refund-shop) — an invented shop with a model and two
planned tasks. Every screenshot in this README is that project.

---

## Twelve skills, grouped by when you need them

<img src="docs/img/skills.png" alt="The skill cards: understand what exists, decide what to build, build and prove it, work on code you inherited" width="960">

Click a card, paste into Claude. They are plain markdown in [`skills/`](skills) — read them,
change them, keep your own.

| | |
|---|---|
| **Understand what exists** | `gitmir-model` builds the model from real code · `model-ingest` does it for a codebase too big to read in one pass · `model-navigate` answers architectural questions by walking ids instead of re-reading the repo |
| **Decide what to build** | `product-docs-spec` turns a client's description into a `docs/` folder precise enough to build from · `context-distillation` compresses a pile of tickets and threads into a brief that fits |
| **Build and prove it** | `task-planner` writes tasks that carry their own checks · `task-runner` works the queue to empty · `app-audit` walks the running app end to end · `task-log` keeps the record |
| **Work on code you inherited** | `legacy-maintenance` changes an old system without breaking what sits next to it · `stack-port` moves it to a new stack, with a parity ledger |
| **Prove it does what you promised** | `spec-audit` reads the written rules against the code and records every disagreement where it will be seen again |

**→ [What each one does](docs/SKILLS.md)**

---

## Where the code disagrees with the product

Your agent reads the spec against the code and finds fifteen places they disagree. It
writes them in a reply, and they are gone when the conversation ends — the agent that
edits one of those functions next week does not know, and neither does whoever approves
the change.

`spec-audit` records them instead. Each one names the rule, what the code does instead,
what that costs, and the objects it sits on:

- the object is **drawn as deviating on every diagram** — colour, so the mark survives at
  the zoom where labels disappear
- the **radius warns** before anyone approves a change that reaches it
- the **context handed to an agent carries it**, so it cannot plan against rules the code
  does not follow
- deciding to **live with one records who decided and why** — the difference between a
  product with known limits and a product with surprises

A finding remembers the files it was read from. When one changes, it asks to be re-checked
rather than going on asserting something about code that has moved.

## Why "done" means something here

A specification is written by a person, from memory, about a system too large to hold in
one head. The checks then cover what that person happened to think of — and the agent
grades its own homework.

Here the model is read out of the code, the reach of a change is walked from it, **that
reach becomes the `## Verify` steps**, and a task moves to `done` only when they pass.

**→ [How it works](docs/HOW-IT-WORKS.md)**

---

## The same answers inside your editor

`mcp.ts` serves the model over [MCP](https://modelcontextprotocol.io), so Claude Code,
Cursor, or anything else that speaks it can ask what something is, what breaks if it
changes, what a task would touch, what changed in the product last month, and queue or
approve work — without leaving the editor.

```bash
gitmir mcp add        # or `gitmir mcp` to print the config for another editor
```

```json
{ "mcpServers": { "gitmir": {
    "command": "node",
    "args": ["/path/to/gitmir-claude-control/mcp.ts", "--project", "/path/to/your/project"] } } }
```

Your editor starts it as a subprocess and talks over stdin/stdout. **No port, no network,
and the dashboard does not need to be running** — two programs, the same files, the same
arithmetic, so they cannot give you different answers. Every reply states how fresh the
model is, because there is no amber banner in someone else's editor.

See what your editor will see, before wiring one up:

```
node mcp-check.ts examples/refund-shop tools
node mcp-check.ts examples/refund-shop impact 010-partial-refund.md
```

**→ [The MCP server](docs/MCP.md)**

---

## The rest of the dashboard

The Model section is arranged by the question you arrived with, not by the shape of the
data. Every view opens by saying what it is, what it gives you, and how to use it.

| The question | What answers it |
|---|---|
| **What does it do?** | the product map, the journeys people walk, the business objects, where data moves between areas, and what raises a signal |
| **Why does it work this way?** | the lifecycle of each object, and every branch with the condition it actually checks |
| **What would a change cost?** | what a task reaches, how much of the product that is, and whether anything sensitive is in it |
| **Who answers for it?** | the owning team per area — and the areas nobody has claimed, drawn as the gap they are |
| **How much should I trust it?** | where the model is solid, where it is guessing, and what it does not know yet |
| **What actually happened?** | where the code does not do what the product says, what changed between two dates, whether finished work stayed inside the scope it declared, and the record in order |

Alongside it: **Queue** (`todo → in progress → verify → done`, each card carrying its risk
and its approval) and **Preview** (open any URL, click an element, get a prompt naming it
and the files it probably lives in).

Every diagram opens. An area holds its objects, a transition holds what it fires — so the
top level stays a size you can take in, and the detail is one click inside it rather than a
wall of nodes you have to read past.

<img src="docs/img/map-open.jpg" alt="The Orders area opened in place, showing the objects, screens and endpoints inside it" width="920">

A lifecycle reads as the chain it is — `created → paid → delivered → refunded` — with each
transition carrying the effects that fire on it, folded inside until you ask:

<img src="docs/img/lifecycle.jpg" alt="An order lifecycle: states, the transitions between them, and a transition holding two effects" width="920">

They are drawn on a canvas by a renderer written for this. That is why there is no layout
library in `vendor/` any more, and why a map exported to a single file is 714 KB rather
than 2.3 MB.

---

## The rules

**Your code never leaves your machine.** Claude runs locally, the model is built locally,
everything lives in your repo. **No telemetry, ever.** ([SECURITY.md](SECURITY.md))

**Team.** Solo is free forever. The **Team bridge** lets teammates run this same tool and
see your model, see which checks passed, and send you tasks that land in your
`tasks/todo/`. The server routes messages and stores no business logic. **$19/month per
builder, viewers free** — sharing a read-only map is free on any plan.
**→ [ide.gitmir.com](https://ide.gitmir.com)**

**Requirements.** [Node.js](https://nodejs.org) 22.18+ (it runs the TypeScript directly —
`node server.ts` is the whole build system), the `claude` CLI on your `PATH`, macOS ·
Windows · Linux. `dependencies` is empty and staying that way: the diagrams are drawn by a
renderer written for this, and the fonts are vendored, so it works offline. Port 4599, or `GITMIR_PORT=4600 node server.ts`. Desktop
shortcut: `bash install-shortcut.command` (macOS) · `install-shortcut.cmd` (Windows).
`curl -fsSL https://raw.githubusercontent.com/gitmir-hello/gitmir-claude-control/main/install.sh | bash` installs the `gitmir` command; reading
[`install.sh`](install.sh) before running it is the correct instinct and it is kept short
for that reason.

**License.** Dual: **[AGPL-3.0](LICENSE)** — free, fork it, use it for paid work; distribute
a modified version as a service and your source goes AGPL too. Or a **[commercial
license](LICENSING.md)** for closed-source embedding or hosting — **hello@gitmir.com**.

---

<div align="center">

We built this for ourselves — we run Claude Code all day across dozens of projects.

**[Did it run on your machine?](https://github.com/gitmir-hello/gitmir-claude-control/discussions/1)**
There is no telemetry, so that thread is the only way we learn anything — especially
whether the model matched your product, and where it got it wrong.

🌐 **[gitmir.com](https://gitmir.com)** · 🚀 **[ide.gitmir.com](https://ide.gitmir.com)** · ✉️ **hello@gitmir.com**

<sub>© GITMIR · bundled libraries and fonts ship under their own licenses ([THIRD_PARTY.md](THIRD_PARTY.md)) · the GITMIR name and logo are trademarks</sub>

</div>
