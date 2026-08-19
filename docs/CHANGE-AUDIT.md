# The change audit — every definition, and what each one refuses to claim

A request rarely lands in one pass. It lands, somebody says *that is not what I
meant*, and the rest is a person walking the agent to the finish. Those two halves
cost differently and are usually reported as one number: "the feature took four
days".

This screen separates them. It runs on nothing but the moves your tasks make
between `todo → in progress → verify → done`, which the dashboard is watching
anyway, and it needs no timer, no plugin and no account.

**This page is the contract.** Every definition below is what the code computes.
If a number is quoted anywhere else — a landing page, a proposal, a slide — and
disagrees with this page, this page is wrong or that number is; either way one of
them changes deliberately, not quietly.

---

## What is recorded

One line per move, appended to `.gitmir/audit/events.jsonl` in your project:

```json
{"t":"2026-08-19T09:30:00.000Z","change":"refunds","task":"001-refund-button",
 "from":"todo","to":"doing","kind":"build","areas":["mod-refunds"]}
```

- `change` — the `Change:` line on the task. Every task from the same request
  carries the same one, including the fix tasks written later. This is what turns
  four task files into one change.
- `task` — the file name, without `.md`.
- `from` / `to` — the columns. `from: null` is a task appearing; `to: null` is one
  disappearing.
- `areas` — the areas of the model the task's `Touches:` ids belong to, resolved
  when the move is recorded, so the record stays readable after the task is
  deleted and the model rebuilt.

**There is no author field.** No name, no email, no machine, no hostname. The file
is append-only and never leaves your machine unless you press the button that
sends the numbers, which shows you every byte first.

The watcher runs inside the local dashboard, on a two-second sweep that only reads
task files when a name or a modification time changed. It does not require the
team bridge to be connected.

---

## The numbers

Everything below is per **change**, then summed or averaged across the changes in
the window.

| Number | Definition |
|---|---|
| **First pass** | From the change's first move into `in progress` to its first move into `verify`. |
| **After the first pass** | From that first `verify` to the last `done` that stuck. |
| **First-pass ratio** | Changes that reached `verify` once and were accepted, over changes that reached `verify` at all. |
| **Iterations per change** | Moves from `verify` back to `in progress`, divided by the number of changes. |
| **Review cycles** | Every move into `verify`, first and repeat. |
| **Late discoveries** | Tasks of a change whose first event is later than that change's first `verify`. |

### The window

A change counts if it **started** inside the window — whole. One that began
earlier is left out, not measured from its middle.

This matters more than it sounds. Cutting the *events* to the window instead would
take a change that began the day before, lose the move that started it, and
measure its first pass from whatever it happened to do next — reporting "0 minutes
to first review" for two days of work. A change belongs to the window it began in,
or it is not in the sample.

### The idle cutoff

Within a change, a gap longer than the cutoff (4 hours by default; 2 and 8 are
offered) is **not counted as work at all**. A task left overnight does not add
fourteen hours to any timer.

The honest part: a queue move cannot tell a night from six hours of unbroken work.
Both are one gap between two moves. So the cutoff throws away real work as well as
real nights, and the screen says how much — "5 stretches longer than 4h were not
counted, worth 35h between them". If your work runs in longer sittings than the
cutoff, widen it and the number changes in front of you.

### What is deliberately not counted

- **A task that never entered `in progress`** — backlog is not cost.
- **A task that disappeared without reaching `done`** — somebody withdrew it. It is
  not an acceptance and not a late discovery. A task deleted *after* it was done is
  ordinary tidying and still counts.
- **A change still in review** — it appears in the table as `not yet` settled, and
  its "after the first pass" clock is still running.
- **A change with no `Change:` line** — it counts as its own change, named after
  its task. Old queues stay countable; they just read as many small changes.

---

## What it will not tell you

**Who.** The audit cuts by process and by area of the model. There is no per-person
number in the screen, in the API, in the export, or in the file it reads from —
and there is not going to be one. A tool that reports upward how many rounds a
developer needed is a tool that developer uninstalls.

The one count of people is exactly that: a count. When the audit is sent, it may
carry `developers: 4`, taken from `git log` at that moment and never stored. No
name goes with it.

**How much you would save.** The screen reports where time concentrates. It does
not claim a percentage that would go away, because that depends on work we have not
seen. Anything of that shape belongs in a conversation, not in a number.

**Whether the numbers are ready.** Below four changes the screen says so in words
instead of showing a confident `0%`.

---

## Sending it

The button beside the results opens a form — email required, name, company, note —
and then shows the **exact JSON** that will leave, updating as you type. The
numbers on the screen, the fields you filled, the areas by name-in-the-model, the
build version. No paths, no file names, no code, no model.

It posts from the local server rather than from the page, so the request carries an
`Origin` the receiving end can score. Three attempts on a network failure; a
refusal (`400`, `429`) is passed straight back with its own message rather than
retried. If it fails, nothing you typed is lost.
