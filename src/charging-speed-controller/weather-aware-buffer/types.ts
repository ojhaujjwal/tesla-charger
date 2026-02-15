export type WeatherAwareBufferConfig = {
  readonly minBufferPower: number; // floor (e.g. 1000W, same as EXCESS_SOLAR_BUFFER_POWER)
  readonly bufferMultiplierMax: number; // max multiplier on minBuffer (e.g. 3 -> up to 3000W)
  readonly carBatteryCapacityKwh: number; // e.g. 75 for Model Y LR
  readonly peakSolarCapacityKw: number; // nameplate peak at solar noon in best month (e.g. 9kW)
  readonly latitude: number; // for sunrise/sunset + seasonal peak calculation
  readonly longitude: number; // for solar noon calculation
  readonly monthlyPeakFactors?: readonly number[]; // 12 multipliers [Jan..Dec] on peakSolarCapacityKw
  // auto-generated from latitude if not provided
  readonly defaultDailyProductionKwh: number; // fallback if forecast unavailable
  readonly deadlineHour?: number; // optional departure deadline (e.g. 14 = 2PM)
  readonly solarCutoffHour: number; // end of useful solar (default 18 = 6PM)
  readonly multipleOf: number; // ampere rounding (currently 3)
};

export type SunTimes = {
  readonly sunrise: number; // fractional hours (e.g. 6.5 = 6:30 AM)
  readonly sunset: number; // fractional hours (e.g. 18.5 = 6:30 PM)
};

export type SimulationResult = {
  readonly canComplete: boolean;
  readonly usableSlots: number;
  readonly totalSlots: number;
  readonly utilizationRatio: number; // usableSlots / totalSlots
  readonly shortfallKwh: number; // 0 if canComplete
};
