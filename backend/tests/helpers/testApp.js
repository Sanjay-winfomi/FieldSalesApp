/**
 * testApp.js — mounts a route module on a minimal Express app for supertest,
 * with a fake auth middleware (bypassing real JWT verification) so route
 * tests can focus on the route's own logic against a mocked pool.
 */
const express = require('express');

function makeApp(router, { basePath = '/api/x', employee = { id: 1, role: 'rep', username: 'testuser' } } = {}) {
  const app = express();
  app.use(express.json());
  app.use(basePath, (req, res, next) => {
    req.employee = employee;
    next();
  }, router);
  return app;
}

module.exports = { makeApp };
