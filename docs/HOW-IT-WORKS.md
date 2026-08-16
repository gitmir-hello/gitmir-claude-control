# How it works

Four links, each a rule in a skill file you can open and read.

## 1. The model comes from the code, not from anyone's memory

`gitmir-model` reads the repository and writes `.gitmir/model/` — ten linked
collections, every reference a stable id, so they form **one graph** instead of ten
lists:

`modules` · `entities` · `serverUnits` · `serverFunctions` · `apiRoutes` ·
`frontendUnits` · `events` · `processes` · `statusFlows` · `reactions`

Plain JSON in your repo. Diff it, review it in a PR, grep it.

Look at the last four collections. Most tools in this space build a *code* graph —
functions, calls, imports. This is a **product** graph. A code graph answers *"what
calls `updateOrder`"*. This answers *"how does an order get from `placed` to
`refunded`, what fires when it does, and which three services read the field you
are about to rename"*.

It does not rot: the skill installs a standing rule in the project's `CLAUDE.md`,
so every later session reads the model first and refreshes it after changing code.
When it does fall behind, the Model tab says so in amber, naming the file that
moved most recently — one paste refreshes it.

## 2. Navigation follows the links that tell you what breaks

From [`skills/model-navigate.md`](../skills/model-navigate.md):

> Traverse **inbound as well as outbound**. Outbound tells you what this thing
> uses; inbound tells you what breaks when you change it, and inbound is the one
> that gets forgotten.

It has a named answer for *"what breaks if I remove X"* — including the trap that a
**field** needs a name-based pass as well as an id search, or the answer is quietly
wrong.

## 3. That reach becomes the checks

From [`skills/task-planner.md`](../skills/task-planner.md):

> **Cover what the change could break nearby.** Use `.gitmir/model/` to see what
> else reads or writes the fields you touched, **and add a step for it.**

> **Every task needs a `## Verify` section.** A task with no way to check it is not
> ready to run — a requirement you cannot check is a wish, not a task.

So coverage stops being a function of *who wrote the spec and what they remembered*
and becomes a function of *what the code actually does*. The planner also covers
the negative case — the invalid input, the empty list, the unauthorised call — and
marks a step `(manual)` where only a person can judge it, rather than inventing a
fake automated check.

Each task also carries a `Touches:` line naming the model objects it will change.
That line is what the **Impact** view reads.

## 4. The checks get run for real

`task-runner` works the queue `todo → in progress → verify → done`. A task reaches
`done` only when its checks actually pass; a failure becomes a fix task the runner
writes itself. It corrects the `Touches:` line to what it really changed and
records the same ids in the task log, so the record reflects the work rather than
the plan.

---

## What Impact computes

For the ids a task names:

- **Reach** — breadth-first along the model's own links (writes, calls, emits,
  subscribes, consumes, `derivedFrom`, transition effects), bounded to two hops.
  Unbounded reach on a connected product is just the whole product.
- **Risk** — eight weighted components: module boundaries crossed (×2), user
  journeys affected (×3), internal processes (×1), lifecycles touched (×3),
  sensitive data reached (×4), API endpoints (×1), screens (×1), functions
  downstream (×1). The total is divided by what the whole product would score, so
  the level is a **share of the product** and reads the same in any project.
- **The picture** — a node per reached object is unreadable: measured over 97 real
  tasks in four projects, one hop already reaches a median of 11–20 objects and up
  to 156. So downstream is grouped by area, which holds every task at 21–26 nodes
  while the exact counts stay in the cards.

Naming an **area** counts as touching everything inside it — the reach opens the
module into its own contents rather than answering "nothing downstream".

---

## When the product is too big to fit

On a legacy system with thousands of cross-references, or a spreadsheet where the
logic lives in the columns, an agent asked to "map this" does not fail with an
error. It reads part of the source, summarises it, and hands you a model that
**looks** complete. The entities survive that treatment; the links between things
in different folders do not — and in a legacy system those links *are* the product.

So `model-ingest` does not read it. It measures it — file and line counts per
folder, or a census of a CSV's columns, fill rates and distinct values — cuts it
into fragments, orders them so the things everything else points at get built
first, and writes **one queue task per fragment**. `task-runner` works through
them, each with a fresh context holding only its own slice, and the model grows
additively.

The Model tab shows the run while it happens: one cell per fragment (done ·
pending · blocked), how many of the source's lines have actually been read, the
model growing dimension by dimension, and the unresolved references with their
evidence.

> A model with twelve recorded unknowns is trustworthy; a model with twelve
> invented links is not, and looks identical from the outside.

For a normal-sized repo you need none of this — run `gitmir-model` and you're done.

---

## Showing a client how their product works

1. **Build the model.** `gitmir-model` in that project; `model-ingest` if one pass
   produced a model where the entities are all present and the links between
   modules are not.
2. **Check it before you show it.** Every node needs a real one-line description,
   not its own name restated; every status transition needs a **label** — "Capture
   payment", not a nameless arrow; `index.json` counts must match with no dangling
   reference. A diagram of labelled boxes that explain nothing is worse than no
   diagram, because it looks like you documented something.
3. **Open Model → Product map.** Built for this conversation: business areas and
   what connects them, no code and no file names. Then follow their questions —
   **Business logic** for "how does a deal move", **Journeys** for "what happens
   end to end", **Data flow** for "where does this number come from". Every diagram
   has a fullscreen button, which matters on a projector.
4. **Check the freshness banner first.** Showing a client a confident diagram of
   the product as it was two weeks ago is the worst outcome available.

The dashboard lists **every project you have**, including other clients — go
fullscreen, or tidy the list before you share your screen. If they want something
to keep, `product-docs-spec` turns the same model into a `docs/` folder of twelve
files: the diagram is for the conversation, `docs/` is for the record.

---

## Where this sits

| | model built from your code | turns it into checks | runs the checks |
|---|---|---|---|
| Specification toolkits | no — the spec is human intent | writes criteria, from memory | no |
| Code-graph / context servers | a *symbol* graph | no — they are read tools | no |
| LLM evaluation platforms | no | no — they score model behaviour | n/a |
| **GitMir Local** | **yes, at the product level** | **yes, explicitly** | **yes, and records what happened** |

These are complements, not enemies. Keep your code-graph server for fast symbol
lookup and your evals for model behaviour; this is the layer that decides whether
the work is finished.
