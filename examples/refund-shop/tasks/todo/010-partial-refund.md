# Allow a partial refund

Type: build
Touches: sf-refund-order, ent-order, ev-order-refunded

## Context

Refunds are all-or-nothing today. `refundOrder` writes `order.status` and
`order.total`; the `delivered → refunded` transition reverses the whole payment.

## Task

Accept an amount on the refund endpoint and reverse only that much.

## Verify

1. Refund half of a delivered order — status stays `delivered`, total drops by half.
2. Refund the remainder — status becomes `refunded`.
3. Refund more than the total — rejected with a 400.
