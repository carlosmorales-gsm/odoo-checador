#!/usr/bin/env node

/**
 * Dry-run: detecta asistencias abiertas en Odoo y simula qué pasaría
 * si cada empleado checara AHORA con las reglas de auto-cierre.
 *
 * No escribe nada en Odoo ni en SQLite.
 *
 * Uso: node scripts/dry-run-stale-attendances.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const OdooClient = require('../src/odoo/client');
const config = require('../src/config');

function addHoursUTC(utcStr, hours) {
  const d = new Date(utcStr.replace(' ', 'T') + 'Z');
  d.setTime(d.getTime() + hours * 3_600_000);
  return d.toISOString().replace('T', ' ').substring(0, 19);
}

function diffHoursUTC(utcA, utcB) {
  const a = new Date(utcA.replace(' ', 'T') + 'Z');
  const b = new Date(utcB.replace(' ', 'T') + 'Z');
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return Infinity;
  return (a.getTime() - b.getTime()) / 3_600_000;
}

(async () => {
  try {
    const odoo = new OdooClient(config.odoo);
    await odoo.authenticate();

    const nowUTC = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const { staleThresholdHours, autoCloseHours } = config.sync;

    console.log('=== Dry-run: Asistencias abiertas en Odoo ===');
    console.log(`Ahora (UTC):              ${nowUTC}`);
    console.log(`STALE_THRESHOLD_HOURS:    ${staleThresholdHours}`);
    console.log(`AUTO_CLOSE_HOURS:         ${autoCloseHours}`);
    console.log('');

    const cutoff = new Date(Date.now() - 168 * 60 * 60 * 1000)
      .toISOString().replace('T', ' ').substring(0, 19);

    const BATCH = 200;
    let offset = 0;
    const allOpen = [];

    while (true) {
      const ids = await odoo._call('hr.attendance', 'search', [
        [
          ['check_out', '=', false],
          ['check_in', '>=', cutoff],
        ],
      ], { limit: BATCH, offset, order: 'check_in asc' });
      if (!ids || ids.length === 0) break;
      const records = await odoo._call('hr.attendance', 'read', [
        ids,
        ['id', 'employee_id', 'check_in', 'check_out'],
      ]);
      allOpen.push(...records);
      if (ids.length < BATCH) break;
      offset += BATCH;
    }

    console.log(`Asistencias abiertas encontradas (ultimos 7 dias): ${allOpen.length}\n`);

    if (allOpen.length === 0) {
      console.log('No hay asistencias abiertas. Nada que simular.');
      return;
    }

    let staleCount = 0;
    let normalCount = 0;

    const sorted = allOpen.sort((a, b) => {
      const ha = diffHoursUTC(nowUTC, a.check_in);
      const hb = diffHoursUTC(nowUTC, b.check_in);
      return hb - ha;
    });

    for (const att of sorted) {
      const empName = Array.isArray(att.employee_id) ? att.employee_id[1] : `Employee #${att.employee_id}`;
      const empId = Array.isArray(att.employee_id) ? att.employee_id[0] : att.employee_id;
      const hoursOpen = diffHoursUTC(nowUTC, att.check_in);

      if (hoursOpen > staleThresholdHours) {
        const autoCloseTs = addHoursUTC(att.check_in, autoCloseHours);
        console.log(`  [STALE] ${empName} (emp=${empId}, att=#${att.id})`);
        console.log(`          check_in:    ${att.check_in}`);
        console.log(`          abierta:     ${hoursOpen.toFixed(1)}h (> ${staleThresholdHours}h)`);
        console.log(`          → Se cerraria a:  ${autoCloseTs} (check_in + ${autoCloseHours}h)`);
        console.log(`          → Nueva entrada:  ${nowUTC} (timestamp actual)`);
        console.log('');
        staleCount++;
      } else {
        console.log(`  [OK]    ${empName} (emp=${empId}, att=#${att.id})`);
        console.log(`          check_in:    ${att.check_in}`);
        console.log(`          abierta:     ${hoursOpen.toFixed(1)}h — check-out normal si checa ahora`);
        console.log('');
        normalCount++;
      }
    }

    console.log('========================================');
    console.log(`  Total abiertas:       ${allOpen.length}`);
    console.log(`  Auto-cierre (>${ staleThresholdHours}h): ${staleCount}`);
    console.log(`  Normales (<${staleThresholdHours}h):     ${normalCount}`);
    console.log('========================================');

  } catch (err) {
    console.error('Error fatal:', err.message);
    process.exit(1);
  }
})();
