Break a goal into small, independently-runnable tasks and drop each one as its own
file in this project's `tasks/todo/` folder, so the `task-runner` skill can execute
them one by one.

The queue has **four** states — a task is not finished when the code is written, it
is finished when it has been **proven**:

    tasks/todo/  →  tasks/inprogress/  →  tasks/verify/  →  tasks/done/

Your job is to make that provable: every task you write must carry the steps that
show it actually works.

## Language

**Write everything you produce in English.** File names and their contents,
object names and descriptions, task titles, `## Context` and `## Verify` steps,
log entries, notes, findings, briefs, docs — all of it, always, no matter what
language the request arrived in.

This is not a style preference. These artefacts are read by people who did not
write them: a teammate on a shared model, a client opening a shared link, a
reviewer on a public repository, and the next session of Claude, which orients
from what is on disk. A model whose descriptions are half in one language and
half in another cannot be read straight through by any of them.

If a value is a proper noun — a table name, a route path, a status key, an
identifier from the code — keep it exactly as the code spells it. Translate the
prose around it, never the thing itself.

## Task types

Give each task a `Type:` line. Three types come from you; the fourth is created by
the runner while it works.

| Type | Purpose | Who creates it |
|---|---|---|
| `build` | Implement something — the normal unit of work. | you |
| `verify` | Prove that something works, step by step. Use for checks that span several build tasks (a whole user flow), or that need a human. | you |
| `fix` | Repair what a verification proved broken. | the runner |

A `build` task always carries its own `## Verify` steps for its own slice. A separate
`verify` task is for the bigger picture: "the whole checkout flow still works end to
end after tasks 003–007".

## File shape

Create `tasks/todo/NNN-<slug>.md` (zero-padded number prefix so they run in order):

    # <short task title>

    Type: build
    Change: refunds
    Touches: ent-order, sf-refund-order, ev-order-refunded

    ## Context
    <the relevant slice of the product — pull it from `.gitmir/model/` if present:
    the entities, fields, functions, routes, events, status flows and processes
    this task touches, referenced by their ids/names, so the runner has everything
    it needs without re-reading the whole repo>

    ## Task
    <precisely what to do — small enough to finish in one pass>

    ## Verify
    <the numbered steps that prove it works — see below. MANDATORY.>

## The `Change:` line

One short slug naming **the request all these tasks came from**, identical on
every task in the batch. Lowercase, hyphens, a few words: `refunds`,
`checkout-guest-mode`, `invoice-pdf`.

This is what makes the work measurable. A request rarely produces one task: it
produces a task, then a fix task after the person says "not like that", then
another after review. Grouped by `Change:`, that reads as one change with three
rounds — which is the truth. Ungrouped it reads as three unrelated tasks, and the
one number worth knowing (how much of this was finished on the first pass, and how
much was the person pushing the agent to the finish) cannot be computed at all.

Rules that matter:

- **Same request, same slug** — including for fix tasks written later, and
  including when the person changes their mind mid-way. A changed mind is part of
  the same change; that is exactly what the measurement is for.
- **New request, new slug** — even if it touches the same objects.
- Never put a person's name, a ticket assignee or a machine in it. The record this
  feeds cuts work by process and by area, never by person.

Omit the line only if you genuinely cannot tell what the request was.

## The `Touches:` line

List the ids of the model objects **this task will change** — not everything it
reads. One line, comma-separated, ids exactly as they appear in
`.gitmir/model/*.json`. Omit the line only when the project has no model.

This is what turns a queue into an impact estimate. Before the task runs, the
interface walks those ids through the model and shows what else is downstream:
which modules the change crosses, which processes and journeys run through it,
which endpoints and screens sit on top, and what that scores as risk. Someone can
then approve it — or split it — before any code is written.

Get the distinction right: a task that reads `ent-user` to render a name and
writes `ent-invoice` touches `ent-invoice`. Putting both in overstates the blast
radius, and an inflated radius trains people to ignore it.

Without the line the interface falls back to every model id mentioned anywhere in
the file, and labels the result inferred. That is a worse estimate than one you
write deliberately.

## Writing the `## Verify` section

This is the part that makes the queue trustworthy. Write **numbered steps a person
or an agent can execute one at a time**, each with the exact command or action and
the **expected result**. Not "check that it works" — that proves nothing.

    ## Verify
    1. `npm run build` — compiles with no errors.
    2. `npm test -- orders` — all order tests pass.
    3. Start the app, POST /api/orders with {"items":[]} — responds 400 with
       "order must have at least one item", not a 500.
    4. POST a valid order, then GET it — status is "draft", total equals the sum
       of the item prices.
    5. In the DB, the new row has created_at set. (manual)

Rules for the steps:

- **Each step is checkable.** A command with its expected output, an HTTP call with
  the expected status/body, a screen with what must appear.
- **Cover the negative case too**, not just the happy path — the invalid input, the
  empty list, the unauthorised call.
- **Cover what the change could break nearby.** Use `.gitmir/model/` to see what else
  reads or writes the fields you touched, and add a step for it.
- **If the task changes code and the project has a `.gitmir/model/`, add a step for the
  model itself** — "`.gitmir/model/` describes the new field / route / transition, ids
  unchanged, `index.json` refreshed". The model is what every later task is briefed from;
  if it silently lags, every one of them is briefed from fiction.
- Mark a step `(manual)` when only a human can judge it. The runner will stop and
  ask rather than guess.
- If a task genuinely cannot be verified by anything but a person, say so in the step
  — do not invent a fake automated check.

## Rules

- One task per file. Keep each small and self-contained. If a step depends on
  another, order them with the number prefix.
- **Every task needs a `## Verify` section.** A task with no way to check it is not
  ready to run — a requirement you cannot check is a wish, not a task.
- Ground the context in the real model/code — never invent. Prefer linking model
  ids/names over pasting large chunks of code.
- Add standalone `verify` tasks at the points where a whole flow should be re-proven
  (after a group of related build tasks), not after every single one.
- Only CREATE the files here; do not execute them (that is `task-runner`'s job).
  List the files you created when done.
