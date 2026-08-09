import { describe, expect, it, layer } from "@effect/vitest";
import { Context, Effect, Exit, FileSystem, Layer, Option, Tracer } from "effect";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { JsonlTraceControl, layer as jsonlTraceExporterLayer } from "../../../tracing/jsonl-trace-exporter.js";
import { isoFromNanos, toJsonSpan, utcDayFromNanos, type TraceSpanJson } from "../../../tracing/tracer.js";

const makeSpan = (options: {
  readonly name: string;
  readonly parent: Option.Option<Tracer.AnySpan>;
  readonly startTime: bigint;
  readonly kind: Tracer.SpanKind;
  readonly sampled?: boolean | undefined;
}): Tracer.NativeSpan =>
  new Tracer.NativeSpan({
    name: options.name,
    parent: options.parent,
    annotations: Context.empty(),
    links: [],
    startTime: options.startTime,
    kind: options.kind,
    sampled: options.sampled ?? true
  });

class TraceDirectory extends Context.Service<TraceDirectory, string>()("TraceDirectory") {}

const traceDirectoryLayer = Layer.effect(
  TraceDirectory,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.makeTempDirectoryScoped({ prefix: "jsonl-trace" }).pipe(Effect.orDie);
  })
);

const exporterLayer = traceDirectoryLayer.pipe(
  Layer.flatMap((context) => {
    const directory = Context.get(context, TraceDirectory);
    return jsonlTraceExporterLayer({ directory, minimumTraceLevel: "All" });
  })
);

const testLayers = Layer.mergeAll(traceDirectoryLayer, exporterLayer).pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))
);

describe("JSONL trace exporter", () => {
  it("derives UTC timestamps and day keys from nanos without using Date", () => {
    expect(isoFromNanos(0n)).toBe("1970-01-01T00:00:00.000Z");
    expect(isoFromNanos(1_700_000_000_000_000_000n)).toBe("2023-11-14T22:13:20.000Z");
    expect(utcDayFromNanos(1_700_000_000_000_000_000n)).toBe("2023-11-14");
  });

  it("serializes a successful span", () => {
    const span = makeSpan({
      name: "db.query",
      parent: Option.none(),
      startTime: 1_000n,
      kind: "client"
    });
    span.attribute("db.system", "postgres");
    span.attribute("db.rows", 42);
    span.end(3_000n, Exit.succeed("ok"));

    const json = toJsonSpan(span);
    expect(json.traceId).toHaveLength(32);
    expect(json.spanId).toHaveLength(16);
    expect(json.parentSpanId).toBeUndefined();
    expect(json.name).toBe("db.query");
    expect(json.kind).toBe("client");
    expect(json.startTimeUnixNano).toBe("1000");
    expect(json.endTimeUnixNano).toBe("3000");
    expect(json.durationMs).toBe(0.002);
    expect(json.attributes).toEqual({ "db.system": "postgres", "db.rows": 42 });
    expect(json.status).toEqual({ code: "OK" });
    expect(json.events).toEqual([]);
  });

  it("generates pure hex ids via Effect's NativeSpan", () => {
    const span = makeSpan({
      name: "hex.ids",
      parent: Option.none(),
      startTime: 0n,
      kind: "internal"
    });
    span.end(1_000n, Exit.succeed("ok"));

    const json = toJsonSpan(span);
    expect(json.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(json.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(json.spanId).not.toContain("undefined");
    expect(json.traceId).not.toContain("undefined");
  });

  it("inherits traceId and parentSpanId from the parent span", () => {
    const parent = makeSpan({
      name: "parent",
      parent: Option.none(),
      startTime: 0n,
      kind: "server"
    });
    const child = makeSpan({
      name: "child",
      parent: Option.some(parent),
      startTime: 1_000n,
      kind: "internal"
    });
    child.end(2_000n, Exit.succeed("ok"));

    const json = toJsonSpan(child);
    expect(json.traceId).toBe(parent.traceId);
    expect(json.parentSpanId).toBe(parent.spanId);
  });

  it("reports errors with exception events", () => {
    const span = makeSpan({
      name: "failing",
      parent: Option.none(),
      startTime: 0n,
      kind: "internal"
    });
    const cause = new Error("boom");
    span.end(1_000n, Exit.fail(cause));

    const json = toJsonSpan(span);
    expect(json.status.code).toBe("ERROR");
    expect(json.status.message).toBe("boom");
    expect(json.events).toHaveLength(1);
    expect(json.events[0]).toMatchObject({
      name: "exception",
      timeUnixNano: "1000",
      attributes: {
        "exception.type": "Error",
        "exception.message": "boom"
      }
    });
  });

  it("marks interrupted spans", () => {
    const span = makeSpan({
      name: "cancelled",
      parent: Option.none(),
      startTime: 0n,
      kind: "internal"
    });
    span.end(1_000n, Exit.interrupt());

    expect(toJsonSpan(span).status.code).toBe("INTERRUPTED");
  });
});

layer(testLayers)((it) => {
  it.effect("writes one JSON line per sampled span to a daily file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* TraceDirectory;
      const control = yield* JsonlTraceControl;

      yield* Effect.log("hello world").pipe(Effect.withSpan("nested.emit"));
      yield* control.flush();

      const files = yield* fs.readDirectory(directory);
      const jsonlFile = files.find((f) => f.startsWith("trace-") && f.endsWith(".jsonl"));
      expect(jsonlFile).toBeDefined();

      const raw = yield* fs.readFileString(`${directory}/${jsonlFile}`, "utf-8");
      const lines = raw.trim().split("\n");
      expect(lines.length).toBe(1);
      const line = lines[0];
      if (line === undefined) {
        throw new Error("expected trace file content");
      }
      const parsed: TraceSpanJson = JSON.parse(line);
      expect(parsed.name).toBe("nested.emit");
      expect(parsed.status.code).toBe("OK");
      expect(parsed.startTime).toMatch(/T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(parsed.endTime).toMatch(/T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    })
  );
});
