# Implementation Plan

## Active Tasks

- [ ] **Task 1**: Convert `src/app.ts` functions (6 functions) to `Effect.fn` pattern
- [ ] **Task 2**: Convert `src/tesla-client/index.ts` functions (4 functions) to `Effect.fn` pattern
- [ ] **Task 3**: Verify all tests pass and no regressions

## Notes

### Critical Pattern Details

**The conversion pattern requires TWO closing parentheses:**

```typescript
// Before:
const myFunction = () => Effect.gen(function* () {
  // implementation
});

// After:
const myFunction = Effect.fn("myFunction")(function* () {
  // implementation  
}));  // ← TWO closing parens: one for generator, one for Effect.fn
```

**Call sites must remove `()`:**
- Before: `myFunction()` 
- After: `myFunction`

**With `.pipe()`:**
- Before: `myFunction().pipe(Effect.withSpan("name"))`
- After: `myFunction.pipe(Effect.withSpan("name"))`

### Task 1 Details

Convert these 6 functions in `src/app.ts`:

1. `checkIfCorrectlyCharging` (line 203)
2. `syncChargingRateBasedOnExcess` (line 229)
3. `computeAndEmitSessionSummary` (line 282)
4. `stop` (line 319)
5. `shutdownAfterMaxRuntimeHours` (line 372)
6. `start` property (line379)

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