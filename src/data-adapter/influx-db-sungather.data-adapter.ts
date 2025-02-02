import { IDataAdapter } from "./types";

type AuthContext = null;

const parseCsv = async (rows: string[], numberOfRows: number) => {
  const headers = rows[0].split(',');
  const data = rows.slice(1, 1 + numberOfRows).map(row => {
    const values = row.split(',');
    return headers.reduce((acc, header, index) => {
      acc[header] = values[index];
      return acc;
    }, {} as Record<string, string>);
  });

  if (rows.length < 2) { 
    return Promise.reject('No data found');
  }

  return data.reduce((acc, row) => {
    acc[row._field] = row._value;
    return acc;
  }, {} as Record<string, string>);
}

export class SunGatherInfluxDbDataAdapter implements IDataAdapter<AuthContext>  {
  constructor(
    private influxUrl: string,
    private influxToken: string,
    private org: string,
    private bucket: string,
  ) {}

  async authenticate() {
    // connect to influxdb
    return null;
  }

  async getDailyImportValue(): Promise<number> {
    const result = await this.queryLatestValue(['daily_import_from_grid']);

    return result.daily_import_from_grid ? parseFloat(result.daily_import_from_grid) : Promise.reject('No data found');
  }

  async getGridExportValue(): Promise<number> {
    const result = await this.queryLatestValue(['export_to_grid', 'import_from_grid']);

    return parseInt(result.export_to_grid ?? '0') - parseInt(result.import_from_grid ?? '0');
  }

  async getCurrentLoad(): Promise<number> {
    const result = await this.queryLatestValue(['load_power']);

    return result.load_power ? parseFloat(result.load_power) : Promise.reject('No data found');
  }

  async getLowestValueInLastXMinutes(field: string, minutes: number): Promise<number> {
    const response = await fetch(`${this.influxUrl}/api/v2/query?org=${this.org}&pretty=true`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/vnd.flux',
        'Accept': 'application/csv',
        'Authorization': `Token ${this.influxToken}`        
      },
      body: 
        `
        from(bucket: "${this.bucket}")
          |> range(start: -${minutes}m)
          |> filter(fn: (r) => r._field == "${field}")
          |> min()
        `
    });

    const lines = (await response.text()).split('\n');

    if (lines.length < 2) { 
      return Promise.reject('No data found');
    }

    const result = await parseCsv(lines, 1);

    return result[field] ? parseFloat(result[field]) : Promise.reject('No data found');
  }

  private async queryLatestValue(fields: string[]) {

    const filterExpression = fields.map(field => `r._field == "${field}"`).join(' or ');

    const response = await fetch(`${this.influxUrl}/api/v2/query?org=${this.org}&pretty=true`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/vnd.flux',
        'Accept': 'application/csv',
        'Authorization': `Token ${this.influxToken}`        
      },
      body: 
        `
        from(bucket: "${this.bucket}")
          |> range(start: -2m)
          |> filter(fn: (r) => ${filterExpression})
          |> last()
        `
    });

    const lines = (await response.text()).split('\n');

    if (lines.length < 2) { 
      return Promise.reject('No data found');
    }

    return await parseCsv(lines, fields.length);
  }
}
 