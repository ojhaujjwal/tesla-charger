import type { WeatherAwareBufferConfig, SunTimes } from "./types.js";

// Pure functions for solar position calculations

export const calculateSunTimes = (date: Date, latitude: number): SunTimes => {
  // Calculate day of year (1-365)
  const startOfYear = new Date(date.getFullYear(), 0, 1);
  const dayOfYear = Math.floor(
    (date.getTime() - startOfYear.getTime()) / (1000 * 60 * 60 * 24)
  );

  // Solar declination angle (in radians)
  const declinationRad =
    (23.45 * Math.PI) /
    180 *
    Math.sin((2 * Math.PI * (284 + dayOfYear)) / 365);

  // Convert latitude to radians
  const latRad = (latitude * Math.PI) / 180;

  // Hour angle at sunrise/sunset (in radians)
  // cos(hourAngle) = -tan(lat) * tan(declination)
  const cosHourAngle = -Math.tan(latRad) * Math.tan(declinationRad);

  // If cosHourAngle > 1, sun never rises (polar night)
  // If cosHourAngle < -1, sun never sets (polar day)
  if (cosHourAngle >= 1) {
    // Polar night - no sunrise/sunset
    return { sunrise: 12, sunset: 12 };
  }
  if (cosHourAngle <= -1) {
    // Polar day - sun always up
    return { sunrise: 0, sunset: 24 };
  }

  const hourAngleRad = Math.acos(cosHourAngle);
  const hourAngleDeg = (hourAngleRad * 180) / Math.PI;

  // Convert hour angle to time (hours)
  // Solar noon is at 12:00, hour angle is 0 at noon
  // Hour angle increases by 15 degrees per hour
  const sunriseHour = 12 - hourAngleDeg / 15;
  const sunsetHour = 12 + hourAngleDeg / 15;

  return {
    sunrise: sunriseHour,
    sunset: sunsetHour,
  };
};

export const calculateDefaultMonthlyPeakFactors = (
  latitude: number
): readonly number[] => {
  const factors: number[] = [];

  // Calculate for each month (using 15th as representative day)
  for (let month = 0; month < 12; month++) {
    const date = new Date(2024, month, 15); // Use 2024 as reference year
    const startOfYear = new Date(2024, 0, 1);
    const dayOfYear =
      Math.floor(
        (date.getTime() - startOfYear.getTime()) / (1000 * 60 * 60 * 24)
      ) + 1;

    // Solar declination angle (in radians)
    const declinationRad =
      (23.45 * Math.PI) /
      180 *
      Math.sin((2 * Math.PI * (284 + dayOfYear)) / 365);

    // Solar elevation at noon = 90 - |latitude - declination|
    // For southern hemisphere, we need to account for the sign
    const declinationDeg = (declinationRad * 180) / Math.PI;
    const solarElevationDeg = 90 - Math.abs(latitude - declinationDeg);

    // Convert to radians and take sine (solar output is proportional to sin(elevation))
    const solarElevationRad = (solarElevationDeg * Math.PI) / 180;
    const factor = Math.max(0, Math.sin(solarElevationRad)); // Clamp to 0 minimum

    factors.push(factor);
  }

  // Normalize so max = 1.0
  const maxFactor = Math.max(...factors);
  if (maxFactor > 0) {
    return factors.map((f) => f / maxFactor);
  }

  // Fallback if all factors are 0 (shouldn't happen)
  return [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
};

export const expectedCapacityKw = (
  date: Date,
  hour: number,
  config: WeatherAwareBufferConfig
): number => {
  // Get monthly peak factors (use provided or calculate)
  const monthlyPeakFactors =
    config.monthlyPeakFactors ??
    calculateDefaultMonthlyPeakFactors(config.latitude);

  // Get sun times for this date
  const { sunrise, sunset } = calculateSunTimes(date, config.latitude);

  // If before sunrise or after sunset, capacity is 0
  if (hour < sunrise || hour > sunset) {
    return 0;
  }

  // Calculate solar noon and daylight half-span
  const solarNoon = (sunrise + sunset) / 2;
  const daylightHalfSpan = (sunset - sunrise) / 2;

  // Calculate hour angle (-1.0 to 1.0, where 0 is solar noon)
  const hourAngle = (hour - solarNoon) / daylightHalfSpan;

  // Bell curve: cos^2 of hour angle (scaled to pi/2)
  // This gives 1.0 at noon, ~0.78 at mid-morning/afternoon, 0 at sunrise/sunset
  const dailyShape = Math.pow(Math.cos((hourAngle * Math.PI) / 2), 2);

  // Get monthly factor for this month (0-11)
  const monthIndex = date.getMonth();
  const monthFactor = monthlyPeakFactors[monthIndex] ?? 1.0;

  // Final capacity = peak * monthly factor * daily shape
  return config.peakSolarCapacityKw * monthFactor * dailyShape;
};
