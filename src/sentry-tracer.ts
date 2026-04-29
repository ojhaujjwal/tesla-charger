import type { Span, SpanAttributeValue, SpanAttributes } from "@sentry/core";
import { SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN, startInactiveSpan, withActiveSpan } from "@sentry/core";
import type * as Context from "effect/Context";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as EffectTracer from "effect/Tracer";

function isSpanAttributeValue(value: unknown): value is SpanAttributeValue {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) {
    return value.every(
      (item) =>
        item === null ||
        item === undefined ||
        typeof item === "string" ||
        typeof item === "number" ||
        typeof item === "boolean"
    );
  }
  return false;
}

function isSpanAttributes(value: Record<string, unknown>): value is SpanAttributes {
  return Object.values(value).every((v) => v === undefined || isSpanAttributeValue(v));
}

function deriveOrigin(name: string): string {
  if (name.startsWith("http.server") || name.startsWith("http.client")) {
    return "auto.http.effect";
  }
  return "auto.function.effect";
}

type HrTime = [number, number];

const SENTRY_SPAN_SYMBOL = Symbol.for("@sentry/effect.SentrySpan");

function nanosToHrTime(nanos: bigint): HrTime {
  const seconds = Number(nanos / BigInt(1_000_000_000));
  const remainingNanos = Number(nanos % BigInt(1_000_000_000));
  return [seconds, remainingNanos];
}

type SentrySpanLike = {
  readonly [SENTRY_SPAN_SYMBOL]: true;
  readonly sentrySpan: Span;
} & EffectTracer.Span;

function isSentrySpan(span: EffectTracer.AnySpan): span is SentrySpanLike {
  return SENTRY_SPAN_SYMBOL in span;
}

class SentrySpanWrapper implements SentrySpanLike {
  public readonly [SENTRY_SPAN_SYMBOL] = true as const;
  public readonly _tag = "Span" as const;
  public readonly spanId: string;
  public readonly traceId: string;
  public readonly attributes: Map<string, unknown>;
  public readonly sampled: boolean;
  public readonly parent: Option.Option<EffectTracer.AnySpan>;
  public readonly links: EffectTracer.SpanLink[];
  public status: EffectTracer.SpanStatus;
  public readonly sentrySpan: Span;

  public constructor(
    public readonly name: string,
    parent: Option.Option<EffectTracer.AnySpan>,
    public readonly context: Context.Context<never>,
    links: readonly EffectTracer.SpanLink[],
    startTime: bigint,
    public readonly kind: EffectTracer.SpanKind,
    sentrySpan: Span
  ) {
    this.attributes = new Map<string, unknown>();
    this.parent = parent;
    this.links = [...links];
    this.sentrySpan = sentrySpan;

    const spanContext = this.sentrySpan.spanContext();
    this.spanId = spanContext.spanId;
    this.traceId = spanContext.traceId;
    this.sampled = this.sentrySpan.isRecording();
    this.status = { _tag: "Started", startTime };
  }

  public attribute(key: string, value: unknown): void {
    if (!this.sentrySpan.isRecording()) return;
    if (value === undefined || isSpanAttributeValue(value)) {
      this.sentrySpan.setAttribute(key, value);
    }
    this.attributes.set(key, value);
  }

  public addLinks(links: readonly EffectTracer.SpanLink[]): void {
    this.links.push(...links);
  }

  public end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    this.status = { _tag: "Ended", endTime, exit, startTime: this.status.startTime };
    if (!this.sentrySpan.isRecording()) return;

    if (Exit.isFailure(exit)) {
      const cause = exit.cause;
      const message =
        cause._tag === "Fail" ? String(cause.error) : cause._tag === "Die" ? String(cause.defect) : "internal_error";
      this.sentrySpan.setStatus({ code: 2, message });
    } else {
      this.sentrySpan.setStatus({ code: 1 });
    }
    this.sentrySpan.end(nanosToHrTime(endTime));
  }

  public event(name: string, startTime: bigint, attributes?: Record<string, unknown>): void {
    if (!this.sentrySpan.isRecording()) return;
    if (attributes && isSpanAttributes(attributes)) {
      this.sentrySpan.addEvent(name, attributes, nanosToHrTime(startTime));
    } else {
      this.sentrySpan.addEvent(name, nanosToHrTime(startTime));
    }
  }
}

function createSentrySpan(
  name: string,
  parent: Option.Option<EffectTracer.AnySpan>,
  context: Context.Context<never>,
  links: readonly EffectTracer.SpanLink[],
  startTime: bigint,
  kind: EffectTracer.SpanKind
): SentrySpanLike {
  let parentSentrySpan: Span | null = null;

  if (Option.isSome(parent) && isSentrySpan(parent.value)) {
    parentSentrySpan = parent.value.sentrySpan;
  }

  const newSpan = startInactiveSpan({
    name,
    startTime: nanosToHrTime(startTime),
    attributes: {
      [SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN]: deriveOrigin(name)
    },
    ...(parentSentrySpan ? { parentSpan: parentSentrySpan } : {})
  });

  return new SentrySpanWrapper(name, parent, context, links, startTime, kind, newSpan);
}

export const CustomSentryTracer: EffectTracer.Tracer = EffectTracer.make({
  span(name, parent, context, links, startTime, kind) {
    return createSentrySpan(name, parent, context, links, startTime, kind);
  },
  context(execution, fiber) {
    const currentSpan = fiber.currentSpan;
    if (currentSpan === undefined || !isSentrySpan(currentSpan)) {
      return execution();
    }
    return withActiveSpan(currentSpan.sentrySpan, execution);
  }
});
