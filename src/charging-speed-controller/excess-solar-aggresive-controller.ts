import { DataAdapter } from "../data-adapter/types.js";
import { ChargingSpeedController, InadequateDataToDetermineSpeedError } from "./types.js";
import { Effect, Layer } from "effect";

export const ExcessSolarAggresiveControllerLayer = (config: {
  bufferPower: number;
  multipleOf: number;
}) => Layer.effect(
  ChargingSpeedController,
  Effect.gen(function* () {
    const dataAdapter = yield* DataAdapter;

    return {
      determineChargingSpeed: (currentChargingSpeed: number) => Effect.gen(function* () {
        const {
          voltage,
          battery_power,
          export_to_grid,
          import_from_grid
        } = yield* dataAdapter.queryLatestValues(['voltage', 'battery_power', 'export_to_grid', 'import_from_grid']);

        const netExport = export_to_grid - import_from_grid;
        const isBatteryCharging = battery_power < 0;
        const isBatteryDischarging = battery_power > 0;

        const excessSolar = isBatteryCharging
          ? Math.abs(battery_power) + netExport - config.bufferPower + (currentChargingSpeed * voltage)
          : isBatteryDischarging
            ? netExport - battery_power - config.bufferPower + (currentChargingSpeed * voltage)
            : netExport - config.bufferPower + (currentChargingSpeed * voltage);

        if (excessSolar > 0) {
          yield* Effect.log('[ExcessSolarAggresiveController] raw result:', { excessSolar, netExport, batteryPower: battery_power, isBatteryCharging });
        }

        if ((excessSolar / voltage) >= 32) {
          return 32;
        }

        // round to nearest multiple of parameter
        return Math.max(0, Math.floor((excessSolar / voltage) / config.multipleOf) * config.multipleOf);
      }).pipe(
        Effect.catchTags({
          'DataNotAvailable': (err) => Effect.fail(new InadequateDataToDetermineSpeedError({ cause: err })),
          'SourceNotAvailable': (err) => Effect.fail(new InadequateDataToDetermineSpeedError({ cause: err })),
        })
      )
    };
  })
);
