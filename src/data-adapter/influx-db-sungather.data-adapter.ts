import { IDataAdapter, Field } from "./types.js";

type AuthContext = null;

type InfluxField = 'phase_a_voltage'
  | 'total_active_power'
  | 'load_power'
  | 'daily_import_from_grid'
  | 'export_to_grid'
  | 'import_from_grid';

const fieldMap: Record<Field, InfluxField> = {
  voltage: 'phase_a_voltage',
  current_production: 'total_active_power',
  current_load: 'load_power',
  daily_import: 'daily_import_from_grid',
  export_to_grid: 'export_to_grid',
  import_from_grid: 'import_from_grid',
}

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

  async getValues(fields: Field[]): Promise<Record<Field, number>> {
    const result = await this.queryLatestValue(fields.map(field => fieldMap[field] ?? field));

    return fields.reduce((acc, field) => {
      if (!(field in result)) {
        throw new Error(`No data found for field ${field}`);
      }

      acc[field] = parseFloat(result[fieldMap[field]]);
      return acc;
    }, {} as Record<Field, number>);
  }

  async getVoltage(): Promise<number> {
    const result = await this.queryLatestValue(['phase_a_voltage']);

    return result.phase_a_voltage ? parseFloat(result.phase_a_voltage) : Promise.reject('No data found');
  }

  async getCurrentProduction(): Promise<number> {
    const result = await this.queryLatestValue(['total_active_power']);

    return result.total_active_power ? parseFloat(result.total_active_power) : Promise.reject('No data found');
  }

  async getDailyImportValue(): Promise<number> {
    const result = await this.queryLatestValue(['daily_import_from_grid']);

    return result.daily_import_from_grid ? parseFloat(result.daily_import_from_grid) : Promise.reject('No data found');
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
          |> range(start: -10m)
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
 