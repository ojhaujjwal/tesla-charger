export class AbruptProductionDropError extends Error {
  constructor() {
    super('Sudden current production fluctuation detected');
  }
}
