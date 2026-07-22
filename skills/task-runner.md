Process the file-based task queue in this project's `tasks/` folder. Tasks are
individual markdown files that move between three folders as their status changes:
`tasks/todo/`, `tasks/inprogress/`, `tasks/done/`.

Work the queue one task at a time, **oldest first** (files are named with a
sortable timestamp/number prefix):

1. If `tasks/inprogress/` already contains a file, resume that one first.
2. Otherwise take the OLDEST file in `tasks/todo/` and **move** it (rename) into
   `tasks/inprogress/` before you start — so the status is visible in the dashboard.
3. Read the task file. It already contains the model context and what to do —
   follow it exactly. If the project has a `.gitmir/model/`, treat it as the source
   of truth and update it after any code change (per the GitMir model rule).
4. When finished, append a short `## Outcome` section to the file (what changed,
   files touched, any follow-ups) and **move** the file to `tasks/done/`.
5. If a task cannot be completed, append a `## Blocked` note explaining why, and
   either move it to `tasks/done/` or leave it in `tasks/inprogress/` and stop to
   ask the user — your judgement.
6. Repeat until `tasks/todo/` is empty. Give a one-line summary per finished task.

Rules: never work two tasks at once; keep each task as its own file; don't rewrite
files already in `tasks/done/`.
