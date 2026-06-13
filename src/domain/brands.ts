import { Brand, Schema } from "effect";

export type Ampere = Brand.Branded<number, "Ampere">;

export const Ampere = Brand.check<Ampere>(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 32 }));

export const minAmpere = 0;
export const maxAmpere = 32;

// Ensures the ampere value is within the allowed range
// and constructs an Ampere brand type
export const clampAmpere = (n: number): Ampere => Ampere(Math.max(minAmpere, Math.min(maxAmpere, Math.round(n))));

export const AmpereFromString = Schema.fromBrand("Ampere", Ampere)(Schema.Int);

// ---- KiloWattHours ----
export type KiloWattHours = Brand.Branded<number, "KiloWattHours">;
export const KiloWattHours = Brand.check<KiloWattHours>(Schema.isGreaterThanOrEqualTo(0));
export const KiloWattHoursFromNumber = Schema.fromBrand("KiloWattHours", KiloWattHours)(Schema.Number);
export const KiloWattHoursFromString = Schema.fromBrand("KiloWattHours", KiloWattHours)(Schema.NumberFromString);

// ---- StateOfCharge ----
export type StateOfCharge = Brand.Branded<number, "StateOfCharge">;
export const StateOfCharge = Brand.check<StateOfCharge>(Schema.isBetween({ minimum: 0, maximum: 100 }));
export const StateOfChargeFromNumber = Schema.fromBrand("StateOfCharge", StateOfCharge)(Schema.Number);

// ---- Voltage ----
export type Voltage = Brand.Branded<number, "Voltage">;
export const Voltage = Brand.check<Voltage>(Schema.isBetween({ minimum: 200, maximum: 260 }));

// ---- HourOfDay ----
export type HourOfDay = Brand.Branded<number, "HourOfDay">;
export const HourOfDay = Brand.check<HourOfDay>(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 23 }));
export const HourOfDayFromString = Schema.fromBrand("HourOfDay", HourOfDay)(Schema.Int);

// ---- Watt ----
export type Watt = Brand.Branded<number, "Watt">;
export const Watt = Brand.check<Watt>(Schema.isGreaterThanOrEqualTo(0));
export const WattFromString = Schema.fromBrand("Watt", Watt)(Schema.NumberFromString);

// ---- Latitude ----
export type Latitude = Brand.Branded<number, "Latitude">;
export const Latitude = Brand.check<Latitude>(Schema.isBetween({ minimum: -90, maximum: 90 }));
export const LatitudeFromString = Schema.fromBrand("Latitude", Latitude)(Schema.NumberFromString);

// ---- Longitude ----
export type Longitude = Brand.Branded<number, "Longitude">;
export const Longitude = Brand.check<Longitude>(Schema.isBetween({ minimum: -180, maximum: 180 }));
export const LongitudeFromString = Schema.fromBrand("Longitude", Longitude)(Schema.NumberFromString);
