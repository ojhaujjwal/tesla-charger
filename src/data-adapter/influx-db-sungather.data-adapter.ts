import { IDataAdapter } from "./types";

type AuthContext = null;

const parseCsv = async (rows: string[]) => {
  const headers = rows[0].split(',');
  const data = rows.slice(1, 3).map(row => {
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
    private bucket: string,
  ) {}

  async authenticate() {
    // connect to influxdb
    return null;
  }

  async getGridExportValue(): Promise<number> {
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
          |> filter(fn: (r) => r._field == "export_to_grid" or r._field == "import_from_grid")
          |> last()
        `
    });

    const lines = (await response.text()).split('\n');

    if (lines.length < 2) { 
      return Promise.reject('No data found');
    }

    const parsedLines = (await parseCsv(lines));
    
    const exportValue = parsedLines.find(d => d._field === 'export_to_grid')?._value;
    const importValue = parsedLines.find(d => d._field === 'import_from_grid')?._value;


    return parseInt(exportValue ?? '0') - parseInt(importValue ?? '0');
  }
}
 