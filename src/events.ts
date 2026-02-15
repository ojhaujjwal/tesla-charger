export type BatteryEvent =
  | { readonly _tag: 'AmpereChanged'; readonly previous: number; readonly current: number };

export type TeslaChargerEvent = BatteryEvent;
