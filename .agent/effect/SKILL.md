# Effect Best Practices for Antigravity

This skill defines the patterns and best practices for writing Effect TypeScript code in this repository. Use these guidelines to ensure consistency and leverage the full power of the Effect framework.

## Core Patterns

### 1. Services and Layers (Dependency Injection)
Always use the `Context.Tag` and `Layer` pattern for services. Avoid manual class instantiation in the business logic.

- **Tag Definition**: Use `Context.GenericTag<Interface>("@tesla-charger/ServiceName")`.
- **Layer Implementation**: Use `Layer.effect`, `Layer.sync`, or `Layer.succeed`.
- **Accessing Services**: Use `yield* Tag` within `Effect.gen`.

```typescript
// Example Service
export interface MyService {
  readonly doSomething: () => Effect.Effect<void, MyError>;
}
export const MyService = Context.GenericTag<MyService>("@tesla-charger/MyService");

// Example Layer
export const MyServiceLive = Layer.effect(
  MyService,
  Effect.gen(function*() {
    // Inject dependencies
    const other = yield* OtherService;
    return {
      doSomething: () => Effect.log("Doing something...")
    };
  })
);
```

### 2. The Entry Point
Use `NodeRuntime.runMain` to execute the top-level effect. Compose all required layers using `Effect.provide`.

```typescript
const program = Effect.gen(function*() {
  const app = yield* App;
  yield* app.run();
}).pipe(
  Effect.provide(AppLive),
  Effect.provide(MainLayers),
  Effect.scopedOrDie // Finalizers and survivors
);

NodeRuntime.runMain(program);
```

### 3. Error Handling
- Use `Effect.fail` for expected errors (Domain Errors).
- Create custom classes/objects for errors with a `_tag` for pattern matching.
- Use `Effect.catchTag` or `Effect.catchTags` to handle specific errors.
- Use `Effect.die` for truly exceptional, unrecoverable states (bugs).

### 4. Data Modeling
- Use `effect/Schema` (formerly `@effect/schema`) for all data validation and parsing.
- Lean on `Schema.decodeUnknown` for external data (API responses, file system).

## Tools

### Effect Solutions CLI
Before implementing new patterns, consult the `effect-solutions` CLI:
- `effect-solutions list`: See available guides.
- `effect-solutions show <topic>`: Show specific patterns (e.g., `services-and-layers`, `testing`).

### Local Effect Reference
The Effect source code is available for reference at `~/.local/share/effect-solutions/effect`. Use it to explore real-world implementation details and type definitions.

---

## checklist
- [ ] Align with `Context.Tag` and `Layer` patterns
- [ ] Use `Effect.gen` for complex logic
- [ ] Handle errors explicitly with `_tag`
- [ ] Use `effect/Schema` for parsing
- [ ] Provide dependencies at the edge (Main/Test entry points)
