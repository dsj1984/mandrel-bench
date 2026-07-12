# Working in this codebase

You are making a change to an existing production codebase, not starting a
fresh project. The repository already has a structure, house conventions,
and a test suite — your change is expected to fit in, not to restyle what is
already here.

## Before you write any code

- Read the documentation under `docs/` first. This project documents its
  engineering conventions there, and changes that drift from them get
  rejected in review. Treat those documents as binding for every file you
  touch.
- Read the parts of the codebase your change will touch, and the parts they
  call into. Understand how existing endpoints, modules, and layers are
  organized before adding your own.
- Look at how an existing feature similar to yours is implemented
  end-to-end, and follow the same path through the codebase for the new
  work.

## While you work

- Match the existing patterns exactly: file placement and naming, module
  boundaries, request/response shapes, and helper usage. When the codebase
  already has a utility for something, use it rather than writing a second
  one.
- Keep the existing layering intact. Put new code in the layer where the
  codebase puts that kind of code today, and keep dependencies flowing in
  the same direction the current modules use.
- Prefer the smallest change that satisfies the request. Do not refactor,
  rename, or reformat code the task does not require you to touch.
- When the request changes behavior that other parts of the system rely on,
  find and update every caller — a grep across the repository is cheaper
  than a broken integration.

## Before you finish

- Run the project's own test suite and make sure it passes. An existing
  passing test that your change breaks is a regression, not an
  inconvenience — fix the code, not the test, unless the requested change
  genuinely supersedes the tested behavior.
- Add tests for the behavior you introduced, in the same style and location
  as the existing tests.
- Boot the app and exercise your change end to end the way a caller would.
- Leave the working tree clean: no debug files, no commented-out code, no
  stray TODOs.
