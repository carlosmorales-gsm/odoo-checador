const zkClient = require('../zkteco/client');
const OdooClient = require('../odoo/client');
const stateDb = require('../db/state');
const config = require('../config');
const { createChild } = require('../logger');
const { enrollDeviceFromOdoo } = require('./enrollment');
const { restoreFingerprintsFromBackup } = require('./fingerprint-restore');

const logger = createChild('sync');

/** Current time in device timezone, format "YYYY-MM-DD HH:mm:ss" for sync_state comparison */
function nowInDeviceTz(timezone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

function toUTC(localDateStr, timezone) {
  // localDateStr comes from ZKTeco as "YYYY-MM-DD HH:mm:ss" in device-local time.
  if (!localDateStr || typeof localDateStr !== 'string') {
    throw new Error(`toUTC: invalid localDateStr (${typeof localDateStr})`);
  }

  /** Fallback when Intl path fails (e.g. ICU/timezone on Raspberry Pi): parse and apply fixed offset. */
  function fallbackMexicoCity() {
    const trimmed = localDateStr.trim();
    const m = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{1,2}):(\d{1,2})$/);
    if (!m) throw new Error(`toUTC: invalid format (expected YYYY-MM-DD HH:mm:ss): ${localDateStr}`);
    const [, y, mo, d, h, mi, s] = m;
    const localAsUtc = Date.UTC(
      parseInt(y, 10), parseInt(mo, 10) - 1, parseInt(d, 10),
      parseInt(h, 10), parseInt(mi, 10), parseInt(s, 10)
    );
    // America/Mexico_City = UTC-6 → UTC = local + 6h
    const utcDate = new Date(localAsUtc + 6 * 60 * 60 * 1000);
    if (isNaN(utcDate.getTime())) throw new Error(`toUTC: fallback produced invalid date for ${localDateStr}`);
    return utcDate.toISOString().replace('T', ' ').substring(0, 19);
  }

  /** Use fallback whenever Intl fails (invalid tzDisplay/utcDate or missing parts). Does not depend on exact TIMEZONE string. */
  function useFallbackIfPossible() {
    if (/^\d{4}-\d{1,2}-\d{1,2} \d{1,2}:\d{1,2}:\d{1,2}$/.test(localDateStr.trim())) {
      return fallbackMexicoCity();
    }
    return null;
  }

  // Append 'Z' to treat the string as an anchor in UTC for offset calculation.
  const anchor = new Date(localDateStr.replace(' ', 'T') + 'Z');
  if (isNaN(anchor.getTime())) {
    const fallback = useFallbackIfPossible();
    if (fallback !== null) return fallback;
    throw new Error(`toUTC: could not parse date: ${localDateStr}`);
  }

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(anchor);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const y = get('year'), mo = get('month'), d = get('day');
  const h = get('hour'), mi = get('minute'), s = get('second');

  if (!y || !mo || !d || h === undefined || h === '' || !mi || !s) {
    const fallback = useFallbackIfPossible();
    if (fallback !== null) return fallback;
    throw new Error(`toUTC: formatToParts missing parts (tz=${timezone})`);
  }

  // Reconstruct the timezone-shifted wall-clock time as a UTC Date to find the offset.
  const tzDisplay = new Date(
    `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(s).padStart(2, '0')}Z`
  );
  if (isNaN(tzDisplay.getTime())) {
    const fallback = useFallbackIfPossible();
    if (fallback !== null) return fallback;
    throw new Error(`toUTC: invalid tzDisplay (input: ${localDateStr})`);
  }

  const offsetMs = tzDisplay.getTime() - anchor.getTime();
  const utcDate = new Date(anchor.getTime() - offsetMs);

  if (isNaN(utcDate.getTime())) {
    const fallback = useFallbackIfPossible();
    if (fallback !== null) return fallback;
    throw new Error(`toUTC: invalid utcDate (input: ${localDateStr})`);
  }

  try {
    return utcDate.toISOString().replace('T', ' ').substring(0, 19);
  } catch (e) {
    const fallback = useFallbackIfPossible();
    if (fallback !== null) return fallback;
    throw e;
  }
}

/** Difference in minutes between two "YYYY-MM-DD HH:mm:ss" strings (both in the same timezone). */
function diffMinutes(tsA, tsB) {
  const a = new Date(tsA.replace(' ', 'T') + 'Z');
  const b = new Date(tsB.replace(' ', 'T') + 'Z');
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return Infinity;
  return Math.abs(a.getTime() - b.getTime()) / 60_000;
}

/** Difference in hours between two UTC "YYYY-MM-DD HH:mm:ss" strings. */
function diffHoursUTC(utcA, utcB) {
  const a = new Date(utcA.replace(' ', 'T') + 'Z');
  const b = new Date(utcB.replace(' ', 'T') + 'Z');
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return Infinity;
  return Math.abs(a.getTime() - b.getTime()) / 3_600_000;
}

/** Add hours to a UTC "YYYY-MM-DD HH:mm:ss" string and return the same format. */
function addHoursUTC(utcStr, hours) {
  const d = new Date(utcStr.replace(' ', 'T') + 'Z');
  d.setTime(d.getTime() + hours * 3_600_000);
  return d.toISOString().replace('T', ' ').substring(0, 19);
}

async function syncDevice(device, odoo) {
  const deviceLabel = `${device.name} (${device.ip})`;
  logger.info(`Connecting to ${deviceLabel}...`);

  const lastSynced = stateDb.getLastSyncedTimestamp(device.ip);

  // New device (IP not in sync_state): reprovision before first attendance sync
  if (lastSynced === null) {
    try {
      logger.info(`${deviceLabel}: new device detected, reprovisioning (clear → enroll from Odoo → restore fingerprints)...`);
      await zkClient.clearDevice(device);
      logger.info(`${deviceLabel}: device cleared`);
      await enrollDeviceFromOdoo(device, odoo);
      logger.info(`${deviceLabel}: enrollment from Odoo done`);
      await new Promise((r) => setTimeout(r, 1500));
      await restoreFingerprintsFromBackup(device);
      logger.info(`${deviceLabel}: reprovisioning complete`);
      // Mark device as provisioned so we don't reprovision again on next cycle (sync_state is
      // updated even when getAttendanceLogs fails or returns 0 records after clear).
      const watermark = nowInDeviceTz(config.sync.timezone);
      stateDb.setLastSyncedTimestamp(device.ip, watermark);
      logger.info(`${deviceLabel}: registered in sync_state (last_synced=${watermark}), next runs will only sync attendance`);
    } catch (err) {
      logger.error(`${deviceLabel}: reprovisioning failed: ${err.message}`);
      return { device: deviceLabel, processed: 0, errors: 1 };
    }
  }

  const effectiveLastSynced = stateDb.getLastSyncedTimestamp(device.ip);

  let logs;
  try {
    logs = await zkClient.getAttendanceLogs(device);
  } catch (err) {
    logger.error(`Failed to get logs from ${deviceLabel}: ${err.message}`);
    return { device: deviceLabel, processed: 0, errors: 1 };
  }

  logger.info(`${deviceLabel}: ${logs.length} total records, last synced: ${effectiveLastSynced || 'never'}`);

  // Filter new records and sort chronologically
  const newLogs = logs
    .filter((l) => !effectiveLastSynced || l.timestamp > effectiveLastSynced)
    .sort((a, b) => (a.timestamp > b.timestamp ? 1 : -1));

  if (newLogs.length === 0) {
    logger.info(`${deviceLabel}: No new records`);
    return { device: deviceLabel, processed: 0, errors: 0 };
  }

  logger.info(`${deviceLabel}: ${newLogs.length} new records to sync`);

  let processed = 0;
  let errors = 0;
  let latestTimestamp = effectiveLastSynced;
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
      // --- Dedup: skip if same user on same device checked within DEDUP_MINUTES ---
      const lastUserTs = stateDb.getLastSyncLogForUser(device.ip, log.userId);
      if (lastUserTs && diffMinutes(log.timestamp, lastUserTs) < config.sync.dedupMinutes) {
        const gap = diffMinutes(log.timestamp, lastUserTs).toFixed(1);
        logger.warn(`Duplicate skipped: user ${log.userId}, ${gap} min since last record`);
        stateDb.logSync(device.ip, log.userId, log.timestamp, 'skipped_duplicate', null);
        if (!encounteredError && (!latestTimestamp || log.timestamp > latestTimestamp)) {
          latestTimestamp = log.timestamp;
        }
        continue;
      }

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
        logger.debug(`Check-in: ${employee.name} at ${utcTimestamp} (attendance #${odooAttendanceId})`);
      } else {
        const hoursOpen = diffHoursUTC(utcTimestamp, openAttendance.check_in);

        if (hoursOpen > config.sync.staleThresholdHours) {
          // Stale attendance: auto-close at check_in + AUTO_CLOSE_HOURS, then open new
          const autoCloseTs = addHoursUTC(openAttendance.check_in, config.sync.autoCloseHours);
          await odoo.updateCheckOut(openAttendance.id, autoCloseTs);
          stateDb.logSync(device.ip, log.userId, log.timestamp, 'auto_close', openAttendance.id);
          logger.info(`Auto-close: ${employee.name} attendance #${openAttendance.id} closed at ${autoCloseTs} (was open ${hoursOpen.toFixed(1)}h)`);

          odooAttendanceId = await odoo.createCheckIn(employee.id, utcTimestamp);
          action = 'check_in';
          logger.debug(`Check-in (after auto-close): ${employee.name} at ${utcTimestamp} (attendance #${odooAttendanceId})`);
        } else {
          // Normal check-out
          await odoo.updateCheckOut(openAttendance.id, utcTimestamp);
          odooAttendanceId = openAttendance.id;
          action = 'check_out';
          logger.debug(`Check-out: ${employee.name} at ${utcTimestamp} (attendance #${odooAttendanceId})`);
        }
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
  if (latestTimestamp && latestTimestamp !== effectiveLastSynced) {
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
