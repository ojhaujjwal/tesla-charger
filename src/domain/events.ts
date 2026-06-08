import { Context, PubSub } from "effect";
import type { Ampere } from "./brands.js";
import type { SessionSummary } from "./session-summary.js";

export type TeslaChargerEvent =
  | { readonly _tag: "ChargingStarted" }
  | { readonly _tag: "ChargingStopped" }
  | { readonly _tag: "AmpereChangeInitiated"; readonly previous: Ampere; readonly current: Ampere }
  | { readonly _tag: "AmpereChangeFinished"; readonly current: Ampere }
  | { readonly _tag: "SessionEnded"; readonly summary: SessionSummary };

export class TeslaChargerEventPubSub extends Context.Service<
  TeslaChargerEventPubSub,
  PubSub.PubSub<TeslaChargerEvent>
>()("@tesla-charger/Domain/TeslaChargerEventPubSub") {}
