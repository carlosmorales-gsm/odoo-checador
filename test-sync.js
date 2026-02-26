#!/usr/bin/env node

/**
 * Prueba de sync hardcodeada para Carlos Alberto Morales Heras (employee_id: 2).
 * Simula checadas del ZKTeco y las manda a Odoo.
 *
 * Uso:
 *   node test-sync.js              # crea check-in si no hay abierto, o check-out si hay
 *   node test-sync.js checkin      # forzar check-in
 *   node test-sync.js checkout     # forzar check-out
 *   node test-sync.js ver          # solo ver asistencias actuales
 */

require('dotenv').config();
const OdooClient = require('./src/odoo/client');

const EMPLOYEE_ID = 2;
const EMPLOYEE_NAME = 'CARLOS ALBERTO MORALES HERAS';

function nowUTC() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

async function main() {
  const action = (process.argv[2] || '').toLowerCase();

  const odoo = new OdooClient({
    url: process.env.ODOO_URL.replace(/\/+$/, ''),
    db: process.env.ODOO_DB,
    user: process.env.ODOO_USER,
    apiKey: process.env.ODOO_API_KEY,
  });

  console.log('Autenticando...');
  await odoo.authenticate();
  console.log('OK\n');

  // Ver asistencia abierta
  const open = await odoo.getLastOpenAttendance(EMPLOYEE_ID);

  if (action === 'ver') {
    // Solo mostrar asistencias
  } else if (action === 'checkin' || (!action && !open)) {
    // Crear check-in
    const ts = nowUTC();
    console.log(`Creando CHECK-IN para ${EMPLOYEE_NAME} a las ${ts}...`);
    const id = await odoo.createCheckIn(EMPLOYEE_ID, ts);
    console.log(`Check-in creado — attendance #${id}\n`);

  } else if (action === 'checkout' || (!action && open)) {
    if (!open) {
      console.log('No hay asistencia abierta para hacer check-out.');
      return;
    }
    const ts = nowUTC();
    console.log(`Creando CHECK-OUT para ${EMPLOYEE_NAME} a las ${ts}...`);
    await odoo.updateCheckOut(open.id, ts);
    console.log(`Check-out registrado en attendance #${open.id}\n`);
  }

  // Mostrar asistencias de Carlos
  console.log(`--- ASISTENCIAS DE ${EMPLOYEE_NAME} ---\n`);
  const ids = await odoo._call('hr.attendance', 'search', [
    [['employee_id', '=', EMPLOYEE_ID]],
  ], { order: 'check_in desc', limit: 20 });

  if (ids.length === 0) {
    console.log('No hay registros.');
    return;
  }

  const records = await odoo._call('hr.attendance', 'read', [
    ids,
    ['id', 'check_in', 'check_out'],
  ]);

  console.log('ID\tCheck-in\t\tCheck-out\t\tDuración');
  console.log('-'.repeat(80));
  for (const r of records) {
    const cout = r.check_out || '(abierto)';
    let duracion = '';
    if (r.check_out) {
      const ms = new Date(r.check_out) - new Date(r.check_in);
      const mins = Math.floor(ms / 60000);
      const hrs = Math.floor(mins / 60);
      const m = mins % 60;
      duracion = `${hrs}h ${m}m`;
    }
    console.log(`${r.id}\t${r.check_in}\t\t${cout}\t\t${duracion}`);
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
