# Refactor`() => Effect.gen` to `Effect.fn`

## Overview

Convert named function assignments using `() => Effect.gen` pattern to `Effect.fn("name")()` for improved tracing, better stack traces, and enhanced observability in telemetry systems.

## Background

The pattern `const myFunction = () => Effect.gen(function* () { ... })` creates anonymous generator functions that lose call-site context in traces. Using `Effect.fn("myFunction")(function* () { ... })` provides:

- **Call-site tracing**: Shows where the function was invoked from, not just where it's defined
- **Better stack traces**: Includes location details in error reports
- **Telemetry integration**: Automatically creates spans for OpenTelemetry integration

## Requirements

- [ ] Convert all named function assignments from `() => Effect.gen` to `Effect.fn` pattern
- [ ] Preserve existing behavior and types
- [ ] Ensure all tests pass after conversion
- [ ] Skip test files (tests already have descriptive names via `it.effect()`)

## Files to Convert

### src/app.ts (6 functions)
- `checkIfCorrectlyCharging`
- `syncChargingRateBasedOnExcess`
- `computeAndEmitSessionSummary`
- `stop`
- `shutdownAfterMaxRuntimeHours`
- `start` property in returned object

### src/tesla-client/index.ts (4 functions)
- `getTokens`
- `refreshAccessTokenFromTesla`
- `refreshAccessToken`
- `getChargeState`

## Tasks

- [ ] **Task 1**: Convert `src/app.ts` functions (6 functions) to `Effect.fn` pattern
- [ ] **Task 2**: Convert `src/tesla-client/index.ts` functions (4 functions) to `Effect.fn` pattern
- [ ] **Task 3**: Verify all tests pass and no regressions

## Implementation Details

### Task 1: Convert src/app.ts functions

Convert these 6 functions in order:

1. `checkIfCorrectlyCharging` (line 203)
2. `syncChargingRateBasedOnExcess` (line 229)
3. `computeAndEmitSessionSummary` (line 282)
4. `stop` (line 319)
5. `shutdownAfterMaxRuntimeHours` (line 372)
6. `start` property (line 379)

After all conversions, update call sites:
- `syncChargingRateBasedOnExcess()` → `syncChargingRateBasedOnExcess`
- `shutdownAfterMaxRuntimeHours()` → `shutdownAfterMaxRuntimeHours`

**Run verification:**
```bash
npm run build && npm run lint:fix && npm test -- --run
```

### Task 2: Convert src/tesla-client/index.ts functions

Convert these 4 functions:

1. `getTokens` (line 53)
2. `refreshAccessTokenFromTesla` (line 58)
3. `refreshAccessToken` (line 166)
4. `getChargeState` (line 173)

After all conversions, update call sites:
- `getTokens()` → `getTokens`
- `refreshAccessTokenFromTesla()` → `refreshAccessTokenFromTesla`
- `getChargeState()` → `getChargeState`

**Run verification:**
```bash
npm run build && npm run lint:fix && npm test -- --run
```

### Task 3: Final verification

Run full CI:
```bash
npm run build && npm run lint:fix && npm test -- --run
```

## Conversion Pattern

Before:
```typescript
const myFunction = () => Effect.gen(function* () {
  // implementation
});
```

After:
```typescript
const myFunction = Effect.fn("myFunction")(function* () {
  // implementation
}));
```

**IMPORTANT:** `Effect.fn("name")(function* () {...})` returns a FUNCTION, not an Effect directly. Call sites must KEEP the `()`.

Example with `.pipe()`:
```typescript
// Before:
const myFunction = () => Effect.gen(function* () {
  // implementation
}).pipe(Effect.withLogAnnotation("key", "value"));

// After: CANNOT convert - Effect.fn returns a function, not an Effect
// The pattern Effect.fn("name")(generator).pipe(...) fails because .pipe() is called on a function
```

**Functions with `.pipe()` at the end CANNOT be converted.** The pattern `Effect.fn("name")(function* {...}).pipe(...)` does NOT work because `Effect.fn(name)(generator)` returns a function, not an Effect.

**Steps:**

1. **Update src/app.ts** - Convert 6 functions:

For `checkIfCorrectlyCharging` (line 203):
```typescript
const checkIfCorrectlyCharging = Effect.fn("checkIfCorrectlyCharging")(function* () {
  const { current_load: currentLoad, voltage } = yield* dataAdapter.queryLatestValues(['current_load', 'voltage']);
  // rest of implementation...
}));  // ← TWO closing parens
```

For `syncChargingRateBasedOnExcess` (line 229):
```typescript
const syncChargingRateBasedOnExcess = Effect.fn("syncChargingRateBasedOnExcess")(function* () {
  const ampere = yield* chargingSpeedController.determineChargingSpeed(
    chargeState.running ? chargeState.ampere : 0,
  );
  // rest of implementation...
})).pipe(  // ← TWO closing parens + .pipe
  Effect.withSpan('syncChargingRateBasedOnExcess')
);
```

For `computeAndEmitSessionSummary` (line 282):
```typescript
const computeAndEmitSessionSummary = Effect.fn("computeAndEmitSessionSummary")(function* () {
  // implementation...
}));  // ← TWO closing parens
```

For `stop` (line 319):
```typescript
const stop = Effect.fn("stop")(function* () {
  // implementation...
})).pipe(  // ← TWO closing parens + .pipe
  Effect.tap(() => computeAndEmitSessionSummary.pipe(Effect.fork)),  // ← NO () after computeAndEmitSessionSummary
  Effect.orDie
);
```

For `shutdownAfterMaxRuntimeHours` (line 372):
```typescript
const shutdownAfterMaxRuntimeHours = Effect.fn("shutdownAfterMaxRuntimeHours")(function* () {
  // implementation...
}));  // ← TWO closing parens
```

For `start` in returned object (line 379):
```typescript
return {
  start: Effect.fn("start")(function* () {
    // implementation...
  })),  // ← TWO closing parens
  stop,
};
```

2. **Update src/tesla-client/index.ts** - Convert 4 functions:

For `getTokens` (line 53):
```typescript
const getTokens = Effect.fn("getTokens")(function* () {
  const json = yield* fs.readFileString(config.tokenFilePath || 'token.json');
  return yield* Schema.decodeUnknown(TeslaCachedTokenSchema)(json);
}));  // ← TWO closing parens
```

**Note:** Call sites must change from `getTokens()` to `getTokens` (no parentheses).

For `refreshAccessTokenFromTesla` (line 58):
```typescript
const refreshAccessTokenFromTesla = Effect.fn("refreshAccessTokenFromTesla")(function* () {
  const { refresh_token } = yield* getTokens.pipe(  // ← NO () after getTokens
    // rest of implementation...
  );
}));  // ← TWO closing parens
```

For `refreshAccessToken` (line 166):
```typescript
const refreshAccessToken = Effect.fn("refreshAccessToken")(function* () {
  // implementation...
})).pipe(  // ← TWO closing parens + .pipe
  Effect.mapError((err) => new AuthenticationFailedError({ cause: err }))
);
```

For `getChargeState` (line 173):
```typescript
const getChargeState = Effect.fn("getChargeState")(function* () {
  // implementation...
}));  // ← TWO closing parens
```

3. **Run linter and type check**:
```bash
npm run lint:fix
npm run build
```

4. **Run tests** to verify behavior is preserved:
```bash
npm test
```

**INCREMENTAL APPROACH:** Convert one file at a time and verify:

```bash
# After converting src/app.ts functions:
npm run build && npm run lint:fix && npm test -- --run

# Only proceed to src/tesla-client/index.ts if build passes
```

This ensures you catch syntax errors early before they compound.

## Testing Plan

### Unit Tests

All existing unit tests should pass without modification. The conversion is purely structural and doesn't change behavior.

Run: `npm test`

### Verification

- Linter passes: `npm run lint:fix`
- TypeScript compiles: `npm run build`
- All tests pass: `npm test`
- Manual verification: Check that stack traces show function names in error scenarios

## Verification Checklist

Before signaling `TASK_COMPLETE`, verify:

- [ ] All 10 functions converted to `Effect.fn` pattern
- [ ] No lint errors
- [ ] TypeScript compilation succeeds
- [ ] All tests pass
- [ ] Code follows Effect best practices with `Effect.fn`

## Rollback Plan

Since this is a pure refactoring:
1. Revert the changes using git
2. All tests will pass with original code

## Future Considerations (Optional)

None - this is a straightforward refactoring tofollow Effect best practices.

## Spec Readiness Checklist

Before running ralph-auto.sh, verify:

- [x] All requirements are clearly defined (no unanswered questions)
- [x] All tasks are actionable and appropriately sized (1-4 hours each)
- [x] Implementation details are specific enough to execute
- [x] Testing plan covers happy path and error cases
- [x] Verification steps are concrete and testable
- [x] Rollback plan exists

## References

- Effect Solutions basics documentation: `effect-solutions show basic`
- `Effect.fn` provides call-site tracing for better observability

## Implementation Findings

During implementation of Task 2 (tesla-client/index.ts), the following was discovered:

### Converted Functions (3 out of 4)

1. **`getTokens`** (line 53) - ✅ Converted successfully
2. **`refreshAccessTokenFromTesla`** (line 58) - ✅ Converted successfully
3. **`getChargeState`** (line 173) - ✅ Converted successfully

### Cannot Convert (1 out of 4)

**`refreshAccessToken`** (line 166) - ❌ Cannot convert

This function has `.pipe(Effect.mapError(...))` at the end:
```typescript
const refreshAccessToken = () => Effect.gen(function* () {
  const result = yield* refreshAccessTokenFromTesla();
  yield* saveTokens(result.access_token, result.refresh_token);
}).pipe(
  Effect.mapError((err) => new AuthenticationFailedError({ cause: err }))
);
```

**Issue:** The `Effect.fn("name")(generator)` pattern returns a FUNCTION, not an Effect. The `.pipe()` method exists on Effects, not on functions. The pattern `Effect.fn("refreshAccessToken")(function* {...}).pipe(...)` fails because you cannot call `.pipe()` on a function.

**Alternative attempted:** The spec suggested `Effect.fn("name", pipeable)(generator)` but this overload does not exist in Effect - there is no overload that accepts both a name and a pipeable.

**Resolution:** `refreshAccessToken` remains in its original `() => Effect.gen(...).pipe(...)` form.