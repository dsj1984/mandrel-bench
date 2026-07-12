# Change request — role management

Admins need to manage user roles instead of asking us to edit the
database:

- `GET /users` (admin only) responds with the users — id, name, email
  and role.
- `PATCH /users/:id/role` with `{"role": "admin"}` or
  `{"role": "member"}` (admin only) changes that user's role.

A role change takes effect immediately, including for users who are
already signed in. The last remaining admin cannot be demoted.
