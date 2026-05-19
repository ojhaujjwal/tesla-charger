import { NodeHttpServer } from "@effect/platform-node";
import { createServer } from "node:http";

export const httpServerLayer = (port: number) => NodeHttpServer.layer(createServer, { port });
