# Improve OAuth Error Messages

## Overview

Enhance `UnableToFetchAccessTokenError` and related error classes to include HTTP status code and response body, enabling clear diagnosis of Tesla OAuth API failures.

## Background

When Tesla's OAuth token endpoint returns non-200 status codes (401, 400, 429, etc.), the current error contains no diagnostic information. Users see only `UnableToFetchAccessToken` without knowing:
- Which HTTP status code was returned
- What error message Tesla's API included in the response body

This makes debugging authentication failures unnecessarily difficult.

## Requirements

- [x] `UnableToFetchAccessTokenError` includes `message` field (required)
- [x] `UnableToFetchAccessTokenError` includes `statusCode` field (optional - undefined for timeouts)
- [x] `UnableToFetchAccessTokenError` includes `responseBody` field (optional - undefined for timeouts)
- [x] Error message is human-readable and includes status code (when available)
- [x] Error instance can be logged/inspected for full details
- [x] Timeout cases include cause chain to original TimeoutException
- [x] Similar improvement for `authenticateFromAuthCodeGrant` (separate task)
- [x] AuthenticationFailedError continues to wrap errors via cause field (no changes needed)

## Tasks

- [x] **Task 1**: Update error class and all existing usage sites (including tests)
- [x] **Task 2**: Add error handling to `authenticateFromAuthCodeGrant` (including tests)

## Implementation Details

### Task 1: Update error class and all existing usage sites

This task MUST be completed atomically - updating both the error class definition and all its usage sites in a single commit.

#### Step 1.1: Update `UnableToFetchAccessTokenError` class

File: `src/tesla-client/errors.ts`

Change from:
```typescript
export class UnableToFetchAccessTokenError extends Data.TaggedError("UnableToFetchAccessToken") {}
```

To:
```typescript
export class UnableToFetchAccessTokenError extends Data.TaggedError("UnableToFetchAccessToken")<{
  message: string;
  statusCode?: number;
  responseBody?: string;
}> {}
```

Fields are optional because timeouts have no HTTP response.

#### Step 1.2: Update timeout handler at line 90

File: `src/tesla-client/index.ts`

Change from:
```typescript
Effect.catchTag('TimeoutException', () => Effect.fail(new UnableToFetchAccessTokenError()))
```

To:
```typescript
Effect.catchTag('TimeoutException', (err) => 
  Effect.fail(new UnableToFetchAccessTokenError({ 
    message: 'Request timed out after 5 seconds'
  }, { cause: err }))
)
```

This preserves the original TimeoutException in the cause chain for debugging.

#### Step 1.3: Update HTTP error handler at lines 93-95

File: `src/tesla-client/index.ts`

Change from:
```typescript
if (response.status !== 200) {
  return yield* new UnableToFetchAccessTokenError();
}
```

To:
```typescript
if (response.status !== 200) {
  const body = yield* response.text.pipe(
    Effect.catchAll(() => Effect.succeed('Unable to read response body'))
  );
  return yield* new UnableToFetchAccessTokenError({
    message: `Token refresh failed with status ${response.status}`,
    statusCode: response.status,
    responseBody: body,
  });
}
```

All HTTP non-200 responses now include diagnostic details.

#### Step 1.4: Add unit tests for `refreshAccessTokenFromTesla`

File: `src/tests/unit/tesla-client/tesla-client.test.ts` (create if doesn't exist)

Create test file with test cases for timeout and HTTP error scenarios:

1. **Timeout scenario**: Mock network timeout - verify error has `message`, no `statusCode`/`responseBody`, and original TimeoutException in cause chain
2. **HTTP 401 response**: Mock Tesla API returning 401 - verify error contains `message`, `statusCode: 401`, and `responseBody`
3. **HTTP 400 response**: Mock Tesla API returning 400 - verify error fields populated correctly  
4. **HTTP 429 response**: Mock rate limit response - verify error contains status 429 and rate limit info in body
5. **HTTP 500 response**: Mock server error - verify error contains status 500 and error details
6. **Unable to read response body**: Mock 200 status but fail on `response.text` - verify graceful fallback to "Unable to read response body"
7. **Successful token refresh**: Mock successful200 response - verify tokens are refreshed correctly

Use Vitest with `@effect/platform/HttpClient` mocking patterns from Effect testing docs.

### Task 2: Add error handling to `authenticateFromAuthCodeGrant`

File: `src/tesla-client/index.ts`

Locate the `authenticateFromAuthCodeGrant` function (around lines226-246). Add error handling after the HTTP POST to `OAUTH2_TOKEN_BASE_URL`:

1. Add timeout handling (chain to existing httpClient.post):
   ```typescript
   .pipe(
     Effect.timeout(Duration.seconds(5)),
     Effect.catchTag('TimeoutException', (err) => 
       Effect.fail(new UnableToFetchAccessTokenError({
         message: 'Authorization code grant request timed out'
       }, { cause: err }))
     )
   )
   ```

2. Add HTTP status check after response is received:
   ```typescript
   if (response.status !== 200) {
     return yield* new UnableToFetchAccessTokenError({
       message: `Authorization code grant failed with status ${response.status}`,
       statusCode: response.status,
       responseBody: yield* response.text,
     });
   }
   ```

3. Wrap schema decode to ensure malformed responses are captured:
   ```typescript
   yield* Schema.decodeUnknown(TeslaTokenResponseSchema)(yield* response.text).pipe(
     Effect.mapError((err) => new UnableToFetchAccessTokenError({
       message: 'Failed to parse token response',
       responseBody: String(err)
     }))
   )
   ```

#### Step 2.4: Add unit tests for `authenticateFromAuthCodeGrant`

File: `src/tests/unit/tesla-client/tesla-client.test.ts` (same file as Task1 tests)

Add test cases for authorization code grant flow:

1. **HTTP 401 response**: Mock invalid auth code response - verify error contains `message`, `statusCode: 401`, and `responseBody`
2. **HTTP 400 response**: Mock invalid redirect_uri response - verify error fields populated correctly
3. **Request timeout**: Mock timeout during auth code exchange - verify error has `message` and cause chain
4. **Malformed response**: Mock200 status with invalid JSON - verify parse error captured with `responseBody`
5. **Successful 200 response**: Verify tokens are parsed and returned correctly

Use Vitest with `@effect/platform/HttpClient` mocking patterns from Effect testing docs.

## Testing Plan

### UnitTests

**Test file location**: `src/tests/unit/tesla-client/tesla-client.test.ts`

Tests are implemented alongside each task:
- **Task 1 comprehensive suite**: Tests for `refreshAccessTokenFromTesla` covering timeout scenarios and HTTP error responses (see Step 1.4)
- **Task 2 comprehensive suite**: Tests for `authenticateFromAuthCodeGrant` covering timeout, HTTP errors, malformed responses, and happy path (see Step 2.4)

**Key test categories:**
- Timeout scenarios (cause chain preservation, missing statusCode/responseBody)
- HTTP error scenarios (401, 400, 429, 500 status codes with response bodies)
- Response body read failures (graceful degradation)
- Malformed JSON responses (schema validation errors)
- Happy path (successful token retrieval)

### Integration Tests

No integration tests needed for this change (unit tests with mocked HTTP responses suffice).

### Manual Testing

1. Run with intentionally invalid/expired refresh token
2. Verify error log shows status code and response body
3. Confirm error message is clear and actionable

## Verification Checklist

Before signaling `TASK_COMPLETE`, verify:

- [ ] Timeout tests pass: verify cause chain preserved in error
- [ ] HTTP error tests pass: verify statusCode and responseBody captured
- [ ] Manual test with invalid/expired token shows enhanced error message
- [ ] Manual test with network timeout shows timeout error with cause chain

**Note**: CI checks (build, lint, test) are run automatically by ralph-auto.sh. Do not run them manually.

## Rollback Plan

1. Revert error class in `src/tesla-client/errors.ts`:
   ```typescript
   export class UnableToFetchAccessTokenError extends Data.TaggedError("UnableToFetchAccessToken") {}
   ```

2. Revert timeout handler in `src/tesla-client/index.ts`:
   ```typescript
   Effect.catchTag('TimeoutException', () => Effect.fail(new UnableToFetchAccessTokenError()))
   ```

3. Revert HTTP error handlers in `src/tesla-client/index.ts`:
   ```typescript
   if (response.status !== 200) {
     return yield* new UnableToFetchAccessTokenError();
   }
   ```

4. Remove error handling added to `authenticateFromAuthCodeGrant`

## Future Considerations (Optional)

- Structured logging integration to capture errors in monitoring systems
- Rate limiting awareness (retry on 429 with backoff)
- Token expiration tracking with proactive refresh

## References

- Tesla Fleet API OAuth: https://developer.tesla.com/docs/fleet-api#authentication
- Effect TS Error Handling: `~/.local/share/effect-solutions/effect`
- Vitest Mocking: https://vitest.dev/guide/mocking.html

## Spec Readiness Checklist

Before running ralph-auto.sh, verify:

- [x] All requirements are clearly defined (no unanswered questions)
- [x] All tasks are actionable and appropriately sized (1-4 hours each)
- [x] Implementation details are specific enough to execute
- [x] Testing plan covers happy path and error cases
- [x] Verification steps are concrete and testable
- [x] Rollback plan exists