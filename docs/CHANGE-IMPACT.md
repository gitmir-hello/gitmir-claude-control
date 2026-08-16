# How change impact is calculated

The number on the screen is arguable on purpose. Every part of it is shown with
its count and its weight, and this page is the rest of the working — because a
number nobody can check is a number nobody should act on.

## What is deterministic, and what is not

This distinction matters more than any other on this page.

**The model is built by an AI reading your repository.** The `gitmir-model` skill
walks the code and writes objects and the relationships between them into
`.gitmir/model/`. That step involves judgement, and it can be wrong.

**Everything after that is arithmetic.** Impact is a graph walk over the
relationships already written down — no model is asked what a change might
affect. Run it twice on the same model and you get the same answer, byte for
byte. Change one link in the model by hand and the number moves accordingly.

So the honest claim is not "no LLM guessed this". It is: *an AI wrote the map, a
program walked it, and you can read both.* Which parts of the map to doubt is
what the **How much to trust it** view is for.

## What "reaches" means

`blastRadius(ids, model)` starts from the ids a task names and walks the model's
own links outward — both directions.

**Both directions, because inbound is the one that gets forgotten.** What the
changed function calls is usually in the author's head already. What calls *it*
is not.

**Two hops, and no further.** On a real product, hop three reaches most of the
codebase and stops distinguishing anything. Two hops is the distance at which
"this reaches Payments" is still a fact about your change rather than a fact
about the product being connected.

The links walked are the ones the model asserts: a function writing a field, a
screen calling an endpoint, an endpoint handled by a function, a function raising
an event, a lifecycle governing an object, a journey walking through a step. A
relationship the model never learned is not walked — absence is silent, which is
why the confidence view exists.

## Declared or inferred

A task carries a `Touches:` line naming the ids it will change. When it has one,
the radius starts from exactly those and the badge reads **DECLARED**.

When it does not, the ids are taken from what the task text happens to mention.
That is a weaker input and the badge says so — amber, and the wording changes to
name what it did. Both are shown rather than one silently standing in for the
other.

## The score

Each kind of thing in reach has a weight:

| In reach | Weight | Why |
|---|---|---|
| Sensitive data | 4 | Money, credentials or personal data — marked in the model, not guessed |
| User journeys | 3 | Someone walks these; breaking one is visible to a person |
| Lifecycles | 3 | A state machine carries effects that fire on every transition |
| Area boundaries crossed | 2 | A change inside one area is a smaller thing than one spanning several |
| API endpoints | 1 | Each is a contract something outside already depends on |
| Screens | 1 | What a user would see change |
| Other functions downstream | 1 | Code that runs through the changed part |
| Internal processes | 1 | Machinery, not something a person walks |

`score = Σ (count × weight)`

## Why it is a share, not a score

A raw score is not comparable between products. Twenty-one points is most of a
three-area shop and a corner of a ninety-area platform, and a tool that calls
both HIGH is telling you nothing.

So the score is divided by what the **whole product** would score if a change
reached all of it:

```
ceiling = Σ (total of each kind in the model × its weight)
share   = score / ceiling
```

| Share | Level |
|---|---|
| ≥ 25% | HIGH |
| ≥ 8% | MEDIUM |
| below | LOW |

The same change gets a different label in a small product and a large one, which
is the correct behaviour: it *is* a different change.

## A real one, from the shipped example

`examples/refund-shop`, task `010-partial-refund.md`:

```
Changes directly:  refundOrder · Order · OrderRefunded
Within 2 hops:     Payment · notifyRefund · captureRefund
                   POST /api/orders/:id/refund · OrderPage · RefundDialog
                   Order lifecycle
Areas:             Orders (owner: Fulfilment team) · Payments
Journeys:          Refund an order (5 steps)

  1 × 2 = 2   area boundaries crossed
  1 × 3 = 3   user journeys affected
  1 × 3 = 3   lifecycles touched
  2 × 4 = 8   sensitive data reached
  1 × 1 = 1   API endpoints in reach
  2 × 1 = 2   screens in reach
  2 × 1 = 2   other functions downstream
  ─────────
       21 of 29 possible  =  72% of the product  →  HIGH
```

Reproduce it yourself:

```bash
node mcp-check.ts examples/refund-shop impact 010-partial-refund.md
```

Twenty-nine is small because the product is small — three areas, three objects,
two endpoints. On a real repository the ceiling runs into the thousands and the
same absolute score lands nowhere near HIGH.

## Disagreeing with it

The weights are one object in `lib/impact.js`:

```js
const W = { modules:2, journeys:3, processes:1, lifecycle:3,
            sensitive:4, routes:1, screens:1, callers:1 };
```

Change one, reload, and every number on the screen moves. If your product has no
money in it, sensitive data weighing 4 is wrong for you — and the point of
showing the arithmetic is that you can see that and fix it, rather than arguing
with a level.

## What it does not measure

- **How hard the change is.** This is reach, not effort.
- **Whether the code is any good.** A well-tested function with wide reach still
  scores high, and should.
- **Anything the model does not know.** A dependency nobody recorded is not in
  the radius, and the radius will not mention that it is missing. That is what
  the confidence view reports, and why freshness rides on every answer.
