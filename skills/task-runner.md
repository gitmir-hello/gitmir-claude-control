Run the file-based task queue in this project's `tasks/` folder **until it is empty** —
every task, in one go, not the first one and a summary. Tasks are individual markdown
files that move between **four** folders as their status changes:

    tasks/todo/  →  tasks/inprogress/  →  tasks/verify/  →  tasks/done/

The rule that matters: **writing the code does not finish a task.** A task is done
only once its `## Verify` steps have actually been run and passed. Nothing goes
straight from `inprogress` to `done`.

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

## The loop

You are running the **whole queue**, not one task. Work one task at a time, **oldest
first** (files are named with a sortable number prefix), and keep going:

1. **Resume first.** If `tasks/inprogress/` contains a file, finish that one before
   anything else.
2. **Verify before you build.** If `tasks/verify/` contains files, verify the oldest
   one (see below) before claiming new work — unproven work is the oldest debt in the
   queue.
3. **Claim.** Take the OLDEST file in `tasks/todo/` and **move** (rename) it into
   `tasks/inprogress/` before you start, so the dashboard shows it as active.
4. **Do it.** Read the file — it carries the model context and what to do. Follow it
   exactly. If the project has a `.gitmir/model/`, treat it as the source of truth
   and update it after any code change (per the GitMir model rule).
5. **Hand off to verification.** Append a short `## Outcome` (what changed, files
   touched) and **move the file to `tasks/verify/`**. Never to `tasks/done/`. If the
   task carries a `Touches:` line, correct it to the ids you actually changed — that
   line is what the impact view reads, and a wrong one is worse than none.
6. **Record what you touched.** When writing the task into `.claude/tasks.json`
   (task-log), fill `touched` with the ids of the model objects you changed.
7. **Count what is left, out loud**, in one line — nothing more:

        queue: 4 todo, 2 verify — continuing

   Then **go back to step 1** and take the next one. Do not summarise, do not review
   what you have built, do not ask whether to continue — see below. That one line is
   the only thing you say between tasks; it keeps the remaining count in front of both
   of us, so a run that ends early is obvious instead of invisible.

## Approval

Some projects approve a change before it is built: the dashboard writes an
`Approved: <when> by <who>` line into the task file. Two rules:

- **Never remove or edit that line.** It is a record of a decision, not your bookkeeping.
- **If any task in `tasks/` carries one, the project is using approvals.** Then, before
  claiming an unapproved task, say so plainly in your one-line count:

        queue: 4 todo, 2 verify — next one is not approved, taking it anyway

  Say it and continue. Do not stall the queue waiting for an approval that may never
  come — but do not let an unapproved change go by silently either.

## When you may stop

Finishing a task is not finishing the queue. This is the instruction agents skip most
often: they complete one task, write a tidy summary, hand back — and leave work sitting
in `todo/` that nobody asked them to leave.

There are exactly **four** reasons to stop before both folders are empty. If none of
them applies you are not finished: return to step 1 immediately, without pausing to
report and without asking permission to continue.

1. `tasks/todo/` and `tasks/verify/` are **both** empty.
2. A `(manual)` step needs a judgement only a human can make.
3. A third attempt at the same failure has failed — you are going in circles.
4. A task is blocked and you have decided it needs the user.

Not on that list, and therefore not a reason to stop: "the task I picked up is done",
"this is a natural place to check in", "that was a lot of work", or a long run. A queue
of twelve tasks is **one** run, not twelve. The user started the runner so they would
not have to nudge it after every file.

**Check the folders before you report.** Immediately before writing your final message,
list `tasks/todo/` and `tasks/verify/`. If either still has files and none of reasons
2–4 applies, throw the report away and go back to step 1. The listing is the check —
not your memory of what you did.

## Verifying (this is the point)

For a file in `tasks/verify/`, run its `## Verify` steps **one at a time, in order**,
and record the result of each under a `## Verification` heading in the same file:

    ## Verification
    1. `npm run build` — PASS
    2. `npm test -- orders` — PASS
    3. POST /api/orders with {"items":[]} — FAIL: responded 500, expected 400
       with "order must have at least one item"
    4. not run (blocked by 3)

Rules while verifying:

- **Actually execute each step.** Run the command, make the call, read the output.
  Never mark a step PASS because the code "looks right" — that is the failure this
  whole stage exists to prevent.
- Record the **real** observed result on a failure (what you got vs what was
  expected). That text becomes the fix task's context.
- A step marked `(manual)` that you cannot judge: mark it `NEEDS HUMAN`, and tell the
  user at the end which tasks are waiting on them.
- If a step cannot run at all (no test runner, service won't start), say so plainly
  as `BLOCKED: <reason>` — do not silently skip it.

**The model is one of the checks.** If the project has a `.gitmir/model/` and this task
changed code, verify that too, as its own line in `## Verification`: does the model still
describe what the code now does — the entity, field, function, route, screen, event or
status flow you touched? If it does not, that is a FAILED step like any other. Fix it by
updating the affected `.gitmir/model/*.json` (stable ids, refresh `index.json`) and record
it. A model that lags the code is worse than no model: it reads as authoritative and
quietly misleads every session after this one, and the dashboard will show it as stale.

**All steps passed** → move the file to `tasks/done/`.

**Any step failed** → do NOT move it to done:

1. Leave the task in `tasks/verify/` — it is built but unproven, and the dashboard
   should show that honestly.
2. Create a **fix task** in `tasks/todo/` for the failure — this is how the queue
   repairs itself:

        # Fix: <what is broken, in a few words>

        Type: fix
        Change: <copy the parent task's `Change:` line VERBATIM — a fix is part of
                 the same change, not a new one. If the parent has no Change: line,
                 omit it here too.>
        Fixes: <the original task's id — its filename WITHOUT the .md suffix,
                e.g. 001-add-refund-button — this is what links the two>
        Attempt: 1

        ## Context
        <the original task's context, plus: the verify step that failed, the exact
        expected result and the actual observed result>

        ## Task
        <what needs to change to make that step pass>

        ## Verify
        1. <the failed step, repeated verbatim>
        2. <the other steps of the original task, so the fix cannot break them>

   Number it so it runs next (before newer work), and create one fix task per
   distinct failure rather than one that bundles unrelated breakage.
3. When a fix task later passes its own verification, re-run the parent task's
   `## Verify` steps; if they now pass, move the parent from `tasks/verify/` to
   `tasks/done/` too.

A failed verification is **not** a reason to stop — it is ordinary queue work. Write the
fix task and carry on with the loop.

`Change:` and `Attempt:` are copied for different reasons and must not be confused:
`Attempt:` counts how many times you have tried this same failure, and stops you at
three. `Change:` never increases — it is the name of the request, and it stays the
same through every fix, so the whole round can be counted as one change afterwards.

**Do not loop forever.** Copy `Attempt:` from the fix task you are repairing and
increase it by one. If a third attempt at the same failure fails, stop (stop reason 3),
leave everything where it is, and ask the user — you are going in circles and need a
human.

## Blocked work

If a task cannot be done at all, append a `## Blocked` note explaining why and either
move it to `tasks/done/` or leave it in `tasks/inprogress/` and stop to ask — your
judgement. If you can keep going without it, prefer to: park that one file, go back to
step 1, and raise it in the final report with everything else.

## The final report

Only once you have listed both folders and confirmed you are allowed to stop. Report:
one line per finished task, plus an explicit list of anything left in `tasks/verify/`
(unproven), any `NEEDS HUMAN` steps, any fix tasks you created, and — if you stopped
for reason 2, 3 or 4 — exactly what is still in `tasks/todo/` and what you need from
the user to finish it.

Rules: never work two tasks at once; keep each task as its own file; don't rewrite
files already in `tasks/done/`; never mark a verification step PASS that you did not
actually run.
