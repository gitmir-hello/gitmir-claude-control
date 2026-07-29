---
name: model-ingest
description: >-
  Build the GitMir object-information model from a source that is too big to read in one
  pass — a legacy codebase with dense coupling, a large spreadsheet or CSV export, a data
  dump. Instead of reading everything, it measures the source, carves it into fragments
  that each fit in context, writes one queue task per fragment, and grows
  .gitmir/model/ additively while recording every reference it cannot yet resolve. Use
  when `gitmir-model` produced a shallow or invented model, when the repo or dataset is
  large, when the user says "it can't hold this much", "map this legacy system", "build
  a model from this Excel", or when a first attempt ran out of context halfway.
---

# Ingesting a big source into the model, one fragment at a time

## What this fixes

`gitmir-model` reads a repository and writes the model in one pass. That works up to a
point. Past it, the source does not fit — and the failure is not an error message, it is
a **plausible, shallow, partly invented model**, which is worse, because everything
downstream is then briefed from it with confidence.

The failure mode is specific and worth naming, because it tells you what to do instead:

- Reading is sampled, not complete. Half the modules get skimmed, and the model records
  what was skimmed as if it were what exists.
- The relations go first. Entities survive summarisation; the **links between things in
  different folders** do not — and in a legacy system those links *are* the product.
- Nothing is resumable. When the window fills, the work is not half-done, it is unusable,
  because you cannot tell which parts were read properly.

So do not read the source. **Measure it, cut it, and let the queue eat it in pieces.**

Use this skill when the source is large or densely coupled. For a small or medium
repository, `gitmir-model` in one pass is simpler and better — do not add machinery you
do not need.

For a pile of prose (specs, tickets, chat threads) use `context-distillation` instead:
that produces a brief, not a model. This skill is for sources that describe *structure* —
code and tables.

## What you write

The model itself goes to `.gitmir/model/` in exactly the shape `gitmir-model` defines —
same ten dimensions, same id prefixes, same integrity rules. **Read that skill's schema
section first; this skill does not redefine it.** What this skill adds is a work record:

```
.gitmir/
├── model/                     # the target — the standard ten dimensions
└── ingest/
    ├── ledger.json            # every fragment, what it owns, whether it is done
    └── unresolved.json        # references seen but not yet resolvable
```

Both are plain JSON, 2-space indented, committed with the project. They are the reason a
session with an empty context can pick this up and continue.

## Phase 1 — census: measure without reading

Produce numbers with a script, not by reading files into context. You are looking for the
shape and the size of the source, not its meaning.

**For a codebase.** Walk the tree, excluding vendored and generated paths (`node_modules`,
`.git`, `dist`, `build`, `vendor`, lock files, minified bundles, snapshots). For each
directory record file count and total lines. Then locate the anchors: schema and migration
files, route definitions, service/controller folders, the frontend tree, and any config
that lists modules. A `wc -l` per directory and a `find` for schema-shaped filenames is
enough — this phase should cost almost nothing.

**For a spreadsheet or CSV.** Never read the rows into context. Compute a census with a
short script (`python3` with the standard `csv` module — no dependencies) and read only its
output: per file or sheet, the row count, the column names, the fill rate per column, the
number of distinct values per column, and up to five example values for columns with few
distinct values. That census is what you reason from; the raw rows stay on disk.

`.xlsx` is a zip of XML and is not worth parsing by hand. Convert to one CSV per sheet
first, and say which route you took: a spreadsheet app's *Save as CSV*, or
`libreoffice --headless --convert-to csv`, or `ssconvert`, or `python3` with `openpyxl` if
it happens to be installed. If none is available, stop and ask the user to export — do not
guess at the contents of a binary file.

Report the census to the user before cutting. It is the first useful artifact: on a legacy
system, "the whole product is 41 000 lines and 60% of it is in two folders" is already a
finding.

## Phase 2 — carve into fragments

A fragment is a slice of the source that one task can read **completely**.

**Size it to fit.** Aim for a fragment whose files total roughly **1 000–1 500 lines**, or
about 10–15 files, or one spreadsheet sheet. That is a heuristic, not a law: the real test
is that the task can read every line of its fragment *and* the model slice it needs to link
against, and still have room to think. If it cannot, the fragment is too big. Never split a
single file across two fragments.

**Cut along cohesion, not just size.** A good fragment is a folder, module, or table
cluster whose members reference each other more than they reference the outside. Cutting
through the middle of a cohesive unit produces two fragments that each see half a relation.
Where a folder is too big to be one fragment, split it by layer (schema · routes ·
services) rather than alphabetically.

**Order the fragments so that referenced things land first.** This is the single decision
that most reduces work later:

1. **Data first** — schema, migrations, ORM models, table definitions. `entities` and their
   fields are what every other dimension points at, so creating them first turns most
   forward references into resolvable ones.
2. **Structure** — server units, API routes, frontend units.
3. **Behaviour** — server functions with their field-level reads and writes, events.
4. **Meaning** — processes, status flows, reactions. These reference everything else, so
   they go last, when everything else exists.

Write the plan to `.gitmir/ingest/ledger.json`:

```json
{
  "source": "/Users/me/legacy-erp",
  "kind": "code",
  "at": "2026-07-30T09:12:00Z",
  "fragments": [
    { "n": 7, "id": "frag-billing-schema",
      "owns": ["db/migrations/2019_*.sql", "app/models/invoice.rb", "app/models/payment.rb"],
      "size": { "files": 11, "lines": 1240 },
      "dimensions": ["entities", "serverUnits"],
      "status": "pending",
      "added": null,
      "note": "" }
  ]
}
```

`status` is one of `pending` · `done` · `blocked` · `skipped`. `owns` must be explicit
paths or globs — a fragment that says "the billing area" is not a fragment, it is a wish.

Show the user the fragment count before generating tasks. Forty fragments is a real amount
of work and they should know the size of it up front.

## Phase 3 — one task per fragment

Write each fragment as its own task file in `tasks/todo/`, numbered in the ingest order, so
the existing `task-runner` works through them one at a time and the dashboard's **Queue**
tab shows the progress. This is why the ingestion is expressed as tasks rather than a long
session: each task starts with a **fresh context** holding only its own fragment.

```md
# Ingest 007 — billing schema

Type: build

## Context
Model ingest, fragment 7 of 41. Ledger: `.gitmir/ingest/ledger.json`.
Schema and conventions: the `gitmir-model` skill — ids, prefixes, integrity rules.

This fragment owns, and you may read, ONLY:
  db/migrations/2019_*.sql, app/models/invoice.rb, app/models/payment.rb   (11 files, ~1 240 lines)

Dimensions to fill from it: entities, serverUnits.
Already in the model: 6 modules, 18 entities, 4 serverUnits — read `index.json` and the
dimension files you are adding to, reuse existing ids, and do not re-derive what is there.

## Task
Read every file this fragment owns — all of it, not a sample. Add the entities, fields and
server units it describes to `.gitmir/model/`, following the `gitmir-model` schema.

Append and patch by id. Do not rewrite a dimension file wholesale, and do not touch objects
this fragment does not own — another fragment owns them.

Any reference you cannot resolve against an id that already exists goes into
`.gitmir/ingest/unresolved.json` with its evidence. Do not invent the target and do not drop
the link.

Set this fragment's ledger entry to `"status": "done"` with the counts you added.

## Verify
1. Every object added has an id with the correct prefix and a real one-line `description`
   — not a restated name.
2. Every reference between objects added by this fragment resolves inside the model.
3. Every reference out of this fragment is either resolved to an existing id or present in
   `unresolved.json` with a file:line evidence string. Zero invented ids.
4. `index.json` counts equal the array lengths in every dimension file.
5. `git diff --stat .gitmir/model/` shows additions and patches only — no dimension file
   rewritten end to end, no object outside this fragment changed.
6. The ledger entry for fragment 7 reads `"status": "done"` with non-null `added` counts.
```

Step 5 is the one that keeps a long ingestion honest: it makes clobbering **visible**
instead of silent. If a fragment rewrites a file it did not own, the diff says so.

## The unresolved-reference ledger

This is the mechanism that makes fragmented ingestion work at all, so do not treat it as
bookkeeping.

Fragment 7 reads `invoice.rb` and sees a call to `ledger.post()`. The function
`postToLedger` lives in fragment 24, which does not exist yet. There are three things you
can do and two of them are wrong:

- **Invent** `sf-post-to-ledger` and link to it — creates a dangling id and a model that
  fails its own integrity check.
- **Drop** the link — loses exactly the cross-module coupling that is the reason for
  modelling a legacy system in the first place.
- **Record it.** Write what you saw, where you saw it, and what it appears to point at.

```json
[
  { "fragment": 7,
    "from": "sf-invoice-finalize",
    "field": "callsFunctionIds",
    "wanted": "ledger.post",
    "evidence": "app/models/invoice.rb:88 — ledger.post(invoice.total)",
    "resolvedTo": null }
]
```

Every later fragment, when it creates an object, checks `unresolved.json` for entries whose
`wanted` now matches, fills in `resolvedTo`, and writes the real link into the model. The
file shrinks as the ingestion proceeds.

## Phase 4 — the stitch pass

Add one final task to the queue, after all fragments:

```md
# Ingest — stitch and validate

Type: verify
```

It does four things:

1. **Resolve what can be resolved.** For every remaining entry in `unresolved.json`, look
   for a matching object now in the model and write the link.
2. **Build the meaning layer.** `processes`, `statusFlows` and `reactions` are the
   dimensions that span fragments, so they are built here, from the model rather than from
   the source — walk the functions and events that now exist and describe the flows they
   form. This is the part a single pass over a large repo never reaches.
3. **Run `gitmir-model`'s integrity rules** over the whole model: no dangling references,
   every entity has a primary field, aggregates have `derivedFrom`, status-flow transitions
   reference declared states, `index.json` counts match.
4. **Report the honest gaps.** Whatever is still unresolved stays in the file and goes in
   the report, with its evidence, as a named list. A model with twelve recorded unknowns is
   trustworthy; a model with twelve invented links is not, and looks identical from the
   outside.

Then install the standing `CLAUDE.md` rule exactly as `gitmir-model` specifies, so the
model stays current from here on, and tell the user to read the model with the
`model-navigate` skill rather than by opening the JSON.

## Resuming

A fresh session with no memory of the run can continue: read `ledger.json`, find the first
`pending` fragment, and carry on. The queue holds the remaining tasks, the ledger holds the
progress, and the model holds the work. Nothing important lives in the conversation.

If a fragment fails three times, `task-runner`'s own rule applies — mark it `blocked` in the
ledger with the reason and go on to the next one. One unreadable folder must not stop the
other forty.

## Guardrails

- **Never read outside a fragment's `owns` list.** The whole design rests on each task
  seeing a small, complete slice. "While I was there I also looked at…" is how a fragmented
  ingestion turns back into a sampled one.
- **Additive only.** Fragments add and patch. The only place a wholesale rewrite is allowed
  is `index.json`.
- **Ids stay stable forever.** Every later fragment, every future task and every diagram
  link depends on it.
- **Empty is a finding, invented is a defect.** A fragment that yields no status flows says
  so. Do not manufacture structure to make a dimension look populated.
- **Report the cost before you start.** Fragment count and rough size, before the tasks are
  generated. The user decides whether to spend it.
