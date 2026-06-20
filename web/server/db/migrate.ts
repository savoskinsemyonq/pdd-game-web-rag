import { isDbAvailable, query } from "./pool.js";

export async function runMigrations(): Promise<void> {
  if (!isDbAvailable()) return;

  await query(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE`,
  );
}
