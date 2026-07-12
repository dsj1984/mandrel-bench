# Ledgerline engineering conventions

These conventions are load-bearing. Every change to this codebase — new
endpoints, refactors, bug fixes — must follow them. Reviewers reject changes
that drift from any of the four rules below.

## 1. Error envelope

Every non-2xx response body has exactly this shape:

```json
{ "error": { "code": "E_SNAKE_CASE", "message": "human-readable detail" } }
```

- Error codes are UPPER_SNAKE_CASE and always prefixed `E_` (for example
  `E_NOT_FOUND`, `E_VALIDATION`, `E_UNAUTHENTICATED`, `E_FORBIDDEN`,
  `E_CONFLICT`, `E_INVALID_STATUS`).
- An optional `details` array may accompany validation failures.
- Error responses are produced **only** via `sendError()` from
  `src/lib/errors.js` (directly, or by throwing `ApiError`, which the router
  converts through `sendError`). Never hand-roll an error JSON body in a
  route, service, or repository.

## 2. Validation

Every write handler (POST/PATCH/PUT) validates its request body by calling
`validate(body, schema)` from `src/lib/validate.js` **before** touching any
service or repository.

- Schemas are colocated in `src/schemas/`, one file per resource
  (`customer.schema.js`, `order.schema.js`, …). A new writable resource gets
  a new schema file there.
- A non-empty problem list is returned to the client as
  `422 E_VALIDATION` with the problems in `details`.
- Unknown fields are rejected, not silently dropped.

## 3. Layering

The codebase is layered `routes → services → repositories`, and the database
handle is confined to the bottom layer:

- **Only files in `src/repositories/` (`*.repo.js`) may import
  `src/lib/db.js`.** Routes and services never touch SQL or the database
  handle — all reads and writes go through a repository function.
- Routes hold HTTP concerns only (parse, validate, respond); business rules
  live in `src/services/`; SQL lives in `src/repositories/`.

## 4. Money

All monetary amounts are **integer cents**, end to end:

- Fields are named with a `Cents` suffix (`amountCents`, `totalCents`,
  `unitPriceCents`) and hold integers — never floats, never decimal strings.
- Database columns storing money are `INTEGER` with a `_cents` suffix.
- Arithmetic on money is integer arithmetic. No floating-point division or
  multiplication on amounts; derived values (totals, balances) stay in cents.
