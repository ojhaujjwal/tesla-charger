export class AbruptProductionDropError extends Error {
  constructor(public readonly initialProduction: number, public readonly currentProduction: number) {
    super('Sudden current production fluctuation detected');
  }
}
