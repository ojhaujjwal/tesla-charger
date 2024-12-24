import querystring from 'querystring';
import path from 'path';

(async () => { 
  const authorizationCode = process.argv[2] || null;

  // generate random string
  const state = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  
  if (authorizationCode === null) {
    console.log(
        'https://auth.tesla.com/oauth2/v3/authorize?' + 
        querystring.stringify({
          response_type: "code",
          client_id: process.env.TESLA_OAUTH2_CLIENT_ID,
          scope: "openid offline_access vehicle_location vehicle_charging_cmds vehicle_device_data vehicle_cmds",
          state,
          redirect_uri: `https://${process.env.TESLA_APP_DOMAIN}/tesla-charger`,
          locale: 'en-US',
          prompt: 'login'
        }),
    );
    return;
  }
  
  
  const response = await fetch('https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token', {
    method: 'POST',
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: process.env.TESLA_OAUTH2_CLIENT_ID,
      client_secret: process.env.TESLA_OAUTH2_CLIENT_SECRET,
      audience: 'https://fleet-api.prd.na.vn.cloud.tesla.com',
      code: authorizationCode,
      redirect_uri: `https://${process.env.TESLA_APP_DOMAIN}/tesla-charger`,
    }),
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  });

  console.log(await response.json());
})();

