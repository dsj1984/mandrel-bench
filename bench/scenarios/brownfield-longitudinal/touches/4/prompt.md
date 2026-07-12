# Change request — split client names

Sales needs structured contact names. A client now has a `firstName`
and a `lastName` instead of a single `name`:

- Creating or updating a client takes `firstName` and `lastName`, and
  client responses include both.
- Writes that still send the old single `name` field keep working for
  now: split it — everything before the last space is the first name,
  the last word is the last name, and a single-word name is just the
  last name.
- Existing client records must be migrated in place when the server
  starts up.
- Anywhere else the API surfaces a client's name (the receivables
  report, for example) it shows the client's current full name —
  first and last name joined with a space.
