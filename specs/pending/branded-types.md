# Branded Types: Voltage, StateOfCharge, KiloWattHours, HourOfDay

## Overview

Add 4 branded numeric types following the existing `Ampere` pattern in `src/domain/brands.ts`. Each type enforces a valid range at runtime and communicates it at the type level, preventing out-of-range values from reaching vehicle commands and domain computations.

## Background

Spec B in `specs/pending/gdp-proofs.md` introduced `Ampere` to enforce [0, 32] on charging current. This spec extends the same GDP-proofs pattern to four additional numeric concepts that currently use bare `number`:

| Brand | Range | Classification Site | Risk Without Brand |
|-------|-------|--------------------|--------------------|
| `Voltage` | [200, 260] | Data adapter + each controller | Division by zero in 5 controllers |
| `StateOfCharge` | [0, 100] | Tesla API schema | Silent out-of-range battery values |
| `KiloWattHours` | [0, ∞) | Tesla API + config | Negative energy values propagate silently |
| `HourOfDay` | [0, 23] int | Config only | Out-of-range cutoff hour |

## Requirements

- [x] Four branded types defined in `src/domain/brands.ts` matching the `Ampere` pattern
- [x] Brand classification at data-adapter and API-schema boundaries
- [x] Config values (`KiloWattHours`, `HourOfDay`) validated via `Schema.fromBrand` at resolution time
- [x] All controllers classify `voltage` after destructuring from `queryLatestValues`
- [x] No bare `number` for branded concepts after task completion
- [x] All existing tests pass with branded test data

## Tasks

- [x] **Task 1**: KiloWattHours brand — all consumers and tests
- [x] **Task 2**: StateOfCharge brand — all consumers and tests
- [x] **Task 3**: Voltage brand — all consumers and tests
- [x] **Task 4**: HourOfDay brand — all consumers and tests

Each task is atomic: type signature changes include ALL call sites, leaving the codebase compilable and tests passing.

---

## Implementation Details

### Task 1: KiloWattHours brand — all consumers and tests

Add the `KiloWattHours` brand definition and propagate it through all kWh-carrying types. This is the largest task because kWh flows from Tesla API through domain stats, session summary, config, weather-aware simulation, and session lifecycle — all coupled through shared type signatures.

#### 1.1 Add brand definition to `src/domain/brands.ts`

Append after the `Ampere` block:

```typescript
// ---- KiloWattHours ----
export type KiloWattHours = Brand.Branded<number, "KiloWattHours">;
export const KiloWattHours = Brand.check<KiloWattHours>(Schema.isGreaterThanOrEqualTo(0));
export const KiloWattHoursFromNumber = Schema.fromBrand("KiloWattHours", KiloWattHours)(Schema.Number);
export const KiloWattHoursFromString = Schema.fromBrand("KiloWattHours", KiloWattHours)(Schema.NumberFromString);
```

#### 1.2 Update `src/domain/charging-session.ts`

- Import `KiloWattHours` as both type and value: `import { type KiloWattHours, KiloWattHours as KWh } from "./brands.js"`
- `ChargingSessionStats.chargeEnergyAddedAtStartKwh: KiloWattHours`
- `ChargingSessionStats.dailyImportValueAtStart: KiloWattHours`
- `createInitialChargingSessionStats()`: both fields → `KWh(0)`
- `withDailyImportRecorded(stats, value: KiloWattHours)`
- `withChargeEnergyRecorded(stats, value: KiloWattHours)`

#### 1.3 Update `src/domain/session-summary.ts`

- Import `KiloWattHours` as type + value: `import { type KiloWattHours, KiloWattHours as KWh } from "./brands.js"`
- Params: `finalChargeEnergyAdded: KiloWattHours`, `finalDailyImport: KiloWattHours`
- Type: `totalEnergyChargedKwh`, `gridImportKwh`, `solarEnergyUsedKwh` → `KiloWattHours`
- Wrap computed values: `KWh(params.finalChargeEnergyAdded - params.stats.chargeEnergyAddedAtStartKwh)` etc.
- Subtraction of two `KiloWattHours` gives `number`, so `KWh()` wrap is needed

#### 1.4 Update `src/tesla-client/schema.ts`

- Import `KiloWattHoursFromNumber` from `../domain/brands.js`
- `charge_energy_added: Schema.Number` → `charge_energy_added: KiloWattHoursFromNumber`

#### 1.5 Update `src/tesla-client/index.ts`

- Import `KiloWattHours` type from `../domain/brands.js`
- `ChargeState.chargeEnergyAdded: KiloWattHours`

#### 1.6 Update `src/config.ts`

- Import `KiloWattHours`, `KiloWattHoursFromString` from `./domain/brands.js`
- `carBatteryCapacityKwh`: `EffectConfig.number(...).pipe(EffectConfig.withDefault(60))` → `EffectConfig.schema(KiloWattHoursFromString, "CAR_BATTERY_CAPACITY_KWH").pipe(EffectConfig.withDefault(KiloWattHours(60)))`
- `defaultDailyProductionKwh`: same pattern with `KiloWattHours(60)` default

#### 1.7 Update `src/charging-speed-controller/weather-aware-buffer/types.ts`

- Import `KiloWattHours` type from `../../domain/brands.js`
- `carBatteryCapacityKwh`, `defaultDailyProductionKwh`, `shortfallKwh` → `KiloWattHours`

#### 1.8 Update `src/charging-speed-controller/weather-aware-buffer/charge-simulation.ts`

- Import `KiloWattHours` as type + value from `../../domain/brands.js`
- Line 33: wrap `remainingNeedKwh` with `KiloWattHours(...)`
- Line 41: `let remainingNeed: number = remainingNeedKwh` (accumulator stays `number` after `-=`)
- Line 22 (no-batteryState): `shortfallKwh: KiloWattHours(0)`
- Line 107: `shortfallKwh = canComplete ? KiloWattHours(0) : KiloWattHours(remainingNeed)`

#### 1.9 Update `src/application/session-lifecycle.ts`

- Import `KiloWattHours` from `../domain/brands.js`
- Line 42: `withDailyImportRecorded(..., KiloWattHours(initialData.daily_import))`
- Line 101: `finalDailyImport: KiloWattHours(finalDataValues.daily_import)`

#### 1.10 Update test files

| Test File | Changes |
|-----------|---------|
| `src/tests/unit/domain/charging-session.test.ts` | `KWh(0)` for stats fields; `KWh(5.5)`, `KWh(10.0)` for with*Recorded calls |
| `src/tests/unit/domain/session-summary.test.ts` | All kWh params and expected values → `KWh(...)` |
| `src/tests/unit/tesla-client/tesla-client.test.ts` | Mock `ChargeState`: `chargeEnergyAdded: KWh(0)` |
| `src/tests/unit/battery-state-manager.test.ts` | Mock `getChargeState`: `chargeEnergyAdded: KWh(0)` |
| `src/tests/unit/app.test.ts` | Mock `getChargeState` + SessionSummary assertions: `KWh(...)` |
| `src/tests/unit/charging-speed-controller/weather-aware-buffer/charge-simulation.test.ts` | Config: `KWh(75)`, `KWh(30)`; shortfall: `KWh(0)` |
| `src/tests/unit/charging-speed-controller/weather-aware-buffer/index.test.ts` | Config: `KWh(75)`, `KWh(30)` |
| `src/tests/unit/charging-speed-controller/weather-aware-buffer-controller.test.ts` | Config: `KWh(75)`, `KWh(30)` |
| `src/tests/unit/charging-speed-controller/weather-aware-buffer/solar-calculations.test.ts` | Config: `KWh(75)`, `KWh(30)` |
| `src/tests/unit/http/state.test.ts` | Stats: `KWh(1.5)`, `KWh(0.5)` |

---

### Task 2: StateOfCharge brand — all consumers and tests

Add the `StateOfCharge` brand for battery level and charge limit values (0-100%).

#### 2.1 Add to `src/domain/brands.ts`

```typescript
// ---- StateOfCharge ----
export type StateOfCharge = Brand.Branded<number, "StateOfCharge">;
export const StateOfCharge = Brand.check<StateOfCharge>(Schema.isBetween({ minimum: 0, maximum: 100 }));
export const StateOfChargeFromNumber = Schema.fromBrand("StateOfCharge", StateOfCharge)(Schema.Number);
```

#### 2.2 Update `src/tesla-client/schema.ts`

- Import `StateOfChargeFromNumber`
- `battery_level: Schema.Number` → `battery_level: StateOfChargeFromNumber`
- `charge_limit_soc: Schema.Number` → `charge_limit_soc: StateOfChargeFromNumber`

#### 2.3 Update `src/tesla-client/index.ts`

- Import `StateOfCharge` type
- `ChargeState.batteryLevel: StateOfCharge`
- `ChargeState.chargeLimitSoc: StateOfCharge`

#### 2.4 Update `src/battery-state-manager.ts`

- Import `StateOfCharge` type
- `BatteryState.batteryLevel: StateOfCharge`
- `BatteryState.chargeLimitSoc: StateOfCharge`

#### 2.5 Update `src/charging-speed-controller/weather-aware-buffer/charge-simulation.ts`

- Import `StateOfCharge` type
- Inline `batteryState` param: `batteryLevel: StateOfCharge`, `chargeLimitSoc: StateOfCharge`

#### 2.6 `src/application/charge-verifier.ts` — no changes

`batteryState.batteryLevel >= batteryState.chargeLimitSoc` comparison works since `StateOfCharge` extends `number`.

#### 2.7 Update test files

| Test File | Changes |
|-----------|---------|
| `src/tests/unit/tesla-client/tesla-client.test.ts` | `batteryLevel: StateOfCharge(50)`, `chargeLimitSoc: StateOfCharge(80)` |
| `src/tests/unit/battery-state-manager.test.ts` | Mock `getChargeState`: `StateOfCharge(...)` |
| `src/tests/unit/app.test.ts` | Mock `getChargeState`: `StateOfCharge(...)` |
| `src/tests/unit/charging-speed-controller/weather-aware-buffer/charge-simulation.test.ts` | batteryState: `StateOfCharge(70)`, `StateOfCharge(80)` |
| `src/tests/unit/charging-speed-controller/weather-aware-buffer/index.test.ts` | batteryState: `StateOfCharge(...)` |
| `src/tests/unit/charging-speed-controller/weather-aware-buffer-controller.test.ts` | batteryState: `StateOfCharge(...)` |
| `src/tests/unit/http/state.test.ts` | `BatteryState`: `StateOfCharge(72)`, `StateOfCharge(80)` |

---

### Task 3: Voltage brand — all consumers and tests

Add the `Voltage` brand (200-260V) and classify at the data-adapter boundary and in each controller.

#### 3.1 Add to `src/domain/brands.ts`

```typescript
// ---- Voltage ----
export type Voltage = Brand.Branded<number, "Voltage">;
export const Voltage = Brand.check<Voltage>(Schema.isBetween({ minimum: 200, maximum: 260 }));
```

#### 3.2 Update `src/data-adapter/alpha-ess-api.data-adapter.ts`

- Import `Voltage`
- Line 79: `return 235` → `return Voltage(235)`

#### 3.3 Update `src/application/session-lifecycle.ts`

- Import `Voltage`
- Line 96: `voltage: 230` → `voltage: Voltage(230)`
- Line 102: `finalVoltage: finalDataValues.voltage` → `finalVoltage: Voltage(finalDataValues.voltage)`

#### 3.4 Update `src/domain/session-summary.ts`

- Import `Voltage` type
- `finalVoltage: number` → `finalVoltage: Voltage`

#### 3.5 Voltage classification in controllers (6 files)

In each controller, rename destructured `voltage` → `rawVoltage`, then classify:
```typescript
const { voltage: rawVoltage, ...others } = yield* dataAdapter.queryLatestValues([...]);
const voltage = Voltage(rawVoltage);
```

**Files:**
- `src/application/charge-verifier.ts` — line 14
- `src/charging-speed-controller/fixed-speed.controller.ts` — lines 15-19
- `src/charging-speed-controller/conservative-controller.ts` — lines 21-24
- `src/charging-speed-controller/excess-solar-aggresive-controller.ts` — lines 17-22
- `src/charging-speed-controller/excess-feed-in-solar-controller.ts` — lines 16-20
- `src/charging-speed-controller/weather-aware-buffer/index.ts` — lines 105-109

#### 3.6 Update test files

| Test File | Changes |
|-----------|---------|
| `src/tests/unit/domain/session-summary.test.ts` | `finalVoltage: Voltage(230)` |
| Controller tests | Mock `queryLatestValues` voltage stays plain `number` — classification is inside controller body |
| `src/tests/unit/data-adapter/alpha-ess-api.data-adapter.test.ts` | No change — `Voltage(235)` is structurally `235` |

---

### Task 4: HourOfDay brand — all consumers and tests

Add the `HourOfDay` brand (0-23 integer) with config-level validation only.

#### 4.1 Add to `src/domain/brands.ts`

```typescript
// ---- HourOfDay ----
export type HourOfDay = Brand.Branded<number, "HourOfDay">;
export const HourOfDay = Brand.check<HourOfDay>(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 23 }));
export const HourOfDayFromString = Schema.fromBrand("HourOfDay", HourOfDay)(Schema.Int);
```

#### 4.2 Update `src/config.ts`

- Import `HourOfDay`, `HourOfDayFromString`
- `solarCutoffHour`: `EffectConfig.int(...).pipe(EffectConfig.withDefault(18))` → `EffectConfig.schema(HourOfDayFromString, "SOLAR_CUTOFF_HOUR").pipe(EffectConfig.withDefault(HourOfDay(18)))`
- `deadlineHour`: `EffectConfig.int(...)` → `EffectConfig.schema(HourOfDayFromString, "DEADLINE_HOUR")`

#### 4.3 Update `src/charging-speed-controller/weather-aware-buffer/types.ts`

- Import `HourOfDay` type
- `deadlineHour?: HourOfDay`
- `solarCutoffHour: HourOfDay`

#### 4.4 `charge-simulation.ts` and `index.ts` — no code changes

`HourOfDay` extends `number`, so comparisons (`localHour >= cutoffHour`) and template literals work without modification.

#### 4.5 Update test files

| Test File | Changes |
|-----------|---------|
| `src/tests/unit/charging-speed-controller/weather-aware-buffer/charge-simulation.test.ts` | `solarCutoffHour: HourOfDay(18)` |
| `src/tests/unit/charging-speed-controller/weather-aware-buffer/index.test.ts` | `HourOfDay(18)`, `HourOfDay(14)` |
| `src/tests/unit/charging-speed-controller/weather-aware-buffer-controller.test.ts` | `HourOfDay(18)`, `HourOfDay(14)` |
| `src/tests/unit/charging-speed-controller/weather-aware-buffer/solar-calculations.test.ts` | `HourOfDay(18)` |

---

## Design Decisions

1. **Voltage classification**: Each controller classifies after `queryLatestValues` destructuring. The data-adapter wraps at runtime (`Voltage(235)`) but the generic `Record<F, number>` return type doesn't convey the brand. Controllers do `Voltage(rawVoltage)` for formal classification.

2. **Single `StateOfCharge` brand** for both `batteryLevel` and `chargeLimitSoc` — both are points on the 0-100% charge scale (current vs. target).

3. **`KiloWattHours` as KWh alias**: Since `KiloWattHours` is both a type and a constructor value, consumer files import it as `import { type KiloWattHours, KiloWattHours as KWh }` to avoid naming conflicts.

4. **`charge-simulation.ts` internal accumulator** (`remainingNeed`) stays `number` after `-=`. Only `shortfallKwh` and `remainingNeedKwh` are wrapped.

5. **`http/state.ts` schema** — No changes. Branded types serialize as plain numbers at the API boundary.

## Testing

Each task includes its own test updates. Controller test mocks for `queryLatestValues` do NOT need `Voltage()` wrapping — raw `number` flows through the generic return type.

## Verification

After all 4 tasks:

```bash
npx oxlint                    # No warnings
npx tsc --noEmit              # Clean compile
npm run ci                    # All tests pass
```

Runtime behavior:
- `Voltage(190)` → `BrandError`, `Voltage(270)` → `BrandError`
- `StateOfCharge(101)` → `BrandError`, `StateOfCharge(-1)` → `BrandError`
- `KiloWattHours(-1)` → `BrandError`
- `HourOfDay(24)` → `BrandError`
- Tesla API `battery_level: 101` → `SchemaError` caught as `ChargeStateQueryFailedError`
- Config `SOLAR_CUTOFF_HOUR=24` → typed `ConfigError` at resolution time

## Spec Readiness Checklist

- [x] All requirements are clearly defined
- [x] All tasks are actionable and appropriately sized
- [x] All tasks are atomic (each leaves codebase working)
- [x] Implementation details are specific enough to execute
- [x] Testing plan covers happy path and error cases
- [x] Verification steps are concrete and testable

## References

- `specs/pending/gdp-proofs.md` — Spec B (existing Ampere brand pattern)
- `src/domain/brands.ts` — existing pattern to follow
- `.opencode/plans/1780997539839-tidy-lagoon.md` — detailed change-level plan
