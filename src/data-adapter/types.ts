export type IDataAdapter<AuthContext> = {
  authenticate: () => Promise<AuthContext>;
  getExcessSolar: () => Promise<number>;
};
