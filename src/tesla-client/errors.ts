import type { PlatformError } from '@effect/platform/Error';
import type { ParseError } from 'effect/ParseResult';
import type { HttpClientError } from '@effect/platform/HttpClientError';
import { Data } from "effect";

export class VehicleAsleepError extends Data.TaggedError('VehicleAsleepError') {
  public override message = 'Vehicle is asleep';
}

// Internal retryable error (not exposed externally)
export class ContextDeadlineExceededError extends Data.TaggedError("ContextDeadlineExceeded") {}

export class UnableToFetchAccessTokenError extends Data.TaggedError("UnableToFetchAccessToken") {}

export class AuthenticationFailedError extends Data.TaggedError("AuthenticationFailedError")<{
  previous: HttpClientError | PlatformError | UnableToFetchAccessTokenError | ParseError,
}> {}

export class VehicleCommandFailedError extends Data.TaggedError("VehicleCommandFailed")<{
  message: string;
  stderr?: string;
}> {}
