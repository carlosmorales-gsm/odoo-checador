const zkClient = require('../zkteco/client');
const OdooClient = require('../odoo/client');
const stateDb = require('../db/state');
const config = require('../config');
const winston = require('winston');

const logger = winston.createLogger({ defaultMeta: { service: 'sync' } });
// Transports are configured in index.js; re-use root logger's transports
logger.add(new winston.transports.Console({ format: winston.format.simple() }));

function toUTC(localDateStr, timezone) {
  // localDateStr comes from ZKTeco as "YYYY-MM-DD HH:mm:ss" in device-local time.
  // Append 'Z' to treat the string as an anchor in UTC for offset calculation.
  const anchor = new Date(localDateStr.replace(' ', 'T') + 'Z');

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(anchor);
  const get = (type) => parts.find((p) => p.type === type)?.value;

  // Reconstruct the timezone-shifted wall-clock time as a UTC Date to find the offset.
  // For UTC-6: anchor=08:30Z → formatter shows 02:30 → tzDisplay=02:30Z → offsetMs=-6h
  const tzDisplay = new Date(
    `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}Z`
  );
  const offsetMs = tzDisplay.getTime() - anchor.getTime();

  // UTC = device_local_as_UTC - offsetMs → 08:30Z - (-6h) = 14:30Z
  const utcDate = new Date(anchor.getTime() - offsetMs);
  return utcDate.toISOString().replace('T', ' ').substring(0, 19);
}

async function syncDevice(device, odoo) {
  const deviceLabel = `${device.name} (${device.ip})`;
  logger.info(`Connecting to ${deviceLabel}...`);

  let logs;
  try {
    logs = await zkClient.getAttendanceLogs(device);
  } catch (err) {
    logger.error(`Failed to get logs from ${deviceLabel}: ${err.message}`);
    return { device: deviceLabel, processed: 0, errors: 1 };
  }

  const lastSynced = stateDb.getLastSyncedTimestamp(device.ip);
  logger.info(`${deviceLabel}: ${logs.length} total records, last synced: ${lastSynced || 'never'}`);

  // Filter new records and sort chronologically
  const newLogs = logs
    .filter((l) => !lastSynced || l.timestamp > lastSynced)
    .sort((a, b) => (a.timestamp > b.timestamp ? 1 : -1));

  if (newLogs.length === 0) {
    logger.info(`${deviceLabel}: No new records`);
    return { device: deviceLabel, processed: 0, errors: 0 };
  }

  logger.info(`${deviceLabel}: ${newLogs.length} new records to sync`);

  let processed = 0;
  let errors = 0;
  let latestTimestamp = lastSynced;
  let encounteredError = false;
  // Cache employee lookups to avoid repeated Odoo calls
  const employeeCache = new Map();

  for (const log of newLogs) {
    // Skip records already successfully synced (allows safe retries after partial failures)
    if (stateDb.isAlreadySynced(device.ip, log.userId, log.timestamp)) {
      if (!encounteredError && (!latestTimestamp || log.timestamp > latestTimestamp)) {
        latestTimestamp = log.timestamp;
      }
      continue;
    }

    try {
      // Look up employee
      let employee = employeeCache.get(log.userId);
      if (employee === undefined) {
        employee = await odoo.getEmployeeById(parseInt(log.userId, 10));
        employeeCache.set(log.userId, employee);
      }

      if (!employee) {
        logger.warn(`No Odoo employee for ZKTeco user ${log.userId}, skipping`);
        errors++;
        continue;
      }

      const utcTimestamp = toUTC(log.timestamp, config.sync.timezone);

      // Determine check-in or check-out
      const openAttendance = await odoo.getLastOpenAttendance(employee.id);

      let action;
      let odooAttendanceId;

      if (!openAttendance) {
        // No open attendance → create check-in
        odooAttendanceId = await odoo.createCheckIn(employee.id, utcTimestamp);
        action = 'check_in';
        logger.info(`Check-in: ${employee.name} at ${utcTimestamp} (attendance #${odooAttendanceId})`);
      } else {
        // Open attendance exists → close it with check-out
        await odoo.updateCheckOut(openAttendance.id, utcTimestamp);
        odooAttendanceId = openAttendance.id;
        action = 'check_out';
        logger.info(`Check-out: ${employee.name} at ${utcTimestamp} (attendance #${odooAttendanceId})`);
      }

      stateDb.logSync(device.ip, log.userId, log.timestamp, action, odooAttendanceId);
      processed++;

      // Only advance the watermark if no error has been encountered yet.
      // Freezing it ensures failed records are retried on the next cycle.
      if (!encounteredError && (!latestTimestamp || log.timestamp > latestTimestamp)) {
        latestTimestamp = log.timestamp;
      }
    } catch (err) {
      logger.error(`Error syncing record ${log.userId}@${log.timestamp}: ${err.message}`);
      errors++;
      encounteredError = true; // freeze watermark so failed records are retried
    }
  }

  // Update last synced timestamp
  if (latestTimestamp && latestTimestamp !== lastSynced) {
    stateDb.setLastSyncedTimestamp(device.ip, latestTimestamp);
  }

  return { device: deviceLabel, processed, errors };
}

async function syncAll() {
  logger.info('--- Sync cycle starting ---');
  const odoo = new OdooClient(config.odoo);

  try {
    await odoo.authenticate();
  } catch (err) {
    logger.error(`Odoo authentication failed: ${err.message}`);
    return;
  }

  const results = [];
  for (const device of config.zkteco.devices) {
    const result = await syncDevice(device, odoo);
    results.push(result);
  }

  const totalProcessed = results.reduce((s, r) => s + r.processed, 0);
  const totalErrors = results.reduce((s, r) => s + r.errors, 0);
  logger.info(`--- Sync cycle complete: ${totalProcessed} processed, ${totalErrors} errors ---`);
}

module.exports = { syncAll, toUTC };
