(async () => {
  // const refreshToken = process.env.REFRESH_TOKEN;

  // const authResponse = await fetch('https://auth.tesla.com/oauth2/v3/token', {
  //   method: 'POST',
  //   body: JSON.stringify({
  //     grant_type: "refresh_token",
  //     client_id: process.env.TESLA_OAUTH2_CLIENT_ID,
  //     refresh_token: process.env.TESLA_OAUTH2_REFRESH_TOKEN,
  //     scope: "openid email offline_access"
  //   }),
  //   headers: {
  //     'Content-Type': 'application/json',
  //     'Accept': 'application/json',
  //   },
  // });

  // const accessToken = (await authResponse.json()).access_token;``
  // console.log(accessToken);


  // const response1 = await fetch('https://owner-api.teslamotors.com/api/1/products', {
  //   method: 'GET',
  //   headers: {
  //     "Authorization": `Bearer ${accessToken}`,
  //   },
  // });

  // console.log(response1.status, await response1.text());

  // //TODO: use vehicle sdk for vehicles command
  // // https://github.com/teslamotors/vehicle-command

  // const response = await fetch('https://owner-api.teslamotors.com/api/1/vehicles/LRWYHCFS9RC541952/command/charge_start', {
  //   method: 'POST',
  //   headers: {
  //     "Authorization": `Bearer ${accessToken}`,
  //   },
  // });

  // console.log(response.status, await response.text());

  const response = await fetch('https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token', {
    method: 'POST',
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: process.env.TESLA_OAUTH2_CLIENT_ID,
      refresh_token: process.env.TESLA_OAUTH2_REFRESH_TOKEN,
    }),
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  });

  const accessToken = (await response.json()).access_token;

  console.log(accessToken);

  // todo use accessToken to send vehicle command to start charging
})();
