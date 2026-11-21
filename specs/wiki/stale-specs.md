# Stale specs in specs/pending/

Discovered 2026-11-21 while preparing the Effect fix stack.

## `specs/pending/refactor-app-ddd.md`

- Describes `src/app.ts` as a 461-line monolith with no `domain/` or `application/` split.
- As of `8e840cab`, that split already exists (`src/domain/charging-session.ts`,
  `src/application/charging-session.ts`, `src/application/session-lifecycle.ts`), and
  `app.ts` is ~146 lines with the two-Ref design the spec prescribes.
- All its task checkboxes are unchecked even though the code has moved past them. It was
  never moved to `specs/completed/` (only the user does that, per `specs/README.md`).
- **Agent guidance (2026-11-21):** do not implement this spec. If a task touches `app.ts`
  fiber lifecycle (audit finding 7), the spec's Task 3 sketch is *not* the target design —
  it predates the current `App` service shape and would regress it. Read the actual code.

## `specs/pending/refactor-effect-gen-to-effect-fn.md`

- Requirements and tasks are all checked `[x]`; the conversion is complete in the code as
  of `8e840cab`. It is effectively a completed spec sitting in the pending queue.
- **Agent guidance (2026-11-21):** history, not work. Its one useful durable note: the
  `Effect.fn(name)(generator, (effect) => effect.pipe(...))` transform overload exists and
  is how piped `Effect.fn`s are written in this repo.
