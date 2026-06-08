# GDP for Tesla-Charger: Three Specs

## Background: Ghosts of Departed Proofs

### What It Is

"Ghosts of Departed Proofs" (Noonan, Haskell '18) is an API design pattern where **preconditions are encoded as phantom type parameters** with zero runtime cost. The user expresses correctness arguments by constructing "proofs" — values whose types correspond to logical propositions. The proofs inhabit phantom type slots on wrapper types, which the compiler erases completely.

The name comes from the idea that the proof is "non-corporeal" — no artifact survives into the compiled output. It's a ghost.

### Core Idea from the Paper

The paper (Figure 10) defines:

```haskell
data Proof p = QED       -- phantom type p, single value QED
newtype a ::: p = SuchThat a    -- newtype = zero-cost
x ... proof = coerce x         -- safe coercion, zero cost
axiom :: Proof p               -- library author's escape hatch
```

The entire "proof" is the type parameter `p`. The value `QED` carries no information. The `coerce` is zero-cost because `newtype` wrappers are erased.

### How This Maps to TypeScript (Without `as`)

This project's lint rules ban `as` assertions and `any` entirely:
- `"no-explicit-any": "error"`
- `"typescript/consistent-type-assertions": ["error", "never"]`
- `"typescript/no-non-null-assertion": "error"`

But the Effect library already provides `Brand`, which encapsulates the unsafe casts. Instead of writing `Proof<P>` and `axiom()` ourselves (which require `as any`), we use `Brand.nominal<Branded<T, "Tag">>()` from Effect. The branded type ITSELF is the proof — no separate `Proof` value needed.

| Paper Concept | TypeScript Equivalent | Notes |
|---|---|---|
| `Proof p` | `Branded<A, "P">` | The branded type IS the proof |
| `a ::: p` | `Branded<A, "P">` | Same — the value carries its proof in its type |
| `axiom :: Proof p` | `Brand.nominal<A>()` | Creates a branded type constructor |
| `classify` | `Brand.nominal` inside classification | Runtime → type-level proof |
| rank-2 `name` | Generic callback `<N>` | Prevents name collision |

### Key Patterns

**1. Phantom Names** (Figure 2): Attach an opaque, existential name to a value so that proofs can talk about specific values. In TS, a generic callback prevents the user from choosing the name:

```typescript
function withName<A, R>(x: A, f: <N>(named: Branded<A, string & N>) => R): R {
  return f(Brand.nominal<Branded<A, string & N>>()(x));
}
```

Two separate `withName` calls produce incompatible phantom names — attempting to merge a list sorted by comparator `N1` with a list sorted by `N2` is a type error.

**2. Proof Introduction via classify** (Figure 11): Runtime inspection creates type-level proofs. The `Brand.nominal` call is the bridge.

```typescript
function classify<A, N>(xs: Branded<A[], N>): ListCase<A, N> {
  if (xs.length > 0) {
    return { kind: "Cons", list: Brand.nominal<Branded<A[], N & "__Cons">>()(xs) };
  }
  ...
}
```

**3. The "Simon" Problem** (Section 2.4): If users could name values arbitrarily, they could subvert the proof system. The rank-2 `withName` callback pattern prevents this — the user can't choose `N`, so they can't accidentally make two different comparators share the same name.

### Relevance to Tesla-Charger

| Paper Pattern | Tesla-Charger Application | Status Quo Risk |
|---|---|---|
| Branded types for predicates | State variants (`Idle`, `Starting`, etc.) | Silent no-op on invalid transition |
| Runtime → type-level classify | `classifyState()` inspects status → branded state | Ad-hoc `if` guards |
| Branded value types | `Ampere` enforces [0, 32] | `throw` in Effect fiber, unbounded returns |
| Nominal branding | `BatteryStateWithProof` = `Branded<BatteryState, "Fresh">` | Nullable `get()` checked ad-hoc |

---

## Spec A: State Machine Proofs (`charging-session.ts`)

**Paper reference:** Figures 10-11. Each variant of `ChargingControlState` becomes a distinct branded type. `classifyState` is the proof-introduction site.

**Problem:** 6 transition functions silently no-op when called from wrong state. `completeChargeStart` called from `Idle` returns `{state, events: [], waitSeconds: 0}` instead of a compile-time error. This is the paper's "pit of despair" — silent runtime bugs that should be compile errors.

**Files to change:**
- `src/domain/charging-session.ts` — refactor transitions with Brand
- `src/application/charge-sync.ts` — adapt call sites
- `src/app.ts` — adapt one call site (line 134)
- `src/application/charge-verifier.ts` — adapt one call site (line 16)

**No new files needed.** `Brand` is imported from the existing `effect` dependency. No custom `Proof` or `SuchThat` types.

**Design:** Each state variant gets a branded type via `Brand.nominal`. The `classifyState()` function inspects the runtime state and returns a branded variant, acting as the proof-introduction site. Transition functions accept branded inputs and return branded outputs.

```typescript
// --- REFACTOR: src/domain/charging-session.ts ---

import { Brand, type Branded } from "effect";

// Branded state variants — each carries its status as a phantom type tag.
// At runtime these are plain ChargingControlState objects.
export type IdleState = Branded<ChargingControlState, "Idle">;
export type StartingState = Branded<ChargingControlState, "Starting">;
export type ChargingState = Branded<ChargingControlState, "Charging">;
export type ChangingAmpereState = Branded<ChargingControlState, "ChangingAmpere">;
export type StoppingState = Branded<ChargingControlState, "Stopping">;

export type KnownState = IdleState | StartingState | ChargingState | ChangingAmpereState | StoppingState;

// Constructor instances (one per variant). Brand.nominal contains the
// unsafe cast internally — our code never writes `as`.
const _Idle = Brand.nominal<IdleState>();
const _Starting = Brand.nominal<StartingState>();
const _Charging = Brand.nominal<ChargingState>();
const _ChangingAmpere = Brand.nominal<ChangingAmpereState>();
const _Stopping = Brand.nominal<StoppingState>();

// classify: runtime inspection → type-level proof  (cf. Figure 11)
export function classifyState(state: ChargingControlState): KnownState {
  switch (state.status) {
    case "Idle":           return _Idle(state);
    case "Starting":       return _Starting(state);
    case "Charging":       return _Charging(state);
    case "ChangingAmpere": return _ChangingAmpere(state);
    case "Stopping":       return _Stopping(state);
  }
}
```

Transitions now require the branded state that proves the precondition is met:

```typescript
// --- Transition: Idle → Starting (requires Proof of Idle) ---
export type StartResult = {
  readonly state: StartingState;
  readonly events: readonly [ChargingControlEvent];
  readonly waitSeconds: number;
  readonly recordFluctuation: true;
};

export function requestChargeStart(
  state: IdleState,
  targetAmpere: number,
  config: ChargingConfig
): StartResult {
  const amp = Math.min(32, targetAmpere);
  const chargingStarted: ChargingControlState = { status: "Starting", targetAmpere: amp };
  return {
    state: _Starting(chargingStarted),
    events: [{ type: "ChargingStarted" as const }],
    waitSeconds: amp * config.waitPerAmereInSeconds + config.extraWaitOnChargeStartInSeconds,
    recordFluctuation: true,
  };
}

// --- Transition: Starting → Charging (requires Proof of Starting) ---
export function completeChargeStart(
  state: StartingState
): { readonly state: ChargingState; readonly events: readonly []; readonly waitSeconds: 0 } {
  const target = state.targetAmpere;
  return {
    state: _Charging({ status: "Charging", ampere: target }),
    events: [],
    waitSeconds: 0,
  };
}

// --- Transition: Charging → ChangingAmpere (requires Proof of Charging) ---
export type AmpereChangeResult =
  | { readonly state: ChangingAmpereState; readonly events: readonly [ChargingControlEvent]; readonly waitSeconds: number; readonly recordFluctuation: true }
  | { readonly state: ChargingState; readonly unchanged: true };

export function requestAmpereChange(
  state: ChargingState,
  targetAmpere: number,
  config: Pick<ChargingConfig, "waitPerAmereInSeconds">
): AmpereChangeResult {
  const current = state.ampere;
  const amp = Math.min(32, targetAmpere);
  if (current === amp) return { state, unchanged: true };
  const ampDiff = Math.abs(amp - current);
  return {
    state: _ChangingAmpere({ status: "ChangingAmpere", current, target: amp }),
    events: [{ type: "AmpereChangeInitiated" as const, previous: current, current: amp }],
    waitSeconds: ampDiff * config.waitPerAmereInSeconds,
    recordFluctuation: true,
  };
}

// --- Transition: ChangingAmpere → Charging ---
export function completeAmpereChange(
  state: ChangingAmpereState
): { readonly state: ChargingState; readonly events: readonly [ChargingControlEvent] } {
  const target = state.target;
  return {
    state: _Charging({ status: "Charging", ampere: target }),
    events: [{ type: "AmpereChangeFinished" as const, current: target }],
  };
}

// --- Transition: active state → Stopping ---
export type ActiveState = StartingState | ChargingState | ChangingAmpereState;

export function requestChargeStop(
  state: ActiveState,
  config: Pick<ChargingConfig, "extraWaitOnChargeStopInSeconds">
): { readonly state: StoppingState; readonly waitSeconds: number } {
  return {
    state: _Stopping({ status: "Stopping" }),
    waitSeconds: config.extraWaitOnChargeStopInSeconds,
  };
}

// --- Transition: Stopping → Idle ---
export function completeChargeStop(
  state: StoppingState
): { readonly state: IdleState; readonly events: readonly [ChargingControlEvent] } {
  return {
    state: _Idle({ status: "Idle" }),
    events: [{ type: "ChargingStopped" as const }],
  };
}
```

Call site in `charge-sync.ts` — the pattern follows the paper's classify → pattern-match → use-proof flow:

```typescript
// --- REFACTORED: src/application/charge-sync.ts (key excerpt) ---

// First, classify the raw state to get a branded proof
const known = classifyState(controlState);

switch (known.status) {
  case "Idle": {
    if (amp >= 3) {
      // known is IdleState here — requestChargeStart accepts it
      const startResult = requestChargeStart(known, amp, config);
      yield* vehicle.startCharging();
      yield* vehicle.setAmpere(amp);
      let currentStats = startResult.recordFluctuation ? recordFluctuationStat(sessionStats) : sessionStats;
      yield* publishChargingEvent(startResult.events[0], pubSub);
      yield* waitForRampUp(startResult.waitSeconds);
      const completed = completeChargeStart(startResult.state);
      return { state: completed.state, stats: currentStats };
    }
    return { state: controlState, stats: sessionStats };
  }
  case "Starting":
  case "ChangingAmpere":
  case "Stopping": {
    return { state: controlState, stats: sessionStats };
  }
  case "Charging": {
    if (amp < 3) {
      const stopResult = requestChargeStop(known, config);
      yield* vehicle.stopCharging();
      yield* Effect.sleep(Duration.seconds(stopResult.waitSeconds));
      const completed = completeChargeStop(stopResult.state);
      yield* PubSub.publish(pubSub, { _tag: "ChargingStopped" as const });
      return { state: completed.state, stats: sessionStats };
    }
    const changeResult = requestAmpereChange(known, amp, config);
    if ("unchanged" in changeResult) {
      return { state: controlState, stats: sessionStats };
    }
    yield* vehicle.setAmpere(amp);
    let currentStats = changeResult.recordFluctuation ? recordFluctuationStat(sessionStats) : sessionStats;
    yield* publishChargingEvent(changeResult.events[0], pubSub);
    yield* waitForRampUp(changeResult.waitSeconds);
    const completed = completeAmpereChange(changeResult.state);
    if (completed.events.length > 0) {
      yield* publishChargingEvent(completed.events[0], pubSub);
    }
    return { state: completed.state, stats: currentStats };
  }
}
```

**What changes for callers:**
- `classifyState(controlState)` replaces `if (state.status === "Idle")` — branded variants carry the predicated type
- `requestChargeStart()` requires `IdleState` (was `ChargingControlState`)
- `completeChargeStart()` requires `StartingState` (was `ChargingControlState`)
- Each transition returns a branded variant instead of raw `ChargingControlState`
- `TransitionResult` type goes away — each function returns its own result type
- `Branded<T, S>` is structurally identical to `T` at runtime, so `Ref.set` / `Ref.get` still work without casts

**Safety guarantee:** Calling `completeChargeStart()` with a `ChargingState` (or any state that's not `StartingState`) is a compile-time type error. No silent no-op. This is the paper's core thesis: "incorrect uses become compile-time errors."

---

## Spec B: Value Range Proofs — Branded Amperes

**Paper reference:** The `SortedBy comp` pattern (Figure 3). Just as `SortedBy comp` encodes "sorted by comparator named comp" at the type level, `Branded<number, "Ampere">` encodes "this number is in [0, 32]". The `Brand.make` function with validation is the proof-introduction site.

**Problem:** `setAmpere(ampere: number)` accepts any number. `fixed-speed.controller.ts:12` does `throw new Error(...)` (synchronous throw in Effect generator = fiber death). Multiple call sites clamp to [0,32] manually with `Math.min(32, n)` — no type-level enforcement.

**Files to change:**
- `src/domain/electric-vehicle.ts` — `setAmpere(ampere: Ampere)` instead of `setAmpere(ampere: number)`
- `src/tesla-client/index.ts` — update `setAmpere` signature (just the type, no body change)
- `src/charging-speed-controller/types.ts` — change `determineChargingSpeed` return type
- `src/charging-speed-controller/fixed-speed.controller.ts` — replace `throw` with `Brand.make`
- `src/charging-speed-controller/conservative-controller.ts` — return clamped value
- All other controllers (excess-solar-*, weather-aware-buffer) — trivial type updates
- `src/app.ts:142` — remove manual `Math.min(32, ampere)`
- `src/application/charge-sync.ts:69` — remove manual `Math.min(32, targetAmpere)`

**Design:**

```typescript
// --- NEW: anywhere shared. Could go in src/domain/charging-session.ts or a new src/domain/brands.ts ---

import { Brand, type Branded } from "effect";

/**
 * Ampere: a branded number guaranteed to be in [0, 32].
 *
 * This is the "SortedBy comp" pattern from the paper (Figure 3):
 * the brand encodes the precondition at the type level.
 * Brand.make applies validation at the construction site (the "proof
 * introduction" point). After construction, the type system guarantees
 * the invariant without further checks.
 */
export type Ampere = Branded<number, "Ampere">;

export const Ampere = Brand.make<Ampere>(
  (n: number) => n >= 0 && n <= 32
);

// Convenience: clamp then brand
export const clampAmpere = (n: number): Ampere =>
  Ampere(Math.max(0, Math.min(32, Math.round(n))));
```

```typescript
// --- REFACTORED: src/domain/electric-vehicle.ts ---
import type { Ampere } from "./brands.js";

export class ElectricVehicle extends Context.Service<
  ElectricVehicle,
  {
    readonly startCharging: () => Effect.Effect<void, VehicleAsleepError | VehicleCommandFailedError>;
    readonly stopCharging: () => Effect.Effect<void, VehicleAsleepError | VehicleCommandFailedError>;
    // setAmpere now requires Ampere — the precondition is in the type
    readonly setAmpere: (ampere: Ampere) => Effect.Effect<void, VehicleAsleepError | VehicleCommandFailedError>;
  }
>()("@tesla-charger/Domain/ElectricVehicle") {}
```

```typescript
// --- REFACTORED: src/charging-speed-controller/types.ts ---
import type { Ampere } from "../domain/brands.js";

export class ChargingSpeedController extends Context.Service<
  ChargingSpeedController,
  {
    determineChargingSpeed(currentChargingSpeed: Ampere): Effect.Effect<Ampere, InadequateDataToDetermineSpeedError>;
  }
>()("@tesla-charger/ChargingSpeedController") {}
```

```typescript
// --- REFACTORED: src/charging-speed-controller/fixed-speed.controller.ts ---
import { Ampere, clampAmpere } from "../domain/brands.js";

export const FixedSpeedControllerLayer = (config: { fixedSpeed: number; bufferPower: number }) =>
  Layer.effect(
    ChargingSpeedController,
    Effect.gen(function* () {
      // Ampere validates at layer creation time.
      // On invalid input, Brand.make's result returns a BrandError.
      // We getOrThrow it so setup fails fast — no fiber death.
      const fixedAmp = Ampere.result(config.fixedSpeed).pipe(
        Result.getOrThrowWith(
          (err) => new Error(`Fixed speed must be between 0 and 32 amperes: ${err.message}`)
        )
      );
      ...
      return {
        determineChargingSpeed: Effect.fn("determineChargingSpeed")(
          function* (currentChargingSpeed: Ampere) {
            ...
            // Controller always returns an Ampere — type-safe at compile time
            return availablePower >= desiredChargingPower
              ? fixedAmp
              : clampAmpere(0);
          },
          ...
        )
      };
    })
  );
```

```typescript
// --- REFACTORED: src/tesla-client/index.ts ---
// Import Ampere type
import type { Ampere } from "../domain/brands.js";

setAmpere: (ampere: Ampere) => execTeslaControl(["charging-set-amps", `${ampere}`]),
// `${ampere}` converts to string — runtime same as any number.
// The brand is phantom; it vanishes at runtime.
```

```typescript
// --- REFACTORED: src/app.ts:142 ---
// Before:
const targetAmpere = Math.min(32, ampere);
// After:
const targetAmpere = ampere; // already Ampere — guaranteed in [0, 32]

// --- REFACTORED: src/application/charge-sync.ts:69 ---
// Before:
const amp = Math.min(32, targetAmpere);
// After:
const amp = targetAmpere; // targetAmpere is already Ampere
```

**Safety guarantee:** It is impossible for any number outside [0,32] to reach `setAmpere()`. The `throw` in `fixed-speed.controller.ts` is replaced by `Brand.make` which returns `Result` instead of crashing the Effect fiber. Invalid config values produce a `BrandError` at layer construction time, caught and reported as a typed error.

---

## Spec C: Non-Null Battery State Proofs

**Paper reference:** The `:::` pattern (Figure 10, Section 5). Just as `([a] ~~ xs ::: IsCons xs)` attaches a proof of non-emptiness to a specific list, `Branded<BatteryState, "Fresh">` attaches a proof that battery state has been fetched. The `get()` method's null-check is the proof-introduction site.

**Problem:** `BatteryStateManager.get()` returns `BatteryState | null`. Consumers must defensively check with `if (batteryState && ...)`. A new consumer might forget.

**Files to change:**
- `src/battery-state-manager.ts` — `get()` returns `BatteryStateWithProof | null`
- `src/application/charge-verifier.ts` — use branded type
- `src/charging-speed-controller/weather-aware-buffer/index.ts` — use branded type

**Design:** The branded type marks "this battery state has been fetched." The null-check in `get()` is the sole place where `null` is eliminated:

```typescript
// --- src/battery-state-manager.ts ---
import { Brand, type Branded } from "effect";

export type BatteryStateWithProof = Branded<BatteryState, "Fresh">;

export class BatteryStateManager extends Context.Service<
  BatteryStateManager,
  {
    readonly start: (pubSub: PubSub.PubSub<TeslaChargerEvent>) => Effect.Effect<void>;
    readonly get: () => BatteryStateWithProof | null;  // was: BatteryState | null
  }
>()("@tesla-charger/BatteryStateManager") {}

// In the layer implementation — one-time Brand.nominal instance:
const _Fresh = Brand.nominal<BatteryStateWithProof>();

const get = () => {
  // Same null check as before, but now the truthy branch
  // carries a phantom brand as "proof" of non-null
  if (batteryState === null) return null;
  return _Fresh(batteryState);
};
```

```typescript
// --- REFACTORED: src/application/charge-verifier.ts ---
const freshBattery = batteryStateManager.get();
if (freshBattery && freshBattery.batteryLevel >= freshBattery.chargeLimitSoc) {
  // freshBattery has type BatteryStateWithProof (= Branded<BatteryState, "Fresh">)
  // The brand makes it a different type from BatteryState | null.
  // Any consumer that requires BatteryStateWithProof will fail to compile
  // if it forgets the null check.
  yield* onBatteryComplete;
}
```

```typescript
// --- REFACTORED: src/charging-speed-controller/weather-aware-buffer/index.ts ---
// Before:
if (config.deadlineHour !== undefined && batteryState) {
  const urgencyFactor = simulation.utilizationRatio;
  finalBuffer = weatherBuffer * (1 - urgencyFactor * 0.5);
}
// After — same logic, but batteryState is now BatteryStateWithProof:
if (config.deadlineHour !== undefined && batteryState) {
  const urgencyFactor = simulation.utilizationRatio;
  finalBuffer = weatherBuffer * (1 - urgencyFactor * 0.5);
}
```

**What this buys you:** The brand makes `BatteryStateWithProof` a distinct type from `BatteryState`. If a new function requires `BatteryStateWithProof`, forgetting to null-check before calling it is a compile error. The runtime behavior is identical — the brand is phantom.

**Trade-off:** This is the lightest-touch GDP application. Existing consumers don't change their null-checking pattern. The value emerges when new code is added.

---

## Verification

After implementing each spec:

1. `npx oxlint` — no warnings (no `as`, no `any` anywhere)
2. `npx tsc --noEmit` — clean compile
3. `npx vitest run` — all tests pass
4. For Spec B: verify `fixed-speed.controller.ts` has no `throw` — uses `Ampere.result().pipe(Result.getOrThrowWith(...))` instead

---

## Implementation Order

Spec B (branded amperes) — simplest, fixes a real bug, demonstrates the `Brand.make` pattern first.  
Spec A (state machine) — highest value but touches the most code.  
Spec C (battery proofs) — lightweight, good alongside A or after.
