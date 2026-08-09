import { Context, Effect, Layer, LogLevel, Option, Queue, Ref, Tracer } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { FileSystem } from "effect/FileSystem";
import { Path } from "effect/Path";
import { makeTracer, toJsonSpan, utcDayFromNanos } from "./tracer.js";

export class JsonlTraceControl extends Context.Service<
  JsonlTraceControl,
  {
    readonly flush: () => Effect.Effect<void>;
  }
>()("JsonlTraceControl") {}

class ExporterHandle extends Context.Service<
  ExporterHandle,
  {
    readonly tracer: Tracer.Tracer;
    readonly flush: () => Effect.Effect<void>;
  }
>()("ExporterHandle") {}

const appendSpan =
  (fs: FileSystem, path: Path, directory: string) =>
  (span: Tracer.NativeSpan): Effect.Effect<void, PlatformError> => {
    const record = toJsonSpan(span);
    const day = utcDayFromNanos(BigInt(record.endTimeUnixNano));
    return fs.writeFileString(path.join(directory, `trace-${day}.jsonl`), JSON.stringify(record) + "\n", {
      flag: "a"
    });
  };

type Append = (span: Tracer.NativeSpan) => Effect.Effect<void, PlatformError>;

const writeSafely = (append: Append, span: Tracer.NativeSpan) =>
  append(span).pipe(Effect.catchCause((cause) => Effect.logError("JSONL trace writer failed", cause)));

const buildExporter = (options: {
  readonly directory: string;
  readonly minimumTraceLevel?: LogLevel.LogLevel | undefined;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const path = yield* Path;
    yield* fs.makeDirectory(options.directory, { recursive: true }).pipe(Effect.orDie);
    const queue = yield* Queue.unbounded<Tracer.NativeSpan>();
    const inflight = yield* Ref.make(0);
    const append = appendSpan(fs, path, options.directory);

    const consume = (span: Tracer.NativeSpan) =>
      Ref.update(inflight, (n) => n + 1).pipe(
        Effect.flatMap(() => writeSafely(append, span)),
        Effect.ensuring(Ref.update(inflight, (n) => n - 1))
      );

    yield* Effect.forkScoped(Queue.take(queue).pipe(Effect.flatMap(consume), Effect.forever));

    const drainRemaining: () => Effect.Effect<void> = () =>
      Effect.gen(function* () {
        const span = yield* Queue.poll(queue);
        if (Option.isNone(span)) {
          return;
        }
        yield* consume(span.value);
        yield* drainRemaining();
      });

    const waitIdle: () => Effect.Effect<void> = () =>
      Effect.gen(function* () {
        const pending = yield* Ref.get(inflight);
        if (pending === 0) {
          return;
        }
        yield* Effect.sleep("100 millis");
        yield* waitIdle();
      });

    const flush: () => Effect.Effect<void> = () =>
      drainRemaining().pipe(
        Effect.flatMap(() => waitIdle()),
        Effect.catchCause((cause) => Effect.logError("Failed to flush JSONL trace file", cause))
      );

    yield* Effect.addFinalizer(flush);

    return {
      tracer: makeTracer((span) => Queue.offerUnsafe(queue, span)),
      flush
    };
  });

export const layer = (options: {
  readonly directory: string;
  readonly minimumTraceLevel?: LogLevel.LogLevel | undefined;
}) =>
  Layer.merge(
    Layer.sync(Tracer.MinimumTraceLevel, () => options.minimumTraceLevel ?? "All"),
    Layer.effect(ExporterHandle, buildExporter(options)).pipe(
      Layer.flatMap((context) => {
        const handle = Context.get(context, ExporterHandle);
        return Layer.merge(
          Layer.succeed(Tracer.Tracer, handle.tracer),
          Layer.succeed(JsonlTraceControl, { flush: handle.flush })
        );
      })
    )
  );
