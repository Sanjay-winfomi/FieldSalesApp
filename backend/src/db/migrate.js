/**
 * migrate.js — Creates the fieldtrack database (if needed) then runs schema.sql.
 * Usage: node src/db/migrate.js
 *
 * WHY PLAIN SQL MIGRATIONS (not Prisma/Drizzle)?
 * - Zero ORM magic: every column and index is exactly what you write.
 * - Schema is easy to read for the whole team, not hidden in generated code.
 * - Prisma/Drizzle add value for type-safe clients; we'll add that in Phase 2
 *   when the schema stabilises after photos and hierarchy columns are added.
 */
require('dotenv').config({ override: true });
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// pg's Client has no default connection timeout — if the DB is momentarily
// slow or unreachable, .connect() hangs forever rather than rejecting, which
// on a host like Render means the process never reaches app.listen() and the
// deploy's health check eventually times out waiting for a response that was
// never coming. A generous-but-finite timeout turns that into a fast, clear
// failure instead. Mirrors pool.js's ssl/timeout handling for the same reason.
function clientConfig(database) {
  const useSsl = process.env.DB_SSL === 'true';
  return {
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '5432'),
    database,
    user:     process.env.DB_USER     || 'postgres',
    password: process.env.DB_PASSWORD || '',
    ssl:      useSsl ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } : false,
    connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT_MS || '10000'),
  };
}

async function migrate() {
  const dbName = process.env.DB_NAME || 'fieldtrack';

  // Step 1: connect to the default "postgres" db to create the app database
  // if it's missing. This only works against a self-managed Postgres where
  // the app user has CREATEDB and the admin "postgres" database is reachable
  // — most managed providers (Render, RDS, etc.) provision exactly one
  // database per instance up front and lock down access to just that one, so
  // this step is expected to fail there. That's fine: the database already
  // exists in that case, so we just skip ahead to applying the schema.
  try {
    const adminClient = new Client(clientConfig('postgres'));

    await adminClient.connect();
    console.log('✓ Connected to postgres (admin)');

    const exists = await adminClient.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [dbName]
    );

    if (exists.rows.length === 0) {
      await adminClient.query(`CREATE DATABASE "${dbName}"`);
      console.log(`✓ Created database: ${dbName}`);
    } else {
      console.log(`ℹ Database already exists: ${dbName}`);
    }

    await adminClient.end();
  } catch (err) {
    console.log(`ℹ Skipping database creation (${err.message}) — assuming "${dbName}" already exists, as it does on managed hosts like Render.`);
  }

  // Step 2: connect to fieldtrack and apply schema
  const appClient = new Client(clientConfig(dbName));

  await appClient.connect();
  console.log(`✓ Connected to ${dbName}`);

  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await appClient.query(sql);
  console.log('✓ Schema applied — all 4 tables created/verified');

  await appClient.end();
  console.log('✅ Migration complete. Run `node src/db/seed.js` next.');
}

migrate().catch((err) => {
  console.error('❌ Migration failed:', err.message);
  process.exit(1);
});
