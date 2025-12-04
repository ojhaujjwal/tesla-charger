import { AlphaEssCloudApiDataAdapterLayer } from "./data-adapter/alpha-ess-api.data-adapter.js";
import { Layer } from "effect";

export const serviceLayers = Layer.mergeAll(
    AlphaEssCloudApiDataAdapterLayer,
);

