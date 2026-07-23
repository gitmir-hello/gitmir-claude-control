Onboard onto an unfamiliar or legacy codebase and change it WITHOUT breaking the
things next to it. The danger with legacy code is not the change itself — it is
the adjacent behaviour nobody remembers, that quietly breaks when you touch a
shared function or column. This skill maps the system first, scopes the blast
radius of the intended change, and ships it in small reversible steps you can
verify.

Use it for: a repo you did not write, a fast-built MVP being stabilised, a
framework/library upgrade, an extraction or rename that reaches across the code, or
any change where "what else does this touch?" is the real question.

## Step 1 — Map before you touch

If this project has no `.gitmir/model/`, build it first with the `gitmir-model`
skill. You cannot safely change what you cannot see. If a model exists, refresh
the areas you are about to work in so it matches the current code.

## Step 2 — Pin the goal

Distil the change into `.gitmir/brief.json` with the `context-distillation` skill:
what must be true when this is done, and the acceptance criteria that prove it.
Legacy work drifts without a fixed definition of done.

## Step 3 — Map the blast radius (the core step)

For the intended change, use `.gitmir/model/` to list everything it can reach, and
write it to `tasks/legacy/blast-radius.md`:

- The **entities/fields** the change reads or writes.
- Every **serverFunction** whose `readsFieldIds`/`writesFieldIds` include those
  fields — these run when your data changes.
- The **apiRoutes** and **frontendUnits** that reach those functions/fields
  (`routeId`, `consumesRouteIds`) — the surfaces a user would notice break.
- **events** the touched functions `emit`/`subscribe`, and any **process** or
  **statusFlow** that passes through them — the indirect ripple.

That list is your "what could break" set. Anything on it needs to still work after
the change, whether or not the task is "about" it.

## Step 4 — Establish a safety net

For each item in the blast radius, decide how you will know it still works:

- If there is a test that covers it, note it.
- If there is not (common in legacy), write down the **current observable
  behaviour** first — a characterization note in `tasks/legacy/blast-radius.md`
  (input → output as it is TODAY). You cannot detect a regression against a
  behaviour you never recorded.

## Step 5 — Plan small, reversible increments

Break the migration into the smallest steps that each leave the app working, and
order them so nothing is half-migrated across a boundary. Hand them to the
`task-planner` skill — one `tasks/todo/NNN-*.md` per increment — each carrying its
slice of the blast radius and the acceptance criteria it must meet. Prefer
parallel-safe changes (add new, migrate readers, remove old) over big-bang
rewrites. If the only plan is "rewrite it all at once", the scope is wrong — split it.

## Step 6 — Execute and verify

Run the queue with `task-runner`. After each increment:

- Check the increment's acceptance criteria from the brief.
- Re-check the blast-radius items — the adjacent behaviour you recorded must still
  hold. A green build is not proof; the ripple set is.
- Update `.gitmir/model/` for what changed (per the GitMir model rule), so the map
  stays true for the next increment.

## Rules

- Never a big-bang rewrite. One small reversible step at a time, app working after
  each.
- The blast-radius map is the deliverable that makes this safe — do not skip it to
  save time; it IS the time saved.
- Where there are no tests, record current behaviour before changing it. Undetected
  regressions are the whole risk of legacy work.
- Ground everything in the model and the real code — never assume how legacy code
  behaves; read it or run it.
