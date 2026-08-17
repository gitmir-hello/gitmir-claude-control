// Refunding a delivered order.
//
// The one function the example's tasks are about: `010-partial-refund.md` plans
// to let it refund part of an order rather than all of it, and the dashboard's
// change radius is computed from what this touches.

import { isRefundable, type Order } from './order.js';

export interface RefundResult {
  order: Order;
  refundedCents: number;
}

/**
 * Refund a delivered order in full.
 *
 * Whole orders only, for now. Partial refunds are the planned change — and the
 * point of the example is that the model already knows what allowing them would
 * reach: the payment, the lifecycle, the event, and the two functions that
 * handle it downstream.
 */
export function refundOrder(order: Order, now = new Date()): RefundResult {
  if (!isRefundable(order, now)) {
    throw new Error(`Order ${order.id} is ${order.status} and outside the refund window`);
  }
  const refundedCents = order.totalCents;
  captureRefund(order.id, refundedCents);
  notifyRefund(order.id);
  return { order: { ...order, status: 'refunded' }, refundedCents };
}

/** Hands the amount back through the payment provider. */
export function captureRefund(orderId: string, amountCents: number): void {
  void orderId; void amountCents;
}

/** Tells the customer it happened. Raised as OrderRefunded in the model. */
export function notifyRefund(orderId: string): void {
  void orderId;
}
