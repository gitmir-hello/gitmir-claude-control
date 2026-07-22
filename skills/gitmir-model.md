---
name: gitmir-model
description: >-
  Build and maintain GitMir's multidimensional object-information model of the
  product this codebase implements, written as id-linked JSON into the project's
  local .gitmir/model/ folder. Use when the user asks to "build the GitMir
  model", "map this codebase", "generate the .gitmir model", "create the
  information model", or wants a living blueprint of what the software IS —
  its data, server logic, API surface, frontend, events, business processes,
  state machines and reactions — cross-linked by stable ids. Run it on a fresh
  repo to create the model, and re-run it after changes to keep it current. It also
  installs a mandatory CLAUDE.md rule so the model stays the product's living source
  of truth across sessions.
---

# GitMir object-information model

## What you are building

A **living blueprint of what this product actually is** — not the code, the
*model behind* the code. It answers "what does this software do, out of what
parts, and how do they connect" in a form both a human and an AI can read at a
glance and act on without re-reading the whole repository.

The model is **multidimensional** (ten linked collections, each a different
lens on the same product) and **id-linked** (every reference is a stable id, so
the collections form one connected graph, not ten disconnected lists). A task
later needs only the one or two dimension files relevant to it — that is the
whole point: cheap, targeted context instead of the entire codebase.

You write it to `.gitmir/model/` as plain JSON. You are the source of truth for
this local model — there is no server involved in this skill.

## Output layout

Write exactly this structure at the repository root:

```
.gitmir/
├── model/
│   ├── index.json          # { dimensions: {name: count}, at, project }
│   ├── modules.json        # Module[]         — the product's areas
│   ├── entities.json       # Entity[]         — the data (tables/views/aggregates)
│   ├── serverUnits.json    # ServerUnit[]     — backend building blocks
│   ├── serverFunctions.json# ServerFunction[] — operations (the verb layer)
│   ├── apiRoutes.json      # ApiRoute[]        — the HTTP surface
│   ├── frontendUnits.json  # FrontendUnit[]    — screens, components, stores
│   ├── events.json         # DomainEvent[]     — things that happen
│   ├── processes.json      # BusinessProcess[] — the "why": end-to-end flows
│   ├── statusFlows.json    # StatusFlow[]      — state machines + effects
│   └── reactions.json      # Reaction[]        — cause → effect rules
└── brief.json              # optional: product brief (see last section)
```

Each dimension file is a **JSON array** of the objects defined below. `index.json`
records the count per dimension and an ISO timestamp, e.g.
`{ "dimensions": { "modules": 6, "entities": 21, ... }, "at": "2026-07-21T…Z", "project": "acme-shop" }`.

Pretty-print with 2-space indentation so diffs are reviewable.

## Build in two layers, top layer first

Do **not** try to produce everything at once. Build the cheap static skeleton
across the whole repo first, then deepen.

**Layer 1 — STATIC (do this fully first, one broad pass over the repo):**
`modules`, `entities` (with key fields + foreign keys), `serverUnits`,
`apiRoutes`, `frontendUnits`. This alone is a usable map.

**Layer 2 — DYNAMIC (deepen after the skeleton exists):**
`serverFunctions` (with field-level reads/writes and call/emit graph), `events`,
`processes`, `statusFlows`, `reactions`, and the frontend data-flow tree
(`nodeKind`/`parentId`/`inputs`/`outputs` on FrontendUnits). Populate these where
the code actually supports them — an app with no state machine has an empty
`statusFlows.json`, and that is correct, not a gap to invent around.

## ID conventions (critical — links depend on this)

Every object has a stable, human-readable `id` with a per-collection prefix,
kebab-cased from the name:

| Collection      | prefix | example          |
|-----------------|--------|------------------|
| Module          | `mod-` | `mod-analytics`  |
| Entity          | `ent-` | `ent-order`      |
| Field           | `f-`   | `f-order-total`  |
| ServerUnit      | `su-`  | `su-orders`      |
| ServerFunction  | `sf-`  | `sf-order-advance`|
| ApiRoute        | `rt-`  | `rt-orders-patch`|
| FrontendUnit    | `fe-`  | `fe-checkout-page`|
| DomainEvent     | `ev-`  | `ev-order-paid`  |
| BusinessProcess | `proc-`| `proc-checkout`  |
| StatusFlow      | `sfw-` | `sfw-order-state`|
| Reaction        | `rx-`  | `rx-recalc-total`|

Ids **must stay stable across re-runs** — links break if you rename them. When
you re-run this skill, load the existing `.gitmir/model/*.json`, reuse the ids
already there, and only add/patch/remove deltas. Never regenerate ids for
objects that still exist.

## The schema

Types below use TS-ish notation: `?` = optional, `ID` = a string id of another
object, `A[]` = array. Omit optional fields you have no evidence for rather than
guessing. `moduleId` on any object links it to its area and is optional but
strongly encouraged.

### Module — `modules.json`
```ts
{ id, name, key?, description, parentId?: ID, icon?, order?: number }
```
The product's top-level areas (Orders, Billing, Analytics…). `parentId` nests
sub-areas. `key` is a short stable slug.

### Entity — `entities.json`
```ts
{ id, name, tableName, description, storage: "table"|"view"|"aggregate"|"external",
  serverUnitId: ID, moduleId?: ID, derivedFrom?: ID[], fields: Field[],
  rowCount?: number, sampleRows?: object[] }

Field = { id, name, type: FieldType, isPrimary?, isNullable?, isUnique?,
          refEntityId?: ID, note? }
FieldType = "uuid"|"string"|"text"|"int"|"bigint"|"float"|"decimal"|"bool"
          |"timestamp"|"date"|"json"|"enum"|"ref"
```
`storage`: `table`/`view` = persisted in the DB; `aggregate` = computed by a
service (set `derivedFrom` to the source entity ids); `external` = owned by
another system. A foreign key is a Field with `type:"ref"` and `refEntityId`
pointing at the target entity.

Example:
```json
{ "id": "ent-daily-revenue", "name": "DailyRevenue", "tableName": "daily_revenue",
  "storage": "aggregate", "serverUnitId": "su-analytics", "moduleId": "mod-analytics",
  "derivedFrom": ["ent-order", "ent-order-item"],
  "description": "Computed daily revenue totals.",
  "fields": [
    { "id": "f-dr-date", "name": "date", "type": "date", "isPrimary": true },
    { "id": "f-dr-revenue", "name": "revenue", "type": "decimal" } ] }
```

### ServerUnit — `serverUnits.json`
```ts
{ id, name, kind: ServerUnitKind, description, entityIds: ID[], dependsOn: ID[],
  moduleId?: ID }
ServerUnitKind = "service"|"controller"|"worker"|"gateway"|"integration"
               |"scheduler"|"auth"
```
A backend building block. `entityIds` = entities it owns; `dependsOn` = other
serverUnits it calls.

### ServerFunction — `serverFunctions.json`  (the operation / verb layer)
```ts
{ id, name, serverUnitId: ID, operation: ServerOperation, description,
  routeId?: ID, moduleId?: ID,
  readsFieldIds: ID[], writesFieldIds: ID[], callsFunctionIds: ID[],
  emitsEventIds: ID[], subscribesEventIds: ID[] }
ServerOperation = "list"|"getById"|"create"|"update"|"delete"
                |"business_action"|"resolver"|"subscriber"|"job"
```
The granular thing tasks act on. `readsFieldIds`/`writesFieldIds` reference
`Field` ids (fully qualified — the field's own id, e.g. `f-order-status`), giving
a field-level data-flow graph. `routeId` links the function to the endpoint that
invokes it. This is Layer-2 work; fill the graph edges from the actual code.

Example:
```json
{ "id": "sf-order-advance", "name": "advanceOrderStatus", "serverUnitId": "su-orders",
  "operation": "business_action", "routeId": "rt-orders-patch", "moduleId": "mod-orders",
  "readsFieldIds": ["f-order-status"], "writesFieldIds": ["f-order-status"],
  "callsFunctionIds": ["sf-inventory-reserve"], "emitsEventIds": ["ev-order-ready"],
  "subscribesEventIds": [], "description": "Moves an order to the next state." }
```

### ApiRoute — `apiRoutes.json`
```ts
{ id, method: "GET"|"POST"|"PUT"|"PATCH"|"DELETE", path, name, description,
  serverUnitId: ID, moduleId?: ID, auth: boolean }
```
One per HTTP endpoint. `auth` = does it require authentication.

### FrontendUnit — `frontendUnits.json`
```ts
{ id, name, kind: FrontendUnitKind, description, consumesRouteIds: ID[],
  dependsOn: ID[], emitsEventIds?: ID[], subscribesEventIds?: ID[], moduleId?: ID,
  // per-screen data-flow tree (Layer 2, optional):
  nodeKind?: "container"|"array"|"element"|"algorithm", parentId?: ID,
  inputs?: { key, from? }[], outputs?: { key, isArray?, source? }[] }
FrontendUnitKind = "page"|"view"|"component"|"store"|"hook"|"form"|"flow"
```
Screens, components, stores, hooks. `consumesRouteIds` links a screen to the
endpoints it calls. The optional `nodeKind`/`parentId`/`inputs`/`outputs` model
the data-flow tree *inside* a screen — build it only where a screen's internal
wiring matters.

### DomainEvent — `events.json`
```ts
{ id, name, description, payload?, moduleId?: ID }
```
Something meaningful that happens (`OrderPaid`, `UserInvited`). Producers set
`emitsEventIds`, consumers set `subscribesEventIds` — that is what wires the
event graph together across serverFunctions and frontendUnits.

### BusinessProcess — `processes.json`  (the "why" layer)
```ts
{ id, name, description, triggerKind: "ui"|"api"|"event"|"schedule",
  triggerRefId?: ID, moduleId?: ID, steps: ProcessStep[] }
ProcessStep = { refKind: "function"|"route"|"event"|"entity"|"frontend",
                refId: ID, note? }
```
An end-to-end flow told as an ordered list of steps, each pointing (by
`refKind`+`refId`) at a real object already in the model. This is the layer that
explains business intent — "checkout" as a path through functions, events and
entities. `triggerRefId` points at what starts it (a route id, an event id…).

### StatusFlow — `statusFlows.json`  (state machine + transition effects)
```ts
{ id, name, entityId: ID, fieldName?, description?, moduleId?: ID,
  states: { key, name, ownerRole?, editedWhere? }[],
  transitions: { from, to, byRole?, condition?, effects: TransitionEffect[] }[] }
TransitionEffect = { kind: "create"|"update"|"recalculate"|"sync"|"notify"|"link"
                        |"delete", entityId?: ID, fieldName?, description }
```
The lifecycle of a status field on an entity (`order.status`:
draft→paid→shipped). Each transition can carry `effects` — what else changes
when it fires. `from`/`to`/`condition` are state `key`s and expressions.

### Reaction — `reactions.json`  (universal cause → effect)
```ts
{ id, name, description?, moduleId?: ID,
  trigger: { entityId: ID, fieldName?, change? },
  effects: TransitionEffect[] }
```
"When this field changes, that recalculates / syncs / notifies." Use for derived
values and side effects that are not tied to a status transition (e.g. when
`orderItem.qty` changes, recalculate `order.total`).

## How to extract from a codebase

Ground **every** object in something real in the repo. Do not invent state; if
you are unsure, either omit it or add a short `note`/`description` flagging the
uncertainty.

Rough mapping to look for:

- **DB schema / migrations / ORM models** (Prisma, Drizzle, SQLAlchemy, ActiveRecord, `CREATE TABLE`) → `entities` + `fields`; foreign keys → `type:"ref"` fields.
- **Services / controllers / modules / packages** → `serverUnits`; group by folder/domain.
- **Route definitions / OpenAPI / framework routers** → `apiRoutes`; the handler each route calls → the `routeId` on a `serverFunction`.
- **Exported functions / methods / resolvers / jobs / handlers** → `serverFunctions`; classify each into an `operation`; trace what it reads/writes to fill the field graph.
- **Pages / components / stores / hooks** (React/Vue/Svelte routes and components) → `frontendUnits`; `fetch`/API-client calls → `consumesRouteIds`.
- **Message bus / emitters / webhooks / queue topics** → `events`.
- **Status/enum columns with lifecycle logic** (`status`, `state`, `phase`) → `statusFlows`.
- **Triggers, computed columns, `@computed`, recalculation logic, post-save hooks** → `reactions`.
- **README / product docs / top-level folder names** → `modules` and their descriptions.

Work top-down: identify modules → entities → server units → routes → frontend
(Layer 1), then walk the operations to fill functions/events/processes/flows
(Layer 2).

## Integrity rules — check before you finish

The value is entirely in the links being correct. Before writing the final
files, verify:

1. **No dangling references.** Every `ID` in every field (`serverUnitId`,
   `refEntityId`, `readsFieldIds`, `routeId`, `steps[].refId`, `entityId`,
   `emitsEventIds`, `consumesRouteIds`, `parentId`, `derivedFrom`, …) resolves to
   an object that exists in the model.
2. **Every entity has ≥1 `isPrimary` field.**
3. **Every serverFunction belongs to a real serverUnit**; every apiRoute too.
4. **`aggregate` entities have a non-empty `derivedFrom`.**
5. **StatusFlow `from`/`to` reference declared state `key`s**; Reaction/StatusFlow
   effect `entityId`/`fieldName` resolve.
6. **`index.json` counts equal the array lengths** in each dimension file, and
   `at` is refreshed.

If a check fails, fix the reference — do not delete the link to make the check
pass.

## Re-running (idempotent updates)

This skill is meant to be run repeatedly as the codebase evolves:

1. Read the existing `.gitmir/model/*.json` if present.
2. Reconcile against the current code: **keep stable ids**, add new objects,
   patch changed ones, remove objects whose code is gone.
3. Re-validate the integrity rules and rewrite `index.json` with fresh counts
   and `at`.

Treat `.gitmir/model/` as the model's home. If a `.gitmir/brief.json` exists,
never overwrite it from here — it is the product brief, a separate artifact.

## Standing rule — the model is the product's source of truth (mandatory)

Building this model is not a one-off snapshot. Each time you run this skill, also
make its upkeep a **standing rule** for the project, so every future session
follows it automatically without being asked.

Ensure the project root has a `CLAUDE.md` that contains the section below. Create
`CLAUDE.md` if it is absent; if it already exists, add or update **only** this
section and leave all unrelated content untouched:

```md
## GitMir model — source of truth (mandatory)

This project maintains a `.gitmir/model/` — the authoritative object-information
model of the product (entities, server units & functions, API routes, frontend
units, events, business processes, status flows, reactions), cross-linked by id.

- **Orient from it first.** Before answering questions about the product or
  changing code, read the relevant `.gitmir/model/*.json` dimension(s) to see what
  exists and how it connects. Treat the model as the source of truth over ad-hoc
  code reading.
- **Keep it current (mandatory).** After ANY change to code that affects the
  model — an entity, field, server unit/function, API route, frontend unit, event,
  business process, status flow, or reaction added, changed, or removed — update
  the affected `.gitmir/model/*.json` in the SAME session before finishing, keeping
  ids stable and integrity intact, and refresh `index.json`. Never leave the model
  stale after a code change.
- Rebuild/update the model with the `gitmir-model` skill.
```

With that rule in `CLAUDE.md`, the model becomes a **living source of truth**: each
session orients from it and refreshes it after code changes.

## Optional: `brief.json`

If the user also wants the locked product brief captured, write
`.gitmir/brief.json` as:
```ts
{ summary,
  must:  { text, criteria?: { text, kind: "build"|"smoke"|"flow"|"manual" }[] }[],
  nice:  string[], out: string[],
  decisions?: { conflict, decision, rationale }[],
  openQuestions?: string[] }
```
`must` = requirements that must hold, each with machine-checkable acceptance
criteria; `out` = explicitly out of scope. Only produce this when asked — the
model itself does not require it.

## Scope guardrails

- Write **only** under `.gitmir/` — plus the single "GitMir model — source of
  truth" section in the project's `CLAUDE.md` (see the Standing rule section). Do
  not touch application source.
- The model describes what the code **is**, from the code — it is documentation
  of reality, never a wishlist. Empty dimensions are honest; invented ones are not.
- Keep descriptions short and concrete (one line). The reader wants the shape of
  the system, not prose.
