# Add the refund endpoint

Type: build
Touches: rt-order-refund, sf-refund-order

## Context

Support had no way to refund an order — the lifecycle had the transition but
nothing exposed it.

## Task

Add `POST /api/orders/:id/refund`, guarded by the `support` role, calling
`refundOrder`.

## Verify

1. A support user refunds a delivered order — status becomes `refunded`.
2. A customer calling the same endpoint gets 403.
3. Refunding an order that is not delivered gets 409.

## Outcome

Added the route and the role guard. `refundOrder` now emits `OrderRefunded`.
Files: src/orders/refund.ts, src/routes/orders.ts
