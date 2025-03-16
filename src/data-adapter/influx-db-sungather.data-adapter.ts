import type { IDataAdapter, Field } from "./types.js";

// Enhanced logging utility
const logger = {
  info: (message: string) => console.log(`[InfluxDB Adapter] ${message}`),
  error: (message: string) => console.error(`[InfluxDB Adapter] ERROR: ${message}`),
  warn: (message: string) => console.warn(`[InfluxDB Adapter] WARNING: ${message}`)
};

// Custom error for more detailed error handling
class InfluxDataAdapterError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
    this.name = 'InfluxDataAdapterError';
  }
}

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
  if (rows.length === 0) {
    logger.error('No data rows found in CSV');
    throw new InfluxDataAdapterError('No data found', 'NO_DATA');
  }
  
  if (rows.length < 2) { 
    logger.error('No data rows found in CSV');
    throw new InfluxDataAdapterError('No data found', 'NO_DATA');
  }

  const headers = rows[0].split(',');
  const data = rows.slice(1, 1 + numberOfRows).map(row => {
    const values = row.split(',');
    return headers.reduce((acc, header, index) => {
      acc[header] = values[index];
      return acc;
    }, {} as Record<string, string>);
  });

  return data.reduce((acc, row) => {
    acc[row._field] = row._value;
    return acc;
  }, {} as Record<string, string>);
}

export class SunGatherInfluxDbDataAdapter implements IDataAdapter<AuthContext>  {
  private readonly TIMEOUT_MS = 10000; // 10 seconds timeout
  private readonly MAX_RETRIES = 3;

  constructor(
    private influxUrl: string,
    private influxToken: string,
    private org: string,
    private bucket: string,
  ) {
    logger.info(`Initializing InfluxDB Adapter for bucket: ${bucket}`);
  }

  async authenticate() {
    logger.info('Authenticating with InfluxDB');
    return null;
  }

  private async fetchWithTimeout(url: string, options: RequestInit, timeout = this.TIMEOUT_MS): Promise<Response> {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      clearTimeout(id);
      return response;
    } catch (error) {
      clearTimeout(id);
      if (error instanceof Error && error.name === 'AbortError') {
        logger.error('Request timed out');
        throw new InfluxDataAdapterError('Request timed out', 'TIMEOUT');
      }
      throw error;
    }
  }

  async getValues(fields: Field[]): Promise<Record<Field, number>> {
    try {
      const result = await this.queryLatestValue(fields.map(field => fieldMap[field] ?? field));

      return fields.reduce((acc, field) => {
        const mappedField = fieldMap[field] ?? field;
        if (!(mappedField in result)) {
          logger.warn(`No data found for field ${field}`);
          throw new InfluxDataAdapterError(`No data found for field ${field}`, 'FIELD_NOT_FOUND');
        }

        acc[field] = parseFloat(result[mappedField]);
        return acc;
      }, {} as Record<Field, number>);
    } catch (error) {
      logger.error(`Error in getValues: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  async getVoltage(): Promise<number> {
    try {
      const result = await this.queryLatestValue(['phase_a_voltage']);
      return result.phase_a_voltage 
        ? parseFloat(result.phase_a_voltage) 
        : Promise.reject(new InfluxDataAdapterError('No voltage data found', 'NO_VOLTAGE'));
    } catch (error) {
      logger.error(`Error getting voltage: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  async getCurrentProduction(): Promise<number> {
    try {
      const result = await this.queryLatestValue(['total_active_power']);
      return result.total_active_power 
        ? parseFloat(result.total_active_power) 
        : Promise.reject(new InfluxDataAdapterError('No production data found', 'NO_PRODUCTION'));
    } catch (error) {
      logger.error(`Error getting current production: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  async getDailyImportValue(): Promise<number> {
    try {
      const result = await this.queryLatestValue(['daily_import_from_grid']);
      return result.daily_import_from_grid 
        ? parseFloat(result.daily_import_from_grid) 
        : Promise.reject(new InfluxDataAdapterError('No daily import data found', 'NO_DAILY_IMPORT'));
    } catch (error) {
      logger.error(`Error getting daily import value: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  async getLowestValueInLastXMinutes(field: Field, minutes: number): Promise<number> {
    const mappedField = fieldMap[field] ?? field;

    try {
      const response = await this.fetchWithTimeout(`${this.influxUrl}/api/v2/query?org=${this.org}&pretty=true`, {
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
            |> filter(fn: (r) => r._field == "${mappedField}")
            |> min()
          `
      });

      const lines = (await response.text()).split('\n');

      if (lines.length < 2) { 
        logger.warn(`No data found for lowest value in last ${minutes} minutes`);
        return Promise.reject(new InfluxDataAdapterError('No data found', 'NO_MIN_VALUE'));
      }

      const result = await parseCsv(lines, 1);

      return result[mappedField] 
        ? parseFloat(result[mappedField]) 
        : Promise.reject(new InfluxDataAdapterError('No data found', 'NO_MIN_VALUE'));
    } catch (error) {
      logger.error(`Error getting lowest value: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  private async queryLatestValue(fields: string[]) {
    try {
      const filterExpression = fields.map(field => `r._field == "${field}"`).join(' or ');

      const response = await this.fetchWithTimeout(`${this.influxUrl}/api/v2/query?org=${this.org}&pretty=true`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/vnd.flux',
          'Accept': 'application/csv',
          'Authorization': `Token ${this.influxToken}`        
        },
        body: 
          `
          from(bucket: "${this.bucket}")
            |> range(start: -1h)
            |> filter(fn: (r) => ${filterExpression})
            |> last()
          `
      });

      const lines = (await response.text()).split('\n');

      if (lines.length < 2) { 
        logger.warn('No data found in latest value query');
        return Promise.reject(new InfluxDataAdapterError('No data found', 'NO_LATEST_VALUE'));
      }

      return await parseCsv(lines, fields.length);
    } catch (error) {
      logger.error(`Error in queryLatestValue: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }
}
