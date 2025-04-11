// import ModbusRTU from "modbus-serial"; 
// import { IDataAdapter, Field } from "./types.js";

// // Create a wrapper class to handle Modbus client interactions
// class ModbusWrapper {
//   private client: ModbusRTU;
  
//   constructor() {
//     this.client = new ModbusRTU();
//   }

//   async connect(host: string, port: number, slaveId: number): Promise<void> {
//     //this.client.setHost(host);
//     //this.client.setPort(port);
//     await this.client.connectTCP(host, { port });
//     this.client.setID(slaveId);
//   }

//   get isOpen(): boolean {
//     return this.client.isOpen;
//   }

//   async readInputRegisters(address: number, count: number): Promise<{ data: number[] }> {
//     return this.client.readInputRegisters(address, count);
//   }

//   async readHoldingRegisters(address: number, count: number): Promise<{ data: number[] }> {
//     return this.client.readHoldingRegisters(address, count);
//   }
// }

// // Define an interface for the Modbus client
// interface ModbusClient {
//   connect: (host: string, port: number, slaveId: number) => Promise<void>;
//   isOpen: boolean;
//   readInputRegisters: (address: number, count: number) => Promise<{ data: number[] }>;
//   readHoldingRegisters: (address: number, count: number) => Promise<{ data: number[] }>;
// }

// type AuthContext = ModbusClient;

// // Modbus register mappings based on Sungather config
// const MODBUS_REGISTERS = {
//   voltage: { address: 30001, type: 'input', multiplier: 0.1 },
//   current_production: { address: 30013, type: 'input', multiplier: 0.1 },
//   current_load: { address: 30025, type: 'input', multiplier: 0.1 },
//   daily_import: { address: 30037, type: 'input', multiplier: 0.1 },
//   export_to_grid: { address: 30049, type: 'input', multiplier: 0.1 },
//   import_from_grid: { address: 30061, type: 'input', multiplier: 0.1 }
// };

// export class ModbusSungrowDataAdapter implements IDataAdapter<AuthContext> {
//   private client: ModbusWrapper;
//   private host: string;
//   private port: number;
//   private slave: number;
//   private registerConfig: typeof MODBUS_REGISTERS;

//   constructor(
//     options: {
//       host?: string;
//       port?: number;
//       slave?: number;
//       registerOverrides?: Partial<typeof MODBUS_REGISTERS>;
//     } = {}
//   ) {
//     const {
//       host = '192.168.0.193',
//       port = 502,
//       slave = 0x01,
//       registerOverrides = {}
//     } = options;

//     this.host = host;
//     this.port = port;
//     this.slave = slave;
//     this.client = new ModbusWrapper();

//     // Merge default registers with any provided overrides
//     this.registerConfig = {
//       ...MODBUS_REGISTERS,
//       ...registerOverrides
//     };

//     // Log configuration for debugging
//     console.log('Modbus Configuration:', {
//       host: this.host,
//       port: this.port,
//       slave: this.slave,
//       registers: this.registerConfig
//     });
//   }

//   /**
//    * Attempt to find working register addresses by probing different ranges
//    */
//   async findWorkingRegisters(): Promise<Partial<typeof MODBUS_REGISTERS>> {
//     const probeRanges = [
//       { start: 30000, end: 30100 },  // Input registers
//       { start: 40000, end: 40100 },  // Holding registers
//       { start: 0, end: 1000 }        // Some devices use lower ranges
//     ];

//     const workingRegisters: Partial<typeof MODBUS_REGISTERS> = {};

//     // Ensure connection is established
//     await this.authenticate();

//     // Probe for each known field type
//     for (const field of Object.keys(MODBUS_REGISTERS) as Field[]) {
//       const originalRegister = MODBUS_REGISTERS[field];
      
//       for (const range of probeRanges) {
//         for (let address = range.start; address <= range.end; address++) {
//           try {
//             const result = originalRegister.type === 'input'
//               ? await this.client.readInputRegisters(address, 1)
//               : await this.client.readHoldingRegisters(address, 1);

//             // If we get a valid result, log and store the working address
//             if (result && result.data && result.data.length > 0) {
//               console.log(`Found working register for ${field}: ${address}`);
//               workingRegisters[field] = {
//                 ...originalRegister,
//                 address: address
//               };
//               break;  // Stop searching for this field once found
//             }
//           } catch {
//             // Ignore errors during probing
//             continue;
//           }
//         }

//         // If we found a working register for this field, move to next field
//         if (workingRegisters[field]) break;
//       }

//       // If no working register found, log a warning
//       if (!workingRegisters[field]) {
//         console.warn(`Could not find working register for field: ${field}`);
//       }
//     }

//     return workingRegisters;
//   }

//   async authenticate(): Promise<AuthContext> {
//     await this.client.connect(this.host, this.port, this.slave);
//     return this.client;
//   }

//   private async readRegister(registerConfig: { address: number, type: string, multiplier: number }): Promise<number> {
//     try {
//       if (!this.client.isOpen) {
//         await this.authenticate();
//       }

//       let result;
//       try {
//         result = registerConfig.type === 'input' 
//           ? await this.client.readInputRegisters(registerConfig.address, 1)
//           : await this.client.readHoldingRegisters(registerConfig.address, 1);
//       } catch (readError: any) {
//         // Log specific details about the read error
//         console.warn(`Failed to read register at ${registerConfig.address}:`, 
//           readError.message, 
//           readError.modbusCode ? `Modbus Code: ${readError.modbusCode}` : '');
        
//         // Return 0 or null for unsupported registers to prevent complete failure
//         return 0;
//       }

//       // Validate result before accessing
//       if (!result || !result.data || result.data.length === 0) {
//         console.warn(`No data returned for register at ${registerConfig.address}`);
//         return 0;
//       }

//       return result.data[0] * registerConfig.multiplier;
//     } catch (error) {
//       console.error('Unexpected error in readRegister:', error);
//       return 0;
//     }
//   }

//   async getValues(fields: Field[]): Promise<Record<Field, number>> {
//     const values: Partial<Record<Field, number>> = {};

//     for (const field of fields) {
//       const registerConfig = MODBUS_REGISTERS[field];
//       if (!registerConfig) {
//         throw new Error(`No Modbus register mapping for field: ${field}`);
//       }
//       values[field] = await this.readRegister(registerConfig);
//     }

//     return values as Record<Field, number>;
//   }

//   async getVoltage(): Promise<number> {
//     return this.readRegister(MODBUS_REGISTERS.voltage);
//   }

//   async getCurrentProduction(): Promise<number> {
//     return this.readRegister(MODBUS_REGISTERS.current_production);
//   }

//   async getDailyImportValue(): Promise<number> {
//     return this.readRegister(MODBUS_REGISTERS.daily_import);
//   }

//   async getLowestValueInLastXMinutes(field: string, minutes: number): Promise<number> {
//     // Validate the field is a valid Field type
//     if (!(field in MODBUS_REGISTERS)) {
//       throw new Error(`Invalid field: ${field}`);
//     }

//     // Note: This method requires historical data tracking which Modbus doesn't inherently support
//     // For now, it will just return the current value
//     console.warn(`getLowestValueInLastXMinutes not fully implemented for Modbus. Returning current value.`);
//     return this.readRegister(MODBUS_REGISTERS[field as Field]);
//   }
// }
