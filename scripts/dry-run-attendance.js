#!/usr/bin/env node

/**
 * Dry-run de sincronizacion de asistencia.
 * Muestra que registros se sincronizarian sin escribir en Odoo.
 * Incluye simulacion de dedup y auto-cierre.
 *
 * Uso: node scripts/dry-run-attendance.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const zkClient = require('../src/zkteco/client');
const OdooClient = require('../src/odoo/client');
const stateDb = require('../src/db/state');
const config = require('../src/config');
const { toUTC } = require('../src/sync/attendance');

function diffMinutes(tsA, tsB) {
  const a = new Date(tsA.replace(' ', 'T') + 'Z');
  const b = new Date(tsB.replace(' ', 'T') + 'Z');
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return Infinity;
  return Math.abs(a.getTime() - b.getTime()) / 60_000;
}

function diffHoursUTC(utcA, utcB) {
  const a = new Date(utcA.replace(' ', 'T') + 'Z');
  const b = new Date(utcB.replace(' ', 'T') + 'Z');
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return Infinity;
  return Math.abs(a.getTime() - b.getTime()) / 3_600_000;
}

function addHoursUTC(utcStr, hours) {
  const d = new Date(utcStr.replace(' ', 'T') + 'Z');
  d.setTime(d.getTime() + hours * 3_600_000);
  return d.toISOString().replace('T', ' ').substring(0, 19);
}

(async () => {
  try {
    stateDb.init();

    const odoo = new OdooClient(config.odoo);
    await odoo.authenticate();
    console.log('Odoo autenticado');
    console.log(`Config: DEDUP_MINUTES=${config.sync.dedupMinutes}, STALE_THRESHOLD_HOURS=${config.sync.staleThresholdHours}, AUTO_CLOSE_HOURS=${config.sync.autoCloseHours}\n`);

    let totalOps = 0;
    let totalDedup = 0;
    let totalAutoClose = 0;

    for (const device of config.zkteco.devices) {
      const label = `${device.name} (${device.ip})`;
      console.log(`=== ${label} ===`);

      let logs;
      try {
        logs = await zkClient.getAttendanceLogs(device);
      } catch (err) {
        console.log(`  ERROR: ${err.message}\n`);
        continue;
      }

      const lastSynced = stateDb.getLastSyncedTimestamp(device.ip);
      console.log(`  Total registros: ${logs.length}`);
      console.log(`  Ultimo sync:     ${lastSynced || 'nunca'}`);

      const newLogs = logs
        .filter((l) => !lastSynced || l.timestamp > lastSynced)
        .sort((a, b) => (a.timestamp > b.timestamp ? 1 : -1));

      console.log(`  Pendientes:      ${newLogs.length}`);

      if (newLogs.length === 0) {
        console.log('  Sin registros nuevos\n');
        continue;
      }

      const employeeCache = new Map();
      const openAttendanceCache = new Map();
      const lastUserTsCache = new Map();
      console.log('');

      for (const log of newLogs) {
        if (stateDb.isAlreadySynced(device.ip, log.userId, log.timestamp)) {
          continue;
        }

        // --- Dedup check ---
        const lastUserTs = lastUserTsCache.get(log.userId)
          || stateDb.getLastSyncLogForUser(device.ip, log.userId);

        if (lastUserTs && diffMinutes(log.timestamp, lastUserTs) < config.sync.dedupMinutes) {
          const gap = diffMinutes(log.timestamp, lastUserTs).toFixed(1);
          console.log(`  [DEDUP] userId=${log.userId} @ ${log.timestamp} — ${gap} min desde ultimo registro, se descartaria`);
          lastUserTsCache.set(log.userId, log.timestamp);
          totalDedup++;
          continue;
        }

        const empId = parseInt(log.userId, 10);
        let employee = employeeCache.get(empId);
        if (employee === undefined) {
          employee = await odoo.getEmployeeById(empId);
          employeeCache.set(empId, employee);
        }

        if (!employee) {
          console.log(`  [SKIP] userId=${log.userId} @ ${log.timestamp} — Sin empleado en Odoo`);
          continue;
        }

        const utc = toUTC(log.timestamp, config.sync.timezone);

        const cacheKey = employee.id;
        let openAtt = openAttendanceCache.get(cacheKey);
        if (openAtt === undefined) {
          openAtt = await odoo.getLastOpenAttendance(employee.id);
          openAttendanceCache.set(cacheKey, openAtt);
        }

        if (!openAtt) {
          console.log(`  [CHECK-IN]    ${employee.name} (ID ${employee.id}) @ ${log.timestamp} → UTC: ${utc}`);
          openAttendanceCache.set(cacheKey, { id: '?', check_in: utc });
        } else {
          const hoursOpen = diffHoursUTC(utc, openAtt.check_in);

          if (hoursOpen > config.sync.staleThresholdHours) {
            const autoCloseTs = addHoursUTC(openAtt.check_in, config.sync.autoCloseHours);
            console.log(`  [AUTO-CLOSE]  ${employee.name} (ID ${employee.id}) — asistencia #${openAtt.id} abierta ${hoursOpen.toFixed(1)}h, se cerraria a ${autoCloseTs}`);
            console.log(`  [CHECK-IN]    ${employee.name} (ID ${employee.id}) @ ${log.timestamp} → UTC: ${utc} (nueva entrada tras auto-cierre)`);
            openAttendanceCache.set(cacheKey, { id: '?', check_in: utc });
            totalAutoClose++;
            totalOps++;
          } else {
            console.log(`  [CHECK-OUT]   ${employee.name} (ID ${employee.id}) @ ${log.timestamp} → UTC: ${utc} (${hoursOpen.toFixed(1)}h abierta)`);
            openAttendanceCache.set(cacheKey, null);
          }
        }

        lastUserTsCache.set(log.userId, log.timestamp);
        totalOps++;
      }

      console.log('');
    }

    console.log('========================================');
    console.log(`  Operaciones que se ejecutarian: ${totalOps}`);
    console.log(`  Duplicados que se descartarian: ${totalDedup}`);
    console.log(`  Auto-cierres que se aplicarian: ${totalAutoClose}`);
    console.log('========================================');

    stateDb.close();
  } catch (err) {
    console.error('Error fatal:', err.message);
    process.exit(1);
  }
})();
