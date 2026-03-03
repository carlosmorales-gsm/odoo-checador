#!/usr/bin/env node

/**
 * Quita un dispositivo de sync_state para forzar reprovisionado en el próximo sync.
 * Uso:
 *   node scripts/reset-device-sync.js 10.1.20.185
 *   node scripts/reset-device-sync.js "Fune Navolato"
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const stateDb = require('../src/db/state');
const config = require('../src/config');

const arg = process.argv[2];
if (!arg) {
  console.error('Uso: node scripts/reset-device-sync.js <IP|nombre>');
  console.error('  Ejemplo: node scripts/reset-device-sync.js 10.1.20.185');
  console.error('  Ejemplo: node scripts/reset-device-sync.js "Fune Navolato"');
  process.exit(1);
}

stateDb.init();

const devices = config.zkteco.devices;
const byIp = devices.find((d) => d.ip === arg);
const byName = devices.find((d) => d.name === arg);
const device = byIp || byName;

const ip = device ? device.ip : arg;

const result = stateDb.deleteSyncState(ip);
stateDb.close();

if (result.changes > 0) {
  console.log(`OK: eliminado sync_state de ${ip}${device ? ` (${device.name})` : ''}. Próximo sync hará reprovisionado.`);
} else {
  console.log(`No había registro para ${ip}${device ? ` (${device.name})` : ''}. Nada que borrar.`);
}

process.exit(0);
