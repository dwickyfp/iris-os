// import { Logger } from "drizzle-orm";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

// class MyLogger implements Logger {
//   logQuery(query: string, params: unknown[]): void {
//     console.log({ query, params });
//   }
// }

/**
 * Explicit pool size: node-postgres defaults to 10 per process, and the web
 * process additionally shares Postgres with two workers plus the pg-boss
 * pool (see lib/jobs/pg-boss). Size every pool consciously so the total
 * stays under max_connections.
 */
export const PG_POOL_MAX = Number(process.env.PG_POOL_MAX ?? 20);

export const pgDb = drizzlePg(
  new Pool({
    connectionString: process.env.POSTGRES_URL!,
    max: PG_POOL_MAX,
  }),
  //   logger: new MyLogger(),
  {},
);
