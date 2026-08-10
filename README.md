<div align="center">

# GITMIR Claude Control

**See what a change will break — before you let the agent make it.**

A local dashboard that builds a living model of your product from your own code,
then uses it to answer what a diff cannot: *what will this task touch*, and
*did it actually work*.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-2fd8ff.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.18-2fd8ff.svg)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/runtime_deps-0-2fd8ff.svg)](#requirements)
[![Runs 100% local](https://img.shields.io/badge/runs-100%25_local-2fd8ff.svg)](SECURITY.md)
[![Telemetry](https://img.shields.io/badge/telemetry-none-2fd8ff.svg)](SECURITY.md)
[![by GITMIR](https://img.shields.io/badge/by-gitmir.com-2fd8ff.svg)](https://gitmir.com)

<br>

<img src="docs/img/demo.gif" alt="GITMIR Claude Control — demo" width="920">

</div>

---

## 60 seconds

```bash
git clone https://github.com/gitmir-hello/gitmir-claude-control.git
cd gitmir-claude-control
node server.ts
```

**http://localhost:4599** → add a project folder → **▶ Run Claude** → paste the
**`gitmir-model`** skill. Claude reads the repo, writes `.gitmir/model/`, and the
dashboard comes alive. No account, no build step, zero runtime dependencies.

Want to see it before pointing it at your own code? Add
[`examples/refund-shop`](examples/refund-shop) — an invented shop with a model
and two planned tasks, so every view has something to show.

---

## Impact — what a task will change, before it runs

Open a queued task:

```
Business risk  HIGH   reaches 32% of the product · 134 of 417 points

   10 × 2   module boundaries crossed     a change inside one area is a smaller
                                          thing than one that spans several
    7 × 3   user journeys affected        someone walks through these — breaking
                                          one is visible to them
    5 × 3   lifecycles touched            state machines carry effects that fire
                                          on every transition
```

Then it is drawn, left to right: **what the task changes** → **the areas that
reaches**, each stating what of it is in reach (*"2 objects · 6 functions ·
3 endpoints · 7 screens"*) → **the user journeys that run through those areas**.

- **The arithmetic is on screen** — every component with its count, its weight and
  why it counts. A number nobody can check is a number nobody argues with.
- **Risk is a share of the product, not a point score** — 30 points is "most of it"
  in a nine-module product and "a corner" in a ninety-one module one.
- **Nothing is declared** — the reach is walked along the model's own links, from
  what the task names to what sits downstream of it.

**Approve this change** writes an `Approved:` line into the task file. It travels
with the task and whoever runs it sees it — including Claude, which is told never
to edit that line and to say so out loud before running something unapproved.

---

## The rest

| | |
|---|---|
| **Product map** | the product as areas a client recognises — with layers for **Heat**, **Risk**, **Ownership** and **This change** |
| **Journeys · Business logic · Decisions · Events · Data** | how it works: the paths people walk, entity lifecycles, every branch and its condition, event chains, the data and where it moves |
| **Queue** | `todo → in progress → verify → done`, each card carrying its risk and its approval |
| **Timeline** | the product changing, in the order it changed |
| **Preview** | open any URL, click an element, get a prompt naming it and the files it probably lives in |

Click anything on any diagram: what it reaches, who may use it, which tasks changed
it — and the exact context to paste into Claude, assembled by walking id-links
rather than by guessing what is relevant.

| | |
|---|---|
| [<img src="docs/img/03-model-business-logic.png" alt="Business logic">](docs/img/03-model-business-logic.png) | [<img src="docs/img/07-queue.png" alt="Queue">](docs/img/07-queue.png) |

---

## Why the checks are worth anything

A specification is written by a person, from memory, about a system too large to
hold in one head — so the checks cover what that person thought of, and the agent
grades its own homework. Here the model is read out of the code, the reach of a
change is walked from it, **that reach becomes the `## Verify` steps**, and a task
reaches `done` only when they actually pass.

**→ [How it works](docs/HOW-IT-WORKS.md)** · **→ [The skills](docs/SKILLS.md)**

---

## The same model, inside your editor

`mcp.ts` serves the model over [MCP](https://modelcontextprotocol.io) — so Claude Code,
Cursor, or anything else that speaks it can ask *what is this*, *what breaks if I change
it*, *what would this task touch and how risky is it*, without leaving the editor.

```json
{ "mcpServers": { "gitmir": {
    "command": "node",
    "args": ["/path/to/gitmir-claude-control/mcp.ts", "--project", "/path/to/your/project"] } } }
```

Your editor starts it as a subprocess and talks to it over stdin/stdout. **No port, no
network, and the dashboard does not need to be running** — they are two programs reading
the same files, sharing the same arithmetic, so they cannot disagree. Every answer says
how fresh the model is, because there is no amber banner in someone else's editor.

**→ [The MCP server](docs/MCP.md)**

---

## The rules

**Your code never leaves your machine.** Claude runs locally, the model is built
locally, everything lives in your repo. **No telemetry, ever.**
([SECURITY.md](SECURITY.md))

**Team.** Solo is free forever. The **Team bridge** lets teammates run this same
tool on their machines and see your model, see which checks passed, and send you
tasks that land in your `tasks/todo/`. The server routes messages and stores no
business logic. **$19/month per builder, viewers free** — sharing a read-only map
is free on any plan. **→ [ide.gitmir.com](https://ide.gitmir.com)**

**Requirements.** [Node.js](https://nodejs.org) 22.18+ (it runs the TypeScript
directly — `node server.ts` is the whole build system), the `claude` CLI on your
`PATH`, macOS · Windows · Linux. `dependencies` is empty and staying that way: ELK
and the fonts are vendored, so it works offline. Port 4599, or
`GITMIR_PORT=4600 node server.ts`. Desktop shortcut:
`bash install-shortcut.command` (macOS) · `install-shortcut.cmd` (Windows).

**License.** Dual: **[AGPL-3.0](LICENSE)** — free, fork it, use it for paid work;
distribute a modified version as a service and your source goes AGPL too. Or a
**[commercial license](LICENSING.md)** for closed-source embedding, hosting, or a
signed agreement — **hello@gitmir.com**.

---

<div align="center">

We built this for ourselves — we run Claude Code all day across dozens of projects.
It turned out useful enough to share.

**[Did it run on your machine?](https://github.com/gitmir-hello/gitmir-claude-control/discussions/1)**
There is no telemetry, so that thread is the only way we learn anything — especially
whether the model matched your product, and where it got it wrong.

🌐 **[gitmir.com](https://gitmir.com)** · 🚀 **[ide.gitmir.com](https://ide.gitmir.com)** · ✉️ **hello@gitmir.com**

<sub>© GITMIR · bundled libraries and fonts ship under their own licenses ([THIRD_PARTY.md](THIRD_PARTY.md)) · the GITMIR name and logo are trademarks</sub>

</div>
