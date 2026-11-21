import { Effect, Layer } from "effect";
import {
  SolarForecast,
  type SolarForecastNotAvailableError,
  type SolarForecastResult
} from "../../solar-forecast/types.js";

export const makeSolarForecastTest = (
  getForecast: Effect.Effect<SolarForecastResult, SolarForecastNotAvailableError>
): Layer.Layer<SolarForecast> => Layer.succeed(SolarForecast, { getForecast: () => getForecast });
