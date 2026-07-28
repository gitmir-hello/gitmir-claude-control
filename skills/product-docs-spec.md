---
name: product-docs-spec
description: >-
  Assemble a docs/ folder of 12 files that serves as the PRECISE specification for
  development — so the product is built right the first time, without rework. Use at the
  very start of a new product or niche: when there is raw input (a client's description,
  .md/.docx/.pdf specs, a CSV dataset, a Lovable/Figma export, existing code) and it has to
  become a structured specification BEFORE any code is written. Also use when asked to "set
  the project up the way I taught you", "make the docs", or "describe the screens".
---

# Skill: the product specification as a `docs/` folder (12 files)

Your job under this skill is **not to write code** — it is to assemble a `docs/` folder of
12 files that is then used as the specification. A good `docs/` folder lets the product be
built correctly on the first attempt, because every decision is made and written down
BEFORE the code: the data model, the roles, the screens, the processes, the API, the
invariants and the open questions. A bad one — vague, full of generalities — produces
rework.

---

## 0. When to use it, and what comes out

**Use it when:** a new product or niche is starting; there is input but no specification;
you are asked to "put the docs together".

**Result:** a `<Project>/docs/` folder with exactly **12 files** (see §3). The language of
the docs is the language of the product (the local language for a local niche, English for
an international catalogue, and so on) — but one language throughout the folder.

**Important:** docs first, code second. If you are asked to "build the whole project", this
skill is the FIRST step (the docs); development against those docs starts only afterwards.

---

## 1. The principle: why these docs work as a specification

1. **Grounded.** Every statement is derived from real input — a spec you read, a CSV you
   parsed, existing code or an export you went through. Nothing is invented. If the data is
   not there, that is an open question, not a guess.
2. **Decisions, not descriptions.** Not "it could be done this way or that way" but "we do it
   this way, because…". Write as a designer who has decided, not as an analyst listing
   options.
3. **Concrete down to implementation level.** Exact fields and types, enum values verbatim, a
   permission matrix, per-screen interactions, the API contract, and the invariants the server
   ENFORCES. A developer must be able to start coding without filling in blanks.
4. **Open questions with defaults.** Everything ambiguous goes into one file, each question
   with a proposed default and a note on whether it blocks. That is what lets building
   continue without stalling: debatable points proceed on the default, critical ones get
   answered.
5. **Consistency throughout.** The same numbers, enum values, entity names and terms are
   identical across every file and match the real data. Numbers that drift apart are a defect
   in the specification.

---

## 2. The process, step by step

1. **Gather the input.** Find and READ everything the client provided: text (.md/.docx/.pdf),
   data (CSV/JSON), design or code exports, the existing repository. Do not write docs before
   you have read the sources.
2. **Parse the data.** If there is a dataset, actually parse it: how many records, which
   columns, how well populated, and what a row means (this often REDEFINES the model — e.g.
   "a row is a person at a company", "the email is a shared inbox, not a personal one").
   Check duplicates, overlaps between files, distributions. Derive the data model from the
   facts in the dataset, not from generalities.
3. **Go through the screens and the code.** If an export (Lovable/Figma) or existing code was
   provided, walk every screen and module and record what exists, what is mocked and what is
   live.
4. **Make the decisions.** For each debatable point pick a sensible default (roles, statuses,
   uniqueness keys, what is public and what is not, units, language). Debatable but not
   critical — decide it yourself and write it down. Critical (legal risk, money, access to
   external data) — raise it as an open question.
5. **Write the 12 files** (§3), grounding every statement in the input. Hold the quality bar
   (§4).
6. **Pass over it for consistency.** Reconcile numbers, enums and entity names between files
   and against the data.
7. **Record the open questions** with defaults and a blocking/not-blocking flag.

If the scope is large (many screens), the writing can be parallelised across subagents — but
fix the contract (entity names, roles, API) in 03/02/07 FIRST, so the other files can refer
to it.

---

## 3. The structure: 12 files

The number prefix in the filename (`00_`, `01_`, …) sets the reading order. The canonical
set:

| # | File | Purpose |
| --- | --- | --- |
| 1 | `README.md` | Index: one paragraph about the product + a table linking the other files + coordinates (domain, port, repo) |
| 2 | `00_OVERVIEW.md` | Problem → solution → users → value → 3–5 key scenarios |
| 3 | `01_SCOPE.md` | Boundaries: **MVP** / second wave / **deliberately out of scope** |
| 4 | `02_ROLES.md` | Roles + a **permission matrix** + visibility rules |
| 5 | `03_DATA_MODEL.md` | Entities: fields, **types**, enum values, relations, **integrity rules** |
| 6 | `04_SCREENS.md` | Each screen: purpose, layout, data, **interactions** (what is live / what is mocked) |
| 7 | `05_WORKFLOWS.md` | Key processes step by step + **state machines** / lifecycles |
| 8 | `06_REPORTS.md` | Reports, analytics, dashboard: contents + **formulas**. No analytics → say so explicitly |
| 9 | `07_API.md` | REST endpoints + response conventions + error format |
| 10 | `08_NONFUNCTIONAL.md` | Volumes, performance, security, privacy/GDPR, SEO, operations, deployment, domain |
| 11 | `09_OPEN_QUESTIONS.md` | **Open questions** — each with a default decision + a "blocking / not blocking" flag |
| 12 | `10_ARCHITECTURE.md` | Stack + architectural decisions + build and deploy. If the stack is non-trivial (SSR and such) move it earlier |

**Adaptive slots** (the set flexes, but it is always 12 files):
- `05_WORKFLOWS` → replace with `05_DATA_IMPORT` if the core of the product is importing and
  normalising a dataset (then describe: what the files actually contain, the mapping rules,
  deduplication, idempotency, the expected result).
- `06_REPORTS` → if there are no reports, keep the file but state briefly that there is no
  analytics, or that it is second wave.
- `10_ARCHITECTURE` → move it up (e.g. to `01_ARCHITECTURE`) if the stack is part of what was
  agreed with the client.

### What every file must contain

**README.md** — one paragraph of substance; a "file → what it covers" table; the project
coordinates (slug, domain, port, repo, branch). If decisions have already been agreed with
the client, a "client decisions" block.

**00_OVERVIEW.md** — the problem (the pain, concretely), the solution, who the users are (a
role → job table), how it differs from a well-known analogue (a comparison table where that
helps), the value, and 3–5 scenarios.

**01_SCOPE.md** — three sections: **in the MVP** (a block → contents table), **second wave**,
and **deliberately out of scope** (explaining why each is a decision and not an omission).
Boundaries are the single most important thing for getting it right first time: without them
the product bloats.

**02_ROLES.md** — the list of roles (who they are, what they can do), a **permission matrix**
(action × role → ✅ / —), and visibility rules (who sees what: "a technician sees only their
own visits", "the catalogue is open without registration").

**03_DATA_MODEL.md** — the core of the specification. For each entity: **every field with its
type**, enum values **verbatim**, relations (1—*, *—1), indexes. A separate **"Integrity
rules"** section: the invariants the server ENFORCES (e.g. "totals are computed by the server
only", "the slug is unique per X", "a closed record is immutable", "money is an integer in
minor units"). An ASCII diagram of the relations is worth including.

**04_SCREENS.md** — the longest file. Each screen as a `##` section: **purpose**, **layout/UI**
(the actual blocks and widgets), **data** (which fields and entities), **interactions**
(buttons, filters, toggles — and which of them are really wired to the backend and which are
mocked). If you are going through an existing export, mark wired/mock honestly. If you are
designing from scratch, describe the intended behaviour.

**05_WORKFLOWS.md** — the key business processes step by step; for entities with a status, a
**state machine** (which transitions are allowed and who performs them) and the consequences
(what happens on closing, publishing, writing off). Also the rules about what is irreversible
and what triggers side effects.

**06_REPORTS.md** — if there is analytics: the source data (which records are included), the
**formulas** for each metric, the breakdowns, the export, and the accuracy rules (what the
server computes). If there is none: a short note and a move to the second wave.

**07_API.md** — endpoint tables by section: method, path, access, body/purpose. A single
response format (`{result:'ok', ...}` / `{result:'error', error_code, message}`), pagination,
the operational `/health` and `/readyz`, and the key business errors. The API must map 1:1
onto the model and the screens.

**08_NONFUNCTIONAL.md** — real constraints rather than platitudes: **volumes** (how many
records and files, and which of those is the bottleneck — often NOT the database but photos,
search or traffic), **performance** (pagination, indexes, when full-text search is needed),
**security**, **privacy/GDPR** (if there is personal data about real people — what is
published and what is not, the right to deletion), **SEO** (is SSR or a sitemap needed),
**operations** (port, health, logs), **backups**, **domain/DNS**.

**09_OPEN_QUESTIONS.md** — list EVERYTHING ambiguous. Each question: the substance + a
**default decision** ("if this is acceptable, no separate answer is needed") + whether it is
**blocking** (cannot be built without an answer — e.g. the provenance of personal data, the
legal entity, access to an external dataset, DNS). This is what allows work to continue
without getting stuck.

**10_ARCHITECTURE.md** — the stack and why; how rendering and the process work; the routes;
the build and the deployment; how the initial data gets in (seed or import). If the project
lives in a known infrastructure, refer to its deployment rules.

---

## 4. The quality bar (what separates a specification from filler)

- **Types and enums verbatim.** Not "order status" but
  `status: enum (draft | in_progress | done | cancelled)`.
- **Invariants on the server.** State explicitly what the server computes and checks rather
  than the client (money, totals, status transitions, permissions). The client must not send
  "its own total".
- **Uniqueness keys and slugs.** What identifies an entity, how the URL slug is built, what
  happens on a collision. (E.g. "a company's key is name + country"; "the slug comes from the
  domain and is unique by construction".)
- **Units and formats.** Money as integers in minor units (cents), dates in UTC/ISO, currency
  from settings.
- **wired vs mock** on the screens — mandatory when going through an existing product.
- **Privacy up front.** If the data contains real people: what is public, what is not, how
  someone is removed. That is a decision in the specification, not "later".
- **Numbers that agree.** Import totals, volumes and counters match between 00/01/05/06/08 and
  the real data. Recompute them if you changed anything.
- **Cross-links.** The files link to each other (`[03_DATA_MODEL.md](./03_DATA_MODEL.md)`).

---

## 5. Anti-patterns (do not do this)

- Filler and marketing instead of decisions ("a modern, convenient interface").
- A data model without types or relations; "we'll add fields as we go".
- Screens without interactions; "buttons as usual".
- Forgetting the open questions, or asking them without defaults (development then stalls).
- Numbers that disagree between the files and the data.
- Inventing data, a country or a type that is not in the input instead of honestly raising it
  as an open question.
- Starting to write code before the docs are ready.

---

## 6. Readiness checklist

- [ ] Exactly 12 files, the numbering sets the order, the README links to all of them.
- [ ] Every input (specs, data, code) has actually been read and is grounded in the docs.
- [ ] The dataset, if there is one, has been parsed; the data model follows from its facts.
- [ ] 03_DATA_MODEL: every entity has fields + types + enums + relations, plus an "Integrity
      rules" section.
- [ ] 02_ROLES: a permission matrix and visibility rules.
- [ ] 04_SCREENS: every screen with its interactions (wired/mock when going through an
      existing product).
- [ ] 07_API: the endpoints map onto the model and the screens; one response and error format.
- [ ] 08_NONFUNCTIONAL: the real bottlenecks are named, along with privacy, SEO, deployment
      and backups.
- [ ] 09_OPEN_QUESTIONS: every question has a default and a blocking/not-blocking flag.
- [ ] Numbers, enums and entity names are consistent across every file and with the data.
- [ ] One language throughout the docs; the cross-links are in place.

When the checklist is green, the `docs/` folder is ready to serve as the specification, and
the product can be built from it.
