(async () => {
    
  // documented URI https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token
  const response = await fetch('https://auth.tesla.com/oauth2/v3/token', {
    method: 'POST',
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: process.env.TESLA_OAUTH2_CLIENT_ID,
      client_secret: process.env.TESLA_OAUTH2_CLIENT_SECRET,
      audience: 'https://fleet-api.prd.na.vn.cloud.tesla.com',
      scope: "openid offline_access vehicle_device_data vehicle_location vehicle_charging_cmds",
    }),
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    console.error(await response.json());
    return;
  }

  const { access_token } = await response.json();
  console.log(access_token);

  const response2 = await fetch('https://fleet-api.prd.na.vn.cloud.tesla.com/api/1/partner_accounts', {
    method: 'POST',
    body: JSON.stringify({
      domain: process.env.TESLA_APP_DOMAIN,
    }),
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${access_token}`,
    }
  });

  console.log(await response2.json());
})();
