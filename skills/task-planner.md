Break a goal into small, independently-runnable tasks and drop each one as its own
file in this project's `tasks/todo/` folder, so the `task-runner` skill can execute
them one by one.

For each task create `tasks/todo/NNN-<slug>.md` (a zero-padded number prefix so
they run in order) with this shape:

    # <short task title>

    ## Context
    <the relevant slice of the product — pull it from `.gitmir/model/` if present:
    the entities, fields, functions, routes, events, status flows and processes
    this task touches, referenced by their ids/names, so the runner has everything
    it needs without re-reading the whole repo>

    ## Task
    <precisely what to do — small enough to finish in one pass, with acceptance
    criteria where useful>

Rules:
- One task per file. Keep each small and self-contained. If a step depends on
  another, order them with the number prefix.
- Ground the context in the real model/code — never invent. Prefer linking model
  ids/names over pasting large chunks of code.
- Only CREATE the files here; do not execute them (that is `task-runner`'s job).
  List the files you created when done.
