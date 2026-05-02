# Testing with effect

Run `effect-solutions show testing` to get all testing guides.

## Replacing `beforeEach` / `afterEach`

Use `it.scoped()` and `Effect.addFinalizer()` to manage per-test setup and teardown. Each test gets its own scope, and finalizers run automatically when the test ends.

```ts
import { it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { NodeFileSystem } from "@effect/platform-node";

const withTestDir = <A, E, R>(f: (tmpDir: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tmpDir = `/tmp/my-test-${Date.now()}`;
    yield* fs.makeDirectory(tmpDir, { recursive: true });
    yield* Effect.addFinalizer(() =>
      fs.exists(tmpDir).pipe(
        Effect.flatMap((exists) => exists ? fs.remove(tmpDir, { recursive: true }) : Effect.void),
        Effect.catchAll(() => Effect.void)
      )
    );
    return yield* f(tmpDir);
  });

it.scoped("uses isolated temp directory", () =>
  withTestDir((tmpDir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(`${tmpDir}/data.txt`, "hello");
    })
  ).pipe(Effect.provide(NodeFileSystem.layer))
);
```

## Replacing `beforeAll` / `afterAll`

Use `layer()` to build shared resources once for a group of tests and tear them down after the last test finishes.

```ts
import { describe, layer, expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";

class Database extends Context.Tag("Database")<
  Database,
  { readonly query: (sql: string) => Effect.Effect<Array<unknown>> }
>() {
  static Live = Layer.sync(Database, () => ({
    query: (_sql) => Effect.succeed(["row1", "row2"])
  }));
}

class Users extends Context.Tag("Users")<
  Users,
  { readonly findById: (id: string) => Effect.Effect<{ id: string; name: string }> }
>() {
  static Live = Layer.effect(
    Users,
    Effect.gen(function* () {
      const db = yield* Database;
      return {
        findById: (id: string) =>
          db.query(`SELECT * FROM users WHERE id = ${id}`).pipe(
            Effect.map((rows) => ({ id, name: String(rows[0]) }))
          )
      };
    })
  );
}

describe("Users", () => {
  layer(Database.Live)((it) => {
    it.effect("finds a user", () =>
      Effect.gen(function* () {
        const users = yield* Users;
        const user = yield* users.findById("123");
        expect(user.id).toBe("123");
      }).pipe(Effect.provide(Users.Live))
    );

    it.effect("finds another user", () =>
      Effect.gen(function* () {
        const users = yield* Users;
        const user = yield* users.findById("456");
        expect(user.id).toBe("456");
      }).pipe(Effect.provide(Users.Live))
    );
  });
});
```
