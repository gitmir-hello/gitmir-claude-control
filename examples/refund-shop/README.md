# refund-shop — a project to try the dashboard on

A tiny invented shop: orders, payments, a catalog. Nothing here is real code —
it is a `.gitmir/model/` and two planned tasks, which is everything the dashboard
reads.

Add this folder as a project and every view has something to show. It exists so
you can see what the tool does before pointing it at your own repository, and so
the checklist in `handoff/` can be run without touching anyone's client work.

The interesting one is **`tasks/todo/010-partial-refund.md`**. It carries a
`Touches:` line, so **Impact** can answer, before a line of code is written:

- it changes `refundOrder`, `Order` and the `OrderRefunded` event;
- that reaches **Orders** (1 function · 1 endpoint · 2 screens · 1 lifecycle) and
  **Payments** (1 object · 1 function);
- one staff journey runs through it — *Refund an order*;
- **high** risk: it reaches 72% of this small product, and `Order` and `Payment`
  are marked `sensitivity: "high"`, which is worth 4 points each.

`020-catalog-sort.md` is the counter-example: one function, nothing sensitive,
nothing downstream — **low**. Two tasks, two honest answers.
