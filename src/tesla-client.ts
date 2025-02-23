import { exec, ExecException } from 'node:child_process';
import { promisify } from 'node:util';
import pRetry from 'p-retry';
import fs from 'node:fs';


const OAUTH2_TOKEN_BASE_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';

export type ITeslaClient = {
  authenticateFromAuthCodeGrant(authorizationCode: string): Promise<unknown>;
  setupAccessTokenAutoRefresh(timeoutInSeconds: number): () => void;
  startCharging(): Promise<void>;
  stopCharging(): Promise<void>;
  setAmpere(ampere: number): Promise<void>;
  wakeUpCar(): Promise<void>;
}

export class TeslaClient implements ITeslaClient {
  constructor(
    private appDomain: string,
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
        redirect_uri: `https://${this.appDomain}/tesla-charger`,
        code: authorizationCode,
      }),
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });
  
    return await response.json();
  }

  private async refreshAccessToken(): Promise<string>
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

  public setupAccessTokenAutoRefresh(timeoutInSeconds: number): () => void {
    const refresher = async () => {
      const accessToken = await this.refreshAccessToken();

      // TODO: use temp file instead
      await promisify(fs.writeFile)('.access-token', accessToken, 'utf8');
    };

    // call it at the start
    refresher();
    
    const interval = setInterval(refresher, 1000 * timeoutInSeconds);

    return () => clearInterval(interval);
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
    
    await pRetry(() => promisify(exec)(`tesla-control ${command}`), {
      retries: 3,
      shouldRetry: (error) => {
        return (error as ExecException).stderr?.includes('context deadline exceeded') ?? false;
      }
    });
  }
}
