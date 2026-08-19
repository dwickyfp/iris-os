import { eq } from "drizzle-orm";
import { pgDb } from "lib/db/pg/db.pg";
import { UserTable } from "lib/db/pg/schema.pg";
import { HARNESS_USER } from "../tests/harness/fixtures";

if (!process.env.POSTGRES_URL?.includes("127.0.0.1")) {
  throw new Error("Harness seeding requires loopback PostgreSQL");
}

const { auth } = await import("auth/auth-instance");
const result = await auth.api.signUpEmail({
  body: {
    email: HARNESS_USER.email,
    password: HARNESS_USER.password,
    name: HARNESS_USER.name,
  },
  headers: new Headers({ "content-type": "application/json" }),
});

if (!result.user)
  throw new Error("Better Auth did not create the Harness user");

await pgDb
  .update(UserTable)
  .set({ role: HARNESS_USER.role })
  .where(eq(UserTable.id, result.user.id));

console.log(`Seeded focused Better Auth user ${HARNESS_USER.email}`);
process.exit(0);
