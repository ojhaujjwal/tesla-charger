# GDP for Tesla-Charger: Two Specs

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
| Branded types for predicates | State variants (`Idle`, `Starting`, etc.) with narrow shapes | Silent no-op on invalid transition |
| Transition functions as proof-introduction | `_Idle()`, `_Starting()` etc. construct branded values | Ad-hoc `if` guards |
| Branded value types | `Ampere` enforces [0, 32] | `throw` in Effect fiber, unbounded returns |
| Nominal branding | `BatteryStateWithProof` = `Branded<BatteryState, "Fresh">` | Nullable `get()` checked ad-hoc |

---

## Spec A: State Machine Proofs (`charging-session.ts`)

**Status:** Implemented (with deviations from original design — see notes below).

**Paper reference:** Figure 10. Each state variant is a branded type with a narrow underlying shape (only the fields relevant to that variant). Proof is introduced at construction time by the transition functions themselves — there is no separate `classifyState` bridge.

**Problem:** 6 transition functions silently no-op when called from wrong state. `completeChargeStart` called from `Idle` returns `{state, events: [], waitSeconds: 0}` instead of a compile-time error. This is the paper's "pit of despair" — silent runtime bugs that should be compile errors.

**Files changed:**
- `src/domain/charging-session.ts` — refactored transitions with Brand
- `src/application/charge-sync.ts` — adapted call sites
- `src/app.ts` — adapted one call site (line 134)
- `src/application/charge-verifier.ts` — adapted one call site (line 16)

**No new files needed.** `Brand` is imported from the existing `effect` dependency. No custom `Proof` or `SuchThat` types.

**Design:** Each state variant gets a **narrow branded type** — only the fields relevant to that variant (e.g., `ChargingState` has `{ status: "Charging"; ampere: number }`, not the full union). The branded union `ChargingControlState = IdleState | StartingState | ...` is the only type in circulation — there is no unbranded "raw" type. TypeScript's discriminated union narrowing on `.status` handles variant selection directly, with no `classifyState()` bridge function.

**Key deviation from original plan:** The original design wrapped the full `ChargingControlState` object in each brand and used a `classifyState()` function as the proof-introduction site. The implementation instead:
1. Uses **narrow variant shapes** — each branded type carries only its variant's fields, making `state.ampere` directly accessible after narrowing
2. Eliminates `classifyState()` — TypeScript narrows the branded union on `.status` directly
3. Makes **transition functions** the proof-introduction sites (constructors like `_Idle`, `_Starting` produce branded values)
4. Has no unbranded state type — the branded union IS the sole `ChargingControlState`

```typescript
// --- src/domain/charging-session.ts ---

import { Brand } from "effect";

// Branded state variants — each carries only its variant's fields.
// The brand is phantom; at runtime these are plain objects.
export type IdleState = Brand.Branded<{ readonly status: "Idle" }, "Idle">;
export type StartingState = Brand.Branded<{ readonly status: "Starting"; readonly targetAmpere: number }, "Starting">;
export type ChargingState = Brand.Branded<{ readonly status: "Charging"; readonly ampere: number }, "Charging">;
export type ChangingAmpereState = Brand.Branded<
  { readonly status: "ChangingAmpere"; readonly current: number; readonly target: number },
  "ChangingAmpere"
>;
export type StoppingState = Brand.Branded<{ readonly status: "Stopping" }, "Stopping">;

// The branded union — every value flowing through the system carries
// its status as a phantom type tag. Callers read from Ref and switch
// directly on .status with no separate classify step.
export type ChargingControlState = IdleState | StartingState | ChargingState | ChangingAmpereState | StoppingState;

export const createInitialChargingControlState = (): IdleState => _Idle({ status: "Idle" });
```

Branded constructors (one per variant). These are exported so transitions can produce branded values. Each `Brand.nominal` encapsulates the unsafe cast — our code never writes `as`:

```typescript
export const _Idle = Brand.nominal<IdleState>();
export const _Starting = Brand.nominal<StartingState>();
export const _Charging = Brand.nominal<ChargingState>();
export const _ChangingAmpere = Brand.nominal<ChangingAmpereState>();
export const _Stopping = Brand.nominal<StoppingState>();
```

Transitions require the branded state that proves the precondition is met:

```typescript
// --- Transition: Idle → Starting (requires IdleState) ---
export type StartResult = {
  readonly state: StartingState;
  readonly events: readonly [ChargingControlEvent];
  readonly waitSeconds: number;
  readonly recordFluctuation: true;
};

export const requestChargeStart = (state: IdleState, targetAmpere: number, config: ChargingConfig): StartResult => {
  const amp = Math.min(32, targetAmpere);
  return {
    state: _Starting({ status: "Starting", targetAmpere: amp }),
    events: [{ type: "ChargingStarted" }],
    waitSeconds: amp * config.waitPerAmereInSeconds + config.extraWaitOnChargeStartInSeconds,
    recordFluctuation: true,
  };
};

// --- Transition: Starting → Charging (requires StartingState) ---
export const completeChargeStart = (
  state: StartingState
): { readonly state: ChargingState; readonly events: readonly []; readonly waitSeconds: 0 } => {
  const target = state.targetAmpere;
  return {
    state: _Charging({ status: "Charging", ampere: target }),
    events: [],
    waitSeconds: 0,
  };
};

// --- Transition: Charging → ChangingAmpere (requires ChargingState) ---
export type AmpereChangeResult =
  | { readonly state: ChangingAmpereState; readonly events: readonly [ChargingControlEvent]; readonly waitSeconds: number; readonly recordFluctuation: true }
  | { readonly state: ChargingState; readonly unchanged: true };

export const requestAmpereChange = (
  state: ChargingState,
  targetAmpere: number,
  config: Pick<ChargingConfig, "waitPerAmereInSeconds">
): AmpereChangeResult => {
  const current = state.ampere;
  const amp = Math.min(32, targetAmpere);
  if (current === amp) return { state, unchanged: true };
  const ampDiff = Math.abs(amp - current);
  return {
    state: _ChangingAmpere({ status: "ChangingAmpere", current, target: amp }),
    events: [{ type: "AmpereChangeInitiated", previous: current, current: amp }],
    waitSeconds: ampDiff * config.waitPerAmereInSeconds,
    recordFluctuation: true,
  };
};

// --- Transition: ChangingAmpere → Charging ---
export const completeAmpereChange = (
  state: ChangingAmpereState
): { readonly state: ChargingState; readonly events: readonly [ChargingControlEvent]; readonly waitSeconds: 0 } => {
  const target = state.target;
  return {
    state: _Charging({ status: "Charging", ampere: target }),
    events: [{ type: "AmpereChangeFinished", current: target }],
    waitSeconds: 0,
  };
};

// --- Transition: active state → Stopping ---
export type ActiveState = StartingState | ChargingState | ChangingAmpereState;

export const requestChargeStop = (
  _state: ActiveState,
  config: Pick<ChargingConfig, "extraWaitOnChargeStopInSeconds">
): { readonly state: StoppingState; readonly waitSeconds: number } => ({
  state: _Stopping({ status: "Stopping" }),
  waitSeconds: config.extraWaitOnChargeStopInSeconds,
});

// --- Transition: Stopping → Idle ---
export const completeChargeStop = (
  _state: StoppingState
): { readonly state: IdleState; readonly events: readonly [ChargingControlEvent]; readonly waitSeconds: 0 } => ({
  state: _Idle({ status: "Idle" }),
  events: [{ type: "ChargingStopped" }],
  waitSeconds: 0,
});
```

Call site in `charge-sync.ts` — switches directly on the branded union, no classify step. TypeScript narrows via discriminated union:

```typescript
// --- src/application/charge-sync.ts ---
// controlState is ChargingControlState (the branded union)

switch (controlState.status) {
  case "Idle": {
    // controlState is IdleState here — requestChargeStart accepts it
    if (amp >= 3) {
      const startResult = requestChargeStart(controlState, amp, config);
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
    // controlState is ChargingState here — controlState.ampere is accessible
    if (amp < 3) {
      const stopResult = requestChargeStop(controlState, config);
      yield* vehicle.stopCharging();
      yield* Effect.sleep(Duration.seconds(stopResult.waitSeconds));
      const completed = completeChargeStop(stopResult.state);
      yield* PubSub.publish(pubSub, { _tag: "ChargingStopped" as const });
      return { state: completed.state, stats: sessionStats };
    }
    const changeResult = requestAmpereChange(controlState, amp, config);
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

**What changed for callers:**
- No `classifyState()` call — switch directly on `controlState.status`; TypeScript narrows the branded union
- `requestChargeStart()` requires `IdleState` (was unbranded `ChargingControlState`)
- `completeChargeStart()` requires `StartingState` (was unbranded `ChargingControlState`)
- Each transition returns a branded variant instead of raw `ChargingControlState`
- `TransitionResult` type eliminated — each function returns its own result type
- `Branded<T, S>` is structurally identical to `T` at runtime, so `Ref.set` / `Ref.get` still work without casts
- Narrow variant shapes mean variant-specific fields (e.g., `ChargingState.ampere`) are directly accessible after narrowing — no extra casts

**Trade-offs of this approach:**

| Aspect | Original Plan | Implemented |
|---|---|---|
| Variant shape | Wraps full `ChargingControlState` | Narrow — only variant-specific fields |
| Proof introduction | Single `classifyState()` bridge | Distributed across transition functions |
| Raw type exists? | Yes (for backward compat) | No — branded union is the only type |
| `state.ampere` after narrowing | Needs cast to access | Directly accessible |
| Caller burden | Must call `classifyState()` first | Switch on `.status` like before |
| Constructor visibility | Private (spec implied) | Exported (needed by transitions) |

**Open risk — exported constructors (see Discussion below):** The branded constructors (`_Idle`, `_Starting`, etc.) are exported, meaning any module can forge a branded value. The original `classifyState` design would have kept them private with classify as the sole proof-introduction site. This is acceptable for a closed state machine where the Ref is the single source of truth and transitions form a closed graph, but it weakens the proof guarantee compared to a single-gatekeeper approach.

**Safety guarantee:** Calling `completeChargeStart()` with a `ChargingState` (or any state that's not `StartingState`) is a compile-time type error. No silent no-op. This is the paper's core thesis: "incorrect uses become compile-time errors."

---

## Spec B: Value Range Proofs — Branded Amperes

**Paper reference:** The `SortedBy comp` pattern (Figure 3). Just as `SortedBy comp` encodes "sorted by comparator named comp" at the type level, `Branded<number, "Ampere">` encodes "this number is a valid integer in [0, 32]". `Brand.check` with Schema predicates is the proof-introduction site — more declarative than `Brand.make` with a hand-written predicate, and produces better error messages. Config integration via `Schema.fromBrand` + `Config.schema` ensures that even environment variables produce branded values at config-resolution time.

**Problem:** `setAmpere(ampere: number)` accepts any number. `fixed-speed.controller.ts:12` does `throw new Error(...)` (synchronous throw in Effect generator = fiber death). Multiple call sites clamp to [0,32] manually with `Math.min(32, n)` — no type-level enforcement. `ConservativeController`, `ExcessFeedInSolarController`, and `ExcessSolarNonAggresiveController` return unbounded values (negative or >32) — nothing stops an out-of-range value from reaching the vehicle.

**Design decisions (from grilling sessions):**

- **Ampere type**: `Brand.check<Ampere>(Schema.isInt(), Schema.between(0, 32))` — integer-only, range-validated. `Brand.check` with Schema predicates gives descriptive error messages (`"Expected a value between 0 and 32, got 50"`).
- **Constants**: `minAmpere = 0`, `maxAmpere = 32` exported from `brands.ts` alongside the brand — single source of truth for the range.
- **`clampAmpere`**: kept as a utility. Controllers that produce values that can naturally go out of range (ConservativeController, ExcessFeedInSolarController) call it at their return site. Each controller is explicitly responsible for its own clamping rather than relying on a post-processing layer.
- **Config values**: `config.fixedSpeed: Ampere` instead of `config.fixedSpeed: number`. Config is resolved via `Config.schema(AmpereFromString, ...)` where `AmpereFromString = Schema.fromBrand("Ampere", Ampere)(Schema.Int)` — parsing, validation, and branding happen at config-resolution time. The layer body has zero validation code.
- **Full propagation**: Every function in the ampere chain takes and returns `Ampere` — controller interface, transition functions, variant type fields, event types. No bare `number` for ampere values anywhere.
- **Events**: `ChargingControlEvent` and `TeslaChargerEvent` carry `Ampere` in their `previous`/`current` fields. The event bus communicates branded values.
- **Not branded**: `SessionSummary.averageChargingSpeedAmps` (statistical average, not a control input), `charge-verifier.ts`'s `currentLoadAmpere` (measured load, not a control target), `ampereFluctuations` (a count).

**Files to change:**

New file:
- `src/domain/brands.ts` — `Ampere` type, `Ampere` constructor, `minAmpere`/`maxAmpere` constants, `clampAmpere` utility, `AmpereFromString` Schema

Core domain:
- `src/domain/charging-session.ts` — variant fields `StartingState.targetAmpere`, `ChargingState.ampere`, `ChangingAmpereState.current`/`target` become `Ampere`; transition functions take `Ampere` params; `ChargingControlEvent` fields become `Ampere`; remove internal `Math.min(32, ...)` clamps
- `src/domain/electric-vehicle.ts` — `setAmpere(ampere: Ampere)`
- `src/domain/events.ts` — `TeslaChargerEvent` fields `previous`/`current` become `Ampere`

- `src/tesla-client/index.ts` — `setAmpere(ampere: Ampere)` (just the type, no body change)

Controller layer:
- `src/charging-speed-controller/types.ts` — `determineChargingSpeed(currentChargingSpeed: Ampere): Effect.Effect<Ampere, ...>`
- `src/charging-speed-controller/fixed-speed.controller.ts` — `config.fixedSpeed: Ampere` (validated by Config.schema, no validation in layer body)
- `src/charging-speed-controller/conservative-controller.ts` — wrap return in `clampAmpere()`
- `src/charging-speed-controller/excess-solar-aggresive-controller.ts` — already self-clamps; wrap final return in `Ampere()`
- `src/charging-speed-controller/excess-feed-in-solar-controller.ts` — wrap return in `clampAmpere()`
- `src/charging-speed-controller/excess-solar-non-aggresive.controller.ts` — internal state `lastAppliedSpeed: Ampere = Ampere(0)`, `readHistory` stores `Ampere`, comparisons work on branded types
- `src/charging-speed-controller/weather-aware-buffer/index.ts` — already self-clamps; wrap final return in `Ampere()`

- `src/config.ts` — `fixedSpeedAmpere` uses `Config.schema(AmpereFromString, "FIXED_SPEED_AMPERE").pipe(Config.withDefault(Ampere(5)))`

Application:
- `src/application/charge-sync.ts` — `targetAmpere: Ampere` parameter, remove `Math.min(32, targetAmpere)` on line 69
- `src/app.ts` — remove `Math.min(32, ampere)` on line 142; line 134: use `Ampere(0)` instead of `0` in ternary
- `src/main.ts` — `const fixedSpeed` is already `Ampere` from config; no change needed

Test files (mechanical `Ampere()` wrapping):
- `src/tests/unit/domain/charging-session.test.ts` — all branded state constructors and event assertions wrap numbers in `Ampere()`
- `src/tests/unit/app.test.ts` — mock calls and assertions wrap in `Ampere()`
- `src/tests/unit/battery-state-manager.test.ts` — `previous`/`current` in PubSub events wrap in `Ampere()`
- `src/tests/unit/tesla-client/tesla-client.test.ts` — `setAmpere(Ampere(10))`; refactor "invalid ampere value" test (can't construct `Ampere(999)`)
- `src/tests/unit/charging-speed-controller/excess-solar-non-aggresive.controller.test.ts` — `determineChargingSpeed(Ampere(0))`, mock returns `Effect.succeed(Ampere(15))`
- `src/tests/unit/charging-speed-controller/excess-solar-aggresive-controller.test.ts` — `determineChargingSpeed(Ampere(0))`
- `src/tests/unit/charging-speed-controller/weather-aware-buffer-controller.test.ts` — `determineChargingSpeed(Ampere(0))`

**Design:**

```typescript
// --- NEW: src/domain/brands.ts ---

import { Brand, type Branded, Schema } from "effect";

/**
 * Ampere: a branded integer guaranteed to be in [0, 32].
 *
 * This is the "SortedBy comp" pattern from the paper (Figure 3):
 * the brand encodes the precondition at the type level.
 * Brand.check with Schema predicates validates at the construction site
 * (the "proof introduction" point). On failure it throws a BrandError
 * with a descriptive message — no fiber death in Effect generators
 * (those use .result()).
 *
 * Schema.fromBrand bridges this to Config.schema so that environment
 * variables produce branded Ampere values at config-resolution time.
 */
export type Ampere = Branded<number, "Ampere">;

export const Ampere = Brand.check<Ampere>(Schema.isInt(), Schema.between(0, 32));

/** Single source of truth for the valid ampere range. */
export const minAmpere = 0;
export const maxAmpere = 32;

/** Coerce any number into a valid Ampere by clamping and rounding. */
export const clampAmpere = (n: number): Ampere =>
  Ampere(Math.max(minAmpere, Math.min(maxAmpere, Math.round(n))));

/** Schema bridge: string → int → Ampere. Use with Config.schema(...). */
export const AmpereFromString = Schema.fromBrand("Ampere", Ampere)(Schema.Int);
```

```typescript
// --- REFACTORED: src/domain/electric-vehicle.ts ---
import type { Ampere } from "../domain/brands.js";

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
import { Ampere } from "../domain/brands.js";

export const FixedSpeedControllerLayer = (config: { fixedSpeed: Ampere; bufferPower: number }) =>
  Layer.effect(
    ChargingSpeedController,
    Effect.gen(function* () {
      const dataAdapter = yield* DataAdapter;
      // No validation needed — config.fixedSpeed is already Ampere.
      // Validation happened at Config.schema resolution time.
      return {
        determineChargingSpeed: Effect.fn("determineChargingSpeed")(
          function* (currentChargingSpeed: Ampere) {
            ...
            return availablePower >= desiredChargingPower
              ? config.fixedSpeed
              : Ampere(0);
          },
          ...
        )
      };
    })
  );
```

```typescript
// --- REFACTORED: src/config.ts ---
import { Ampere, AmpereFromString } from "../domain/brands.js";

controller: {
  fixedSpeedAmpere: EffectConfig.schema(AmpereFromString, "FIXED_SPEED_AMPERE").pipe(
    EffectConfig.withDefault(Ampere(5))
  ),
}
// Ampere(5) is fine — 5 is a valid integer in [0, 32].
```

```typescript
// --- REFACTORED: src/tesla-client/index.ts ---
import type { Ampere } from "../domain/brands.js";

setAmpere: (ampere: Ampere) => execTeslaControl(["charging-set-amps", `${ampere}`]),
// `${ampere}` converts to string — runtime same as any number.
// The brand is phantom; it vanishes at runtime.
```

```typescript
// --- REFACTORED: src/app.ts ---

// Line 134:
const currentSpeed = controlState.status === "Charging"
  ? controlState.ampere     // Ampere
  : Ampere(0);               // not-charging → 0A, also Ampere

// Line 142: (removed — ampere from controller is already Ampere)
const targetAmpere = ampere;  // ampere is Ampere, syncTargetAmpere expects Ampere
```

```typescript
// --- REFACTORED: src/application/charge-sync.ts ---
// export const syncTargetAmpere = (
//   targetAmpere: Ampere,    // was number
//   ...
//   const amp = targetAmpere;   // was Math.min(32, targetAmpere)
```

```typescript
// --- REFACTORED: src/domain/charging-session.ts (variant types ---
export type StartingState = Brand.Branded<
  { readonly status: "Starting"; readonly targetAmpere: Ampere }, "Starting"
>;
export type ChargingState = Brand.Branded<
  { readonly status: "Charging"; readonly ampere: Ampere }, "Charging"
>;
export type ChangingAmpereState = Brand.Branded<
  { readonly status: "ChangingAmpere"; readonly current: Ampere; readonly target: Ampere },
  "ChangingAmpere"
>;

// Transition: Idle → Starting
export const requestChargeStart = (state: IdleState, targetAmpere: Ampere, ...): StartResult => {
  // No Math.min(32, targetAmpere) — targetAmpere is already in [0, 32]
  return {
    state: _Starting({ status: "Starting", targetAmpere }),
    ...
  };
};

// Transition: Charging → ChangingAmpere
export const requestAmpereChange = (state: ChargingState, targetAmpere: Ampere, ...): AmpereChangeResult => {
  const current = state.ampere;  // Ampere
  // No Math.min(32, targetAmpere) — targetAmpere is already in [0, 32]
  ...
};

// Events
export type ChargingControlEvent =
  | { readonly type: "ChargingStarted" }
  | { readonly type: "ChargingStopped" }
  | { readonly type: "AmpereChangeInitiated"; readonly previous: Ampere; readonly current: Ampere }
  | { readonly type: "AmpereChangeFinished"; readonly current: Ampere };
```

```typescript
// --- REFACTORED: src/domain/events.ts ---
export type TeslaChargerEvent =
  | { readonly _tag: "ChargingStarted" }
  | { readonly _tag: "ChargingStopped" }
  | { readonly _tag: "AmpereChangeInitiated"; readonly previous: Ampere; readonly current: Ampere }
  | { readonly _tag: "AmpereChangeFinished"; readonly current: Ampere }
  | { readonly _tag: "SessionEnded"; readonly summary: SessionSummary };
```

```typescript
// --- REFACTORED: src/charging-speed-controller/excess-solar-non-aggresive.controller.ts ---
let lastAppliedSpeed: Ampere = Ampere(0);
const readHistory: { speed: Ampere; dataSignature: string }[] = [];

// Comparisons work on branded types (structurally numbers at runtime):
if (candidateSpeed < lastAppliedSpeed) { ... }  // Ampere vs Ampere
```

```typescript
// --- Other controllers (conservative, excess-feed-in-solar) ---
// Wrap the final computed value:
return clampAmpere(value);  // seen here for conservative-controller.ts
// or
return Ampere(Math.max(0, Math.floor(excessSolar / voltage / config.multipleOf) * config.multipleOf));
//                              ^^ already in [0, 32] after self-clamping (e.g. weather-aware-buffer)
```

**Interaction with Spec A's narrow variant types:** Because Spec A uses narrow shapes, variant fields flow `Ampere` natively:
- `ChargingState.ampere: Ampere` — accessible after `.status` narrowing
- `StartingState.targetAmpere: Ampere` — read by `completeChargeStart`
- `ChangingAmpereState.current` / `target: Ampere` — read by `completeAmpereChange`

**Friction point at `app.ts:134`:**
```typescript
const currentSpeed = controlState.status === "Charging"
  ? controlState.ampere   // Ampere
  : 0;                     // number — RESOLVES TO number
```
After Spec B, `controlState.ampere` is `Ampere`, `0` is `number`. The ternary widens to `number`, then `determineChargingSpeed(Ampere)` rejects it. Fix:
```typescript
  : Ampere(0);            // both branches Ampere
```

**Safety guarantee:** It is impossible for any number outside [0,32] to reach `setAmpere()`. The chain of trust is:
1. Config values: `Config.schema(AmpereFromString, ...)` validates at resolution time
2. Controller outputs: each controller returns `Ampere` — computations that naturally go out of range use `clampAmpere()` or `Ampere()` with explicit bounds
3. Transition functions: accept `Ampere` and store it in `Ampere`-typed variant fields — no clamping, no coercion
4. `setAmpere`: signature enforces `Ampere` at the final boundary
5. The `throw` in `fixed-speed.controller.ts` is eliminated — config resolution either succeeds (producing a valid `Ampere`) or fails with a typed `ConfigError`
6. `Brand.check` with `Schema.isInt()` and `Schema.between(0, 32)` gives descriptive errors on any violation

---


## Verification

After implementing each spec:

1. `npx oxlint` — no warnings (no `as`, no `any` anywhere)
2. `npx tsc --noEmit` — clean compile
3. `npx vitest run` — all tests pass
4. For Spec B: verify `fixed-speed.controller.ts` has no `throw` — config validation happens at `Config.schema` resolution time via `Brand.check`, not in the layer body.

---

## Implementation Order

Spec A (state machine) — **implemented.**  
Spec B (branded amperes) — **implemented.**  


---

## Discussion: Exported Branded Constructors

**Context:** Spec A exports the branded constructors (`_Idle`, `_Starting`, etc.) so that transition functions in `charging-session.ts` can produce branded values. The original plan kept constructors private with `classifyState()` as the sole proof-introduction site.

**The risk:** Any module that imports `_Idle` can forge an `IdleState` from any object — bypassing the transition graph entirely. For example, a future module could write `_Idle({ status: "Idle" })` and pass it to `requestChargeStart`, skipping the normal `completeChargeStop → Idle` path.

**Mitigating factors:**
1. The state machine is closed — `ChargingControlState` only flows through `Ref.get()` → transitions → `Ref.set()`. External code never creates control states.
2. The transition input types are the real guard — even if you forge an `IdleState`, you still can't call `completeChargeStart(IdleState)` (that would be a type error).
3. The project has few call sites (3 files total) and no external consumers.

**Options to address:**

1. **Leave as-is** — Acceptable for a closed internal state machine. The constructor export is a convenience, not a vulnerability in practice.

2. **Unexport constructors, add a `classifyState()` bridge** — Restore the original design with a single proof-introduction site. Adds one function but eliminates forgery risk. Callers would call `classifyState(controlState)` instead of switching directly. Trade-off: extra step for callers, but clearer trust boundary.

3. **Unexport constructors, keep direct switching** — Move transition functions into the same module so they can access unexported constructors. This requires restructuring `charge-sync.ts` into `charging-session.ts` or using a barrel pattern. Trade-off: couples the module structure to the proof system.

4. **Export a branded `of` factory per variant that includes validation** — e.g., `IdleState.of(obj)` that checks `obj.status === "Idle"` at runtime before branding. Adds runtime safety but overhead.

**Decision needed:** Which option (or alternative) to pursue.
