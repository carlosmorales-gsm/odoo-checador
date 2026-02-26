#!/usr/bin/env node

/**
 * Prueba de concepto: conectar a Odoo via JSON-RPC.
 *
 * Uso:
 *   node test-odoo.js
 */

require('dotenv').config();
const OdooClient = require('./src/odoo/client');

async function main() {
  const { ODOO_URL, ODOO_DB, ODOO_USER, ODOO_API_KEY } = process.env;

  console.log('='.repeat(60));
  console.log('Test conexión a Odoo');
  console.log('='.repeat(60));
  console.log(`URL:  ${ODOO_URL}`);
  console.log(`DB:   ${ODOO_DB}`);
  console.log(`User: ${ODOO_USER}`);
  console.log('');

  const odoo = new OdooClient({
    url: ODOO_URL.replace(/\/+$/, ''),
    db: ODOO_DB,
    user: ODOO_USER,
    apiKey: ODOO_API_KEY,
  });

  // 1. Autenticación
  console.log('--- AUTENTICACIÓN ---');
  try {
    const uid = await odoo.authenticate();
    console.log(`OK — uid: ${uid}\n`);
  } catch (err) {
    console.error(`FALLÓ: ${err.message}`);
    process.exit(1);
  }

  // 2. Buscar empleados
  console.log('--- EMPLEADOS ---');
  try {
    const ids = await odoo._call('hr.employee', 'search', [[]], { limit: 200 });
    console.log(`Total empleados: ${ids.length}\n`);

    if (ids.length > 0) {
      const employees = await odoo._call('hr.employee', 'read', [ids, ['id', 'name', 'x_zkteco_user_id']]);
      console.log('ID\tZKTeco ID\tNombre');
      console.log('-'.repeat(60));
      for (const emp of employees) {
        const zkId = emp.x_zkteco_user_id || '(vacío)';
        console.log(`${emp.id}\t${zkId}\t\t${emp.name}`);
      }
    }
  } catch (err) {
    if (err.message.includes('x_zkteco_user_id')) {
      console.log('El campo x_zkteco_user_id NO existe en hr.employee.');
      console.log('Necesitas crearlo en Odoo (Settings → Technical → Fields o con Studio).\n');

      // Listar empleados sin el campo custom
      const ids = await odoo._call('hr.employee', 'search', [[]], { limit: 200 });
      const employees = await odoo._call('hr.employee', 'read', [ids, ['id', 'name']]);
      console.log(`Total empleados: ${ids.length}\n`);
      console.log('ID\tNombre');
      console.log('-'.repeat(40));
      for (const emp of employees) {
        console.log(`${emp.id}\t${emp.name}`);
      }
    } else {
      console.error(`Error: ${err.message}`);
    }
  }

  // 3. Últimas asistencias
  console.log('\n--- ÚLTIMAS ASISTENCIAS ---');
  try {
    const ids = await odoo._call('hr.attendance', 'search', [[]], { limit: 10, order: 'check_in desc' });
    if (ids.length === 0) {
      console.log('No hay registros de asistencia.');
    } else {
      const records = await odoo._call('hr.attendance', 'read', [ids, ['id', 'employee_id', 'check_in', 'check_out']]);
      console.log('ID\tEmpleado\t\t\tCheck-in\t\tCheck-out');
      console.log('-'.repeat(90));
      for (const r of records) {
        const name = (Array.isArray(r.employee_id) ? r.employee_id[1] : r.employee_id || '').toString().substring(0, 25).padEnd(25);
        const cout = r.check_out || '(abierto)';
        console.log(`${r.id}\t${name}\t${r.check_in}\t\t${cout}`);
      }
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
