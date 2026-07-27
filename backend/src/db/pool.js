require('dotenv').config({ override: true });
const { Pool } = require('pg');
const logger = require('../utils/logger');

// Most managed Postgres providers (Render, Heroku, RDS with enforced SSL)
// require SSL and reject plain connections outright — DB_SSL lets a
// production deploy opt in without code changes. rejectUnauthorized is left
// configurable since many providers issue certs that don't chain to a
// standard root store the way it's set up by default.
const useSsl = process.env.DB_SSL === 'true';

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'fieldtrack',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
  ssl:      useSsl ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } : false,
  max:                  parseInt(process.env.DB_POOL_MAX || '10'),
  idleTimeoutMillis:    parseInt(process.env.DB_IDLE_TIMEOUT_MS || '30000'),
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT_MS || '5000'),
});

pool.on('error', (err) => {
  logger.error('Unexpected PostgreSQL client error', { error: err.message, stack: err.stack });
});

module.exports = pool;
