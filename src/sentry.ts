import { Cause, Config, Effect, Layer, Logger } from "effect";
import * as Sentry from "@sentry/effect/server";
import * as SentryCore from "@sentry/core";
import { getDefaultCurrentScope, getDefaultIsolationScope } from "@sentry/core";
import { CustomSentryTracer } from "./sentry-tracer.js";

// Initialize Sentry BEFORE building Effect layers
// This ensures the client is available in the Node.js AsyncLocalStorage context
export function initSentry(): void {
  const sentryDsn = Effect.runSync(Config.string("SENTRY_DSN").pipe(Effect.catchAll(() => Effect.succeed(""))));
  const nodeEnv = Effect.runSync(Config.string("NODE_ENV").pipe(Config.withDefault("production")));

  const sentryClient = Sentry.init({
    dsn: sentryDsn || undefined,
    tracesSampleRate: 1.0,
    enableLogs: true,
    debug: nodeEnv !== "production"
  });

  // CRITICAL: Effect fibers don't inherit Node.js AsyncLocalStorage context.
  // When Sentry's tracer runs in an Effect fiber, getCurrentScope() returns
  // default scopes (via fallback) which don't have the client set.
  // We must set the client on the default scopes so they're available everywhere.
  if (sentryClient) {
    getDefaultCurrentScope().setClient(sentryClient);
    getDefaultIsolationScope().setClient(sentryClient);
  }
}

// Combined logger that logs to both console and Sentry
const CombinedLogger = Logger.zip(Logger.prettyLoggerDefault, Sentry.SentryEffectLogger);

// Sentry Layer for Effect
export const SentryLive = Layer.mergeAll(
  Layer.empty, // Sentry already initialized above
  Layer.setTracer(CustomSentryTracer),
  Logger.replace(Logger.defaultLogger, CombinedLogger)
);

class SentryFlushFailedError extends Cause.RuntimeException {}

class SentryFlushTimeoutError extends Cause.RuntimeException {}

// Periodic flush fiber
export const SentryFlushFiber = Effect.gen(function* () {
  while (true) {
    yield* Effect.sleep(10000);
    yield* Effect.tryPromise({
      try: () => SentryCore.flush(5000),
      catch: (e) => new SentryFlushFailedError(`Sentry flush failed: ${e}`)
    });
  }
});

// Helper to flush Sentry before shutdown
export const flushSentry = () =>
  Effect.tryPromise({
    try: () => SentryCore.flush(5000),
    catch: (e) => new SentryFlushTimeoutError(`Sentry flush timed out: ${e}`)
  });

// Helper to capture exceptions in Effect
export const captureException = (error: unknown) => Effect.sync(() => SentryCore.captureException(error));
