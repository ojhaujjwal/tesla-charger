import { AlphaEssCloudApiDataAdapterLayer } from "./data-adapter/alpha-ess-api.data-adapter.js";
import { Effect, Layer } from "effect";
import { TeslaClient, TeslaClientLayer } from "./tesla-client/index.js";
import { ElectricVehicle } from "./domain/electric-vehicle.js";

export const serviceLayers = Layer.mergeAll(AlphaEssCloudApiDataAdapterLayer);

export const createTeslaClientLayer = (config: {
  readonly appDomain: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly vin: string;
}) => {
  const base = TeslaClientLayer(config);
  const ev = Layer.effect(
    ElectricVehicle,
    Effect.map(TeslaClient, (client): ElectricVehicle["Type"] => client)
  );
  return Layer.mergeAll(base, ev.pipe(Layer.provide(base)));
};
