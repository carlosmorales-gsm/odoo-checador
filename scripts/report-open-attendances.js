#!/usr/bin/env node

/**
 * Reporte de asistencias abiertas con más de 8 horas.
 * Muestra empleado, hora de entrada, horas acumuladas y estado (OK / EXCEDIDO).
 *
 * No modifica nada en Odoo ni en SQLite. Solo lectura.
 *
 * Uso: node scripts/report-open-attendances.js
 *      node scripts/report-open-attendances.js --all        # incluye las de <8h también
 *      node scripts/report-open-attendances.js --min-hours 4  # umbral personalizado
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const OdooClient = require('../src/odoo/client');
const config = require('../src/config');

const args = process.argv.slice(2);
const showAll = args.includes('--all');
const minHoursIdx = args.indexOf('--min-hours');
const minHours = minHoursIdx !== -1 ? parseFloat(args[minHoursIdx + 1]) || 8 : 8;
const threshold = config.sync.staleThresholdHours;

function diffHours(nowMs, checkInStr) {
  const d = new Date(checkInStr.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return 0;
  return (nowMs - d.getTime()) / 3_600_000;
}

function pad(str, len) {
  const s = String(str);
  return s.length >= len ? s : s + ' '.repeat(len - s.length);
}

function padLeft(str, len) {
  const s = String(str);
  return s.length >= len ? s : ' '.repeat(len - s.length) + s;
}

(async () => {
  try {
    const odoo = new OdooClient(config.odoo);
    await odoo.authenticate();

    const nowMs = Date.now();
    const nowUTC = new Date(nowMs).toISOString().replace('T', ' ').substring(0, 19);

    const cutoff = new Date(nowMs - 168 * 60 * 60 * 1000)
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
        ['id', 'employee_id', 'check_in'],
      ]);
      allOpen.push(...records);
      if (ids.length < BATCH) break;
      offset += BATCH;
    }

    const rows = allOpen.map((att) => {
      const name = Array.isArray(att.employee_id) ? att.employee_id[1] : `#${att.employee_id}`;
      const hours = diffHours(nowMs, att.check_in);
      let status;
      if (hours > threshold) {
        status = 'EXCEDIDO';
      } else if (hours > config.sync.autoCloseHours) {
        status = 'PASADO';
      } else {
        status = 'OK';
      }
      return { id: att.id, name, checkIn: att.check_in, hours, status };
    });

    const filtered = showAll ? rows : rows.filter((r) => r.hours >= minHours);
    filtered.sort((a, b) => b.hours - a.hours);

    console.log(`\n  Reporte de asistencias abiertas — ${nowUTC} UTC`);
    console.log(`  Umbral auto-cierre: ${threshold}h | Jornada esperada: ${config.sync.autoCloseHours}h`);
    console.log(`  Mostrando: ${showAll ? 'todas' : `>= ${minHours}h`} (${filtered.length} de ${allOpen.length} abiertas)\n`);

    if (filtered.length === 0) {
      console.log('  No hay asistencias que cumplan el filtro.\n');
      return;
    }

    const hdr = `  ${pad('#', 6)} ${pad('Empleado', 30)} ${pad('Check-in (UTC)', 20)} ${padLeft('Horas', 7)}  Estado`;
    console.log(hdr);
    console.log('  ' + '─'.repeat(hdr.length - 2));

    for (const r of filtered) {
      const hStr = r.hours.toFixed(1) + 'h';
      const tag = r.status === 'EXCEDIDO' ? ' <<<' : r.status === 'PASADO' ? ' <' : '';
      console.log(`  ${pad(r.id, 6)} ${pad(r.name, 30)} ${pad(r.checkIn, 20)} ${padLeft(hStr, 7)}  ${r.status}${tag}`);
    }

    const excedidos = filtered.filter((r) => r.status === 'EXCEDIDO').length;
    const pasados = filtered.filter((r) => r.status === 'PASADO').length;
    const ok = filtered.filter((r) => r.status === 'OK').length;

    console.log('\n  ─── Resumen ───');
    console.log(`  EXCEDIDO (>${threshold}h): ${excedidos}`);
    console.log(`  PASADO   (>${config.sync.autoCloseHours}h):  ${pasados}`);
    if (ok > 0) console.log(`  OK       (<=${config.sync.autoCloseHours}h):  ${ok}`);
    console.log('');

  } catch (err) {
    console.error('Error fatal:', err.message);
    process.exit(1);
  }
})();
