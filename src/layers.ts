import { SunGatherInfluxDbDataAdapterLayer } from "./data-adapter/influx-db-sungather.data-adapter.js";
import { Layer } from "effect";

export const serviceLayers = Layer.mergeAll(
    SunGatherInfluxDbDataAdapterLayer
);

