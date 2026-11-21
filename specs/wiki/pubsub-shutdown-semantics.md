# PubSub shutdown semantics (vendored effect 4.1.5)

Established 2026-11-21 by the PR5 agent from `repos/effect/packages/effect/src/PubSub.ts`
(vendored squash `7e662694`, effect 4.1.5), while replacing the `Effect.yieldNow` hack in
session shutdown (PR #21, commit `881ec90c`):

- `shutdown` closes the hub's scope and finalizes subscriptions; it does **not** drain
  buffered messages. `take` on a shut-down subscription interrupts (`shutdown` L822-830,
  `take` L1327-1331); `unsubscribe` discards buffered nodes (L2425-2441).
- A message published while a subscriber is suspended in `take` completes that take
  synchronously (`strategyCompletePollersUnsafe` L2856-2883). `shutdown` only interrupts
  still-pending pollers, so a pulled-in-flight take still processes its event.
- `PubSub.size` is `publisherIndex - subscribersIndex` (L2280-2282): messages not yet
  pulled by every subscriber. `size == 0` therefore proves every consumer has the message
  in hand.
- There is no subscriber-acknowledgement API, so deterministic "publish then shutdown"
  requires polling `size` to zero. `src/application/session-lifecycle.ts` does this via
  `flushPublishedEvents` before `PubSub.shutdown` (as of #21).

Implication for this codebase: any publish-then-shutdown flow needs an explicit flush.
The old `yield* Effect.yieldNow` before shutdown was never a guarantee — it only appeared
to work because the `main.ts` finalizer happened to run before children were interrupted
on SIGINT.

Related: [effect-fix-stack-plan](effect-fix-stack-plan.md) (PR5), and the app/lifecycle
characterization tests in `src/tests/unit/app.test.ts` +
`src/tests/unit/application/session-lifecycle.test.ts` that pin these semantics.
