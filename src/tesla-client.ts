import { exec } from 'node:child_process';
import type { ExecException } from 'node:child_process';
import { promisify } from 'node:util';
import pRetry from 'p-retry';
//import fs from 'node:fs';
import { VehicleAsleepError } from './errors/vehicle-asleep-error.js';
import { promises as fs } from 'node:fs';


const OAUTH2_TOKEN_BASE_URL = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token';

export type ITeslaClient = {
  authenticateFromAuthCodeGrant(authorizationCode: string): Promise<unknown>;
  setupAccessTokenAutoRefresh(timeoutInSeconds: number): Promise<() => void>;
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
  ) { }

  private async getTokens(): Promise<{ access_token: string; refresh_token: string }> {
    try {
      const tokens = JSON.parse(await fs.readFile('token.json', 'utf8'));
      return tokens;
    } catch(error) {
      console.error(error);
      throw new Error('Failed to read tokens from token.json file');
    }
  }
  
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

  private async refreshAccessToken(): Promise<[string, string]> { 
    const { refresh_token } = await this.getTokens();
    
    const response = await fetch(OAUTH2_TOKEN_BASE_URL, {
      method: 'POST',
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: this.clientId,
        refresh_token: refresh_token,
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

    const result = await response.json();
  
    return [result.access_token, result.refresh_token];
  }

  public async saveTokens(accessToken: string, refreshToken: string) {
    await fs.writeFile('token.json', JSON.stringify({
      access_token: accessToken,
      refresh_token: refreshToken
    }, null, 2), 'utf8');

    await fs.writeFile('.access-token', accessToken, 'utf8');
  }

  public async setupAccessTokenAutoRefresh(timeoutInSeconds: number): Promise<() => void> {
    const refresher = async () => {
      const [accessToken, refreshToken] = await this.refreshAccessToken();

      await this.saveTokens(accessToken, refreshToken);
    };

    // call it at the start
    await refresher();
    
    const interval = setInterval(refresher, 1000 * timeoutInSeconds);

    return () => clearInterval(interval);
  }

  public async startCharging(): Promise<void> {    
    try {
      return await this.execTeslaControl('charging-start');
    } catch (err) {
      if ((err as ExecException).stderr?.includes('car could not execute command: is_charging')) {
        // car is already charging
        return;
      }

      throw err;
    }

    //todo: assert that car is charging by calling API
  }

  public stopCharging(): Promise<void> {
    return this.execTeslaControl('charging-stop');

    //todo: ignore if car is already not charging
  }

  public setAmpere(ampere: number): Promise<void> {
    return this.execTeslaControl(`charging-set-amps ${ampere}`);
  }

  public wakeUpCar(): Promise<void> {
    return this.execTeslaControl('wake');
  }

  private async execTeslaControl(command: string): Promise<void> { 
    console.log(`Running command: tesla-control ${command}`);
    
    try {
      const output = await pRetry(() => promisify(exec)(`tesla-control ${command}`), {
        retries: 3,
        shouldRetry: (error) => {
          return (error as ExecException).stderr?.includes('context deadline exceeded') ?? false;
        }
      });
      console.log(output.stdout, output.stderr);
    } catch (err) {
      if ((err as ExecException).stderr?.includes('vehicle is offline or asleep')) {
        throw new VehicleAsleepError();
      }
      throw err;
    }
  }
}
