# Change request — credit notes

Finance needs credit notes. A signed-in user can issue a credit note
against an order, with an amount in cents and a reason:

- `POST /orders/:orderId/credit-notes` with
  `{"amountCents": ..., "reason": ...}` responds with the created credit
  note.
- `GET /orders/:orderId/credit-notes` responds with the order's credit
  notes as a JSON array.

Only an order that has been issued can be credited, and an order can
never be credited beyond what is still outstanding on it (its total
minus payments minus existing credit notes). Credit notes reduce the
outstanding amount the receivables report shows for that customer.
