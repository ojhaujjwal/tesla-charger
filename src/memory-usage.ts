export const memoryUsageMB = (): number => process.memoryUsage().heapUsed / 1024 / 1024;
