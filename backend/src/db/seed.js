/**
 * seed.js — Inserts test employees and the 3 UI dealers into fieldtrack.
 * Usage: node src/db/seed.js
 * Safe to re-run: ON CONFLICT DO NOTHING on unique columns.
 */
require('dotenv').config({ override: true });
const { Client } = require('pg');
const bcrypt = require('bcryptjs');

const SALT_ROUNDS = 10;

async function seed() {
  // Ships well-known dev/test credentials (e.g. manager/manager123) — running
  // this against a production database would create real, guessable-password
  // accounts. Set SEED_ALLOW_PRODUCTION=true to override, e.g. for a
  // deliberate demo environment.
  if (process.env.NODE_ENV === 'production' && process.env.SEED_ALLOW_PRODUCTION !== 'true') {
    console.error('✗ Refusing to run seed.js with NODE_ENV=production (set SEED_ALLOW_PRODUCTION=true to override)');
    process.exit(1);
  }

  // See migrate.js — pg's Client has no default connection timeout, so a
  // momentarily slow/unreachable DB would otherwise hang this step forever
  // instead of failing fast, blocking npm start (and the deploy's health
  // check) behind it.
  const useSsl = process.env.DB_SSL === 'true';
  const client = new Client({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME     || 'fieldtrack',
    user:     process.env.DB_USER     || 'postgres',
    password: process.env.DB_PASSWORD || '',
    ssl:      useSsl ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } : false,
    connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT_MS || '10000'),
  });

  await client.connect();
  console.log('✓ Connected to fieldtrack');

  // ── Employees ──────────────────────────────────────────────────────────────
  const employees = [
    {
      name:     'Arun Kumar',
      phone:    '9876543210',
      username: 'arun.kumar',
      password: 'password123',
      role:     'rep',
      region:   'Coimbatore North',
    },
    {
      name:     'Divya Shree',
      phone:    '9876543211',
      username: 'divya.shree',
      password: 'password123',
      role:     'rep',
      region:   'Coimbatore South',
    },
    {
      name:     'Manager Admin',
      phone:    '9876543200',
      username: 'manager',
      password: 'manager123',
      role:     'manager',
      region:   'Coimbatore',
    },
  ];

  for (const emp of employees) {
    const hash = await bcrypt.hash(emp.password, SALT_ROUNDS);
    await client.query(
      `INSERT INTO employees (name, phone, username, password_hash, role, region)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (username) DO NOTHING`,
      [emp.name, emp.phone, emp.username, hash, emp.role, emp.region]
    );
    console.log(`✓ Employee: ${emp.username} (${emp.role}) — password: ${emp.password}`);
  }

  // ── Dealers ────────────────────────────────────────────────────────────────
  // Real coordinates for the Coimbatore areas used in the UI mock data.
  const dealers = [
    {
      name:           'Sri Balaji Hardware',
      address:        'RS Puram, Coimbatore, Tamil Nadu 641002',
      latitude:       11.0098,
      longitude:      76.9558,
      contact_person: 'Balaji Rajan',
      contact_phone:  '0422-2543210',
    },
    {
      name:           'Anand Tiles and Sanitary',
      address:        'Peelamedu, Coimbatore, Tamil Nadu 641004',
      latitude:       11.0234,
      longitude:      77.0012,
      contact_person: 'Anand Murugan',
      contact_phone:  '0422-2234567',
    },
    {
      name:           'Kovai Steel Traders',
      address:        'Gandhipuram, Coimbatore, Tamil Nadu 641012',
      latitude:       11.0168,
      longitude:      76.9558,
      contact_person: 'Selvam Kumar',
      contact_phone:  '0422-2312345',
    },
  ];

  for (const dealer of dealers) {
    // dealers has no unique constraint to hang an ON CONFLICT off of (unlike
    // employees.username), so re-running this script would otherwise insert
    // a fresh duplicate row every time — check by name first instead.
    const existing = await client.query('SELECT id FROM dealers WHERE name = $1', [dealer.name]);
    if (existing.rows.length > 0) {
      console.log(`- Dealer already exists: ${dealer.name}`);
      continue;
    }
    await client.query(
      `INSERT INTO dealers (name, address, latitude, longitude, contact_person, contact_phone)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        dealer.name,
        dealer.address,
        dealer.latitude,
        dealer.longitude,
        dealer.contact_person,
        dealer.contact_phone,
      ]
    );
    console.log(`✓ Dealer: ${dealer.name}`);
  }

  await client.end();
  console.log('\n✅ Seed complete!');
  console.log('Test credentials:');
  console.log('  Rep:     username=arun.kumar     password=password123');
  console.log('  Rep:     username=divya.shree    password=password123');
  console.log('  Manager: username=manager        password=manager123');
}

seed().catch((err) => {
  console.error('❌ Seed failed:', err.message);
  process.exit(1);
});
