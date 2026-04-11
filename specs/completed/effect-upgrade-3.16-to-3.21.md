# Effect Upgrade: 3.16.4 → 3.21.0

## Overview

Upgrade Effect ecosystem packages from version 3.16.x to 3.21.0. This is a minor version bump with **no breaking changes** - only additive features and bug fixes.

## Current vs Latest Versions

| Package | Current | Latest |
|---------|---------|--------|
| effect | ^3.16.4 | **3.21.0** |
| @effect/platform | ^0.84.8 | **0.96.0** |
| @effect/platform-node | ^0.85.7 | **0.106.0** |
| @effect/experimental | ^0.48.12 | **0.60.0** |
| @effect/vitest | ^0.23.5 | **0.29.0** |
| @effect/language-service | ^0.62.5 | **0.85.1** |
| @sentry/core | ^10.47.0 | **10.48.0** |
| @sentry/effect | ^10.47.0 | **10.48.0** |
| @effect/cluster | (new) | **0.58.0** |
| @effect/rpc | (new) | **0.75.0** |
| @effect/sql | (new) | **0.51.0** |

## Breaking Changes

**No breaking API changes** between 3.16.4 and 3.21.0. All changes are backward compatible.

## Tasks

- [x] **Task 1**: Update package.json with new dependency versions
- [x] **Task 2**: Run npm install to fetch updated packages
- [x] **Task 3**: Verify build passes (`npm run build`)
- [x] **Task 4**: Verify lint passes (`npm run lint:fix`)
- [x] **Task 5**: Verify tests pass (`npm test -- --run`)
- [x] **Task 6**: Update lock file and verify clean state
- [x] **Task 7**: Fix Effect 3.21.0 lint errors from stricter rules

## Additional Notes

The upgrade required adding three new dependencies that are now peer dependencies of @effect/platform-node@0.106.0:
- @effect/cluster@^0.58.0
- @effect/rpc@^0.75.0
- @effect/sql@^0.51.0

Installation was performed with `--legacy-peer-deps` flag due to peer dependency conflicts between packages.

## Additional Notes (Iteration 2)

Effect 3.21.0 introduced stricter lint rules. The following errors were fixed:
- TS29 (unnecessaryFailYieldableError): Changed `yield* Effect.fail(new Error())` to `yield* new Error()`
- TS11 (returnEffectInGen): Changed `return Effect.void` to `return` in Effect generators
- TS2 (catchUnfailableEffect): Removed unreachable catchAll handlers
- TS16 (unnecessaryPipeChain): Simplified chained pipe calls
- TS39 (catchAllToMapError): Changed catchAll+fail to mapError
- TS15 (tryCatchInEffectGen): Removed manual try/catch in Effect generators
- TS35/TS36 (globalErrorInEffectCatch/Failure): Created tagged error classes

**Remaining TS44 (preferSchemaOverJson) messages**: These are suggestions to use Effect Schema's JSON handling instead of JSON.parse/stringify. They don't affect build and were left as-is because:
- Using Schema.encode for request bodies requires separate request body schemas
- Using Schema.encode for file cache writes still requires JSON.stringify afterward
- These are API concerns, not data modeling concerns where Schema shines

## Implementation Details

### Task 1: Update package.json

Update the following dependencies in `package.json`:

**dependencies:**
```json
"effect": "^3.21.0",
"@effect/platform": "^0.96.0",
"@effect/platform-node": "^0.106.0",
"@effect/experimental": "^0.60.0",
"@sentry/core": "^10.48.0",
"@sentry/effect": "^10.48.0"
```

**devDependencies:**
```json
"@effect/vitest": "^0.29.0",
"@effect/language-service": "^0.85.1"
```

### Task 2: Install Dependencies

```bash
npm install
```

This will update `package-lock.json` with the new resolved versions.

### Task 3: Build Verification

Run the TypeScript compiler:
```bash
npm run build
```

Expected: Zero errors. The codebase should compile without modifications since there are no breaking changes.

### Task 4: Lint Verification

Run ESLint with auto-fix:
```bash
npm run lint:fix
```

Expected: Zero errors. Linting rules should pass without modifications.

### Task 5: Test Verification

Run the test suite:
```bash
npm test -- --run
```

Expected: All tests pass. No test modifications required since APIs are backward compatible.

### Task 6: Final Verification

- Ensure `package-lock.json` has been updated
- Verify no uncommitted changes remain (except package files)
- Confirm git status shows only dependency updates

## Verification Checklist

Before signaling `TASK_COMPLETE`, verify:

- [x] `npm run build` exits with code 0
- [x] `npm run lint:fix` exits with code 0
- [x] `npm test -- --run` exits with code 0
- [x] No TypeScript errors in IDE
- [x] package.json shows updated versions
- [x] package-lock.json reflects new versions

## Rollback Plan

If critical issues arise:

1. Revert package.json changes:
   ```bash
   git checkout -- package.json package-lock.json
   npm install
   ```

2. Document the issue in this spec file for investigation.

## References

- [Effect CHANGELOG](https://github.com/Effect-TS/effect/blob/main/packages/effect/CHANGELOG.md)
- [Effect Releases](https://github.com/Effect-TS/effect/releases)

## Notes

- **OpenTelemetry Users**: If you use OTel semantic conventions, note that attribute names were updated in 3.16.14 (`db.system` → `db.system.name`, etc.)
- **New Features Available**: After upgrade, you can use new modules like `Graph`, `HashRing`, `PartitionedSemaphore`, `ExecutionPlan`, and `Layer.mock` for testing