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

async function migrate() {
  // Step 1: connect to the default "postgres" db to create fieldtrack db
  const adminClient = new Client({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '5432'),
    database: 'postgres',
    user:     process.env.DB_USER     || 'postgres',
    password: process.env.DB_PASSWORD || '',
  });

  await adminClient.connect();
  console.log('✓ Connected to postgres (admin)');

  const dbName = process.env.DB_NAME || 'fieldtrack';
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

  // Step 2: connect to fieldtrack and apply schema
  const appClient = new Client({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '5432'),
    database: dbName,
    user:     process.env.DB_USER     || 'postgres',
    password: process.env.DB_PASSWORD || '',
  });

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
