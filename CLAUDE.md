# The Early Text Computer - Instructions for LLMs

## Commands

```sh
deno task build          # build the derived artefacts into artefacts/ (gitignored)
deno task start          # start the HTTP server on port 8420 (PORT to override)
deno task dev            # as above, restarting on source changes
deno task stdio          # serve the corpus tools over MCP on stdio
deno task test           # run the tests
deno task test:coverage  # run the tests and report coverage
deno task check          # type check and lint the source code
```

## Development Instructions

When refactoring, do not touch the tests.

When modifying a feature, start by modifying the tests in `computer/tests/` to
(re)define the expected behaviour, then implement the feature in
`computer/src/`.

When adding a new feature, start by adding tests in `computer/tests/` to define
the expected behaviour, then implement the feature in `computer/src/`.

When adding new tests, look for a natural home for it in the existing test
files, or create a new one if it doesn't fit. If in doubt, ask the user.

Test coverage is 100%, and after every change or addition, run
`deno task test:coverage` to check that it remains so. If coverage drops, add
tests or remove dead code until it is back at 100%.
