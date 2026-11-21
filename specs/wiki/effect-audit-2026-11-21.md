# Effect philosophy audit — 2026-11-21

Audit of `tesla-charger` at commit `8e840cab` (main). Method: manual inventory per the
effect-service-design audit branch — services, layers, requirements, state ownership,
error taxonomy, test strategies. Tooling note from the owner: the project uses tsgo, so
`@effect/language-service` diagnostics do not fire in editors/CI; surface anti-patterns
must be found by hand. Grep verification at audit time: **no `async`/`await`, no raw
`Promise`, no `Effect.try`/`Effect.promise` anywhere in `src/`** — the basics are clean.
All findings below are architectural.

Effect version at audit time: 4.1.5. Reference docs: `repos/effect/LLMS.md` (read before
any code changes — mandated by `AGENTS.md`).

## Findings selected for the fix stack

### 1 (P0). "Recurring" token refresh is not recurring

- Evidence: `src/tesla-client/index.ts:366-369` —
  `setupAccessTokenAutoRefreshRecurring` is
  `Effect.repeat(refreshAccessToken(), { schedule: Schedule.duration(Duration.seconds(timeoutInSeconds)) })`.
- Root cause verified in vendored Effect source
  (`repos/effect/packages/effect/src/Schedule.ts:752-759`): `Schedule.duration` recurs
  **exactly once** after the delay, then completes. `Schedule.during` is the recurring
  variant; `Schedule.spaced`/`Schedule.fixed` are the usual tools.
- Consequence: the refresh runs one time, 2h after boot (`src/application/session-lifecycle.ts:23-25`
  calls it with `60 * 60 * 2`), then silently stops. Every later token expiry fails the session.
- Call sites: `session-lifecycle.ts:23-25` forks it and discards the repeat value
  (`Effect.flatMap(() => Effect.void), Effect.forkChild`); the mock in
  `src/tests/unit/app.test.ts:119` papers over the semantics.
- Target: genuinely recurring schedule; the background task should be honest about being
  long-running (repeat forever with a fixed/spaced interval). Keep the public interface of
  `TeslaClientService` stable unless a rename is trivial and type-safe.
- Reproduction: failing test with `TestClock` proving refresh currently happens exactly
  once across two intervals.

### 3 (P0). `DataAdapter.getLowestValueInLastXMinutes` is a lying contract

- Evidence: `src/data-adapter/alpha-ess-api.data-adapter.ts:175-177` stubs the method to
  `Effect.fail(new DataNotAvailableError())` unconditionally (it doesn't even accept its
  `field`/`minutes` parameters).
- Consumer: `src/charging-speed-controller/conservative-controller.ts:28` calls it. main.ts
  only wires the Alpha ESS adapter (`src/main.ts:205`), so the `--controller conservative`
  CLI strategy (`src/main.ts:121-124`) can never succeed — it always degrades to
  `InadequateDataToDetermineSpeedError`.
- The Influx adapter implements it for real
  (`influx-db-sungather.data-adapter.ts:134-175`, flux `min()` over a time range) but is
  never wired into main.
- `src/tests/unit/data-adapter/alpha-ess-api.data-adapter.test.ts:348` currently *asserts*
  the dishonesty ("should fail with DataNotAvailableError when calling
  getLowestValueInLastXMinutes").
- Target: implement the window-minimum in the Alpha ESS adapter against its real API
  (check what endpoint the Alpha ESS OpenAPI offers for historical/stat data; if truly
  unsupported by the API, split the port so the interface only promises what every wired
  adapter provides, and make the conservative controller degrade loudly instead of
  silently). Decide implementation vs port-split on evidence found in the Alpha ESS API.

### 4 (P0). Shared service state in mutable closures — with a live cross-fiber race

- `src/battery-state-manager.ts:25,38-44,83` — `let batteryState` mutated by the manager
  fiber, read synchronously by `get()` from **other fibers**: the HTTP handler
  (`src/http/state.ts:58`) and the sync loop (`src/application/charging-session.ts:230`).
  This is a genuine race today, not a theoretical one.
- `src/solar-forecast/solcast.adapter.ts:67-71` — `let memoryCache` (concurrent
  `getForecast` calls can double-fetch) and `let rateLimitedToday`, which is set once and
  **never resets**: "rate limited today" silently becomes "rate limited forever" after
  midnight.
- `src/charging-speed-controller/excess-solar-non-aggresive.controller.ts:18-20` —
  `readHistory` array, `lastAppliedSpeed`, `lastDataSignature`.
- `src/charging-speed-controller/weather-aware-buffer/index.ts:35-36` — `cachedSimulation`,
  `lastForecastHash`.
- Target: `Ref`/`Synchronized`-based state (the codebase already does this correctly in
  `src/app-runtime.ts` and `src/charging-speed-controller/dynamic-config.ts` — be
  consistent with them). `BatteryStateManager.get()` should return an `Effect` so callers
  read through the context; update `http/state.ts`, `application/charging-session.ts`, the
  weather-aware controller, and test mocks accordingly.
- Note: the cache/cooldown logic becomes `TestClock`-testable only after this change —
  that unblocks tests later in the stack (finding 11).
- Scope guard: pubSub-as-parameter (`batteryStateManager.start(pubSub)`) is a *separate*
  finding (drilling, not selected). Do not change that signature in this PR.

### 7 (P1). Manual fiber bookkeeping where scopes/finalizers belong

- Evidence: `src/app.ts:64-68` — five `let`-declared fiber variables;
  `src/app.ts:84-87` — fibers collected into an array and drilled into `endSession`;
  `src/application/session-lifecycle.ts:126-128` — manual `Fiber.interrupt` loop.
- Two parallel shutdown mechanisms exist: `src/main.ts:58-63` registers a finalizer
  calling `app.stop()`, while `stop()` itself manually interrupts fibers.
- `src/application/session-lifecycle.ts:123` — `yield* Effect.yieldNow` before
  `PubSub.shutdown` is a scheduling hack hoping the event-logger fiber drains the
  `SessionEnded` event before the subscription scope dies. Fragile, nondeterministic.
- Target: session lifecycle as scoped resources — `Effect.forkScoped`/`acquireRelease`
  ownership of background fibers, one shutdown path, deterministic drain (explicit flush
  after publish, cf. `JsonlTraceControl.flush` in `src/tracing/jsonl-trace-exporter.ts:77-83`
  which already models this correctly).
- Scope guard: keep `App` service interface (`start`/`stop`) and `AppLayer` factory
  signature stable — `app.test.ts` is a functional/integration harness over that interface.
  Do NOT follow `specs/pending/refactor-app-ddd.md` Task 3 (stale, predates current shape —
  see [stale-specs](stale-specs.md)).

### 9 (P1). Data adapters: foreign paradigm, per-call service provision, raw node:crypto

- `src/data-adapter/alpha-ess-api.data-adapter.ts:108-178` and
  `src/data-adapter/influx-db-sungather.data-adapter.ts:60-176` — class + constructor
  injection, while the entire rest of the codebase uses closure-style `Effect.fn` inside
  `Layer.effect`. Two paradigms in one repo.
- `alpha-ess-api.data-adapter.ts:160-163` — `Effect.provideService(HttpClient.TracerHeaderFilter, ...)`
  and `Effect.updateService(Headers.CurrentRedactedNames, ...)` run on **every**
  `queryLatestValues` call. Belongs at layer construction (`Layer.provide`/`provideService`
  once).
- `alpha-ess-api.data-adapter.ts:72-76` — `node:crypto` `createHash` with a
  `//todo: use Effect Platform` comment. Effect's `Crypto` service should own it
  (LLMS: prefer built-in capabilities; they are testable and context-propagated).
- `Effect.gen({ self: this }, ...)` in the Influx adapter is an unusual v4 signature the
  rest of the repo doesn't use.
- Target: rewrite both adapters as layer-internal `Effect.fn` closures over yielded
  deps; move header/redaction provisioning to the layer; use the `Crypto` service. Keep
  `DataAdapter` interface stable so PR3 (finding 3) and controller tests don't churn.
- Note: the Influx adapter is dead code (never wired in main.ts; only its own test imports
  it). Rewrite it anyway or delete it — decide on evidence; deleting is legitimate if the
  user confirms, but default to rewriting (it's the only real implementation of finding 3's
  method, and `AppConfig.influx` exists for it).

### 11 (P1). Test strategy contradicts the project's own guide

- `src/tests/unit/app.test.ts:1-50` — `describe`/`beforeEach`/hand-built `MockedObject`s
  with a mutable `let batteryState` closure, while
  `specs/guides/testing-with-effect.md` explicitly covers replacing `beforeEach`/
  `beforeAll` with `it.scoped()` + `Effect.addFinalizer` and `layer()`.
- No reusable `layerTest`/`layerMemory` anywhere. `DataAdapter` fakes are re-hand-built in
  7+ test files (`Layer.succeed(DataAdapter, { queryLatestValues: vi.fn(), ...})`).
- After finding 4 lands, the closure-bound cache/cooldown logic becomes testable with
  `TestClock`; this PR should add those tests (solcast TTL, rate-limit reset, battery
  cooldown) and the reusable test layers they need.
- Target: per-service honest test layers (`layerTest` with a test-control where state/
  failure injection matters; plain `Layer.succeed` only for static one-offs), `it.scoped`
  in app.test.ts, shared `layer()` groups. CI at `8e840cab` mentions "effect 4.1.5
  layerTest compatibility" (commit `eae94852`) — the layerTest API is available.
- Correction (2026-11-21, PR #22 investigation, commit `2460881c`): the API claim above
  was wrong. `@effect/vitest` 4.1.5 has no `it.scoped` — `it.effect` is already
  `Effect.scoped` + TestEnv — and no guide-style `layerTest`; `layer()` exists but no
  fake was genuinely shareable. The shipped design: per-test `Layer.succeed` built from
  fixture factories in `src/tests/fixtures/` (scripted DataAdapter, recording battery
  manager, fresh vi.fn TeslaClient, scripted forecast + controllers).

## Findings deliberately NOT in the stack (future opportunities)

2. `Effect.die` for expected external failures (alpha-ess `:141-143`, influx `:51-53`,
   `:120-122`); `Option.getOrThrow(DateTime.make(...))` in solcast `:167,202` whose defect
   escapes the `Effect.catch` fallback. Untouched except where PR4's Ref work crosses it —
   do not fix finding 2 inside PR4 unless the same line is already being changed.
5. Layer-as-function-argument in `excess-solar-non-aggresive.controller.ts:8,14`.
6. Service drilling in `session-lifecycle.ts:12-20,63-72` (note: PR5 touches this file for
   scopes; keep the drilling *shape* intact to avoid scope creep).
8. Three competing config conventions; magic numbers in main.ts.
10. `ElectricVehicle` bridge layer duplicated (main.ts:196-201, app.test.ts:56-59).
12. Error taxonomy consistency (`Data.TaggedError` everywhere, zero `Schema.TaggedError`).
13-20. Dead code (influx adapter itself, `memoryUsageMB`, `tracerLayer`, config.ts:30-35),
un-namespaced tags (`DataAdapter`, `SolarForecast`, `JsonlTraceControl`), hardcoded `32`
duplicating `brands.maxAmpere`, unconditional per-cycle `Effect.log`, rename-only wrappers,
top-level `Effect.runSync` in setup script.
- Discovered during PR3 (2026-11-21, commit `22418e69`): Alpha ESS
  `getOneDayPowerBySn` fetches a whole day (~288 samples) and
  `getLowestValueInLastXMinutes` calls it every controller cycle — caching is a future
  opportunity. `uploadTime` is zone-less wall clock interpreted host-local; a deployment
  whose host TZ differs from the Alpha gateway's gets honest `DataNotAvailableError`s
  rather than wrong numbers.
- **LIVE BUG** discovered during PR6 (2026-11-21, investigation of `2460881c`):
  `solcast.adapter.ts` writes its file cache AFTER decoding (`period` becomes a
  `Duration` object in `FileCacheSchema`'s output type) but `FileCacheSchema` decodes
  `period` from the ISO string — so a cache file the adapter wrote itself can never load
  back; only stale caches written before this decode pipeline (or hand-written JSON in
  tests) ever load. Fix direction: write the encoded JSON form (schema-encode, not
  `JSON.stringify` of decoded values) and add a real write-then-read round-trip test plus
  the stale-cache-fallback test the PR6 agent prototyped.
- Closed 2026-11-21: PR #24 (commit `4ae4b842`) gave `SolarForecastPeriodSchema.period`
  an encode getter (`Duration.formatIso`) and writes via the schema encoder — ISO stays
  on disk, true round trip. Red evidence: the disk showed
  `{"_id":"Duration","_tag":"Millis","millis":1800000}` before the fix. Both the
  write-read-back test and the stale-fallback test are in the suite (22 files / 220
  tests). Merges after #22 (stack follow-up).

## Keep — verified good, do not churn

- Domain purity: `src/domain/charging-session.ts` state machine, `session-summary.ts`,
  `brands.ts` (`Brand.check` + Schema predicates), weather-aware pure modules.
- `PubSub` as a service (`domain/events.ts`); HttpApi schema-first groups/middleware;
  `AppConfig` branded config schemas; `it.effect` + `TestClock` in controller tests;
  `src/tracing/jsonl-trace-exporter.ts` (Queue + forkScoped + finalizer + flush control);
  solcast's Schema-first parsing incl. the ISO-duration `transformEffect` decoder;
  `Layer.unwrap` at the CLI root; `ChildProcessSpawner` usage in tesla-client.
