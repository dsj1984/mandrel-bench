# Project Conventions

You are working in a small Node.js codebase. Follow these general engineering
conventions for every change. They are generic house rules — apply your own
judgment to the specifics of the task.

## Code conventions

- Prefer small, focused modules with one clear responsibility each.
- Use clear, descriptive names for files, functions, and variables; avoid
  abbreviations that a new reader would have to decode.
- Keep functions short. Extract a helper when a function grows past roughly
  40 lines or nests more than two levels deep.
- No dead code: remove unused imports, commented-out blocks, and unreachable
  branches before you finish.
- Handle every error path deliberately. Never swallow an error silently —
  either recover with intent, or fail with a clear message. A request handler
  must never crash the whole process on bad input.
- Validate inputs at the boundary: check types, required fields, and ranges on
  anything that arrives from outside the process before acting on it, and
  reject bad input with a clear 4xx-style response rather than throwing.
- Keep responses and data shapes consistent: one JSON error shape everywhere,
  stable field names, and no leaking of internal details (stack traces,
  file paths) to callers.

## Security hygiene

- Never hardcode secrets, credentials, tokens, or keys in source code. Read
  them from environment variables, and generate unpredictable values with a
  cryptographically secure random source, never Math.random().
- Never store passwords in plaintext or with a fast hash. Use a vetted,
  purpose-built password hashing function (e.g. scrypt or bcrypt) with a
  per-user salt.
- Enforce authorization on the server for every protected operation: check
  that the authenticated user is actually allowed to touch the specific
  resource, not just that they are signed in. Never trust identifiers a
  client supplies as proof of ownership.
- Treat all user input as untrusted: no string-concatenated queries, no
  eval, no shelling out with interpolated input, and be careful with paths
  built from user data.
- Prefer failing closed: when an auth or permission check cannot be
  completed, deny the request.

## Testing and verification

- Test behavior, not implementation details, and cover the failure paths
  (bad input, missing auth, not-found) as well as the happy path.
- Before you consider the task done, run whatever test/lint scripts the
  project defines and make sure they pass; then start the app and exercise
  the main flows end to end yourself.
- Fix root causes, not symptoms: if a test fails, understand why before
  changing either the code or the test.

## Workflow

- Commit in small, coherent steps with imperative, descriptive messages.
- Keep the working tree clean: no stray debug files, editor artifacts, or
  temporary scripts left behind.
- When the task is ambiguous, choose the simplest reasonable interpretation,
  implement it well, and note the assumption in your commit message.
