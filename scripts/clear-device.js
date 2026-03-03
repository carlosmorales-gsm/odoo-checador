#!/usr/bin/env node

/**
 * Limpia TODOS los datos del dispositivo ZKTeco:
 * usuarios, templates biométricos (huellas/cara) y registros de asistencia.
 *
 * Después de ejecutar este script vuelve a correr:
 *   node scripts/enroll-employees.js
 *
 * Uso:
 *   node scripts/clear-device.js                    # Todos los dispositivos
 *   node scripts/clear-device.js --device "Oficina" # Solo el dispositivo indicado
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const ZKTeco = require('zkteco-js');
const config = require('../src/config');

function parseArgs() {
  const args = process.argv.slice(2);
  const deviceIdx = args.indexOf('--device');
  return {
    deviceName: deviceIdx !== -1 ? args[deviceIdx + 1] : null,
  };
}

(async () => {
  const { deviceName } = parseArgs();
  let devices = config.zkteco.devices;
  if (deviceName) {
    devices = devices.filter((d) => d.name === deviceName);
    if (devices.length === 0) {
      console.error(`No se encontró el dispositivo "${deviceName}".`);
      console.error('Dispositivos configurados:', config.zkteco.devices.map((d) => d.name).join(', '));
      process.exit(1);
    }
  } else {
    console.log('Advertencia: se limpiarán TODOS los dispositivos configurados.\n');
  }

  for (const deviceConfig of devices) {
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
