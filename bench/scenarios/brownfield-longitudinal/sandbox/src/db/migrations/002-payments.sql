CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders (id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 1),
  method TEXT NOT NULL CHECK (method IN ('bank_transfer', 'card', 'cash')),
  received_at TEXT NOT NULL
);
