// The order, and the states it is allowed to be in.
//
// This shop is invented: it exists so the dashboard, the MCP server and the task
// queue have something real to answer about before you point them at your own
// code. The model in .gitmir/model/ was written from these files, and the paths
// it records lead back here — which is the property worth demonstrating.

export type OrderStatus = 'created' | 'paid' | 'delivered' | 'refunded';

export interface Order {
  id: string;
  status: OrderStatus;
  /** Minor units, so the arithmetic never meets a floating point. */
  totalCents: number;
  /** Set when the courier hands it over; the refund window is counted from here. */
  deliveredAt?: Date;
}

/** Fourteen days from delivery, as the shop's terms say. */
export const REFUND_WINDOW_DAYS = 14;

export function isRefundable(order: Order, now = new Date()): boolean {
  if (order.status !== 'delivered' || !order.deliveredAt) return false;
  const days = (now.getTime() - order.deliveredAt.getTime()) / 86_400_000;
  return days <= REFUND_WINDOW_DAYS;
}
