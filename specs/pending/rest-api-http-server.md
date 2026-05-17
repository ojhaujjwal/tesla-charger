# REST API with Effect HttpServer

## Overview

Expose charging state and dynamic configuration via a REST API using Effect's `HttpServer`, enabling local monitoring and control without restarting the application.

## Background

Currently the app runs headless — all state (charging control state, session stats, app status, battery state) is held in-memory via `Ref` and inaccessible externally. The `bufferPower` (safety margin subtracted from excess solar before determining charging speed) is baked into the controller at layer construction time and can only be changed by restarting with a different `EXCESS_SOLAR_BUFFER_POWER` env var.

## Problem

- No external visibility into charging state, battery state, or app status
- `bufferPower` cannot be changed at runtime without restarting
- No health check for process monitoring

## Solution

Add an HTTP API server using `@effect/platform`'s `HttpServer` + `HttpRouter`, running alongside the existing charging loop. The server lifecycle is tied to the app's `Scope` via `Effect.forkScoped`. A new `AppRuntime` service owns the three central state `Ref`s (control state, session stats, app status) and exposes them to both `AppLayer` and the HTTP handlers.

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/healthz` | Liveness check — returns `"ok"` |
| `GET` | `/state` | Full snapshot: control state, session stats, app status, battery state |
| `GET` | `/dynamic-charging-config` | Read current `bufferPower` → `{ bufferPower: number }` |
| `PATCH` | `/dynamic-charging-config` | Set `bufferPower` — body: `{ bufferPower: number }` |

### Architecture Decisions

1. **`AppRuntime` owns the Refs** (not `AppLayer`). Extracted from `AppLayer` so the HTTP handlers can access them without coupling to the charging loop internals.

2. **`HttpApi` in a separate file** (`src/http-api.ts`). Decouples HTTP concerns from charging logic. The `HttpApi` service exposes a scoped `start` method.

3. **Scope-driven lifecycle**. `HttpApi.start` returns `Effect<void, never, HttpServer | Scope>`. `App.start()` forks it via `Effect.forkScoped`, binding the server's lifetime to the app's `Scope`. When the app stops, the server shuts down cleanly.

4. **Flat router** (not tag-based). Four routes are simple enough that modular routers would be over-engineering. Refactor to tag-based if routes grow.

5. **HTTP server always on**. No CLI flag needed. Overhead of a listener on `localhost:8080` is negligible.

6. **Port via env var** (`HTTP_API_PORT`, default `8080`). Consistent with how all other settings are configured in this project.

7. **`ExcessSolarAggresiveControllerLayer` consumes `DynamicChargingConfig`** (already implemented). The `DynamicChargingConfig` service uses `getBufferPower`/`setBufferPower` backed by a `Ref`, enabling the PATCH endpoint to change `bufferPower` at runtime.

### `GET /state` Response

```json
{
  "control": { "status": "Charging", "ampere": 16 },
  "stats": { "ampereFluctuations": 3, "sessionStartedAt": "2026-05-17T..." },
  "appStatus": "Running",
  "battery": { "batteryLevel": 72, "chargeLimitSoc": 80, "queriedAtMs": 1715600000000 }
}
```

## Files

### New

| File | Purpose |
|------|---------|
| `src/app-runtime.ts` | `AppRuntime` service + layer. Owns `controlRef`, `statsRef`, `appStatusRef`. |
| `src/http-api.ts` | `HttpApi` service + layer. Builds router with 4 routes, exposes scoped `start`. |

### Modified

| File | Change |
|------|--------|
| `src/config.ts` | Add `httpApi.port` = `HTTP_API_PORT` env var (default `8080`) |
| `src/app.ts` | (a) Remove `Ref.make(...)` lines — use `AppRuntime` instead. (b) Yield `AppRuntime` and `HttpApi`. (c) Fork `httpApi.start()` via `Effect.forkScoped` in `App.start()`. (d) Track `httpServerFiber` alongside existing fibers. (e) Add `HttpServer` and `Scope` to `App.start()` requirements. |
| `src/main.ts` | Provide `AppRuntimeLayer`, `HttpApiLayer`, `NodeHttpServer.layer`. Read `httpApiPort` from env. Import `createServer` from `node:http`. |

## Tasks

- [ ] **Task 1**: Create `src/app-runtime.ts` — `AppRuntime` service + `AppRuntimeLayer`
- [ ] **Task 2**: Create `src/http-api.ts` — `HttpApi` service + `HttpApiLayer` + router + routes
- [ ] **Task 3**: Add `HTTP_API_PORT` to `src/config.ts`
- [ ] **Task 4**: Modify `src/app.ts` — remove Ref creation, yield `AppRuntime` and `HttpApi`, fork HTTP server in `start()`
- [ ] **Task 5**: Modify `src/main.ts` — provide new layers, port from env, import `createServer` and `NodeHttpServer`
- [ ] **Task 6**: Typecheck (`npx tsc --noEmit`) and run all tests (`npx vitest run`)

## Implementation Details

### Task 1: `src/app-runtime.ts`

```ts
import { Context, Effect, Layer, Ref } from "effect";
import type { ChargingControlState, ChargingSessionStats } from "./domain/charging-session.js";
import { createInitialChargingControlState, createInitialChargingSessionStats, AppStatus } from "./domain/charging-session.js";

export class AppRuntime extends Context.Tag("@tesla-charger/AppRuntime")<
  AppRuntime,
  {
    readonly controlRef: Ref.Ref<ChargingControlState>;
    readonly statsRef: Ref.Ref<ChargingSessionStats>;
    readonly appStatusRef: Ref.Ref<AppStatus>;
  }
>() {}

export const AppRuntimeLayer = Layer.effect(
  AppRuntime,
  Effect.gen(function* () {
    const controlRef = yield* Ref.make(createInitialChargingControlState());
    const statsRef = yield* Ref.make(createInitialChargingSessionStats());
    const appStatusRef = yield* Ref.make(AppStatus.Pending);
    return { controlRef, statsRef, appStatusRef };
  })
);
```

### Task 2: `src/http-api.ts`

Service:

```ts
import { Context, Effect, Layer, Ref, Schema } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { AppRuntime } from "./app-runtime.js";
import { DynamicChargingConfig } from "./charging-speed-controller/dynamic-config.js";
import { BatteryStateManager } from "./battery-state-manager.js";
import { AppStatus } from "./domain/charging-session.js";

export class HttpApi extends Context.Tag("@tesla-charger/HttpApi")<
  HttpApi,
  {
    readonly start: Effect.Effect<void, never, HttpServer.HttpServer | Scope.Scope>;
  }
>() {}

export const HttpApiLayer = Layer.effect(
  HttpApi,
  Effect.gen(function* () {
    const appRuntime = yield* AppRuntime;
    const dynamicConfig = yield* DynamicChargingConfig;
    const batteryStateManager = yield* BatteryStateManager;

    const router = HttpRouter.empty.pipe(
      HttpRouter.get("/healthz",
        HttpServerResponse.text("ok")
      ),
      HttpRouter.get("/state",
        Effect.gen(function* () {
          const control = yield* Ref.get(appRuntime.controlRef);
          const stats = yield* Ref.get(appRuntime.statsRef);
          const appStatus = yield* Ref.get(appRuntime.appStatusRef);
          const battery = batteryStateManager.get();
          return HttpServerResponse.unsafeJson({
            control,
            stats,
            appStatus: AppStatus[appStatus],
            battery
          });
        })
      ),
      HttpRouter.get("/dynamic-charging-config",
        Effect.gen(function* () {
          const bufferPower = yield* dynamicConfig.getBufferPower;
          return HttpServerResponse.unsafeJson({ bufferPower });
        })
      ),
      HttpRouter.patch("/dynamic-charging-config",
        Effect.gen(function* () {
          const req = yield* HttpServerRequest.HttpServerRequest;
          const body = yield* HttpServerRequest.schemaBodyJson(
            Schema.Struct({ bufferPower: Schema.Number })
          )(req);
          yield* dynamicConfig.setBufferPower(body.bufferPower);
          return HttpServerResponse.unsafeJson({ bufferPower: body.bufferPower });
        })
      )
    );

    const start = Effect.fn("HttpApi.start")(() =>
      HttpServer.serve(router.pipe(HttpRouter.toHttpApp))
    );

    return { start };
  })
);
```

Key: `HttpApiLayer` yields `AppRuntime`, `DynamicChargingConfig`, and `BatteryStateManager` at layer construction and captures them in the closure. This means the layer requires `AppRuntime | DynamicChargingConfig | BatteryStateManager`, which are all provided elsewhere in the layer graph.

`HttpApi.start` requires `HttpServer` and `Scope` — these come from the outer context when the effect runs (provided by `NodeHttpServer.layer` and `Effect.scoped` respectively).

### Task 3: `src/config.ts` additions

```ts
httpApi: {
  port: EffectConfig.integer("HTTP_API_PORT").pipe(EffectConfig.withDefault(8080))
}
```

### Task 4: `src/app.ts` changes

**Remove** the three `Ref.make(...)` calls on lines 82-84:
```ts
// REMOVE:
const controlRef = yield* Ref.make(createInitialChargingControlState());
const statsRef = yield* Ref.make(createInitialChargingSessionStats());
const appStatusRef = yield* Ref.make(AppStatus.Pending);
```

**Add** after `const batteryStateManager = yield* BatteryStateManager;` (line ~80):
```ts
const appRuntime = yield* AppRuntime;
const httpApi = yield* HttpApi;
```

**Replace** all references to `controlRef`, `statsRef`, `appStatusRef` with `appRuntime.controlRef`, `appRuntime.statsRef`, `appRuntime.appStatusRef` throughout `stop()` and `start()`.

**Add** `httpServerFiber` variable and tracking:
```ts
let httpServerFiber: Fiber.RuntimeFiber<void, never> | undefined;
```

**In `start()`**, after setting `AppStatus.Running`:
```ts
httpServerFiber = yield* Effect.forkScoped(httpApi.start);
```

**In `stop()`**, add `httpServerFiber` to the fibers array:
```ts
fibers: [
  batteryStateManagerFiber,
  eventLoggerFiber,
  tokenRefreshFiber,
  mainSyncFiber,
  runtimeMonitorFiber,
  httpServerFiber
].filter((f): f is NonNullable<typeof f> => f !== undefined)
```

**Update `Fiber.joinAll()`** to include `httpServerFiber`:
```ts
yield* Fiber.joinAll([
  tokenRefreshFiber,
  batteryStateManagerFiber,
  eventLoggerFiber,
  mainSyncFiber,
  runtimeMonitorFiber,
  ...(httpServerFiber ? [httpServerFiber] : [])
]);
```

**Update `App` type** to include `HttpServer` and `Scope` in `start()` requirements:
```ts
readonly start: () => Effect.Effect<
  void,
  ...errors...,
  ElectricVehicle | HttpServer.HttpServer | Scope.Scope
>;
```

**Provide `HttpApi` to `start()`** in the `Effect.provideService` chain alongside the existing provides.

### Task 5: `src/main.ts` changes

**Imports to add:**
```ts
import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { AppRuntimeLayer } from "./app-runtime.js";
import { HttpApiLayer } from "./http-api.js";
```

**Read port** after `costPerKwh`:
```ts
const httpApiPort = yield* AppConfig.httpApi.port;
```

**Add to `Layer.provideMerge` chain** (before the existing controller/battery layers, after AppLayer):
```ts
Layer.provideMerge(controllerLayer),
Layer.provideMerge(AppRuntimeLayer),
Layer.provideMerge(HttpApiLayer),
Layer.provideMerge(NodeHttpServer.layer(() => createServer(), { port: httpApiPort })),
Layer.provideMerge(DynamicChargingConfigLayer(bufferPower)),
Layer.provideMerge(BatteryStateManagerLayer),
```

### Task 6: Verification

```sh
npm run ci
```

## Lifecycle Walkthrough

1. `main.ts` builds `MainLayer` with all layers provided
2. `App.start()` is called → sets status to Running → forks `httpApi.start()` into `httpServerFiber` using `Effect.forkScoped` (bound to the app's `Scope`)
3. HTTP server listens on `HTTP_API_PORT` (default 8080)
4. `App.stop()` is called → interrupts `httpServerFiber` alongside all other fibers → server shuts down cleanly via Scope release
5. `Effect.scoped` in `main.ts` closes the `Scope` on program exit

## Acceptance Criteria

- [ ] `GET /healthz` returns `"ok"` with status 200
- [ ] `GET /state` returns JSON with `control`, `stats`, `appStatus`, `battery` fields reflecting live state
- [ ] `GET /dynamic-charging-config` returns `{ bufferPower: <current value> }`
- [ ] `PATCH /dynamic-charging-config` with `{ bufferPower: 2000 }` changes the value, and subsequent `GET` returns the new value
- [ ] All existing tests pass
- [ ] `npm run ci` passes with no errors
- [ ] Server shuts down cleanly when app stops
- [ ] Server starts/stops via `App.start()` / `App.stop()` lifecycle

## References

- Effect HttpServer guide: `effect-solutions show services-and-layers`
- Existing dynamic config: `src/charging-speed-controller/dynamic-config.ts`
- App lifecycle: `src/app.ts` (AppLayer, start/stop)
- Layer wiring: `src/main.ts` (MainLayer construction)
