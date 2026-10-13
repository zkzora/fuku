import { PrismaClient } from "@prisma/client";
import { PrismaLibSQL } from "@prisma/adapter-libsql";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Local runs use the SQLite file in DATABASE_URL. A hosted deployment (Vercel) has no writable
 * disk, so it sets TURSO_DATABASE_URL and TURSO_AUTH_TOKEN and talks to Turso (hosted SQLite,
 * same schema) through the libSQL driver adapter.
 */
function createClient() {
  const log: ("warn" | "error")[] = process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"];
  const tursoUrl = process.env.TURSO_DATABASE_URL?.trim();
  if (tursoUrl) {
    // intMode "bigint": in the default mode, integers above 2^31 (amountMicros of 4,800 USDC) come
    // back as floats and Prisma rejects them ("number must be an integer").
    const adapter = new PrismaLibSQL({ url: tursoUrl, authToken: process.env.TURSO_AUTH_TOKEN?.trim(), intMode: "bigint" });
    return new PrismaClient({ adapter, log });
  }
  return new PrismaClient({ log });
}

export const db = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
