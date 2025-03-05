export type IEventLogger = {
  onSetAmpere: (ampere: number) => void;
  onNoAmpereChange: (currentChargingAmpere: number) => void;
};