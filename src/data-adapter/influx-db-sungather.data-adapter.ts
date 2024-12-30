//import { InfluxDB, FluxTableMetaData } from '@influxdata/influxdb-client';
import querystring from 'querystring';
import { IDataAdapter } from "./types";

type AuthContext = null;

const parseCsv = async (rows: string[]) => {
  const headers = rows[0].split(',');
  const data = rows.slice(1, 2).map(row => {
    const values = row.split(',');
    return headers.reduce((acc, header, index) => {
      acc[header] = values[index];
      return acc;
    }, {} as Record<string, string>);
  });

  if (rows.length < 2) { 
    return Promise.reject('No data found');
  }

  return data;
}

export class SunGatherInfluxDbDataAdapter implements IDataAdapter<AuthContext>  {
  constructor(
    private influxUrl: string,
    private influxToken: string,
    private org: string,

  ) {}

  async authenticate() {
    // connect to influxdb
    return null;
  }

  async getExcessSolar(): Promise<number> {
    const queryParams = querystring.encode({
      q: 'SELECT last(export_to_grid) FROM "solar" order by time desc limit 1',
      db: 'solar',
      pretty: true,
    });

    const response = await fetch(`${this.influxUrl}/api/v2/query?org=${this.org}&pretty=true`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/vnd.flux',
        'Accept': 'application/csv',
        'Authorization': `Token ${this.influxToken}`        
      },
      body: 
        `
        from(bucket: "solar")
          |> range(start: -2m)
          |> filter(fn: (r) => r._field == "export_to_grid")
          |> last()
        `
    });

    const lines = (await response.text()).split('\n');

    if (lines.length < 2) { 
      return Promise.reject('No data found');
    }

    const data = (await parseCsv(lines))[0];

    return parseInt(data._value);
  }
}
