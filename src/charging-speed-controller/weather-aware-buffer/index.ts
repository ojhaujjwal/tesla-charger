import { DataAdapter } from "../../data-adapter/types.js";
import { ChargingSpeedController, InadequateDataToDetermineSpeedError } from "../types.js";
import { Clock, Effect, Layer } from "effect";
import { SolarForecast } from "../../solar-forecast/types.js";
import { BatteryStateManager } from "../../battery-state-manager.js";
import type { WeatherAwareBufferConfig } from "./types.js";
import { calculateDefaultMonthlyPeakFactors, expectedCapacityKw } from "./solar-calculations.js";
import { periodConfidence } from "./forecast-confidence.js";
import { simulateCharge } from "./charge-simulation.js";

export type { WeatherAwareBufferConfig, SunTimes, SimulationResult } from "./types.js";
export { calculateSunTimes, calculateDefaultMonthlyPeakFactors, expectedCapacityKw } from "./solar-calculations.js";
export { periodConfidence } from "./forecast-confidence.js";
export { simulateCharge } from "./charge-simulation.js";

export const WeatherAwareBufferControllerLayer = (
  config: WeatherAwareBufferConfig
): Layer.Layer<
  ChargingSpeedController,
  never,
  DataAdapter | SolarForecast | BatteryStateManager
> =>
  Layer.effect(
    ChargingSpeedController,
    Effect.gen(function* () {
      const dataAdapter = yield* DataAdapter;
      const solarForecast = yield* SolarForecast;
      const batteryStateManager = yield* BatteryStateManager;

      // Ensure monthlyPeakFactors is set (auto-calculate if not provided)
      const monthlyPeakFactors = config.monthlyPeakFactors ?? calculateDefaultMonthlyPeakFactors(config.latitude);

      // Log monthly peak factors at startup
      yield* Effect.logInfo("Weather-aware buffer controller initialized", {
        monthlyPeakFactors: monthlyPeakFactors,
        peakSolarCapacityKw: config.peakSolarCapacityKw,
        latitude: config.latitude,
      });

      // Cache simulation result (refresh when forecast changes)
      let cachedSimulation: import("./types.js").SimulationResult | undefined;
      let lastForecastHash: string | undefined;

      return {
        determineChargingSpeed: (currentChargingSpeed: number) =>
          Effect.gen(function* () {
            // Get current time from Effect Clock (testable)
            const nowMs = yield* Clock.currentTimeMillis;
            const now = new Date(nowMs);

            // Get forecast
            const forecast = yield* solarForecast.getForecast().pipe(
              Effect.catchAll(() =>
                Effect.succeed({
                  periods: [],
                })
              )
            );

            // Get battery state
            const batteryState = batteryStateManager.get();

            // Run simulation if forecast or battery state changed
            const forecastHash = JSON.stringify(forecast.periods.map((p) => p.period_end));
            const batteryHash = batteryState
              ? `${batteryState.batteryLevel}-${batteryState.chargeLimitSoc}`
              : undefined;
            const currentHash = `${forecastHash}-${batteryHash}`;

            if (currentHash !== lastForecastHash || cachedSimulation === undefined) {
              cachedSimulation = simulateCharge(
                config,
                forecast,
                batteryState,
                now
              );
              lastForecastHash = currentHash;

              // Log shortfall warning if needed
              if (!cachedSimulation.canComplete && cachedSimulation.shortfallKwh > 0) {
                const cutoffHour = config.deadlineHour ?? config.solarCutoffHour;
                yield* Effect.logWarning(
                  `Forecast shows ${cachedSimulation.shortfallKwh.toFixed(1)} kWh shortfall by ${cutoffHour}:00 due to cloud cover. Charging conservatively.`
                );
              }
            }

            const simulation = cachedSimulation;

            // Get current period from forecast
            const currentPeriod = forecast.periods.find((p) => {
              const periodEnd = new Date(p.period_end);
              return periodEnd >= now && periodEnd.getTime() - now.getTime() < 30 * 60 * 1000; // Within next 30 min
            });

            // Calculate dynamic buffer
            let finalBuffer = config.minBufferPower;

            if (currentPeriod) {
              const periodEnd = new Date(currentPeriod.period_end);
              const periodHourUtc =
                periodEnd.getUTCHours() + periodEnd.getUTCMinutes() / 60;
              const localHour = periodHourUtc; // Treat as local solar time

              const expectedCap = expectedCapacityKw(periodEnd, localHour, {
                ...config,
                monthlyPeakFactors,
              });

              const confidence = periodConfidence(
                currentPeriod.pv_estimate,
                expectedCap
              );

              // Weather-based buffer: inversely proportional to confidence
              const weatherBuffer =
                config.minBufferPower *
                (1 +
                  (config.bufferMultiplierMax - 1) * (1 - confidence));

              // Urgency modulation ONLY if deadlineHour is set
              if (config.deadlineHour !== undefined && batteryState) {
                const urgencyFactor = simulation.utilizationRatio;
                finalBuffer = weatherBuffer * (1 - urgencyFactor * 0.5);
              } else {
                finalBuffer = weatherBuffer;
              }

              // Floor at minBufferPower
              finalBuffer = Math.max(config.minBufferPower, finalBuffer);
            }

            // Get grid data
            const {
              voltage,
              export_to_grid: exportingToGrid,
              import_from_grid: importingFromGrid,
            } = yield* dataAdapter.queryLatestValues([
              "voltage",
              "export_to_grid",
              "import_from_grid",
            ]);

            const netExport = exportingToGrid - importingFromGrid;
            const excessSolar =
              netExport - finalBuffer + currentChargingSpeed * voltage;

            if (excessSolar / voltage >= 32) {
              return 32;
            }

            return Math.max(
              0,
              Math.floor((excessSolar / voltage) / config.multipleOf) *
                config.multipleOf
            );
          }).pipe(
            Effect.catchTags({
              DataNotAvailable: (err) =>
                Effect.fail(new InadequateDataToDetermineSpeedError({ cause: err })),
              SourceNotAvailable: (err) =>
                Effect.fail(new InadequateDataToDetermineSpeedError({ cause: err })),
            })
          ),
      };
    })
  );
