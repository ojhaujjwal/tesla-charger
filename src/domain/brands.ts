import { Brand, Schema } from "effect";

export type Ampere = Brand.Branded<number, "Ampere">;

export const Ampere = Brand.check<Ampere>(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 32 }));

export const minAmpere = 0;
export const maxAmpere = 32;

// Ensures the ampere value is within the allowed range
// and constructs an Ampere brand type
export const clampAmpere = (n: number): Ampere => Ampere(Math.max(minAmpere, Math.min(maxAmpere, Math.round(n))));

export const AmpereFromString = Schema.fromBrand("Ampere", Ampere)(Schema.Int);
