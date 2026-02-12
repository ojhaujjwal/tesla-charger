import { AlphaEssCloudApiDataAdapterLayer } from "./data-adapter/alpha-ess-api.data-adapter.js";
import { Layer } from "effect";
import { TeslaClientLayer } from "./tesla-client/index.js";

export const serviceLayers = Layer.mergeAll(
    AlphaEssCloudApiDataAdapterLayer,
);

export const createTeslaClientLayer = (config: {
    readonly appDomain: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly vin: string;
}) => TeslaClientLayer(config);

