# API Client Authentication

This document describes the authentication mechanisms for external API clients used in Tesla Charger.

## Overview

| API | Implementation | Auth Method |
|-----|---------------|-------------|
| Tesla Fleet API | `src/tesla-client/index.ts` | OAuth2 (refresh token flow) |
| Alpha ESS API | `src/data-adapter/alpha-ess-api.data-adapter.ts` | Signature-based (SHA-512) |

---

## Tesla API Authentication

### Overview

Tesla API authentication uses OAuth2 with a custom Tesla application. The flow consists of:
1. Initial setup via authorization code grant
2. Token storage and automatic refresh

### Setup Requirements

1. **Create a Tesla Developer Application** at [Tesla Developer Dashboard](https://developer.tesla.com/en_US/dashboard)

2. **Register as Partner Application** using `npm run cmd:setup-tesla-partner-application` (see [`src/setup-tesla-partner-application.ts`](src/setup-tesla-partner-application.ts))

3. **Generate key pair** for vehicle command signing (required for charging commands)

4. **Obtain refresh token** via the authorization code flow

### Initial Authentication Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│  1. Generate login URI                                              │
│     npm run cmd:generate-refresh-token                              │
│     (src/generate-refresh-token.ts:14-28)                          │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  2. User authenticates at Tesla                                    │
│     https://auth.tesla.com/oauth2/v3/authorize?                     │
│       response_type=code                                           │
│       client_id=TESLA_OAUTH2_CLIENT_ID                             │
│       scope=openid offline_access vehicle_charging_cmds ...         │
│       redirect_uri=https://{TESLA_APP_DOMAIN}/tesla-charger        │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  3. Callback with authorization code                                │
│     http://localhost:4321/tesla-charger?code=NA_xxx&state=xxx      │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  4. Exchange code for tokens                                       │
│     npm run cmd:generate-refresh-token NA_xxx                      │
│     (src/tesla-client/index.ts:236-256 - authenticateFromAuthCodeGrant) │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  5. Tokens saved to token.json                                     │
│     (src/tesla-client/index.ts:100-107 - saveTokens)               │
│     - access_token                                                  │
│     - refresh_token                                                │
└─────────────────────────────────────────────────────────────────────┘
```

### Token Refresh

Tokens are refreshed in two ways:

1. **Manual refresh**: `refreshAccessToken()` ([`index.ts:166-171`](src/tesla-client/index.ts))

2. **Automatic recurring refresh**: `setupAccessTokenAutoRefreshRecurring(timeoutInSeconds)` ([`index.ts:258-260`](src/tesla-client/index.ts))
   - Scheduled via Effect's `Schedule.duration`
   - Default interval: 2 hours (7200 seconds)
   - Called during app startup ([`app.ts:391`](src/app.ts))

### Token Storage

| File | Purpose | Fallback |
|------|---------|----------|
| `token.json` | Primary token storage (access + refresh) | - |
| `.access-token` | Legacy support, stores access token only | Used if `token.json` unavailable |

### Vehicle Commands

Vehicle commands use the `tesla-control` CLI tool, which requires:
- Private key file (`TESLA_KEY_FILE`) or key name (`TESLA_KEY_NAME`)
- Access token for Fleet API authentication

**Supported Commands:**
- `charging-start` - Start charging
- `charging-stop` - Stop charging
- `charging-set-amps <amps>` - Set charging current
- `wake` - Wake vehicle from sleep

### Configuration

| Environment Variable | Required | Description |
|---------------------|----------|-------------|
| `TESLA_OAUTH2_CLIENT_ID` | Yes | Tesla app client ID |
| `TESLA_OAUTH2_CLIENT_SECRET` | Yes | Tesla app client secret |
| `TESLA_OAUTH2_REFRESH_TOKEN` | Yes | OAuth2 refresh token |
| `TESLA_VIN` | Yes | Vehicle Identification Number |
| `TESLA_APP_DOMAIN` | Yes | App domain for OAuth redirect |
| `TESLA_TOKEN_FILE` | No | Custom token storage path (default: `token.json`) |
| `TESLA_KEY_NAME` | For commands | Key name for vehicle commands |
| `TESLA_KEY_FILE` | For commands | Path to private key file |

### Implementation Details

**Token Response Schema** ([`schema.ts:3-8`](src/tesla-client/schema.ts)):
```typescript
{
  access_token: string,
  refresh_token: string
}
```

**Error Handling** ([`errors.ts`](src/tesla-client/errors.ts)):
- `AuthenticationFailedError` - Token refresh or auth code grant failure
- `UnableToFetchAccessTokenError` - Network timeout during token fetch
- `VehicleAsleepError` - Vehicle is asleep and cannot receive commands
- `VehicleCommandFailedError` - Command execution failed
- `ChargeStateQueryFailedError` - Fleet API query failed

---

## Alpha ESS API Authentication

### Overview

Alpha ESS uses a signature-based authentication scheme combining API credentials with timestamps.

### Signature Generation

```
signature = SHA-512(appId + appSecret + timestamp)
```

The signature is computed using Node.js `crypto.createHash("sha512")`.

**Implementation**: [`alpha-ess-api.data-adapter.ts:65-73`](src/data-adapter/alpha-ess-api.data-adapter.ts)

### Request Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│  1. Generate timestamp (Unix seconds)                              │
│     timestamp = Math.floor(Date.now() / 1000)                      │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  2. Compute signature                                              │
│     sign = SHA-512(appId + appSecret + timestamp)                  │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  3. Make authenticated request                                     │
│     GET /api/getLastPowerData?sysSn={sysSn}                        │
│     Headers:                                                       │
│       appId: {appId}                                              │
│       timeStamp: {timestamp}                                      │
│       sign: {signature}                                            │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  4. Validate response                                              │
│     - HTTP status 200                                              │
│     - response.code === 200                                        │
│     - response.data exists                                         │
└─────────────────────────────────────────────────────────────────────┘
```

### Configuration

| Environment Variable | Required | Description |
|---------------------|----------|-------------|
| `ALPHA_ESS_API_APP_ID` | Yes | Alpha ESS application ID |
| `ALPHA_ESS_API_APP_SECRET` | Yes | Alpha ESS application secret |
| `ALPHA_ESS_API_SYS_SN` | Yes | System serial number |
| `ALPHA_ESS_API_BASE_URL` | No | API base URL (default: `https://openapi.alphaess.com/`) |

### Data Retrieval

The Alpha ESS API provides power data including:
- `ppv` - Current solar production
- `pload` - Current load
- `pgrid` - Grid power (positive = import, negative = export)
- `pbat` - Battery power (positive = discharge, negative = charge)
- `soc` - State of charge

**Implementation**: [`alpha-ess-api.data-adapter.ts:116-171`](src/data-adapter/alpha-ess-api.data-adapter.ts)

### Retry Policy

The adapter implements exponential backoff retry:
- **Max attempts**: 6 (1 initial + 5 retries)
- **Backoff**: 2s, 4s, 8s, 16s, 32s
- **Retry conditions**: Timeout, transport errors
