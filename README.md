## Generate Refresh Tokens

1. Generate login URI
```sh
npm run generate-refresh-token
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
npm run generate-refresh-token NA_9e160ae8108f48287d1c28b40a410c4344ea3dc802483002a920bdf52dc2
```

6. Obtain the value of refresh token in the JSON and paste the value of refresh token in `.env` like

```env
TESLA_OAUTH2_REFRESH_TOKEN=NA_sdfgslitrvhnoweitunheroituhewrotiuehrmtylibuerhnyoilertuye

```
