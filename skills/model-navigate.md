---
name: model-navigate
description: >-
  Work a task through the project's .gitmir/model/ by walking id links instead of reading
  the codebase — resolve an entry point, expand by hops within a budget, assemble only the
  slice the task needs, and open source files last. Use on any project that has a
  .gitmir/model/, especially a large or legacy one, when a question is architectural ("what
  breaks if I change this field", "how does an order get refunded", "where is this handled")
  or when a task spans modules. Also use when a session is about to start by reading the
  whole repository.
---

# Navigating the model instead of reading the code

## Why this exists

A model is only worth building if it changes how the next task is done. The default
behaviour it has to displace is this: a question arrives, the repository gets searched,
twenty files get read, and an answer is assembled from whatever fitted. On a big or legacy
codebase that answer is confidently wrong in a predictable way — it describes the files that
were read and is silent about the ones that were not, and the reader cannot tell which is
which.

The model exists so that the search can be **deterministic**. Every reference in
`.gitmir/model/` is a stable id, so the collections form one connected graph. Finding what a
change touches is then a graph traversal, not a guess: you follow links, and when you stop
following them you know exactly what you left out.

So: **the model is the index, the code is the detail.** Read the index first, follow it to
the few files that matter, and never substitute reading-a-lot for knowing-where.

## Step 1 — is the model trustworthy?

Before relying on it, check that it is not describing a product that no longer exists.

Read `.gitmir/model/index.json` — it is tiny and carries `at`, the time the model was last
written. Compare it against the newest source file in the project. If code is newer, say so
to the user before answering, and treat the affected area as unverified. The dashboard shows
this as a banner on the **Model** tab for the same reason.

A stale model is not useless — it is a hypothesis. Use it to find where to look, then
confirm against the code rather than reporting it as fact.

If there is no model at all, do not improvise one in your head. Run `gitmir-model`, or
`model-ingest` if the source is too big for one pass, and then come back.

## Step 2 — resolve the entry point

Find the ids the task is actually about. Grep the **model**, not the repository:

```bash
grep -o '"id": "[^"]*"' .gitmir/model/entities.json | head -50
grep -n -i 'refund' .gitmir/model/*.json
```

The entry point is usually one or two objects: an entity, a field, a route, a screen, a
process. Name them explicitly before going further. If the task's subject matches nothing in
the model, stop — see *When the model is silent* below. Do not fall back to reading the repo
as if the model were not there.

## Step 3 — expand by hops, with a budget

Traversal is cheap and unbounded expansion is not, so decide the radius on purpose.

- **Hop 0** — the objects themselves.
- **Hop 1** — everything they link to directly, in both directions. This is the answer for
  most tasks.
- **Hop 2** — the links of those. Go here only when the task crosses a module boundary, and
  say that you did.
- **Hop 3+** — almost never. If a task needs three hops in every direction it is not one
  task; split it.

Traverse **inbound as well as outbound**. Outbound tells you what this thing uses; inbound
tells you what breaks when you change it, and inbound is the one that gets forgotten. To
find inbound links, grep the id across the model files — that is what stable ids are for:

```bash
grep -l 'f-order-status' .gitmir/model/*.json
grep -n 'f-order-status' .gitmir/model/serverFunctions.json
```

## Which dimensions a task needs

Load the two or three files that matter, not all ten. This table is the practical core of
the skill:

| The task | Start from | Then follow |
|---|---|---|
| Change or rename a **field** | `entities` → the `Field` id | `serverFunctions` where the id appears in `readsFieldIds`/`writesFieldIds`; `statusFlows` whose `fieldName` is it; `reactions` whose `trigger` names it; `entities` with a `ref` field pointing at its entity |
| Change what a **status transition** does | `statusFlows` for that entity | the transition's `effects`; `serverFunctions` writing that field; `events` those functions emit, and their subscribers |
| Add or change an **endpoint** | `apiRoutes` | its `serverUnitId`; `serverFunctions` with that `routeId`; `frontendUnits` with the route in `consumesRouteIds` |
| Change a **screen** | `frontendUnits` | `consumesRouteIds` → `apiRoutes` → the functions behind them; `dependsOn` for the components inside it |
| "What breaks if I remove **X**" | X's own object | every inbound reference, found by grepping X's id across all ten files. The answer is that list |
| "How does **&lt;business flow&gt;** work" | `processes` | each `steps[].refId` in order, into whatever dimension it names |
| "Why did this value change" | `reactions` + `statusFlows` | the effects that write that field, then the functions that fire them |
| Estimate the blast radius before a refactor | `modules` | which modules the touched ids belong to; anything crossing a module boundary is the risk |

## Step 4 — open the code last, and only what the model named

Now you know the handful of functions, routes and files involved. Read **those**. The model
gave you the map; the code gives you the exact current text, which is what you actually edit.

This ordering is the whole point. Reading five files you chose from the graph beats reading
fifty you chose by searching, and — more importantly — you know what the five leave out,
because you can see where you stopped following links.

## Step 5 — show the path you took

State the ids you traversed, compactly, as part of the answer:

> Traversed: `f-order-status` → `sf-order-advance`, `sf-order-refund` (write it) →
> `sfw-order-state` (transitions `paid→refunded`) → `ev-order-refunded` →
> `sf-notify-customer` (subscriber). Hop 2, stopped at the notifications module.

Two reasons, both practical. It makes the reasoning **auditable** — a human can see the path
and spot the link you did not follow, which is impossible when the answer came from
unspecified file reading. And it makes the boundary of the answer explicit: "stopped at the
notifications module" is information, where silence is not.

## When the model is silent

Sometimes the traversal produces nothing, or obviously too little. That is a finding, and it
has a correct response, which is not to quietly start reading the repo instead.

1. **Say it plainly.** "The model has no status flow for `subscription` — either the code has
   none or the model missed it." Distinguishing those two is the user's decision to make.
2. **Check `.gitmir/ingest/unresolved.json` if it exists.** On a fragmented ingestion, a
   missing link is often a recorded one, with its file:line evidence. Look before assuming.
3. **Fill the gap properly.** Run one `model-ingest` fragment over that area, or
   `gitmir-model` if it is small, so the next task benefits too. A gap patched only in this
   conversation is a gap that returns.
4. **If you must proceed without it**, mark that part of the answer as read from the code and
   not from the model, and update the model before finishing.

Never close a gap by inference. An invented entity or a guessed link is indistinguishable
from a real one once it is written down, and every later session will trust it.

## Anti-patterns

- **"Let me get oriented by reading the codebase."** That is the behaviour the model
  replaces. Orient from `index.json` and the dimension you need.
- **Loading all ten dimension files.** On a large model that is most of a context window
  spent before the task starts. Load two or three.
- **Following outbound links only.** Outbound answers "what does this use". The question is
  almost always "what uses this".
- **Re-deriving what the model states.** If the model says a function writes a field, do not
  re-read the function to confirm it unless the model is stale or the answer hinges on it.
- **Reporting the model as the code.** It is a description, written by a reader. Where the
  stakes are high — money, deletion, migrations — confirm the specific line.
- **Traversing silently.** An answer with no stated path cannot be checked, and an
  unstatable path usually means there wasn't one.

## After the change

The model is the source of truth, so a code change that the model does not reflect has left
the project worse than before: the map now lies, authoritatively. Update the affected
`.gitmir/model/*.json` in the same session, keep ids stable, refresh `index.json`.

`task-runner` treats this as a verification step rather than a courtesy, and the dashboard
flags a model older than its code — both exist because this is the step that gets skipped.
