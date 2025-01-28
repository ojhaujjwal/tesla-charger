export type ChargingSpeedController = {
  determineChargingSpeed: (currentChargingSpeed: number) => Promise<number>;
};
