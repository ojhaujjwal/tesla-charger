
Tesla Charger
====================
Using excess solar charger from my solar setup with sungrow inverter to charge my tesla model y. 
It's very much experimental for now.


# Setup
## Create a tesla developer application
Go to [Tesla Developer Dashboard](https://developer.tesla.com/en_US/dashboard) and create a tesla application.

## Set config and secrets
1. Copy example.env to .env
2. Modify .env and update all the credentials and config


## Generate Refresh Tokens
This is needed to run vehicle commands on behalf of a certain tesla user. It's based on OAuth2.

1. Generate login URI
```sh
npm run cmd:generate-refresh-token
```

2. Login using tesla credentials

3. Copy the authorization code from the URI
Example:
```
http://localhost:4321/tesla-charger?locale=en-US&code=NA_9e160ae8108f48287d1c28b40a410c4344ea3dc802483002a920bdf52dc2&state=xdfk76qcqysnf4s4rqhy&issuer=https%3A%2F%2Fauth.tesla.com%2Foauth2%2Fv3
```

4. Copy the value of the parameter `code`
5. Run generate-token again but with the code obtained in the last step like

```sh
npm run cmd:generate-refresh-token NA_9e160ae8108f48287d1c28b40a410c4344ea3dc802483002a920bdf52dc2
```

6. Obtain the value of refresh token in the JSON and paste the value of refresh token in `.env` like

```env
TESLA_OAUTH2_REFRESH_TOKEN=NA_sdfgslitrvhnoweitunheroituhewrotiuehrmtylibuerhnyoilertuye
```

## Pair Tesla app with the Tesla Charger (aka Third party application)
1. Call endpoint [POST /api/1/partner_accounts](https://developer.tesla.com/docs/fleet-api/endpoints/partner-endpoints#register) in Tesla's fleet API and make sure all it's pre-requisites are met including
- Generating private-public key pair for using the tesla vehicle command sdk.
- Upload public key to `.well-known` directory under the required path.

2. Go to https://www.tesla.com/_ak/domain.com and follow the instructions


## Setup Influx and Run SunGather to export data to influx
[SunGather](https://github.com/bohdan-s/SunGather) is a tool to Collect data from Sungrow Inverters and export data to various locations.
For this project, you just need to setup SunGather to write two data points
  - export_to_grid
  - import_to_grid

In theory, you could easily use this without SunGather and for any inverters as long as you can find a way to write those two values in the configured bucket. 

# Running
```sh
npm run dev
```
