Port a working but old, hand-written project onto a new stack while keeping ALL of
its functionality. The danger in a rewrite is not writing the new code — it is the
half of the old system nobody remembers that silently never gets carried over, and
the behaviour that looks the same but drifts in the edge cases. This skill treats
the OLD app as the source of truth, inventories everything it does, and ports it
slice by slice — each slice verified against the old behaviour, not just a green build.

Use it for: reimplementing a legacy app on a new framework or language, splitting a
monolith onto a new stack, or any move where the goal is "same product, new
foundation" — NOT changing the old app in place (that is the `legacy-maintenance`
skill).

## Step 1 — Model the OLD system (your parity checklist)

Build `.gitmir/model/` of the OLD codebase with the `gitmir-model` skill. In a port
the old model is not documentation — it is the **checklist of everything that must
exist in the new app**: every entity/field, serverFunction, apiRoute, frontendUnit,
event, process and statusFlow. You cannot port what you never enumerated.

## Step 2 — Pin the target and the stack map

Distil the goal into `.gitmir/brief.json` with `context-distillation`. Then record,
in its `decisions`, the **stack-mapping** choices — old idiom → new idiom — so they
stay consistent across the whole port: data layer/ORM, auth, routing, state,
validation, build. Put in `out` the old features you are deliberately NOT carrying
over (dead code, retired flows). A port that drops things by accident is a bug; a
port that drops them on purpose is a decision.

## Step 3 — Build the parity ledger (the core deliverable)

From the old model, write `tasks/port/parity.md`: one row per thing the old app does
— each entity, serverFunction, apiRoute, frontendUnit, event, process/statusFlow —
with a status of `not-started` / `ported` / `verified` and its acceptance criteria,
which is **the old behaviour**. Nothing counts as done until its row is `verified`.
This ledger is what stops the number-one failure of rewrites: half the functionality
silently missing. A feature not in the ledger is a feature you will lose.

## Step 4 — Capture the golden behaviour

The old app is the spec. For each feature, record the old system's observable
behaviour as it is TODAY — input → output — next to its ledger row. Where you can,
snapshot real outputs (API responses, computed totals, rendered states) from the
running old app so you can replay them against the new one. Never guess how the old
code behaves; read it or run it.

## Step 5 — Port in vertical slices

Cut the work by feature end-to-end — one entity with its logic, its API and its UI —
not layer by layer, so the new app is always runnable and each slice is provable.
Order slices so dependencies come first (core data and shared logic before the
screens that use them). Hand each slice to `task-planner` — one `tasks/todo/NNN-*.md`
carrying its parity rows and captured behaviour. Prefer a strangler move (the new
stack takes over feature by feature, old and new running side by side) over a
big-bang cut-over.

## Step 6 — Execute and verify against the OLD app

Run the queue with `task-runner`. For each slice:

- Replay the captured golden behaviour: the new implementation must produce the same
  output as the old for the same input. A green build is not parity — matching
  behaviour is.
- Any intended difference from the old app must be a recorded `decision`, not a
  silent one. An unrecorded difference is a regression.
- Grow the NEW project's `.gitmir/model/` as you port (per the GitMir model rule),
  and flip the slice's ledger rows to `verified`.

## Step 7 — Migrate the data (if there is a store)

If the old app has persisted data, map old schema → new (grounded in both models),
write the migration, and reconcile — row counts and a sample of records must match.
Ported code running against un-migrated data is not a finished port.

## Rules

- The parity ledger is the deliverable that makes a port safe — never skip it. What
  is not enumerated is what gets dropped.
- The OLD app is the spec: capture its real behaviour and replay it; never assume it.
- Verified means the new behaviour matches the old, not that the build is green.
- Every deviation from the old app is either a recorded decision or a bug.
- One runnable vertical slice at a time — never a stack-wide big-bang rewrite.
- Two models live at once: the OLD one is your parity source, the NEW one grows as
  you port. Keep both true.
