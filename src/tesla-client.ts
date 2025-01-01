import { exec } from 'child_process';
import { promisify } from 'util';

const OAUTH2_TOKEN_BASE_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';

export class TeslaClient {
  constructor(
    private clientId: string,
    private clientSecret: string,
    private refreshToken?: string
  ) { }
  
  public async authenticateFromAuthCodeGrant(authorizationCode: string) {
    const response = await fetch(OAUTH2_TOKEN_BASE_URL, {
      method: 'POST',
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        audience: 'https://fleet-api.prd.na.vn.cloud.tesla.com',
        code: authorizationCode,
      }),
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });
  
    return await response.json();
  }

  public async refreshAccessToken(): Promise<string>
  { 
    const response = await fetch(OAUTH2_TOKEN_BASE_URL, {
      method: 'POST',
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: this.clientId,
        refresh_token: this.refreshToken,
      }),
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`
        Failed to refresh access token: ${response.statusText} response: ${await response.text()}
      `);
    }
  
    return (await response.json()).access_token;
  }

  public startCharging(): Promise<void> {
    return this.execTeslaControl('charging-start');
  }

  public stopCharging(): Promise<void> {
    return this.execTeslaControl('charging-stop');
  }

  public setAmpere(ampere: number): Promise<void> {
    return this.execTeslaControl(`charging-set-amps ${ampere}`);
  }

  public wakeUpCar(): Promise<void> {
    return this.execTeslaControl('wake');
  }

  private async execTeslaControl(command: string): Promise<void> { 
    console.log(`Running command: tesla-control ${command}`);
    await promisify(exec)(`tesla-control ${command}`);
  }
}
