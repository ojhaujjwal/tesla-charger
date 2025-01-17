export type IDataAdapter<AuthContext> = {
  authenticate: () => Promise<AuthContext>;
  getGridExportValue: () => Promise<number>;
  getDailyImportValue: () => Promise<number>;
};
