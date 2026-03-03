#!/usr/bin/env node

/**
 * Dry-run de sincronizacion de asistencia.
 * Muestra que registros se sincronizarian sin escribir en Odoo.
 *
 * Uso: node scripts/dry-run-attendance.js
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const zkClient = require('../src/zkteco/client');
const OdooClient = require('../src/odoo/client');
const stateDb = require('../src/db/state');
const config = require('../src/config');
const { toUTC } = require('../src/sync/attendance');

(async () => {
  try {
    stateDb.init();

    const odoo = new OdooClient(config.odoo);
    await odoo.authenticate();
    console.log('Odoo autenticado\n');

    let totalOps = 0;

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
      console.log('');

      for (const log of newLogs) {
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
        let isOpen = openAttendanceCache.get(cacheKey);
        if (isOpen === undefined) {
          const open = await odoo.getLastOpenAttendance(employee.id);
          isOpen = !!open;
          openAttendanceCache.set(cacheKey, isOpen);
        }

        const action = isOpen ? 'CHECK-OUT' : 'CHECK-IN';
        console.log(`  [${action}] ${employee.name} (ID ${employee.id}) @ ${log.timestamp} → UTC: ${utc}`);

        openAttendanceCache.set(cacheKey, !isOpen);
        totalOps++;
      }

      console.log('');
    }

    console.log('========================================');
    console.log(`  Total operaciones que se ejecutarian: ${totalOps}`);
    console.log('========================================');

    stateDb.close();
  } catch (err) {
    console.error('Error fatal:', err.message);
    process.exit(1);
  }
})();
