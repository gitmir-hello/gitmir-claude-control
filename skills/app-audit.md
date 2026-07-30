---
name: app-audit
description: >-
  Walk a running application end to end — every page, every interactive element, every API
  route — work out what a user can actually accomplish, and prove each of those use cases
  by executing it. It writes an inventory, turns the use cases into verify tasks in
  tasks/todo/, runs them against the real app, and files a fix task for every failure with
  the exact repro. Use when the user asks to "check the whole app", "go through all the
  pages", "find what is broken", "audit the functionality", or wants regression coverage of
  a product nobody has tested systematically.
---

# Auditing a whole application, use case by use case

## What this produces

Three things, in this order — each one useful even if you stop after it:

```
.gitmir/audit/
├── inventory.json     # every page, element and route found, and how it was found
└── findings.json      # what failed, with the repro that proves it
tasks/todo/
├── NNN-audit-<page>.md    # Type: verify — the use cases to prove, as numbered steps
└── NNN-fix-<what>.md      # Type: fix   — written only after a check actually failed
```

Tasks go in the format `task-planner` defines and `task-runner` executes, so the audit runs
on the machinery that already exists rather than beside it. The **Queue** tab shows it.

### The two files, exactly

The dashboard reads these to draw the audit panel, so the shapes are a contract — keep the
key names. Unknown extra keys are ignored, missing ones just leave a field blank.

```jsonc
// .gitmir/audit/inventory.json
{ "target": "http://localhost:3000",
  "env": "local",                       // local | staging | disposable  (never "production")
  "driver": "chrome-cdp",               // playwright | puppeteer | chrome-cdp | curl
  "at": "2026-07-30T09:00:00Z",
  "auth": ["anonymous", "user"],        // the auth states actually exercised
  "caps": { "crawlDepth": 3, "maxPages": 60 },   // the limits you imposed — state them
  "pages": [
    { "n": 12, "url": "/checkout", "title": "Checkout",
      "foundBy": ["model", "router", "crawl"],   // which sources saw it
      "auth": "user",
      "elements": { "interactive": 24, "data": 6 },
      "useCases": 5,
      "status": "passed",               // passed | failed | pending | unreachable | skipped
      "notExercised": ["Place order — charges the card"],
      "task": "012-audit-checkout",     // the verify task file, without .md
      "note": "" } ],
  "mismatches": [
    { "kind": "route-unreachable", "what": "/admin/legacy",
      "detail": "in the router, never linked from any crawled page" } ] }
```

```jsonc
// .gitmir/audit/findings.json  — an array
[ { "id": "f-001",
    "severity": "critical",             // critical | major | minor | intermittent
    "title": "checkout accepts an empty address",
    "page": "/checkout", "step": 3,
    "expected": "refused, the message names the field (docs/04_SCREENS.md)",
    "observed": "POST /api/orders returned 201, order created with address: null",
    "evidence": ".gitmir/audit/shots/012-3.png",
    "task": "047-fix-checkout-address",  // the fix task you filed, without .md
    "at": "2026-07-30T09:41:00Z" } ]
```

Write `inventory.json` at the end of Phase 2 and update a page's `status` as each audit
task finishes, so the panel fills in while the run is going rather than all at once.

## Before anything: which environment

**Never audit production.** This skill clicks buttons, submits forms and calls endpoints. On
a live system that deletes records, sends email to real customers, and charges cards.

Establish the target before the inventory, and stop and ask if it is not obvious:

1. **Which base URL** — and confirm it is local, staging or a disposable environment.
2. **Whether the data is disposable.** If a mistake here would matter, the answer is no and
   the audit stays read-only.
3. **How to authenticate.** Ask for a test account. Without one you are auditing the
   logged-out surface only — which is a legitimate audit, but you must say so in the report
   rather than implying full coverage.

Then classify every control you find as **safe** or **destructive**:

- Safe: navigation, filters, search, sorting, opening a form, validation errors, read
  endpoints.
- Destructive: delete, cancel, refund, send, publish, pay, invite, anything that writes to a
  third party or is irreversible.

Destructive controls are exercised **only** against disposable data and only when the user
has said so. Otherwise record them in the inventory as `notExercised: "destructive"`. A
control you chose not to press is an honest gap; one you pressed on real data is an
incident.

## Phase 1 — inventory

Build the list of what exists from **three independent sources**, because each misses
something different, and the disagreements between them are findings in their own right.

1. **The model**, if `.gitmir/model/` exists — `frontendUnits` gives the screens,
   `apiRoutes` the endpoints, `processes` and `statusFlows` the flows worth proving. Use
   `model-navigate` to read it rather than opening every file.
2. **The router**, from the code — route definitions, page files, framework conventions
   (`pages/`, `app/`, `routes.rb`, a router config). This is what the app claims to have.
3. **A crawl** of the running app — start at the root, follow same-origin links, breadth
   first, with a cap on depth and page count. This is what a user can actually reach.

Then cross-check, and write down what does not line up:

- In the router but never reachable by crawling → dead route, or UI with no link to it.
- Reachable but not in the model → the model is out of date; note it and refresh it after.
- An `apiRoute` no frontend unit consumes → dead endpoint, or a client you have not found.

**On "every element".** A page has hundreds of nodes and most are decoration. The inventory
records **interactive elements** — links, buttons, inputs, selects, forms, and anything with
a click handler, a `role`, or a `data-testid` — plus **data-bearing regions**: tables,
lists, totals, status badges, anything showing a value that could be wrong. Static text and
layout are counted but not exercised. That is a deliberate narrowing; state it in the report
so nobody reads "all elements checked" as more than it is.

For each page record: URL, title, how it was found, the auth state needed, the interactive
elements with a stable selector for each, and the API routes it calls.

## Phase 2 — derive the use cases

A use case is **something a user accomplishes**, not a control that exists. "The email field
rejects `foo@`" is a check; "a visitor signs up with a valid address and lands on the
dashboard" is a use case. Audit the second, and let the first be one of its steps.

Derive them from what you have:

- **From `processes` and `statusFlows`** in the model — these are already end-to-end flows
  with an expected result. They are the best use cases you will get; use them first.
- **From forms** — each form is at least three use cases: valid submission, invalid input
  rejected with a visible message, and the empty submission.
- **From lists and tables** — load, empty state, pagination, filter, sort.
- **From auth** — logged out, logged in, and if roles exist, one use case per role that
  should be refused.

**Every use case needs an expected result, and where it came from.** This is the difference
between an audit and clicking around. Take the expectation from the model, the docs, or the
code — and when it comes from none of those, mark it `assumed:` and say what you assumed. A
failure against an assumed expectation is a question for the user, not a defect.

Prioritise, because a real app has more use cases than anyone will run:

1. Anything touching money, auth, permissions or data loss.
2. The three or four flows the product exists for.
3. Everything else, breadth first — one use case per page beats five on one page.

Write it all to `.gitmir/audit/inventory.json` and **report the counts before generating
tasks**: pages, elements, use cases, and how many are destructive and will be skipped. The
user decides the size of the run.

## Phase 3 — write the audit tasks

One task per page or per flow — not per use case, which produces hundreds of files.

```md
# Audit — checkout page

Type: verify

## Context
App audit, page 12 of 34. Inventory: `.gitmir/audit/inventory.json`.
URL: http://localhost:3000/checkout   ·   auth: test user `qa@example.com`
Model: proc-checkout, sfw-order-state, rt-orders-post.
Destructive controls on this page, NOT to be pressed: "Place order" (charges the card).

## Verify
1. Load the page logged out — redirects to /login, does not render an empty cart shell.
2. Log in, load it with one item — the total equals the item price plus shipping from
   `proc-checkout`; no console errors.
3. Submit with an empty address — the form is refused and the message names the field.
   (expected: from `04_SCREENS.md`)
4. Change the quantity to 0 — the line is removed and the total recalculates.
   (assumed: the model does not say; confirm with the user if this fails)
5. GET /api/cart with another user's cart id — 403 or 404, never the cart.
```

Number them so the highest-priority pages run first. `task-runner` will pick them up in
order, execute the steps for real and record PASS/FAIL per step — which is exactly the
behaviour this audit needs, so do not build a second mechanism for it.

## Phase 4 — actually driving the app

Use the strongest tool that is present, and **say in the report which one you used**,
because it determines what the audit could see.

1. **Playwright or Puppeteer**, if already in the project — best option, use it.
2. **Chrome over CDP with no dependencies** — Node 22+ has a global `WebSocket`, so a
   headless Chrome can be driven from a short script with nothing installed:

   ```js
   import { spawn } from 'node:child_process';
   const CH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';  // or chrome/chromium on PATH
   spawn(CH, ['--headless=new','--remote-debugging-port=9222','--user-data-dir=/tmp/audit'], {stdio:'ignore'});
   const list = await (await fetch('http://localhost:9222/json')).json();
   const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
   await new Promise(r => ws.addEventListener('open', r));
   let id = 0; const pending = new Map();
   ws.addEventListener('message', e => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); });
   const cmd = (method, params) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({id:i, method, params})); });
   const evalJs = js => cmd('Runtime.evaluate', {expression: js, returnByValue: true}).then(r => r.result?.result?.value);
   ```

   From there: `Page.navigate`, `Runtime.evaluate` to click and read the DOM,
   `Page.captureScreenshot` for evidence, and listen for `Runtime.exceptionThrown` and
   failed `Network.responseReceived` to catch what the page does not show.
3. **`curl` only** — API routes, status codes, auth boundaries. Real coverage of the server,
   none of the UI. Say that plainly rather than reporting the pages as passing.

Whatever you use, capture per step: the **console errors**, the **failed network requests**
and a **screenshot on failure**. A failure without evidence turns into an argument later.

**Wait for the app before you count anything.** On a client-rendered app the DOM a moment
after `Page.navigate` is not the page — it is the shell. Counting elements there gives a
number that is real and meaningless: a dashboard whose whole interface appears after you
pick a project shows four interactive elements on load and dozens once you have. So settle
first — wait for the network to go quiet and for a selector you expect, then inventory, and
where the interface only exists after an interaction, **perform that interaction as part of
reaching the page** and record it as a precondition. A crawler that only loads URLs will
report a rich app as nearly empty and never say why.

## What is a defect, and what is not

Report as defects: a 500, an unhandled exception, a broken link, a form that accepts invalid
input, a form that rejects valid input, a total that does not match its inputs, a permission
that does not hold, a state that cannot be left, data that does not persist across a reload,
a control that does nothing.

Do **not** report: styling opinions, missing features, third-party console noise (analytics,
extensions), slowness without a stated budget, or anything you inferred from reading code
rather than observed. This audit reports what it saw happen.

**Reproduce before you file.** Run the failing step a second time from a clean state. If it
passes the second time, it is flaky — record it as `intermittent` with both observations
rather than as a defect, because a fix task for a race that nobody can reproduce wastes a
whole cycle.

## Phase 5 — findings become fix tasks

Append every confirmed failure to `.gitmir/audit/findings.json` and write one fix task per
distinct defect, in the format `task-runner` already understands:

```md
# Fix: checkout accepts an empty address

Type: fix
Fixes: 012-audit-checkout
Attempt: 1

## Context
Found by app audit, 2026-07-30, against http://localhost:3000 with Chrome over CDP.
Step 3 of the checkout audit.
Expected: submitting with an empty address is refused and the message names the field
(source: docs/04_SCREENS.md).
Observed: the request went through — POST /api/orders returned 201 and the order was
created with `address: null`. Console clean. Screenshot: .gitmir/audit/shots/012-3.png

## Task
Reject the submission server-side when the address is empty, and surface the message on the
field. Client-side validation alone does not close this — the API accepted it directly.

## Verify
1. Submit the form with an empty address — refused, the field shows the message.
2. POST /api/orders directly with `address: null` — 400, no order created.
3. Submit with a valid address — still succeeds, order created. (the original step 2)
```

Two rules that keep this useful:

- **One task per distinct defect.** Ten pages failing from one broken component is one fix
  task naming all ten, not ten tasks.
- **Always re-check the neighbours.** Carry the passing steps of the same page into the fix
  task's `## Verify`, so the repair cannot break what was working.

## Resuming and reporting

The inventory holds the page list and which pages are audited; the queue holds the work; the
findings file holds the results. A session that ends halfway continues from the inventory —
nothing important lives in the conversation.

The final report says, in this order: what was **covered** (pages, use cases, auth states,
which driver), what was **not** — destructive controls skipped, pages behind auth you could
not reach, checks the tooling could not run — then the defects by severity, then the
intermittents, then the assumptions that failed and need a human decision.

Lead with the gaps. "34 of 41 pages, logged-in only, destructive controls not pressed" is
the sentence that makes the rest of the report trustworthy; a report that only lists what
passed invites everyone to believe the app is fine.

## Guardrails

- **The target environment is a decision, not an assumption.** Confirm it before the first
  request.
- **Never file a defect you did not observe.** No reading the code and inferring a bug — that
  is a different, useful activity, and this is not it.
- **Do not fix anything while auditing.** The audit finds and files; `task-runner` repairs.
  Mixing the two loses the record of what was broken.
- **Cap the run and say where you capped it.** Crawl depth, page count, use cases per page —
  state the limits in the report. A silent cap reads as full coverage.
- **If the model exists, refresh it after.** An audit walks the whole product and will find
  screens and routes the model is missing; leaving them out wastes what you just learned.
