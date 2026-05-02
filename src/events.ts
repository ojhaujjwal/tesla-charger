export type TeslaChargerEvent =
  | { readonly _tag: "ChargingStarted" }
  | { readonly _tag: "ChargingStopped" }
  | { readonly _tag: "AmpereChangeInitiated"; readonly previous: number; readonly current: number }
  | { readonly _tag: "AmpereChangeFinished"; readonly current: number };
