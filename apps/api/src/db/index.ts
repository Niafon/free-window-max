import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from './schema.js';
export function createDatabase(url: string) {
  const pool = new pg.Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
  return { pool, db: drizzle(pool, { schema }) };
}
export type Database = ReturnType<typeof createDatabase>;
export async function migrate({ db }: Database) {
  await db.execute(sql.raw(`
    CREATE EXTENSION IF NOT EXISTS postgis;
    CREATE TABLE IF NOT EXISTS users(id text PRIMARY KEY, name text NOT NULL, interests jsonb NOT NULL DEFAULT '[]', last_seen timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS planning_sessions(id uuid PRIMARY KEY, owner_id text NOT NULL, title text NOT NULL, selected_id text, search_id uuid, revision integer NOT NULL DEFAULT 0, expires_at timestamptz NOT NULL);
    CREATE TABLE IF NOT EXISTS session_members(session_id uuid REFERENCES planning_sessions(id) ON DELETE CASCADE, user_id text NOT NULL, name text NOT NULL, preferences jsonb, PRIMARY KEY(session_id,user_id));
    CREATE TABLE IF NOT EXISTS searches(id uuid PRIMARY KEY, user_id text NOT NULL, session_id uuid, preferences jsonb NOT NULL, result jsonb, expires_at timestamptz NOT NULL);
    CREATE TABLE IF NOT EXISTS plans(id uuid PRIMARY KEY, user_id text NOT NULL, search_id uuid NOT NULL, event_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
    ALTER TABLE searches ADD COLUMN IF NOT EXISTS selection_options jsonb;
    ALTER TABLE plans ADD COLUMN IF NOT EXISTS snapshot jsonb;
    CREATE TABLE IF NOT EXISTS feedback(user_id text NOT NULL, event_id text NOT NULL, value integer NOT NULL CHECK(value IN(-1,1)), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,event_id));
    CREATE TABLE IF NOT EXISTS venues(id text PRIMARY KEY, name text NOT NULL, location geography(Point,4326) NOT NULL);
    CREATE INDEX IF NOT EXISTS venues_location_idx ON venues USING gist(location);
    CREATE TABLE IF NOT EXISTS events(id text PRIMARY KEY, venue_id text NOT NULL REFERENCES venues(id), payload jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS bot_dialogs(user_id text PRIMARY KEY, state jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS bot_updates(id text PRIMARY KEY, expires_at timestamptz NOT NULL);
    CREATE TABLE IF NOT EXISTS metrics(id bigserial PRIMARY KEY, kind text NOT NULL, duration_ms integer, result_count integer, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS provider_quota(day date PRIMARY KEY, used integer NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS bot_followups(plan_id uuid PRIMARY KEY, user_id bigint NOT NULL, event_id text NOT NULL, title text NOT NULL, due_at timestamptz NOT NULL, sent_at timestamptz, answer boolean);
    CREATE INDEX IF NOT EXISTS bot_followups_due_idx ON bot_followups(due_at) WHERE sent_at IS NULL;
  `));
}
export async function cleanup({ pool }: Database) {
  await pool.query(`DELETE FROM plans WHERE created_at < now() - interval '24 hours'; DELETE FROM searches WHERE expires_at < now(); DELETE FROM planning_sessions WHERE expires_at < now(); DELETE FROM bot_dialogs WHERE updated_at < now() - interval '24 hours'; DELETE FROM bot_updates WHERE expires_at < now(); DELETE FROM bot_followups WHERE due_at < now() - interval '3 days'; DELETE FROM feedback WHERE updated_at < now() - interval '30 days'; DELETE FROM users WHERE last_seen < now() - interval '30 days'; DELETE FROM metrics WHERE created_at < now() - interval '30 days'; DELETE FROM events WHERE updated_at < now() - interval '1 day';`);
}
