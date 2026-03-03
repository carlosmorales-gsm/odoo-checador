#!/usr/bin/env node

/**
 * Enrollment manual de empleados Odoo → ZKTeco.
 *
 * Uso:
 *   node scripts/enroll-employees.js --dry-run   # Solo preview
 *   node scripts/enroll-employees.js              # Ejecucion real
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { enrollNewEmployees } = require('../src/sync/enrollment');

const dryRun = process.argv.includes('--dry-run');

(async () => {
  try {
    const result = await enrollNewEmployees({ dryRun });

    console.log('\n========================================');
    console.log(dryRun ? '  RESULTADO DRY-RUN (sin cambios)' : '  RESULTADO ENROLLMENT');
    console.log('========================================');
    console.log(`  Registrados: ${result.enrolled}`);
    console.log(`  Errores:     ${result.errors}`);

    if (result.details.length > 0) {
      console.log('\n  Detalle:');
      for (const d of result.details) {
        const uid = d.uid ? ` → uid=${d.uid}` : '';
        console.log(`    [${d.employeeId}] ${d.name}${uid} (${d.action})`);
      }
    }

    console.log('========================================\n');
    process.exit(result.errors > 0 ? 1 : 0);
  } catch (err) {
    console.error('Error fatal:', err.message);
    process.exit(1);
  }
})();
