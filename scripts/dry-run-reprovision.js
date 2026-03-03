#!/usr/bin/env node

/**
 * Dry-run del reprovisionado de checadores nuevos.
 * Muestra qué dispositivos se considerarían "nuevos" (IP no en sync_state) y qué
 * pasos se ejecutarían (clear → usuarios desde Odoo → huellas desde fingerprints/)
 * sin conectar al dispositivo ni modificar nada.
 *
 * Uso:
 *   node scripts/dry-run-reprovision.js              # Todos los dispositivos
 *   node scripts/dry-run-reprovision.js --device "Oficina"  # Solo ese dispositivo
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const stateDb = require('../src/db/state');
const config = require('../src/config');
const OdooClient = require('../src/odoo/client');
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
    stateDb.init();

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
    await odoo.authenticate();
    console.log('Odoo autenticado\n');

    const employees = await odoo.getAllEmployees(['id', 'name', 'barcode']);
    const withBarcode = employees.filter((e) => e.barcode);
    const byEmployee = loadBackupsByEmployee();

    console.log('--- Reprovisionado (dry-run) ---\n');
    console.log(`Empleados en Odoo con barcode: ${withBarcode.length}`);
    console.log(`Respaldos de huellas en ${FINGERPRINTS_DIR}: ${byEmployee.size} empleados\n`);

    let anyWouldReprovision = false;

    for (const device of devices) {
      const label = `${device.name} (${device.ip})`;
      const lastSynced = stateDb.getLastSyncedTimestamp(device.ip);

      if (lastSynced !== null) {
        console.log(`=== ${label} ===`);
        console.log(`  Ya está en sync_state (último sync: ${lastSynced}). No se reprovisionaría.\n`);
        continue;
      }

      anyWouldReprovision = true;
      console.log(`=== ${label} ===`);
      console.log('  [NUEVO] IP no está en sync_state → se reprovisionaría:\n');
      console.log('  1. Se limpiaría el dispositivo (clearData: usuarios, huellas, logs).');
      console.log(`  2. Se añadirían ${withBarcode.length} usuarios desde Odoo (uid=barcode, userid=employee.id):`);
      for (const emp of withBarcode.slice(0, 10)) {
        console.log(`     - [${emp.id}] ${emp.name} → uid=${emp.barcode}`);
      }
      if (withBarcode.length > 10) {
        console.log(`     ... y ${withBarcode.length - 10} más`);
      }
      const withBackup = withBarcode.filter((e) => byEmployee.has(e.id));
      console.log(`  3. Se restaurarían huellas desde fingerprints/ para ${withBackup.length} usuarios (de ${withBarcode.length}):`);
      if (withBackup.length > 0) {
        for (const emp of withBackup.slice(0, 5)) {
          const b = byEmployee.get(emp.id);
          console.log(`     - [${emp.id}] ${emp.name} (${b.templates.length} template(s))`);
        }
        if (withBackup.length > 5) {
          console.log(`     ... y ${withBackup.length - 5} más`);
        }
      } else {
        console.log('     (ningún empleado con barcode tiene respaldo en fingerprints/)');
      }
      console.log('');
    }

    if (!anyWouldReprovision) {
      console.log('Ningún dispositivo se reprovisionaría: todos tienen entrada en sync_state.');
    }

    console.log('========================================');
    console.log('  DRY-RUN: no se modificó ningún dispositivo ni Odoo.');
    console.log('========================================\n');

    stateDb.close();
  } catch (err) {
    console.error('Error fatal:', err.message);
    process.exit(1);
  }
})();
