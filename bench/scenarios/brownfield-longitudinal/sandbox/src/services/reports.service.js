import { listReceivables } from '../repositories/orders.repo.js';

export function receivablesReport() {
  const rows = listReceivables();
  const items = rows.map((row) => ({
    customerId: row.customerId,
    customerName: row.customerName,
    orderCount: row.orderCount,
    outstandingCents: row.outstandingCents,
  }));
  const totalOutstandingCents = items.reduce(
    (sum, item) => sum + item.outstandingCents,
    0,
  );
  return { items, totalOutstandingCents };
}
