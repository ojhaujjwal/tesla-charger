import { Effect, Schema } from "effect";
import { HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";

export class HealthGroup extends HttpApiGroup.make("health", { topLevel: true })
  .add(
    HttpApiEndpoint.get("healthz", "/healthz", {
      success: Schema.String
    })
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "Health",
      description: "Liveness check endpoint"
    })
  ) {}

export const HealthHandlers = Effect.fn("HealthHandlers")(function* (
  handlers: HttpApiBuilder.Handlers.FromGroup<typeof HealthGroup>
) {
  yield* Effect.void;
  return handlers.handle("healthz", () => Effect.succeed("ok"));
});
