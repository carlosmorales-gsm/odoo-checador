#!/usr/bin/env node

/**
 * Ejecuta una sincronización de asistencia de forma manual (una sola vez).
 *
 * Uso:
 *   node scripts/run-sync.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const stateDb = require('../src/db/state');
const { syncAll } = require('../src/sync/attendance');

(async () => {
  stateDb.init();
  try {
    await syncAll();
  } finally {
    stateDb.close();
  }
})();
