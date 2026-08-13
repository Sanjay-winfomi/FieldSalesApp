/**
 * create-demo-manager.js — one-off script to create the demo manager
 * account (username 'demo.manager') used for live demos. This account's
 * Visit Plan tab is hidden client-side (see web/src/views/AdminPage.jsx),
 * without removing the Dealer Assignment feature itself for any other
 * manager account.
 * Usage: node src/db/create-demo-manager.js
 * Safe to re-run: ON CONFLICT DO NOTHING on the unique username column.
 */
require('dotenv').config({ override: true });
const { Client } = require('pg');
const bcrypt = require('bcryptjs');

const SALT_ROUNDS = 10;

const DEMO_MANAGER = {
  name: 'Demo Manager',
  phone: '9999999999',
  username: 'demo.manager',
  password: 'demo1234',
  role: 'manager',
  region: 'Demo',
};

async function run() {
  // This creates a full-privilege manager account with a hardcoded,
  // publicly-known-in-source password — the ONLY restriction on it
  // (hiding one tab) is client-side in the web app and doesn't stop the
  // mobile app, the API directly, or any other web feature. Guard against
  // running this by accident against a real production database; pass
  // ALLOW_DEMO_ACCOUNT=true explicitly if a prod demo account is truly
  // intended.
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_ACCOUNT !== 'true') {
    console.error(
      '❌ Refusing to create the demo manager account with NODE_ENV=production. ' +
      'Set ALLOW_DEMO_ACCOUNT=true if this is intentional.'
    );
    process.exit(1);
  }

  const useSsl = process.env.DB_SSL === 'true';
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'fieldtrack',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    ssl: useSsl ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } : false,
    connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT_MS || '10000'),
  });

  await client.connect();
  console.log('✓ Connected to', process.env.DB_NAME || 'fieldtrack');

  const hash = await bcrypt.hash(DEMO_MANAGER.password, SALT_ROUNDS);
  const result = await client.query(
    `INSERT INTO employees (name, phone, username, password_hash, role, region)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (username) DO NOTHING
     RETURNING id`,
    [DEMO_MANAGER.name, DEMO_MANAGER.phone, DEMO_MANAGER.username, hash, DEMO_MANAGER.role, DEMO_MANAGER.region]
  );

  if (result.rows.length > 0) {
    console.log(`✓ Created demo manager: username=${DEMO_MANAGER.username} password=${DEMO_MANAGER.password} (id=${result.rows[0].id})`);
  } else {
    console.log(`- Username '${DEMO_MANAGER.username}' already exists — left untouched.`);
  }

  await client.end();
}

run().catch((err) => {
  console.error('❌ Failed:', err.message);
  process.exit(1);
});
