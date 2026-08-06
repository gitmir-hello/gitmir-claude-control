# The skills

Copy one from the dashboard (**Settings** → any skill card) and paste it into your
Claude session. They live in [`skills.json`](../skills.json) — point an entry at
your own `.md` to add more.

Every skill writes its output in English, whatever language you asked in:
these files are read by teammates, clients, reviewers and the next session.

## Start here

| Skill | What it does |
|---|---|
| **`gitmir-model`** | Builds the model in `.gitmir/model/` from real code, and installs the standing rule in `CLAUDE.md` that keeps it current. Run it once per project; re-run any time, it is idempotent. |
| **`task-planner`** | Turns a goal into small self-contained task files, each carrying its slice of the model, a `Touches:` line naming what it will change, **and the step-by-step checks that prove it works**. |
| **`task-runner`** | Works the queue autonomously — `todo → in progress → verify → done`. Runs each task's checks for real; when one fails it writes the fix task itself. |
| **`task-log`** | A human-readable log of what Claude completed, with the model objects each task changed. Shown in the **Tasks** tab. |

## Understanding what exists

| Skill | What it does |
|---|---|
| **`model-navigate`** | Answers architectural questions by walking the model's id links instead of reading the repo — including the inbound links, which is what tells you what breaks. |
| **`model-ingest`** | For a source too big to read in one pass — a legacy system, a large spreadsheet, a data dump. Measures it, cuts it into fragments that fit, makes each one a queue task, and records every reference it cannot yet resolve instead of inventing one. |

## Deciding what to build

| Skill | What it does |
|---|---|
| **`product-docs-spec`** | At the start of a product: raw input — a client's description, specs, a dataset, a design export — becomes a `docs/` folder of 12 files that works as the actual build spec, written before any code. |
| **`context-distillation`** | A pile of docs, tickets or a chat thread becomes a small brief with checkable acceptance criteria, written to `.gitmir/brief.json` — the context, not the noise. |

## Proving it works

| Skill | What it does |
|---|---|
| **`app-audit`** | Walks the running app — every page, element and route — derives what a user can actually accomplish, proves each use case by executing it, and files a fix task for every failure with the repro. Refuses production; never presses a destructive control on data that matters. The **Queue** tab shows coverage, the defects, and — first — what it could not reach. |

## Working on code you inherited

| Skill | What it does |
|---|---|
| **`legacy-maintenance`** | Change an old codebase without breaking what is next to it: maps the blast radius from the model, then ships small reversible steps. |
| **`stack-port`** | Port a hand-written project to a new stack at full parity — the old app is the spec, and a parity ledger stops anything being silently dropped. |
