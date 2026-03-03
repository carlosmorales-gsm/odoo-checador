#!/usr/bin/env node

/**
 * Restaura los usuarios en el dispositivo ZKTeco a partir del barcode en Odoo.
 * Útil después de un clear-device para re-poblar el checador sin tocar Odoo.
 *
 * Lógica:
 *   - Lee todos los empleados de Odoo que ya tienen barcode (barcode = uid en ZKTeco)
 *   - Lee los usuarios actualmente en el dispositivo
 *   - Agrega los que faltan usando uid=barcode, userid=employee_id, name=employee.name
 *
 * Uso:
 *   node scripts/restore-device-users.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const zkClient = require('../src/zkteco/client');
const OdooClient = require('../src/odoo/client');
const config = require('../src/config');

(async () => {
  try {
    const odoo = new OdooClient(config.odoo);
    await odoo.authenticate();
    console.log('Odoo autenticado');

    const employees = await odoo.getAllEmployees(['id', 'name', 'barcode']);
    const withBarcode = employees.filter((e) => e.barcode);
    console.log(`Empleados en Odoo con barcode: ${withBarcode.length}\n`);

    if (withBarcode.length === 0) {
      console.log('No hay empleados con barcode en Odoo. Ejecuta primero enroll-employees.js');
      process.exit(0);
    }

    let totalRestored = 0;
    let totalErrors = 0;

    for (const device of config.zkteco.devices) {
      const label = `${device.name} (${device.ip})`;
      console.log(`=== ${label} ===`);

      const currentUsers = await zkClient.getUsers(device);
      const existingIds = new Set(currentUsers.map((u) => u.userId));
      console.log(`  Usuarios actuales en dispositivo: ${currentUsers.length}`);

      const missing = withBarcode.filter((e) => !existingIds.has(String(e.id)));
      console.log(`  Faltan: ${missing.length}`);

      if (missing.length === 0) {
        console.log('  Todos los usuarios ya están presentes.\n');
        continue;
      }

      let restored = 0;
      let errors = 0;

      for (const emp of missing) {
        try {
          await zkClient.setUser(device, {
            uid: parseInt(emp.barcode, 10),
            userid: emp.id,
            name: emp.name,
          });
          console.log(`  [OK] [${emp.id}] ${emp.name} → uid=${emp.barcode}`);
          restored++;
        } catch (err) {
          console.error(`  [ERR] [${emp.id}] ${emp.name}: ${err.message}`);
          errors++;
        }
      }

      console.log(`\n  Restaurados: ${restored} | Errores: ${errors}\n`);
      totalRestored += restored;
      totalErrors += errors;
    }

    console.log('========================================');
    console.log(`  Total restaurados: ${totalRestored}`);
    console.log(`  Total errores:     ${totalErrors}`);
    console.log('========================================\n');

    process.exit(totalErrors > 0 ? 1 : 0);
  } catch (err) {
    console.error('Error fatal:', err.message);
    process.exit(1);
  }
})();
