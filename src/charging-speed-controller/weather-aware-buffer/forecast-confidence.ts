// Pure function for calculating forecast confidence

export const periodConfidence = (
  pvPowerKw: number,
  expectedCapacityKw: number
): number => {
  // If expected capacity is 0 (nighttime), confidence is 0
  if (expectedCapacityKw <= 0) {
    return 0;
  }

  // Confidence = min(1.0, pvPowerKw / expectedCapacityKw / 0.7)
  // The 0.7 divisor means we need ~70% of expected capacity to reach full confidence
  const confidence = Math.min(1.0, (pvPowerKw / expectedCapacityKw) / 0.7);
  return confidence;
};
