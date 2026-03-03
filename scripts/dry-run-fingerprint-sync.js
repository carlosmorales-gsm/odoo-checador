#!/usr/bin/env node

/**
 * Dry-run del sync de huellas faltantes (usuarios Odoo sin huellas en cada checador → desde respaldo).
 * Conecta a Odoo y a cada dispositivo para detectar quiénes no tienen huellas; si existe respaldo
 * en fingerprints/, muestra que se les subirían los templates. No escribe nada en los dispositivos.
 *
 * Uso:
 *   node scripts/dry-run-fingerprint-sync.js              # Todos los dispositivos
 *   node scripts/dry-run-fingerprint-sync.js --device "Oficina"  # Solo ese dispositivo
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const config = require('../src/config');
const OdooClient = require('../src/odoo/client');
const { syncMissingFingerprintsToDevice } = require('../src/sync/fingerprint-restore');
const { loadBackupsByEmployee, FINGERPRINTS_DIR } = require('../src/sync/fingerprint-restore');

function parseArgs() {
  const args = process.argv.slice(2);
  const deviceIdx = args.indexOf('--device');
  return {
    deviceName: deviceIdx !== -1 ? args[deviceIdx + 1] : null,
  };
}

(async () => {
  try {
    const { deviceName } = parseArgs();
    let devices = config.zkteco.devices;
    if (deviceName) {
      devices = devices.filter((d) => d.name === deviceName);
      if (devices.length === 0) {
        console.error(`No se encontró el dispositivo "${deviceName}".`);
        console.error('Dispositivos configurados:', config.zkteco.devices.map((d) => d.name).join(', '));
        process.exit(1);
      }
    }

    const odoo = new OdooClient(config.odoo);
    console.log('Cargando... Autenticando con Odoo...');
    await odoo.authenticate();
    console.log('Odoo autenticado.\n');

    const byEmployee = loadBackupsByEmployee();
    console.log('--- Sync huellas faltantes (dry-run) ---\n');
    console.log(`Respaldos en ${FINGERPRINTS_DIR}: ${byEmployee.size} empleados`);
    console.log(`Dispositivo(s): ${devices.map((d) => d.name).join(', ')}\n`);

    let totalWouldRestore = 0;

    for (const device of devices) {
      const label = `${device.name} (${device.ip})`;
      console.log(`=== ${label} ===`);
      console.log('  Conectando y revisando usuarios (puede tardar)...');

      const result = await syncMissingFingerprintsToDevice(device, odoo, { dryRun: true });

      if (result.wouldRestore && result.wouldRestore.length > 0) {
        console.log(`  Se subirían huellas desde respaldo para ${result.wouldRestore.length} usuario(s):`);
        for (const u of result.wouldRestore) {
          console.log(`    - [${u.employeeId}] ${u.name} (uid=${u.uid}) — ${u.templateCount} template(s)`);
        }
        totalWouldRestore += result.wouldRestore.length;
      } else {
        console.log('  Ningún usuario sin huellas con respaldo en fingerprints/.');
      }
      console.log(`  (${result.skipped} usuario(s) ya tienen huellas en el dispositivo)\n`);
    }

    console.log('========================================');
    console.log(`  Total que se sincronizarían: ${totalWouldRestore} usuario(s)`);
    console.log('  DRY-RUN: no se modificó ningún dispositivo.');
    console.log('========================================\n');
  } catch (err) {
    console.error('Error fatal:', err.message);
    process.exit(1);
  }
})();
