// import { IDataAdapter } from "./types.js";

// type AuthContext = {
//   token: string;
// }

// export class SungrowCloudApi implements IDataAdapter<AuthContext> {
//   constructor(private username: string, private password: string) {}
//   getCurrentLoad() {
//     return Promise.resolve(2);
//   };
//   //getDailyImportValue: () => Promise<number>;
//   //getLowestValueInLastXMinutes: (field: string, minutes: number) => Promise<number>;

//   getDailyImportValue() {
//     return Promise.resolve(2);
//   };

//   getLowestValueInLastXMinutes(field: string, minutes: number) {
//     return Promise.resolve(2);
//   };

//   async authenticate() {
//     const respone = await fetch('https://augateway.isolarcloud.com/v1/userService/login', {
//       method: 'POST',
//       headers: {
//         'Content-Type': 'application/json',
//         'X-Access-Key': '9grzgbmxdsp3arfmmgq347xjbza4ysps',
        
//       },
//       body: JSON.stringify({
//         user_account: this.username,
//         user_password: this.password,
//         app_key: 'GWPd4NpXdWsgNTjeyKBYt'
//       }),
//     });


//     console.log('response', await respone.text());

//     return {
//       token: '1234'
//     };
//   }

//   async getGridExportValue(): Promise<number> {
    
//     return Promise.resolve(0);
//   }
// }