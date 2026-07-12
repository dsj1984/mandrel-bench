# Change request — customers are now "clients"

The product renamed "customers" to "clients", and the API should match.
Move the customer endpoints to `/clients` — same behaviour: create,
fetch, update, delete, and the paginated list.

Existing integrations still call `/customers`, so keep every old
`/customers` path working as a deprecated alias for now, backed by the
same data — a record created through one path is visible through the
other.
