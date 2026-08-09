import { Cause, Layer, LogLevel, Option, Tracer } from "effect";

export type TraceStatusCode = "OK" | "ERROR" | "INTERRUPTED";

export interface TraceEventJson {
  readonly name: string;
  readonly timeUnixNano: string;
  readonly time: string;
  readonly attributes?: Record<string, unknown>;
}

export interface TraceStatusJson {
  readonly code: TraceStatusCode;
  readonly message?: string;
}

export interface TraceSpanJson {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  readonly name: string;
  readonly kind: Tracer.SpanKind;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly durationMs: number;
  readonly attributes: Record<string, unknown>;
  readonly events: ReadonlyArray<TraceEventJson>;
  readonly status: TraceStatusJson;
}

const DAY_MS = 86_400_000;

const nsToMs = (nanos: bigint): number => Number(nanos / 1_000_000n);

const pad2 = (n: number): string => String(n).padStart(2, "0");

const civilParts = (epochMs: number) => {
  const days = Math.floor(epochMs / DAY_MS);
  const msOfDay = epochMs - days * DAY_MS;
  const hour = Math.floor(msOfDay / 3_600_000);
  const minute = Math.floor((msOfDay % 3_600_000) / 60_000);
  const second = Math.floor((msOfDay % 60_000) / 1_000);
  const ms = msOfDay % 1_000;
  const [year, month, day] = civilFromDays(days);
  return { year, month, day, hour, minute, second, ms };
};

const civilFromDays = (days: number): readonly [year: number, month: number, day: number] => {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1_460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const year0 = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = year0 + (month <= 2 ? 1 : 0);
  return [year, month, day] as const;
};

export const utcDayFromNanos = (nanos: bigint): string => {
  const { year, month, day } = civilParts(nsToMs(nanos));
  return `${year}-${pad2(month)}-${pad2(day)}`;
};

export const isoFromNanos = (nanos: bigint): string => {
  const { year, month, day, hour, minute, second, ms } = civilParts(nsToMs(nanos));
  return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}.${String(ms).padStart(3, "0")}Z`;
};

export const toJsonSpan = (span: Tracer.NativeSpan): TraceSpanJson => {
  if (span.status._tag !== "Ended") {
    throw new Error("cannot serialize a span that has not ended");
  }
  const status = span.status;
  const events: Array<TraceEventJson> = span.events.map(([name, timeNanos, attributes]) => ({
    name,
    timeUnixNano: String(timeNanos),
    time: isoFromNanos(timeNanos),
    ...(attributes ? { attributes } : {})
  }));
  let code: TraceStatusCode = "OK";
  let message: string | undefined;
  if (status.exit._tag === "Failure") {
    if (Cause.hasInterruptsOnly(status.exit.cause)) {
      code = "INTERRUPTED";
    } else {
      code = "ERROR";
      const errors = Cause.prettyErrors(status.exit.cause);
      if (errors.length > 0) {
        message = errors[0].message;
        for (const error of errors) {
          events.push({
            name: "exception",
            timeUnixNano: String(status.endTime),
            time: isoFromNanos(status.endTime),
            attributes: {
              "exception.type": error.name,
              "exception.message": error.message,
              "exception.stacktrace": error.stack ?? "No stack trace available"
            }
          });
        }
      }
    }
  }
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: Option.isSome(span.parent) ? span.parent.value.spanId : undefined,
    name: span.name,
    kind: span.kind,
    startTimeUnixNano: String(status.startTime),
    endTimeUnixNano: String(status.endTime),
    startTime: isoFromNanos(status.startTime),
    endTime: isoFromNanos(status.endTime),
    durationMs: Number(status.endTime - status.startTime) / 1_000_000,
    attributes: Object.fromEntries(span.attributes),
    events,
    status: { code, ...(message ? { message } : {}) }
  };
};

export type SpanSink = (span: Tracer.NativeSpan) => void;

export const makeTracer = (onSpan: SpanSink): Tracer.Tracer =>
  Tracer.make({
    span(spanOptions) {
      const span = new Tracer.NativeSpan({
        name: spanOptions.name,
        parent: spanOptions.parent,
        annotations: spanOptions.annotations,
        links: spanOptions.links,
        startTime: spanOptions.startTime,
        kind: spanOptions.kind,
        sampled: spanOptions.sampled
      });
      const originalEnd = span.end.bind(span);
      span.end = (endTime, exit) => {
        originalEnd(endTime, exit);
        if (span.sampled) {
          onSpan(span);
        }
      };
      return span;
    }
  });

export const tracerLayer = (options: {
  readonly minimumTraceLevel?: LogLevel.LogLevel | undefined;
  readonly onSpan: SpanSink;
}): Layer.Layer<never, never, never> =>
  Layer.merge(
    Layer.sync(Tracer.MinimumTraceLevel, () => options.minimumTraceLevel ?? "All"),
    Layer.succeed(Tracer.Tracer, makeTracer(options.onSpan))
  );
