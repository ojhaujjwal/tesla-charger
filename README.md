Tesla Charger
====================

## Overview

Tesla Charger is a smart EV charging controller that matches charging speed to excess
solar production. It monitors live power data from a home inverter (via InfluxDB or the
Alpha ESS cloud API), computes how much surplus solar is available, and dynamically adjusts
the vehicle's charging amperage through the Tesla Fleet API — so the car consumes solar
that would otherwise be exported to the grid. Several charging strategies are supported,
from a fixed low speed to a weather-aware controller that simulates whether the car can
finish charging before sunset.

Built with [Effect](https://effect.website), a TypeScript library for typed, concurrent,
and resilient application code. Effect's typed errors, structured concurrency, deterministic
`TestClock` testing, and built-in tracing/logging let the controller absorb real-world
flakiness — a sleeping vehicle, a dropped cloud API call, a sudden production dip — without
a tangle of `try/catch` and callbacks.

### Highlights

- Effect-based, strongly-typed concurrent controller for solar-matched EV charging
- Hexagonal architecture with swappable adapters (Tesla Fleet API, Solcast, InfluxDB / AlphaESS)
- Deterministic 5-state charge-control state machine modeling real charging behavior
- End-to-end typed errors + `Config`-as-Effect secret hygiene

Check out [SETUP.md](SETUP.md) for instructions and how to set it up and run it.


# Architecture

The system is organized as a layered, hexagonal architecture. The core depends on
**ports** (interfaces), not concrete implementations; infrastructure lives behind those
ports and can be swapped without touching the domain.

```
                          main.ts — composition root
                    Layer.unwrap(Config) + Layer.provideMerge
                                     │
        ┌────────────────────────────┼────────────────────────────┐
        ▼                            ▼                             ▼
  application/                  domain/                    charging-speed-controller/
  ChargingSession               ChargingControlState       ChargingSpeedController (port)
  (orchestration)               (5-state machine)          + strategy implementations
                                     │
                                     │ publishes TeslaChargerEvent
                                     ▼
                            TeslaChargerEventPubSub  ────▶  BatteryStateManager
                            (PubSub event bus)              event-logger

  Infrastructure adapters (implement ports, swappable):
  ┌──────────────────┐   ┌───────────────────────┐   ┌──────────────────────┐
  │ tesla-client/    │   │ data-adapter/          │   │ solar-forecast/       │
  │ TeslaClient      │   │ DataAdapter (×2 impls) │   │ SolarForecast         │
  │ Fleet API + CLI  │   │ AlphaESS / InfluxDB    │   │ Solcast               │
  └──────────────────┘   └───────────────────────┘   └──────────────────────┘
```

Principles:

- **Hexagonal / ports & adapters.** `DataAdapter` has two interchangeable implementations
  (Alpha ESS cloud API, SunGather/InfluxDB); `ChargingSpeedController` is a strategy port
  with several implementations; `TeslaClient` and `SolarForecast` hide external APIs behind
  ports. `main.ts` selects a controller from a CLI `--controller` flag.
- **Layered.** `domain/` holds pure types and logic (no Effect dependency); `application/`
  holds Effect orchestration; infrastructure adapters sit at the edge.
- **Domain-driven core.** The 5-state charging-control state machine (`Idle → Starting →
  Charging → ChangingAmpere → Stopping`) is the heart of the system. A shared ubiquitous
  language is maintained in [`CONTEXT.md`](./CONTEXT.md) — read it before naming things.
- **Event-driven decoupling.** Core logic publishes domain events to a `PubSub` bus;
  `BatteryStateManager` and the event-logger subscribe independently, so the core never
  depends on them.
- **Resilience by design.** Network calls use `Schedule`-based retries and timeouts. A
  "production guard" watches for grid import during ramp-up and, after retries are
  exhausted, signals an unrecoverable failure (see `Effect.die` below).
- **Immutability via `Ref`.** Mutable runtime state (control state, stats, app status,
  dynamic buffer power) lives in `Ref`s, never in mutable closure variables.
- **Observability.** Structured logging via `Effect.log*`, and a REST API built with
  `effect/unstable/httpapi` that auto-generates OpenAPI at `/openapi.json`.


# How We Use Effect

This section covers the *non-obvious* ways Effect is applied here — not the basics.

### Composition root with `Layer.unwrap`

Configuration is read inside the composition root, not at module load, so layers can be
built conditionally from a CLI flag. `Layer.unwrap` lets the root be an `Effect` that
returns a `Layer`, and `Layer.provideMerge` assembles the full graph
(see [`src/main.ts`](./src/main.ts)):

```ts
const MainLayer = Layer.unwrap(
  Effect.gen(function* () {
    const bufferPower = yield* AppConfig.excessSolar.bufferPower;
    const controllerTag = Option.getOrElse(parsed.controller, () => "default" as const);

    let controllerLayer;
    if (controllerTag === "fixed-lowest-speed") {
      controllerLayer = FixedSpeedControllerLayer({ fixedSpeed, bufferPower: Watt(300) }).pipe(
        Layer.provideMerge(DynamicChargingConfigLayer(bufferPower))
      );
    } else if (controllerTag === "weather-aware") {
      controllerLayer = WeatherAwareBufferControllerLayer({ ... }).pipe(
        Layer.provide(SolcastForecastLayer({ apiKey, rooftopResourceId })),
        Layer.provideMerge(DynamicChargingConfigLayer(bufferPower))
      );
    }
    // ...

    return AppLayer({ chargingConfig, timingConfig, costPerKwh }).pipe(
      Layer.provideMerge(ChargingSessionLive({ ... })),
      Layer.provideMerge(TeslaChargerEventPubSub.layer),
      Layer.provideMerge(controllerLayer),
      Layer.provideMerge(BatteryStateManager.layer),
      Layer.provideMerge(teslaLayer)
      // ...
    );
  })
);
```

### `Effect.die` as a deliberate fatal sentinel

Recoverable failures are typed and handled; *unrecoverable* ones (retries exhausted) are
escalated with `Effect.die`, which crashes the fiber rather than returning a typed error.
This draws a clear line between "expected and handled" versus "something is genuinely
wrong, shut down" (see [`src/app.ts`](./src/app.ts)):

```ts
mainSyncFiber = yield* Effect.repeat(runSyncCycle(), {
  while: (outcome) => outcome.status === "Running"
}).pipe(
  Effect.flatMap(() => stop()),
  Effect.catchTag("GridImportExhausted", (err) => Effect.die(err)),
  Effect.catchTag("VehicleNotWakingUp", (err) => Effect.die(err)),
  Effect.forkChild
);
```

### `Config`-as-Effect with secret hygiene

Configuration is an `Effect` of `Config` values, and secrets are `Redacted` — they are never
plain strings in memory or in telemetry (see [`src/config.ts`](./src/config.ts)):

```ts
tesla: {
  oauth2ClientSecret: EffectConfig.redacted("TESLA_OAUTH2_CLIENT_SECRET"),
  // ...
}
```

When making HTTP calls, secret header names are registered so they are redacted from logs
and traces (see `src/data-adapter/alpha-ess-api.data-adapter.ts`):

```ts
Effect.updateService(Headers.CurrentRedactedNames, (names) =>
  Array.appendAll(names, REDACTED_HEADER_NAMES)
)
```

### `PubSub` event bus for decoupling

The domain exposes a typed event bus as a service; core logic publishes, subscribers consume
independently (see [`src/domain/events.ts`](./src/domain/events.ts)):

```ts
export class TeslaChargerEventPubSub extends Context.Service<
  TeslaChargerEventPubSub,
  PubSub.PubSub<TeslaChargerEvent>
>()("@tesla-charger/Domain/TeslaChargerEventPubSub") {
  static readonly layer = Layer.effect(
    TeslaChargerEventPubSub,
    Effect.gen(function* () {
      const pubSub = yield* PubSub.unbounded<TeslaChargerEvent>();
      return TeslaChargerEventPubSub.of(pubSub);
    })
  );
}
```

```ts
// published from the charging session; BatteryStateManager and event-logger subscribe
yield* PubSub.publish(pubSub, { _tag: "ChargingStopped" as const });
```

### `Schedule`, `Effect.race`, and `Effect.timeout` for resilience

The ramp-up phase races the physical wait against a repeating production watch, so a sudden
grid import aborts the attempt immediately (see
[`src/application/charging-session.ts`](./src/application/charging-session.ts)):

```ts
yield* Effect.race(
  Effect.void.pipe(Effect.delay(Duration.seconds(waitSeconds))),
  Effect.repeat(
    Effect.gen(function* () {
      const { import_from_grid: importingFromGrid } =
        yield* dataAdapter.queryLatestValues(["import_from_grid"]);
      if (importingFromGrid > 0) return yield* new AbruptProductionDropError({ ... });
    }),
    Schedule.fixed(Duration.seconds(config.watchCadenceInSeconds))
  )
);
```

Network calls use bounded exponential backoff plus a timeout
(`src/data-adapter/alpha-ess-api.data-adapter.ts`):

```ts
Effect.timeout(Duration.millis(this.TIMEOUT_MS)),
Effect.retry({
  schedule: Schedule.exponential(Duration.seconds(2), 2).pipe(Schedule.take(6)),
  while: (err) =>
    err._tag === "TimeoutError" ||
    (err._tag === "HttpClientError" && err.reason?._tag === "TransportError")
})
```


# Conventions

### Naming

- **Services** are PascalCase classes extending `Context.Service`, tagged
  `"@tesla-charger/Name"` (or `"@tesla-charger/Domain/Name"`).
- **Layer factories** follow `XLayer(config)` / `NameLive(config)` / static `X.layer`.
- **Effect functions** are defined with `Effect.fn("camelCaseName")`.
- **Files** are kebab-case with purpose suffixes: `.data-adapter.ts`, `.error.ts`,
  `schema.ts`, `.test.ts`.
- **Errors** are `XxxError` classes extending `Data.TaggedError`, with `_tag` strings such
  as `"VehicleAsleepError"`.

### Tooling

- `npm run ci` is the gate — it runs typecheck (`tsc --noEmit`), lint (`oxlint`),
  tests (`vitest --run`), and format (`oxfmt --write`). Mandated by `AGENTS.md`.
- Formatting/linting use `oxfmt` / `oxlint`; a `husky` pre-commit hook is installed.
- Runtime requires Node >= 21.7.3.
- Tests run with Vitest (`npm run test -- --run`). **Never use `bun test`** (per `AGENTS.md`).
- Before any Effect work, `AGENTS.md` requires reading `repos/effect-smol/LLMS.md`.
