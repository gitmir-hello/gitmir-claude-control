// The screen a customer looks at, and the dialog that starts a refund.
//
// The model records that this page calls POST /api/orders/:id/refund, which is
// how "what breaks if refundOrder changes" reaches a screen a person can see.

import { isRefundable, type Order } from '../orders/order.js';

export function OrderPage({ order }: { order: Order }) {
  return (
    <main>
      <h1>Order {order.id}</h1>
      <p>Status: {order.status}</p>
      {isRefundable(order) ? <RefundDialog order={order} /> : null}
    </main>
  );
}

export function RefundDialog({ order }: { order: Order }) {
  const start = () =>
    fetch(`/api/orders/${order.id}/refund`, { method: 'POST' });
  return (
    <section>
      <p>Refund this order in full.</p>
      <button onClick={start}>Refund {(order.totalCents / 100).toFixed(2)}</button>
    </section>
  );
}
