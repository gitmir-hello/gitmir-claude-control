<div align="center">

# GITMIR Claude Control

**Your agent says the task is done. This is the tool that checks.**

A local queue where writing the code doesn't finish the work — the acceptance
checks have to actually run first. Built on a living model of your product, so
the checks cover what the change really touches instead of what you happened to
remember.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-2fd8ff.svg)](LICENSE)
[![Commercial license](https://img.shields.io/badge/commercial_license-available-2fd8ff.svg)](LICENSING.md)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.18-2fd8ff.svg)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-macOS%20·%20Windows%20·%20Linux-2fd8ff.svg)](#requirements)
[![Dependencies](https://img.shields.io/badge/runtime_deps-0-2fd8ff.svg)](#)
[![TypeScript](https://img.shields.io/badge/TypeScript-no_build_step-2fd8ff.svg)](#)
[![Runs 100% local](https://img.shields.io/badge/runs-100%25_local-2fd8ff.svg)](SECURITY.md)
[![Telemetry](https://img.shields.io/badge/telemetry-none-2fd8ff.svg)](SECURITY.md)
[![by GITMIR](https://img.shields.io/badge/by-gitmir.com-2fd8ff.svg)](https://gitmir.com)

<br>

<img src="docs/img/demo.gif" alt="GITMIR Claude Control — demo" width="920">

<sub>Pick a project → <b>▶ Run Claude</b> → copy the <code>gitmir-model</code> skill → open <b>Model</b> and see the product's business logic and data flows — laid out by <a href="https://github.com/kieler/elkjs">ELK</a> in the GITMIR HUD.</sub>

</div>

---

## The problem

Agents got good at writing code and stayed bad at knowing whether it worked.

That gap is the story of 2026. Adoption of AI coding tools hit a record **84%**
while trust hit a record low: **3%** of developers say they highly trust the
output, **96%** will not ship it without checking by hand, and **53%** say AI has
made their technical debt *worse* — by producing code that looks correct and is
not ([Stack Overflow Developer Survey 2026](https://byteiota.com/stack-overflow-dev-survey-2026-ai-at-84-trust-at-3/),
[Sonar's 2026 developer survey](https://thenewstack.io/agentic-ai-verification-impact/)).

Writing the specification first was the industry's answer, and it is a good one —
right up to the part people are now complaining about:

> Coding agents marked **"verify implementation" tasks as complete without writing
> a single test**, producing manual testing instructions instead. The spec
> provided the intent; the execution still drifted.

and

> Automated checks **only catch the gaps somebody configured them to catch.**

Both failures have one root. A specification is written by a person, from memory,
about a system too large to hold in one head. So the checks cover what that person
thought of — and then the agent grades its own homework.

**This tool closes both, with a mechanism rather than with discipline.**

## 60 seconds

```bash
git clone https://github.com/gitmir-hello/gitmir-claude-control.git
cd gitmir-claude-control
node server.ts
```

Opens on **http://localhost:4599**. Add a project folder → **▶ Run Claude** →
paste the **`gitmir-model`** skill. Claude reads the repo and writes
`.gitmir/model/`. The **Model** tab lights up: entity lifecycles, ER, data flows,
processes.

No account. No sign-in. No install beyond `git clone` — **zero runtime
dependencies**. Node runs the TypeScript directly: no build step, no bundler, no
`dist/`.

---

## How the checking actually works

Four links. Every one of them is a rule in a skill you can open and read — the
file is named at each step, so none of this has to be taken on trust.

### 1. The model comes from the code, not from anyone's memory

`gitmir-model` reads the repository and writes `.gitmir/model/` — ten linked
collections, every reference a stable id, so they form **one graph** instead of
ten lists:

`modules` · `entities` · `serverUnits` · `serverFunctions` · `apiRoutes` ·
`frontendUnits` · `events` · `processes` · `statusFlows` · `reactions`

Plain JSON in your repo. Diff it, review it in a PR, grep it. It is not
documentation that rots: the skill installs a standing rule in the project's
`CLAUDE.md`, so every later session reads the model first and refreshes it after
changing code.

Look at the last four collections. Most tools in this space build a *code* graph —
functions, calls, imports. This is a **product** graph. A code graph answers
*"what calls `updateOrder`"*. This answers *"how does an order get from `placed`
to `refunded`, what fires when it does, and which three services read the field
you are about to rename"*.

### 2. Navigation follows the links that tell you what breaks

From [`skills/model-navigate.md`](skills/model-navigate.md):

> Traverse **inbound as well as outbound**. Outbound tells you what this thing
> uses; inbound tells you what breaks when you change it, and inbound is the one
> that gets forgotten.

It has a named answer for *"what breaks if I remove X"* and for estimating a blast
radius before a refactor — including the trap that a **field** needs a name-based
pass as well as an id search, or the answer is quietly wrong.

Deterministic graph traversal. Nothing guessing what is relevant.

### 3. That blast radius becomes the checks

This is the link that matters. From
[`skills/task-planner.md`](skills/task-planner.md):

> **Cover what the change could break nearby.** Use `.gitmir/model/` to see what
> else reads or writes the fields you touched, **and add a step for it.**

> **Every task needs a `## Verify` section.** A task with no way to check it is not
> ready to run — a requirement you cannot check is a wish, not a task.

So how much your acceptance criteria cover stops being a function of *who wrote
the spec and what they remembered*, and becomes a function of *what the code
actually does*. That is the difference between this and every specification
workflow: **the checks are derived, not recalled.**

The planner also covers the negative case — the invalid input, the empty list, the
unauthorised call — and marks a step `(manual)` where only a human can judge it,
rather than inventing a fake automated check.

### 3b. And you can see that radius before you agree to the change

The planner writes a `Touches:` line naming the model objects a task will change.
The **Impact** view walks those ids through the model and shows what sits
downstream — the data, the endpoints, the screens, the events, the flows a person
walks through — then scores it:

    Business risk  MEDIUM   reaches 20% of the product · 81 of 409 points

    1 × 2   module boundaries crossed     a change inside one area is a smaller thing
    1 × 3   user journeys affected        someone walks through these
    2 × 1   screens in reach              what a user would see change

The score is a **share of the product**, not a raw number: 30 points means "most
of it" in a nine-module product and "a corner" in a ninety-one module one, so it
is divided by what the whole product would score. Every component is shown with
its count and its weight, because a number nobody can check is a number nobody
trusts.

**Approve this change** writes an `Approved: <when> by <who>` line into the task
file. It travels with the task through the queue and whoever runs it can see it —
including Claude, which is told never to edit that line and to say out loud when
it is about to run something unapproved.

There is also a **what-if**: pick objects by hand and read the same analysis
before any task exists.

### 3c. What has been changing, and where

The same link — task to model object — read backwards gives the product's own
history. **Timeline** lists every task that named part of the model, oldest first,
with what it touched. The product map takes **layers** over the same structure:

| Layer | What it paints |
|---|---|
| Heat | how often work has touched each area |
| Risk | what a change there would reach |
| Ownership | who is accountable, as recorded in the model |
| This change | where the task picked in Impact lands — solid where it changes something, faint where the change arrives on its own |

None of it is declared. Heat is counted from real tasks, risk is walked from real
links, and ownership is blank rather than guessed when the model does not say.

### 4. The checks get run for real, and a failure is not a `done`

From [`skills/task-runner.md`](skills/task-runner.md):

> **Actually execute each step.** Run the command, make the call, read the output.
> Never mark a step PASS because the code "looks right" — that is the failure this
> whole stage exists to prevent.
>
> Record the **real** observed result on a failure (what you got vs what was
> expected). That text becomes the fix task's context.

The runner works `todo → in progress → verify → done` and records each check under
a `## Verification` heading in the task file itself:

```
1. GET /api/orders/42 → PASS: 200, body has total 1980
2. Order moves placed → paid on webhook → PASS: status=paid in DB
3. POST /api/orders with {"items":[]} → FAIL: responded 500, expected 400
```

All pass → **done**. One fails → the task **stays in `verify/`**, built but
unproven, and the runner writes the fix task itself, carrying the failed step
verbatim and the result it actually observed.

### And keeping the model current is itself one of the checks

> **If the task changes code and the project has a `.gitmir/model/`, add a step for
> the model itself** — "`.gitmir/model/` describes the new field / route /
> transition, ids unchanged, `index.json` refreshed". The model is what every later
> task is briefed from; if it silently lags, every one of them is briefed from
> fiction.

Specifications drift because everybody may edit them and nobody reconciles them.
Here nobody has to reconcile: a task that let the model fall behind **does not
reach `done`**, for exactly the same reason as any other failing check.

---

## What this does not do

**The checks are only as complete as the model.** If the model missed a link, the
checks miss it too. There is no honest way around that, and anybody claiming total
coverage is claiming something nobody can deliver.

What makes it survivable is that the holes are **recorded rather than silent**. On
a source too large to read in one pass, `model-ingest` measures it, cuts it into
fragments that each fit in one context, and every reference a fragment cannot
resolve — fragment 7 calling a function that fragment 24 will define — is written
to `.gitmir/ingest/unresolved.json` **with its `file:line` evidence, never
invented and never dropped.** A final stitch pass closes what it can and reports
what stayed open.

Which is the whole design philosophy in one line:

> **A model with twelve recorded unknowns is trustworthy; a model with twelve
> invented links is not, and looks identical from the outside.**

---

## What else you get

<img src="docs/img/01-dashboard-settings.png" alt="Dashboard — Settings tab" width="100%">

- **All your projects on one screen.** Add any folder on any disk; launch `claude`
  in it with one click (macOS Terminal · Windows `cmd` · Linux terminals). No more
  `cd` archaeology across three drives.
- **Model** — the product's business logic drawn from your real code.
- **Queue** — the task board, with the checks and what each one actually did.
- **Tasks** — a live log of what Claude did in this project.
- **Preview** — open any URL, click an element on the page, get a prompt naming it
  and the files it probably lives in.
- **Skills** — reusable instructions you copy into Claude with one click.

| Business logic — entity lifecycle | Data flow |
|---|---|
| [<img src="docs/img/03-model-business-logic.png" alt="Model — Business logic">](docs/img/03-model-business-logic.png) | [<img src="docs/img/05-data-flow.png" alt="Model — Data flow">](docs/img/05-data-flow.png) |
| **Tasks — what Claude did** | **Order state machine (fullscreen)** |
| [<img src="docs/img/02-tasks.png" alt="Tasks tab">](docs/img/02-tasks.png) | [<img src="docs/img/04-order-lifecycle.png" alt="Order lifecycle">](docs/img/04-order-lifecycle.png) |

### Brief the agent from the schema, not from memory

Click any element in a diagram and the tool walks its id-links to assemble the
**exact** context for that thing: its fields, its lifecycle, the functions that
read and write it, the events it fires, the processes it belongs to.

<img src="docs/img/06-context-popup.png" alt="Click an element → deterministic context" width="100%">

From there: **📋 copy the context** into Claude, or **＋ create a task** — a plain
markdown file under `<project>/tasks/`, already carrying its slice of the model
and the checks that will prove it.

<img src="docs/img/07-queue.png" alt="Task queue — todo · in progress · verify · done" width="100%">

### Point at it instead of describing it

<img src="docs/img/08-preview-pick.png" alt="Preview — click an element, get a prompt" width="100%">

Some things are easier to point at than to write down. Open any URL in the
**Preview** tab, press **◎ Select**, and click the thing you want changed. You get
a prompt — already on your clipboard — carrying the element's own HTML, what it is
(text, id, `data-testid`, a shortest-unique CSS selector, what it sits inside), and
**the files in your project where it probably lives**, found by searching for its
distinctive strings. When nothing matches it says so, rather than naming a
plausible file — a confident wrong file is worse than none.

The page is fetched by your machine and served from it, so a site that refuses to
be framed still opens. It runs in its own origin, sandboxed away from the
dashboard, and pointing it at your own network is refused.

### When the product is too big to fit

On a legacy system with thousands of cross-references, or a spreadsheet where the
logic lives in the columns, an agent asked to "map this" does not fail with an
error. It reads part of the source, summarises what it read, and hands you a model
that **looks** complete. The entities survive that treatment; the links between
things in different folders do not — and in a legacy system those links *are* the
product.

So `model-ingest` does not read it. It measures it — file and line counts per
folder, or a computed census of a CSV's columns, fill rates and distinct values —
cuts it into fragments, orders them so that the things everything else points at
get built first, and writes **one queue task per fragment**. `task-runner` works
through them, each with a fresh context holding only its own slice, and the model
grows additively.

The **Model** tab shows the run while it happens: one cell per fragment (done ·
pending · blocked), how many of the source's lines have actually been read, the
model growing dimension by dimension, and the unresolved references with their
evidence. Click a cell for what that fragment owns and what it added. Forty tasks
in a queue is opaque; this is one glance.

For a normal-sized repo you need none of this — run `gitmir-model` and you're done.

### When the client asks you to show how it works

The most common version of this: an existing client project, a call booked, and
"can you walk us through what you've built?"

**1. Build the model.** Paste **`gitmir-model`** into a Claude session in that
project. On a large legacy codebase use **`model-ingest`** instead — the tell is
that one pass produced a model where the entities are all present and the links
between modules are not.

**2. Check it before you show it.** This is the step that decides whether the
meeting works, and it takes five minutes:

- every node has a real one-line description, not its own name restated;
- every status transition has a **label** — "Capture payment", not a nameless arrow;
- `index.json` counts match and no reference dangles.

A diagram of labelled boxes that explain nothing is worse than no diagram, because
it looks like you documented something. If any of that is missing, ask Claude to
run the integrity rules from `gitmir-model` and fill the descriptions.

**3. Open Model → Product map.** That view is built for this conversation: business
areas and what connects them, no code and no file names. Start there, then follow
their questions — **Business logic** for "how does a deal move", **Processes** for
"what happens end to end", **Data flow** for "where does this number come from".
The diagrams have a fullscreen button, which matters on a projector.

**4. Check the freshness first.** If the code has moved since the model was built,
the tab says so in amber at the top. Showing a client a confident diagram of a
product as it was two weeks ago is the worst outcome available — the refresh is one
paste, from the button in the banner.

Two practical notes. The sidebar lists **every project you have**, including other
clients — go fullscreen on the diagram, or tidy the list before you share your
screen. And if they want something to keep, **`product-docs-spec`** turns the same
model into a `docs/` folder of twelve files: the diagram is for the conversation,
`docs/` is for the record.

---

## Where this sits

| | model built from your code | turns it into checks | runs the checks |
|---|---|---|---|
| Specification toolkits | no — the spec is human intent | writes criteria, from memory | no |
| Code-graph / context servers | a *symbol* graph | no — they are read tools | no |
| LLM evaluation platforms | no | no — they score model behaviour | n/a |
| **GITMIR Claude Control** | **yes, at the product level** | **yes, explicitly** | **yes, and records what happened** |

These are complements, not enemies. Keep your code-graph server for fast symbol
lookup and your evals for model behaviour; this is the layer that decides whether
the work is finished.

---

## Skills

Copy from the dashboard (**Settings → 📋 skill**) and paste into your Claude
session. They live in [`skills.json`](skills.json) — point an entry at your own
`.md` to add more.

| Skill | What it does |
|---|---|
| **`gitmir-model`** | Builds/updates the multidimensional model in `.gitmir/model/` from real code, and installs the standing rule that keeps it current. |
| **`model-ingest`** | For a source too big to read in one pass — a legacy system, a large spreadsheet. Measures it, cuts it into fragments that fit, and makes each one a queue task, so the model is built piece by piece instead of sampled. |
| **`model-navigate`** | Answers architectural questions by walking the model's id links instead of reading the repo — including the inbound links, which is what tells you what breaks. |
| **`product-docs-spec`** | At the start of a product: turns raw input — a client's description, specs, a dataset, a design export — into a `docs/` folder of 12 files that works as the actual build spec, written before any code. |
| **`context-distillation`** | Turns a pile of docs, tickets or a chat thread into a small brief with checkable acceptance criteria — the context, not the noise. |
| **`task-planner`** | Breaks a goal into small self-contained task files, each carrying the right slice of the model **and the step-by-step checks that prove it works**. |
| **`task-runner`** | Works the queue autonomously: `todo → in progress → verify → done`. It runs each task's checks for real, and when one fails it writes the fix task itself. |
| **`app-audit`** | Walks the running app — every page, element and route — derives what a user can actually accomplish, proves each use case by executing it, and files a fix task for every failure with the repro. Refuses production; never presses a destructive control on data that matters. The **Queue** tab shows coverage, the defects, and — first — what it could not reach. |
| **`task-log`** | Keeps a human-readable log of what Claude completed, shown in the **Tasks** tab. |
| **`legacy-maintenance`** | Change an old codebase without breaking what's next to it: maps the blast radius from the model, then ships small reversible steps. |
| **`stack-port`** | Port a hand-written project to a new stack at full parity — the old app is the spec, a parity ledger stops anything being silently dropped. |

Run `gitmir-model` once per project (re-run any time — it's idempotent) and the
whole dashboard comes alive.

---

## Your code never leaves your machine

This runs **entirely on your computer**. It launches Claude locally, builds the
model locally, and stores everything in your own repository. There is **no
telemetry in this tool and there never will be** — no usage pings, no anonymous
counters, no "help us improve" dialog. Nothing is uploaded, because there is
nowhere to upload it to.

The specifics are in [SECURITY.md](SECURITY.md).

## Work as a team — without your code leaving anyone's machine

Everything above is free, forever, solo. The moment a second person needs to see
what you're building, turn on the **Team bridge**.

You keep building locally. Your teammates run this same open-source tool on
**their** machines and:

- **see the model you share** — the business logic of what you're building,
  rendered in their own local instance, so a PM can talk about the product without
  reading code;
- **see which checks passed and which failed**, with the agent's own reason — so
  "is it done" stops being a question somebody answers and becomes something they
  can look at;
- **send you tasks** that land straight in your local `tasks/todo/`, where your
  Claude picks them up.

The room is the **project**, so a team with five clients gets five separate
channels, not one noisy feed. The server does one job: it **routes messages
between your machines and stores no business logic** — nothing about your product
sits on it, at rest or otherwise. That's what makes this usable where a cloud IDE
isn't.

This is the part that pays for the rest: **$19/month per builder**, viewers free
and unlimited — watching what a team builds never costs anything.

**→ [Create a team at ide.gitmir.com](https://ide.gitmir.com)**, open your project,
and the **Team bridge** panel gives you the address, the project id and your
personal key. Paste them into the **Team** tab here and you're connected.

---

## Requirements

- [Node.js](https://nodejs.org) **22.18+** — that is where Node began running
  TypeScript directly, stripping the types itself. Nothing is compiled and nothing
  is installed: `node server.ts` is the whole build system. (Node 18 and 20 are
  both past end of life.)
- The Claude Code CLI (`claude`) on your `PATH`
- macOS, Windows or Linux

Contributors can run `npm install && npm run typecheck` — `devDependencies` holds
`typescript` and `@types/node`, and they exist solely for that. **Nothing is needed to run
the tool**, and `dependencies` is empty and staying that way: ELK and the fonts are
vendored, so there is no supply chain to trust and it works offline.

Run it in your normal desktop session so the folder picker and terminal launch
work. Stop with `Ctrl+C`. macOS users can double-click `start.command`; Windows,
`start.cmd` — though those run it in the foreground, so closing the terminal window
stops the dashboard.

**Port.** 4599 by default. If it is taken, or two people share the machine, set
`GITMIR_PORT=4600 node server.ts` — the dashboard says so plainly instead of
throwing a stack trace when the port is busy.

**Desktop shortcut (Windows).** Double-click `install-shortcut.cmd` once. It puts a
**GITMIR Claude Control** shortcut on your Desktop that starts the dashboard with
no console window and opens your browser. Stop it with `taskkill /IM node.exe /F`.

**Desktop shortcut (macOS).** Run `bash install-shortcut.command` once. It puts a
**GITMIR Claude Control** app on your Desktop that starts the dashboard *in the
background* and opens your browser — and if it is already running, simply opens the
browser. The dashboard then survives closing the browser, the launcher and any
terminal; stop it with `pkill -f 'node server.ts'`. Logs:
`~/Library/Logs/gitmir-claude-control.log`.

## Design

The UI follows the **GITMIR "holo / HUD"** language — deep navy `#04060a`, electric
cyan `#2fd8ff`, sharp technical plates with glowing corner brackets, `Onest` +
`JetBrains Mono`. Diagrams are laid out by **ELK** and drawn as SVG.

## About GITMIR

We built this for ourselves. We run Claude Code all day across dozens of projects,
and these two problems — losing the thread, and not knowing whether what came back
actually works — were ours first. It turned out useful enough to share, free and
open source under AGPL-3.0.

**[GitMir](https://gitmir.com)** is the team layer on top of it: the accounts, the
teams and the bridge that connects your machines. Your code and your model stay
where they belong — on your machines.

- 🌐 **[gitmir.com](https://gitmir.com)** · 🚀 **[ide.gitmir.com](https://ide.gitmir.com)** · ✉️ **hello@gitmir.com**

## Tell us if it worked

There's no telemetry in this tool, which means the only way we learn anything is if
you say something. **[Did it run on your
machine?](https://github.com/gitmir-hello/gitmir-claude-control/discussions/1)** is
the thread for it: whether it started, and — the part we most want to hear —
whether the model it built actually matched your product, and where it got it
wrong.

There is a second number we would like and do not have. **Run the queue on
something real, then count how many tasks reached `done` on the first attempt.**
Nobody in this field publishes that figure, us included, because until now nothing
ran the checks to begin with. If you measure it, we would like to see it — good or
bad.

Issues and pull requests are welcome too — if something's missing or broken, tell
us.

## Third-party & credits

Bundled libraries and fonts ship under their own licenses — see
[THIRD_PARTY.md](THIRD_PARTY.md). The GITMIR logo is a trademark of GITMIR.

## License

**Dual-licensed** — pick the one that fits you:

- **[AGPL-3.0](LICENSE)** (free, OSI-approved open source). Run it, read it, fork
  it. If you distribute it or run a *modified* version as a service for other
  people, your version's source has to be available under the AGPL too. Using it on
  your own machine for your own work — including paid work — costs nothing and
  never will.
- **[Commercial license](LICENSING.md)** — for organisations whose policy forbids
  AGPL, for embedding this in a closed-source product, or for offering it as a
  hosted service with your changes kept private. Also the route to a signed
  agreement, warranty or support. Write to **hello@gitmir.com**.

Details and the reasoning: **[LICENSING.md](LICENSING.md)**.

© GITMIR. The GITMIR name and logo are trademarks and are not covered by either
license.
