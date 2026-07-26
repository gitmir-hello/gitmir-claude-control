Process the file-based task queue in this project's `tasks/` folder. Tasks are
individual markdown files that move between **four** folders as their status changes:

    tasks/todo/  →  tasks/inprogress/  →  tasks/verify/  →  tasks/done/

The rule that matters: **writing the code does not finish a task.** A task is done
only once its `## Verify` steps have actually been run and passed. Nothing goes
straight from `inprogress` to `done`.

## The loop

Work one task at a time, **oldest first** (files are named with a sortable number
prefix):

1. **Resume first.** If `tasks/inprogress/` contains a file, finish that one before
   anything else. If `tasks/verify/` contains files, verify those before starting
   new work — unproven work is the oldest debt in the queue.
2. **Claim.** Take the OLDEST file in `tasks/todo/` and **move** (rename) it into
   `tasks/inprogress/` before you start, so the dashboard shows it as active.
3. **Do it.** Read the file — it carries the model context and what to do. Follow it
   exactly. If the project has a `.gitmir/model/`, treat it as the source of truth
   and update it after any code change (per the GitMir model rule).
4. **Hand off to verification.** Append a short `## Outcome` (what changed, files
   touched) and **move the file to `tasks/verify/`**. Never to `tasks/done/`.

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

**All steps passed** → move the file to `tasks/done/`.

**Any step failed** → do NOT move it to done:

1. Leave the task in `tasks/verify/` — it is built but unproven, and the dashboard
   should show that honestly.
2. Create a **fix task** in `tasks/todo/` for the failure — this is how the queue
   repairs itself:

        # Fix: <what is broken, in a few words>

        Type: fix
        Fixes: <the original task's filename>
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

**Do not loop forever.** Copy `Attempt:` from the fix task you are repairing and
increase it by one. If a third attempt at the same failure fails, stop, leave
everything where it is, and ask the user — you are going in circles and need a human.

## Blocked work

If a task cannot be done at all, append a `## Blocked` note explaining why and either
move it to `tasks/done/` or leave it in `tasks/inprogress/` and stop to ask — your
judgement.

## Finishing

Repeat until `tasks/todo/` is empty **and** `tasks/verify/` is empty. Then report:
one line per finished task, plus an explicit list of anything left in `tasks/verify/`
(unproven), any `NEEDS HUMAN` steps, and any fix tasks you created.

Rules: never work two tasks at once; keep each task as its own file; don't rewrite
files already in `tasks/done/`; never mark a verification step PASS that you did not
actually run.
