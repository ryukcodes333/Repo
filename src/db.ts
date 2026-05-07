import { sql } from "drizzle-orm";
  import { index, jsonb, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";
  import { drizzle } from "drizzle-orm/node-postgres";
  import pg from "pg";

  const { Pool } = pg;

  // ── Auth tables (required for Replit Auth) ──────────────────────────────────

  export const sessionsTable = pgTable(
    "sessions",
    {
      sid: varchar("sid").primaryKey(),
      sess: jsonb("sess").notNull(),
      expire: timestamp("expire").notNull(),
    },
    (table) => [index("IDX_session_expire").on(table.expire)],
  );

  export const usersTable = pgTable("users", {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    email: varchar("email").unique(),
    firstName: varchar("first_name"),
    lastName: varchar("last_name"),
    profileImageUrl: varchar("profile_image_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  });

  export type UpsertUser = typeof usersTable.$inferInsert;
  export type User = typeof usersTable.$inferSelect;

  // ── Database connection ─────────────────────────────────────────────────────

  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL must be set. Did you forget to provision a database?",
    );
  }

  const schema = { sessionsTable, usersTable };

  export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  export const db = drizzle(pool, { schema });
  