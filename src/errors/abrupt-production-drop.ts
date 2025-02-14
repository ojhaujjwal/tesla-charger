export class AbruptProductionDrop extends Error {
  constructor() {
    super('Sudden current production fluctuation detected');
  }
}
