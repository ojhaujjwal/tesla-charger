# Implementation Plan

## Active Tasks

- [x] **Task 1**: Convert `src/app.ts` functions (6 functions) to `Effect.fn` pattern
- [ ] **Task 2**: Convert `src/tesla-client/index.ts` functions (4 functions) to `Effect.fn` pattern
- [ ] **Task 3**: Verify all tests pass and no regressions

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

**Note:** The spec incorrectly stated call sites should remove `()`. However, `Effect.fn("name")(generator)` returns a FUNCTION (not an Effect directly), so call sites must KEEP the `()`.

**For functions with `.pipe()`:**

```typescript
// Before:
const myFunction = () => Effect.gen(function* () {
  // implementation
}).pipe(pipeable1, pipeable2);

// After:
const myFunction = Effect.fn("myFunction", pipeable1, pipeable2)(function* () {
  // implementation
});
```

### Task 1 Details

Converted these 6 functions in `src/app.ts`:

1. `checkIfCorrectlyCharging` - converted (no pipe)
2. `syncChargingRateBasedOnExcess` - converted (with multiple pipeables)
3. `computeAndEmitSessionSummary` - converted (no pipe)
4. `stop` - converted (with pipeables: tap, orDie)
5. `shutdownAfterMaxRuntimeHours` - converted (no pipe)
6. `start` property - converted (no pipe)

### Task 2 Details

Convert these 4 functions in `src/tesla-client/index.ts`:

1. `getTokens` (line 53)
2. `refreshAccessTokenFromTesla` (line 58)
3. `refreshAccessToken` (line 166)
4. `getChargeState` (line 173)

## Verification

After each task:
```bash
npm run build && npm run lint:fix && npm test -- --run
```
