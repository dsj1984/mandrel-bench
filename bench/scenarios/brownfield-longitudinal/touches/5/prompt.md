# Change request — receivables report at scale

Our biggest tenant's receivables report is getting slow, and ops cannot
consume it in one response anyway:

- Paginate `GET /reports/receivables` with the same `page` / `pageSize`
  query parameters and `items` / `total` / `page` / `pageSize` response
  fields as the other list endpoints. Keep `totalOutstandingCents` in
  the response as the grand total across all pages.
- While you are in there: bump the default page size across the API
  from 20 to 25 — every paginated endpoint, one consistent default.
- The report has to stay fast — with thousands of orders in the
  database it should respond well under two seconds. Add whatever index
  the query needs.
