#!/usr/bin/env node

/**
 * Limpia TODOS los datos del dispositivo ZKTeco:
 * usuarios, templates biométricos (huellas/cara) y registros de asistencia.
 *
 * Después de ejecutar este script vuelve a correr:
 *   node scripts/enroll-employees.js
 *
 * Uso:
 *   node scripts/clear-device.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const ZKTeco = require('zkteco-js');
const config = require('../src/config');

(async () => {
  for (const deviceConfig of config.zkteco.devices) {
    const label = `${deviceConfig.name} (${deviceConfig.ip})`;
    console.log(`\nConectando a ${label}...`);

    const device = new ZKTeco(deviceConfig.ip, deviceConfig.port, 10000, 10000);

    try {
      await device.createSocket();
      console.log('  Conexión OK');

      const info = await device.getInfo();
      console.log(`  Antes — usuarios: ${info.userCounts}, logs: ${info.logCounts}`);

      await device.disableDevice();
      await device.clearData();
      await device.enableDevice();

      const infoAfter = await device.getInfo();
      console.log(`  Después — usuarios: ${infoAfter.userCounts}, logs: ${infoAfter.logCounts}`);
      console.log(`  ✓ ${label} limpiado correctamente`);
    } catch (err) {
      console.error(`  ERROR en ${label}: ${err.message}`);
      process.exitCode = 1;
    } finally {
      try { await device.disconnect(); } catch {}
    }
  }

  console.log('\nListo. Ahora ejecuta: node scripts/enroll-employees.js\n');
})();
