export type IDataAdapter<AuthContext> = {
  authenticate: () => Promise<AuthContext>;
  getCurrentLoad: () => Promise<number>;
  getGridExportValue: () => Promise<number>;
  getDailyImportValue: () => Promise<number>;
  getLowestValueInLastXMinutes: (field: string, minutes: number) => Promise<number>;
};
