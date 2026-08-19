<div align="center">

# GitMir Local

### Open-source Object Context for AI software development.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-2fd8ff.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.18-2fd8ff.svg)](#local-and-what-that-does-and-does-not-mean)
[![Dependencies](https://img.shields.io/badge/runtime_deps-0-2fd8ff.svg)](#local-and-what-that-does-and-does-not-mean)
[![No account](https://img.shields.io/badge/GitMir_account-not_required-2fd8ff.svg)](#local-and-what-that-does-and-does-not-mean)
[![Telemetry](https://img.shields.io/badge/GitMir_telemetry-none-2fd8ff.svg)](SECURITY.md)
[![MCP](https://img.shields.io/badge/MCP-included-2fd8ff.svg)](docs/MCP.md)

</div>

Your repository holds the code. GitMir builds the model of **how the product actually
works** — objects, relationships, business rules, states, journeys, ownership, evidence —
and keeps it in the repo next to the code.

```
                 YOUR REPOSITORY
                        │
                        ▼
          ┌───────────────────────────┐
          │      OBJECT CONTEXT       │  objects · relationships · rules
          │      .gitmir/model/       │  states · journeys · ownership
          └───────────────────────────┘  evidence · known deviations
                        │
             ┌──────────┴──────────┐
             ▼                     ▼
            YOU                YOUR AGENT
      What does this do?    The relevant slice,
      What can break?       not the whole repo
      Why is it like this?  The rules it must not break
      What changed?         What to verify when done
```

Build the context once. Keep it in the repo. Reuse it for every change — instead of making
the agent reconstruct your product from scratch on every task.

**Local-first · no GitMir account · no GitMir telemetry · MCP included**

[60 seconds](#60-seconds) · [Five minutes on your own repository](#five-minutes-on-your-own-repository) · [How the model works](docs/HOW-IT-WORKS.md)

---

## One change, two readings

A ticket says **"Allow a partial refund."**

What the repository shows you: a refund function, an endpoint, a dialog.

What the product says that change means:

```
Allow a partial refund
├── refundOrder                    the function named on the ticket
├── Order                          its lifecycle has a refunded state, with effects
├── OrderRefunded                  an event two other functions handle
├── Payment                        money — marked sensitive in the model
├── captureRefund                  runs downstream, in another area
├── notifyRefund                   runs downstream
├── POST /api/orders/:id/refund
├── OrderPage · RefundDialog
└── "Refund an order"              a journey a person walks, 5 steps
```

**Two areas. One journey. One lifecycle. Money in reach.**
21 of 29 possible points — 72% of this product.

> The ticket tells the agent what to change.
> GitMir shows what the product says that change **means**.

A developer can implement the ticket exactly as written and still implement the wrong
change for the product. So can an agent, faster.

<img src="docs/img/impact-graph.jpg" alt="Changes, the areas they reach, and the user journeys running through those areas" width="900">

**→ [How change impact is calculated](docs/CHANGE-IMPACT.md)** — every weight, the two-hop
rule, and how to disagree with the number.

---

## What it cost you to answer, measured

Open a project and the first screen is not a settings form. It is what the
context is, what it replaced, and what it has caught:

<img src="docs/img/overview.png" alt="A project overview: 24.6x less read to answer, the object context against the source it came from, open deviations, and the record of what was asked" width="900">

Every answer taken from the model — by your agent over MCP, or by you opening an
object — leaves one line in `.gitmir/usage.jsonl`: what was asked, how big the
answer was, and how big the files are that those objects live in.

That second number is deliberately not a claim about what an agent "would have
done". It is a fact about your repository: these objects live in these files, and
the files are this size. On a real 6-area product, four answers came to 12 KB
against 299 KB of source — and you can open the record and check every line.

The record never leaves the machine. It is the file that lets you verify the
no-telemetry claim rather than take it.

---

## How much of a change was first-pass work

A request rarely lands in one pass. It lands, somebody says *that is not what I
meant*, and the rest is a person walking the agent to the finish. Those two halves
cost differently, and are almost always reported as one number: "the feature took
four days".

The **Audit** tab separates them, from nothing but the moves your tasks make
between `todo → in progress → verify → done`:

```
FIRST-PASS RATIO       50%      ITERATIONS PER CHANGE  0.5
AFTER THE FIRST PASS  7.3h      REVIEW CYCLES            8
FIRST PASS            2.7h      LATE DISCOVERIES         2

WHERE THE TIME CONCENTRATES
  Search           4.8h after first pass · 2 changes
  Billing rules    2.3h after first pass · 1 change
```

Every number opens to show what it was computed from, and the screen states the
rules it applied rather than assuming you trust them: which changes were in the
sample, and how many stretches the idle cutoff refused to count — because a queue
move cannot tell a night from six hours of unbroken work, and pretending otherwise
would be the easiest place in this product to lie.

Below four changes it says *not enough data* in words instead of showing a
confident `0%`.

**It cuts by area of the product, never by person.** There is no per-person number
in the screen, the API, the export, or `.gitmir/audit/events.jsonl` — which
carries no name, no email and no machine. That is not a default; it is the design.

**→ [Every definition, and what each one refuses to claim](docs/CHANGE-AUDIT.md)**

## What you get

**1 · Understand the product.** Ask what checkout depends on, where a business rule is
implemented, why an order can enter a state — answered by walking the model rather than
reassembling it from files.

**2 · Understand a change.** What it reaches, in both directions. Inbound is the direction
that gets forgotten: what the function calls is already in your head, what calls *it* is
not.

**3 · Give the agent the right context.** Not more context — the *relevant* context. The
slice for this change, over MCP, with the rules it must not break and the deviations
already known in the code it is about to touch.

**4 · Verify the outcome.** The affected context becomes the verification steps. A task is
not done because code was generated; it is done when the expected product behaviour is
proven.

> **Understand → Execute → Verify**, over one model that lives in the repository.

---

## 60 seconds

Read it first, then run it:

```bash
git clone https://github.com/gitmir-hello/gitmir-local.git
cd gitmir-local
node server.ts
```

Or install the `gitmir` command:

```bash
curl -fsSL https://ide.gitmir.com/install.sh | sh     # macOS · Linux
irm https://ide.gitmir.com/install.ps1 | iex          # Windows
gitmir
```

<sub>Clones into <code>~/.gitmir/local</code>, links one command onto your PATH, and pulls nothing from a package registry. <a href="install.sh">Read the installer</a> — it is short on purpose. There is no npm route: <code>npm i -g</code> would put this under <code>node_modules</code>, where Node refuses to strip TypeScript types.</sub>

**http://localhost:4599** → add a project folder → **▶ Run Claude** → paste the
**`gitmir-model`** skill. Claude reads the repo, writes `.gitmir/model/`, and every view
has something in it.

| Command | |
|---|---|
| `gitmir` | start it and open the browser |
| `gitmir mcp add` | register the MCP server with the Claude Code CLI |
| `gitmir status` | Node version, port, what is missing |
| `gitmir update` | pull the latest, and restart if it was running |

Want to look before pointing it at your own code? Add
[`examples/refund-shop`](examples/refund-shop) — an invented shop with a model and two
planned tasks. Every number in this README is that project.

---

## Five minutes on your own repository

Build the model, then ask your agent these five questions:

1. What are the main business objects in this product?
2. Pick one that matters. What depends on it — in both directions?
3. Where is its lifecycle implemented, and what fires on each transition?
4. If I change that behaviour, which user journeys could be affected?
5. Which of the relationships in your answer are **inferred** rather than confirmed?

If any answer surprises you, GitMir has surfaced context that was living in the repository
or in somebody's head.

---

## What GitMir keeps, instead of another chat history

```
.gitmir/model/       areas · business objects · functions · endpoints · screens
                     events · journeys · lifecycles · reactions · ownership
.gitmir/findings/    where the code does not do what the product says
tasks/               work, its declared scope, its risk, its approval
```

The important part is not the nodes. It is the **relationships**:

```
Refund ─┬─ modifies ────────→ Payment
        ├─ changes ─────────→ Order.status
        ├─ may_restore ─────→ Inventory
        ├─ requires ────────→ Permission
        ├─ contributes_to ──→ FinanceReport
        └─ follows ─────────→ RefundPolicy
```

Ids are stable, so a rename stays a rename instead of becoming a delete and a create. Every
view, the MCP server and the task queue read the same files — they cannot answer the same
question two different ways.

This is not "the code is the truth". The code is one input. The model is
**code + confirmed rules + decisions + evidence**, which is why `spec-audit` can record the
places where those disagree instead of quietly preferring one.

**→ [How the model is built](docs/HOW-IT-WORKS.md)**

---

## Use it from the agent you already have

```bash
gitmir mcp add
```

Then ask, in Claude Code, Cursor, or anything else that speaks
[MCP](https://modelcontextprotocol.io):

```
What depends on Refund?
What breaks if I change Order.status?
Which business rules govern cancellation?
What should be verified for this task?
Where does the code already not do what the spec says?
```

Same model, same relationships, no separate AI knowledge base. Your editor starts it as a
subprocess over stdin/stdout — **no port, no network, and the dashboard does not need to be
running.** Every reply states how fresh the model is, because there is no amber banner in
somebody else's editor.

**→ [The MCP server](docs/MCP.md)** — fourteen tools, and what each admits about its own
behaviour.

An agent that starts a session with `gitmir_attention` gets the list this screen shows —
what has moved, what is unverified, what reaches further than its ticket says — with the
procedure that closes each one. The system does the noticing; a person still does the
deciding, which is the only version of "it runs itself" a governance tool can defend.

---

## Trust is visible

The first question after "an AI built a model of my product" is *what if it got it wrong* —
so the answer is on screen rather than in a footnote.

**An AI reads and structures the codebase. Once the relationships are written down, GitMir
walks them deterministically** — the same model gives the same answer every time, and
changing one link by hand moves the number accordingly. What you are asked to trust is the
map, not the arithmetic. And the map states its own standing:

- **Freshness** — how far the code has moved since the model was built, on every answer
- **Declared or inferred** — whether a task named its scope, or the numbers came from what
  it merely mentions
- **Known deviations** — where the code does not do what the spec says, marked on the
  objects themselves
- **Gaps** — what the model does not know about your product yet, stated as absence rather
  than left silent

The **How much to trust it** view exists to be read before quoting any number from any
other view.

---

## Start with the problem you have

<img src="docs/img/skills.png" alt="The skill cards, grouped by when you need them" width="960">

| Your situation | The path |
|---|---|
| I inherited a codebase | `gitmir-model` → `model-navigate` |
| The repo is too big to read in one pass | `model-ingest` |
| I need to make a risky change | `model-navigate` → `task-planner` → `task-runner` |
| The docs and the code may disagree | `spec-audit` |
| I have to prove the app actually works | `app-audit` |
| I am moving this to another stack | `stack-port` |
| I am changing an old system I did not write | `legacy-maintenance` |
| I have an idea and no spec | `product-docs-spec` → `task-planner` |
| I keep re-explaining the same context | `context-distillation` |
| I cannot say what was done last week | `task-log` |

Twelve skills, plain markdown in [`skills/`](skills) — read them, change them, keep your
own. They are served as MCP prompts too, so most clients surface them as slash commands.

**→ [What each one does](docs/SKILLS.md)**

---

## Drawing what it should become

The map is not only a picture of what exists. Declare an element on it — an action, a
business object, an endpoint, a screen, an event — say what data moves in and out of it,
and it is drawn beside the real thing in a colour that says it is not built yet.

Declarations are the same shape as the model: same dimensions, same id prefixes, same
relationship fields. That is what makes them checkable. Turning a design into tasks writes
the checks from what was declared —

```
- [ ] `sf-apply-coupon` exists in .gitmir/model after a rebuild
- [ ] the model records that applyCoupon writes Order.total
- [ ] the model records that applyCoupon raises CouponApplied
```

— so a task cannot be called done because code appeared. The relationship has to be in the
rebuilt model. Your agent reads the same thing over MCP with `gitmir_design`: what it is
supposed to build before it starts, and how much of what it drew is real afterwards.

Nothing is hand-placed. You say what exists and what moves; the layout is computed, as it
is for the model — a picture somebody can drag into a preferred shape can be made to say
anything.

## Where the code disagrees with the product

Your agent reads the spec against the code and finds fifteen places they disagree. It
writes them in a reply, and they are gone when the conversation ends — the agent that edits
one of those functions next week does not know, and neither does whoever approves the
change.

`spec-audit` records them instead. Each names the rule, what the code does instead, what
that costs, and the objects it sits on:

- the object is **drawn as deviating on every diagram** — in colour, so the mark survives
  at the zoom where labels disappear
- the **change radius warns** before anyone approves work that reaches it
- the **context handed to an agent carries it**, so it cannot plan against rules the code
  does not follow
- deciding to **live with one records who decided and why** — the difference between a
  product with known limits and one with surprises

A finding remembers the files it was read from. When one changes, it asks to be re-checked
rather than going on asserting something about code that has moved.

---

## The dashboard

Arranged by the question you arrived with, not by the shape of the data. Every view opens
by saying what it is, what it gives you, and how to use it.

| The question | What answers it |
|---|---|
| **What does it do?** | the product map, the journeys people walk, the business objects, where data moves between areas, what raises a signal |
| **Why does it work this way?** | the lifecycle of each object, and every branch with the condition it actually checks |
| **What would a change cost?** | what a task reaches, how much of the product that is, whether anything sensitive is in it |
| **Who answers for it?** | the owning team per area — and the areas nobody has claimed, drawn as the gap they are |
| **How much should I trust it?** | where the model is solid, where it is guessing, what it does not know |
| **What actually happened?** | where the code disagrees with the spec, what changed between two dates, whether finished work stayed inside its declared scope |

Every diagram opens: an area holds its objects, a transition holds what it fires — so the
top level stays a size you can take in and the detail is one click inside it.

<img src="docs/img/map-open.jpg" alt="An area opened in place, showing the objects, screens and endpoints inside it" width="920">

<img src="docs/img/lifecycle.jpg" alt="An order lifecycle: states, the transitions between them, and a transition holding two effects" width="920">

Alongside: **Queue** (`todo → in progress → verify → done`, each card carrying its risk and
its approval) and **Preview** (open any URL, click an element, get a prompt naming it and
the files it probably lives in).

They are drawn on a canvas by a renderer written for this project — which is why `vendor/`
holds fonts and nothing else, and why a map exported for someone to open is one self-contained
file under a megabyte.

---

## Local, and what that does and does not mean

**GitMir uploads nothing.** The model, the dashboard, the MCP server and the task queue run
on your machine and are stored in your project. No GitMir account is required for local
use, and there is no GitMir telemetry — not reduced, not anonymised, none.
([SECURITY.md](SECURITY.md))

**Your coding agent is a separate program with its own policy.** Claude Code, Cursor or
whatever you run sends code and context to the model provider it is configured against,
under that provider's data terms. GitMir does not change that and will not pretend to. What
it changes is *how much* has to be sent: the relevant slice of the model, instead of the
repository, over and over.

**Requirements.** [Node.js](https://nodejs.org) 22.18+ — it runs the TypeScript directly, so
`node server.ts` is the whole build system. The `claude` CLI on your PATH if you want the
dashboard to run Claude for you. macOS · Windows · Linux. `dependencies` is empty and
staying that way: the renderer is written for this and the fonts are vendored, so it works
offline. Port 4599, or `GITMIR_PORT=4600`.

---

## Local → Connect → Team → Enterprise

**GitMir Local** — this repository. Free, open source, and not a trial: the model, every
view, the MCP server, twelve skills, the task queue with risk and approval, and sharing a
read-only map. One person on one machine, for as long as they like.

The paid part begins at the second person — a shared model between machines, tasks that
travel between teammates, their snapshots next to yours — and continues into adapting
GitMir to an organisation's own products, agents and rules.
**→ [ide.gitmir.com](https://ide.gitmir.com)**

The model never leaves your machine either way. What travels between teammates is what you
send: ids, counts, area names, decisions and who made them. The server routes messages and
stores no business logic — which is why this engine is open in the first place, and why you
can read exactly what it does.

**License.** Dual: **[AGPL-3.0](LICENSE)** — fork it, use it for paid work, run it forever
without us; distribute a modified version as a service and your source goes AGPL too. Or a
**[commercial license](LICENSING.md)** for closed-source embedding — **hello@gitmir.com**.

---

<div align="center">

We built this for ourselves — we run Claude Code all day across dozens of projects.

**Run it on a product you actually know, then tell us:**
did the model understand it correctly · what did it miss · what dependency did it find that
you did not expect

**[Share what the model got right and wrong](https://github.com/gitmir-hello/gitmir-local/discussions/1)**
There is no telemetry, so that thread is the only way we learn anything.

🌐 **[gitmir.com](https://gitmir.com)** · 🚀 **[ide.gitmir.com](https://ide.gitmir.com)** · ✉️ **hello@gitmir.com**

<sub>© GITMIR · bundled fonts ship under their own licenses ([THIRD_PARTY.md](THIRD_PARTY.md)) · the GITMIR name and logo are trademarks</sub>

</div>
