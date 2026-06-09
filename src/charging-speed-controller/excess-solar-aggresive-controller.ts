import { DataAdapter } from "../data-adapter/types.js";
import { DynamicChargingConfig } from "./dynamic-config.js";
import { ChargingSpeedController, InadequateDataToDetermineSpeedError } from "./types.js";
import { Effect, Layer } from "effect";
import { Ampere, Voltage } from "../domain/brands.js";

export const ExcessSolarAggresiveControllerLayer = (config: { multipleOf: number }) =>
  Layer.effect(
    ChargingSpeedController,
    Effect.gen(function* () {
      const dataAdapter = yield* DataAdapter;
      const dynamicConfig = yield* DynamicChargingConfig;

      return {
        determineChargingSpeed: Effect.fn("determineChargingSpeed")(
          function* (currentChargingSpeed: Ampere) {
            const {
              voltage: rawVoltage,
              battery_power,
              export_to_grid,
              import_from_grid
            } = yield* dataAdapter.queryLatestValues([
              "voltage",
              "battery_power",
              "export_to_grid",
              "import_from_grid"
            ]);

            const voltage = Voltage(rawVoltage);

            const bufferPower = yield* dynamicConfig.getBufferPower;
            const netExport = export_to_grid - import_from_grid;
            const isBatteryCharging = battery_power < 0;
            const isBatteryDischarging = battery_power > 0;

            const excessSolar = isBatteryCharging
              ? Math.abs(battery_power) + netExport - bufferPower + currentChargingSpeed * voltage
              : isBatteryDischarging
                ? netExport - battery_power - bufferPower + currentChargingSpeed * voltage
                : netExport - bufferPower + currentChargingSpeed * voltage;

            if (excessSolar > 0) {
              yield* Effect.log("[ExcessSolarAggresiveController] raw result:", {
                excessSolar,
                netExport,
                batteryPower: battery_power,
                isBatteryCharging
              });
            }

            if (excessSolar / voltage >= 32) {
              return Ampere(32);
            }

            return Ampere(Math.max(0, Math.floor(excessSolar / voltage / config.multipleOf) * config.multipleOf));
          },
          (effect) =>
            effect.pipe(
              Effect.catchTags({
                DataNotAvailable: (err) => Effect.fail(new InadequateDataToDetermineSpeedError({ cause: err })),
                SourceNotAvailable: (err) => Effect.fail(new InadequateDataToDetermineSpeedError({ cause: err }))
              })
            )
        )
      };
    }).pipe(Effect.withSpan("ExcessSolarAggresiveControllerLayer"))
  );
