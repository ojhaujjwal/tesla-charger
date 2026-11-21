# Coding Standards

Read this at review time. Implementation lives in the code and in the linked sources; this file states only what a reviewer should enforce.

## Comments

Comments carry only the implicit or unobvious: a why, an invariant, an external-API quirk. The code states everything else.

## Errors

`Effect.die` is for programmer error. Expected external failures flow through the typed error channel.

## Scope of a PR

One finding per PR. Unrelated cleanup rides its own PR.

## Tests

Bugs land test-first: red, then green. Refactors land with characterization tests. Test names and assertions are preserved; every change to one is justified in the PR body.

## Dependencies

New dependencies require justification in the PR body.

## PR Bodies

Follow the /pr template: a Summary visual, Evidence before and after, and Merge Danger with door and blast radius.

## Sources

Pointers, not copies. `repos/effect/LLMS.md` is the Effect source of truth; read it before writing Effect code. `specs/wiki/` holds dated tribal knowledge.
