Keep a log of the work you complete in this project, in `.claude/tasks.json`
(relative to the root of the current working directory). The local GitMir
dashboard reads it and shows what has been done in the project.

Do this immediately:
1. Read `.claude/tasks.json` if it exists. If it does not, create the `.claude/`
   folder (if needed) and the file with an empty log in the schema below. Never
   overwrite entries that are already there.
2. Confirm briefly: "Logging tasks to `.claude/tasks.json`."
3. From then on, keep the file up to date as you work (rules below).

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

## Schema

`.claude/tasks.json`:

```json
{
  "project": "project-folder-name",
  "updated": "2026-07-21T14:32:00Z",
  "tasks": [
    {
      "id": "t1",
      "title": "Short task title",
      "detail": "1–2 sentences: what exactly was done or changed.",
      "status": "done",
      "ts": "2026-07-21T14:30:00Z",
      "files": ["src/server.js", "index.html"],
      "touched": ["ent-order", "sf-refund-order"]
    }
  ]
}
```

Fields:
- `updated` — ISO time the file was last changed; refresh it on every write.
- `tasks` — an array in chronological order; append new entries at the end.
  - `id` — sequential: `t1`, `t2`, `t3`…
  - `title` — one line, in English.
  - `status` — one of: `todo`, `in_progress`, `done`.
  - `ts` — ISO time; take the current date from the session context (minutes are
    precise enough).
  - `detail`, `files` — where you can, optional.
  - `touched` — ids of the model objects the task **changed** (not the ones it
    read), exactly as they are written in `.gitmir/model/*.json`. This field is
    what the product's own history is built from: what changed, when, and in
    which area. If the project has no model, leave the field out.

The file must always remain valid JSON.

## When and what to record

- Open an entry for a meaningful unit of work — a feature, a bug fix, a
  refactor, a piece of setup — the kind of thing worth seeing in a "what has been
  done" list. Do not log every tool call or small intermediate step.
- Add a multi-step task with status `in_progress` and move it to `done` when it
  is finished (update the same entry by `id`; never duplicate it).
- Read the current file, add or amend entries, and write the whole file back —
  that is the simplest way to keep the JSON valid.
- Never rewrite past entries after the fact (a status change is the exception).
- Never put secrets, tokens, passwords or keys in the log.
