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

Add an HTTP API server using `effect/unstable/http`'s `HttpRouter` + `HttpServer`, running alongside the existing charging loop. Routes are defined as Layers via `HttpRouter.add()` and composed into a server Layer with `HttpRouter.serve()`, which is then provided to the app's Layer graph. A new `AppRuntime` service owns the three central state `Ref`s (control state, session stats, app status) and exposes them to both `AppLayer` and the HTTP handlers.

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/healthz` | Liveness check — returns `"ok"` |
| `GET` | `/state` | Full snapshot: control state, session stats, app status, battery state |
| `GET` | `/dynamic-charging-config` | Read current `bufferPower` → `{ bufferPower: number }` |
| `PATCH` | `/dynamic-charging-config` | Set `bufferPower` — body: `{ bufferPower: number }` |

### Architecture Decisions

1. **`AppRuntime` owns the Refs** (not `AppLayer`). Extracted from `AppLayer` so the HTTP handlers can access them without coupling to the charging loop internals.

2. **Routes in a separate file** (`src/http-api.ts`). Decouples HTTP concerns from charging logic. Routes are defined as Layers using `HttpRouter.add()` and composed with `Layer.mergeAll()`.

3. **Layer-driven lifecycle**. `HttpRouter.serve(routesLayer)` produces a `Layer` that starts the server when built and shuts it down when released. No manual fiber management — the server lifecycle is bound to the app's Scope automatically via the Layer graph.

4. **Flat router layers**. Four routes are simple enough — each is a single `HttpRouter.add()` layer, composed with `Layer.mergeAll`. Refactor to tag-based middleware if routes grow.

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
| `src/http-api.ts` | Route layers for 4 endpoints, composed via `Layer.mergeAll`. |

### Modified

| File | Change |
|------|--------|
| `src/config.ts` | Add `httpApi.port` = `HTTP_API_PORT` env var (default `8080`) |
| `src/app.ts` | (a) Remove `Ref.make(...)` lines — use `AppRuntime` instead. (b) Yield `AppRuntime`. |
| `src/main.ts` | Provide `AppRuntimeLayer`, define/merge HTTP server layer via `NodeHttpServer.layer`. Read `httpApiPort` from env. Import `createServer` from `node:http`. |

## Tasks

- [ ] **Task 1**: Create `src/app-runtime.ts` — `AppRuntime` service + `AppRuntimeLayer`
- [ ] **Task 2**: Create `src/http-api.ts` — 4 route layers composed via `Layer.mergeAll`
- [ ] **Task 3**: Add `HTTP_API_PORT` to `src/config.ts`
- [ ] **Task 4**: Modify `src/app.ts` — remove Ref creation, yield `AppRuntime`, replace `controlRef`/`statsRef`/`appStatusRef` with `appRuntime.*`
- [ ] **Task 5**: Modify `src/main.ts` — provide `AppRuntimeLayer`, build `HttpServerLayer` with `HttpRouter.serve` + `NodeHttpServer.layer`, read `httpApiPort` from env
- [ ] **Task 6**: Typecheck (`npx tsc --noEmit`) and run all tests (`npx vitest run`)

## Implementation Details

### Task 1: `src/app-runtime.ts`

```ts
import { Context, Effect, Layer, Ref } from "effect";
import type { ChargingControlState, ChargingSessionStats } from "./domain/charging-session.js";
import { createInitialChargingControlState, createInitialChargingSessionStats, AppStatus } from "./domain/charging-session.js";

export class AppRuntime extends Context.Service<
  AppRuntime,
  {
    readonly controlRef: Ref.Ref<ChargingControlState>;
    readonly statsRef: Ref.Ref<ChargingSessionStats>;
    readonly appStatusRef: Ref.Ref<AppStatus>;
  }
>()("@tesla-charger/AppRuntime") {}

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

Each route is a `Layer` created by `HttpRouter.add()`, composed with `Layer.mergeAll`. The composed route layer is passed to `HttpRouter.serve()` in `main.ts` to create the server.

```ts
import { Effect, Layer, Ref, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { AppRuntime } from "./app-runtime.js";
import { DynamicChargingConfig } from "./charging-speed-controller/dynamic-config.js";
import { BatteryStateManager } from "./battery-state-manager.js";
import { AppStatus } from "./domain/charging-session.js";

// GET /healthz — no dependencies beyond the router
const HealthRoute = HttpRouter.add(
  "GET", "/healthz",
  HttpServerResponse.text("ok")
);

// GET /state — requires AppRuntime + BatteryStateManager
const StateRoute = HttpRouter.add(
  "GET", "/state",
  Effect.gen(function* () {
    const appRuntime = yield* AppRuntime;
    const batteryStateManager = yield* BatteryStateManager;
    const control = yield* Ref.get(appRuntime.controlRef);
    const stats = yield* Ref.get(appRuntime.statsRef);
    const appStatus = yield* Ref.get(appRuntime.appStatusRef);
    const battery = batteryStateManager.get();
    return HttpServerResponse.jsonUnsafe({
      control,
      stats,
      appStatus: AppStatus[appStatus],
      battery
    });
  })
);

// GET /dynamic-charging-config — requires DynamicChargingConfig
const GetConfigRoute = HttpRouter.add(
  "GET", "/dynamic-charging-config",
  Effect.gen(function* () {
    const dynamicConfig = yield* DynamicChargingConfig;
    const bufferPower = yield* dynamicConfig.getBufferPower;
    return HttpServerResponse.jsonUnsafe({ bufferPower });
  })
);

// PATCH /dynamic-charging-config — requires DynamicChargingConfig
const PatchConfigRoute = HttpRouter.add(
  "PATCH", "/dynamic-charging-config",
  Effect.gen(function* () {
    const body = yield* HttpServerRequest.schemaBodyJson(
      Schema.Struct({ bufferPower: Schema.Number })
    );
    const dynamicConfig = yield* DynamicChargingConfig;
    yield* dynamicConfig.setBufferPower(body.bufferPower);
    return HttpServerResponse.jsonUnsafe({ bufferPower: body.bufferPower });
  })
);

// Compose all routes — the server layer is built in main.ts via HttpRouter.serve
export const AllRoutes = Layer.mergeAll(
  HealthRoute,
  StateRoute,
  GetConfigRoute,
  PatchConfigRoute
);
```

Key points:
- `HttpRouter.add("METHOD", "/path", handler)` returns a `Layer` whose requirements track the handler's service dependencies as phantom types (`Request.From<"Requires", ...>`).
- `HttpServerRequest` and `Scope.Scope` are automatically excluded from layer requirements because the router provides them per-request.
- `schemaBodyJson(schema)` returns an `Effect` that already reads `HttpServerRequest` from context — no need to yield the request explicitly.
- `HttpRouter.serve(AllRoutes)` in `main.ts` produces the server `Layer`, combining the router with `HttpServer.serve`.

### Task 3: `src/config.ts` additions

```ts
httpApi: {
  port: EffectConfig.int("HTTP_API_PORT").pipe(EffectConfig.withDefault(8080))
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
```

**Replace** all references to `controlRef`, `statsRef`, `appStatusRef` with `appRuntime.controlRef`, `appRuntime.statsRef`, `appRuntime.appStatusRef` throughout `stop()` and `start()`.

No other changes to `app.ts` — the HTTP server lifecycle is managed entirely by the Layer graph in `main.ts`; `App.start()`/`stop()` do not need to fork or interrupt the server manually.

### Task 5: `src/main.ts` changes

**Imports to add:**
```ts
import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { HttpRouter } from "effect/unstable/http";
import { AppRuntimeLayer } from "./app-runtime.js";
import { AllRoutes } from "./http-api.js";
```

**Read port** after `costPerKwh`:
```ts
const httpApiPort = yield* AppConfig.httpApi.port;
```

**Build the HTTP server layer** (after controller layer selection, before the final `AppLayer(...).pipe(...)`):
```ts
const HttpServerLayer = HttpRouter.serve(AllRoutes).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { port: httpApiPort }))
);
```

**Add to `Layer.provideMerge` chain** (before the existing controller/battery layers, after `AppLayer`):
```ts
Layer.provideMerge(controllerLayer),
Layer.provideMerge(AppRuntimeLayer),
Layer.provideMerge(HttpServerLayer),
Layer.provideMerge(DynamicChargingConfigLayer(bufferPower)),
Layer.provideMerge(BatteryStateManagerLayer),
```

### Task 6: Verification

```sh
npm run ci
```

## Lifecycle Walkthrough

1. `main.ts` builds `MainLayer` — the Layer graph includes `HttpServerLayer` (routes + Node HTTP server)
2. The `HttpRouter.serve(AllRoutes)` layer starts the server when the Layer graph is built (server listens on `HTTP_API_PORT`, default 8080)
3. `App.start()` is called → sets status to Running
4. `App.stop()` is called
5. `Effect.scoped` releases all layers → the HTTP server shuts down cleanly when its owning Scope finalizes

## Acceptance Criteria

- [ ] `GET /healthz` returns `"ok"` with status 200
- [ ] `GET /state` returns JSON with `control`, `stats`, `appStatus`, `battery` fields reflecting live state
- [ ] `GET /dynamic-charging-config` returns `{ bufferPower: <current value> }`
- [ ] `PATCH /dynamic-charging-config` with `{ bufferPower: 2000 }` changes the value, and subsequent `GET` returns the new value
- [ ] All existing tests pass
- [ ] `npm run ci` passes with no errors
- [ ] Server shuts down cleanly when app stops (via Layer scope finalization)
- [ ] Server starts when Layer graph is built, stops when Scope is released

## References

- Effect HttpServer guide: `ai-docs/src/51_http-server/10_basics.ts` (in effect-smol)
- Existing dynamic config: `src/charging-speed-controller/dynamic-config.ts`
- App lifecycle: `src/app.ts` (AppLayer, start/stop)
- Layer wiring: `src/main.ts` (MainLayer construction)
- Import paths: HTTP modules from `effect/unstable/http`, NodeHttpServer from `@effect/platform-node`
