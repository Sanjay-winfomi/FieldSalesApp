/**
 * dealers.routes.js — Stage 5
 *
 * GET /api/dealers         — list all dealers (supports ?search= query param)
 */
const express = require('express');
const pool    = require('../db/pool');

const router = express.Router();

// GET /api/dealers
router.get('/', async (req, res) => {
  const { search } = req.query;

  try {
    let query, params;

    if (search && search.trim()) {
      const pattern = `%${search.trim()}%`;
      query = `
        SELECT id, name, address, latitude, longitude, contact_person, contact_phone, radius_meters
        FROM dealers
        WHERE name ILIKE $1 OR address ILIKE $1
        ORDER BY name
      `;
      params = [pattern];
    } else {
      query = `
        SELECT id, name, address, latitude, longitude, contact_person, contact_phone, radius_meters
        FROM dealers
        ORDER BY name
      `;
      params = [];
    }

    const result = await pool.query(query, params);
    return res.json({ dealers: result.rows });
  } catch (err) {
    console.error('GET /api/dealers error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
