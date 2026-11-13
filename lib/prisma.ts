import "dotenv/config";
import { neonConfig } from "@neondatabase/serverless";
import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaClient } from "../generated/prisma/client.js";
import { WebSocket } from "ws";

// Run Prisma over the Neon serverless driver using persistent WebSockets
// (HTTPS/443). Startup retries only the read-only connection check, never
// application writes (which could otherwise be duplicated).
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

// Avoid the unreliable IPv6 route on this development network.
class IPv4WebSocket extends WebSocket {
  constructor(address: string, protocols?: string | string[]) {
    super(address, protocols, { family: 4 });
  }
}
neonConfig.webSocketConstructor = IPv4WebSocket;

const adapter = new PrismaNeon({ connectionString, max: 5 }, {
  onConnectionError: (err) => console.error("Neon connection error:", err.message),
});
const prisma = new PrismaClient({ adapter });

// Retry the first query until a WebSocket pool connection is established;
// the flaky local network can drop several handshakes before one gets through.
export async function warmupDb(maxAttempts = 15): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500 * Math.min(attempt, 4)));
    }
  }
  throw new Error("Could not establish a database connection");
}

export { prisma };
