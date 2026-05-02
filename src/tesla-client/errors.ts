export { VehicleAsleepError, VehicleCommandFailedError, ChargeStateQueryFailedError } from "../domain/errors.js";

import type { PlatformError } from "@effect/platform/Error";
import type { ParseError } from "effect/ParseResult";
import type { HttpClientError } from "@effect/platform/HttpClientError";
import { Data } from "effect";

// Internal retryable error (not exposed externally)
export class ContextDeadlineExceededError extends Data.TaggedError("ContextDeadlineExceeded") {}

export class UnableToFetchAccessTokenError extends Data.TaggedError("UnableToFetchAccessToken")<{
  message: string;
  statusCode?: number;
  responseBody?: string;
  cause?: unknown;
}> {}

export class AuthenticationFailedError extends Data.TaggedError("AuthenticationFailedError")<{
  cause: HttpClientError | PlatformError | UnableToFetchAccessTokenError | ParseError;
}> {}
