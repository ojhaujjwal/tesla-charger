# Implementation Plan

## Active Tasks

- [x] **Task 1**: Convert `src/app.ts` functions (6 functions) to `Effect.fn` pattern
- [x] **Task 2**: Convert `src/tesla-client/index.ts` functions (4 functions) to `Effect.fn` pattern
- [x] **Task 3**: Verify all tests pass and no regressions

## Notes

### Critical Pattern Details

**The conversion pattern:**

```typescript
// Before:
const myFunction = () => Effect.gen(function* () {
  // implementation
});

// After:
const myFunction = Effect.fn("myFunction")(function* () {
  // implementation  
});
```

**Call sites remain unchanged** (they still need `()` since `Effect.fn` returns a function):

```typescript
// Before: myFunction()
myFunction()
```

**Note:** `Effect.fn("name")(generator)` returns a FUNCTION (not an Effect directly), so call sites must KEEP the `()`.

**Functions with `.pipe()` at the end CANNOT be converted:**

The pattern `Effect.fn("name")(function* {...}).pipe(...)` does NOT work because `Effect.fn(name)(generator)` returns a function, not an Effect. The spec suggestion to pass pipeables to `Effect.fn` itself (`Effect.fn("name", pipeable)(generator)`) doesn't work because there's no such overload.

### Task 1 Details

Converted these 6 functions in `src/app.ts`:

1. `checkIfCorrectlyCharging` - converted (no pipe)
2. `syncChargingRateBasedOnExcess` - converted (with multiple pipeables)
3. `computeAndEmitSessionSummary` - converted (no pipe)
4. `stop` - converted (with pipeables: tap, orDie)
5. `shutdownAfterMaxRuntimeHours` - converted (no pipe)
6. `start` property - converted (no pipe)

### Task 2 Details

Converted 3 out of 4 functions in `src/tesla-client/index.ts`:

1. `getTokens` (line 53) - ✅ converted
2. `refreshAccessTokenFromTesla` (line 58) - ✅ converted
3. `refreshAccessToken` (line 166) - ❌ NOT converted (has `.pipe(Effect.mapError(...))` at end)
4. `getChargeState` (line 173) - ✅ converted

**Issue with `refreshAccessToken`:**
- Has `.pipe(Effect.mapError(...))` at end
- Cannot convert because `Effect.fn(name)(generator)` returns a function, not an Effect
- The spec's suggestion to use `Effect.fn(name, pipeable)(generator)` doesn't work (no such overload)
- **Resolution:** Leave as-is; this is a known limitation of `Effect.fn`

### Task 3 Details (Completed in Iteration 6)

Verification passed:
- `npm run build` - passes
- `npm run lint:fix` - passes
- `npm test -- --run` - 128 tests pass

The 4th function (`refreshAccessToken`) cannot be converted due to the `.pipe()` limitation documented in the spec. This is expected behavior, not a failure.

## Verification

After each task:
```bash
npm run build && npm run lint:fix && npm test -- --run
```
