export type Field =
  | 'voltage'
  | 'current_production'
  | 'current_load'
  | 'daily_import'
  | 'export_to_grid'
  | 'import_from_grid';

export type IDataAdapter<AuthContext> = {
  authenticate: () => Promise<AuthContext>;
  getCurrentProduction: () => Promise<number>;
  getVoltage: () => Promise<number>;
  getDailyImportValue: () => Promise<number>;

  getValues(fields: Field[]): Promise<Record<Field, number>>;

  getLowestValueInLastXMinutes: (field: string, minutes: number) => Promise<number>;
};
