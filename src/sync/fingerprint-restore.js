const path = require('path');
const fs = require('fs');
const zkClient = require('../zkteco/client');
const { createChild } = require('../logger');

const logger = createChild('fingerprint-restore');

const FINGERPRINTS_DIR = path.resolve(__dirname, '..', '..', 'fingerprints');

/**
 * Loads all backup JSON files from fingerprints/ and indexes them by employeeId.
 * When multiple backups exist for the same employee, keeps the most recent by backedUpAt.
 *
 * @returns {Map<number, { employeeId, zkUserId, zkUid, name, templates }>}
 */
function loadBackupsByEmployee() {
  const byEmployee = new Map();
  if (!fs.existsSync(FINGERPRINTS_DIR)) {
    return byEmployee;
  }

  const files = fs.readdirSync(FINGERPRINTS_DIR).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(FINGERPRINTS_DIR, file), 'utf8');
      const backup = JSON.parse(raw);
      if (!backup.employeeId || !Array.isArray(backup.templates) || backup.templates.length === 0) continue;

      const existing = byEmployee.get(backup.employeeId);
      const backupTime = backup.backedUpAt ? new Date(backup.backedUpAt).getTime() : 0;
      if (!existing || (existing.backedUpAt ? new Date(existing.backedUpAt).getTime() : 0) < backupTime) {
        byEmployee.set(backup.employeeId, backup);
      }
    } catch {
      // Skip invalid files
    }
  }
  return byEmployee;
}

/**
 * Restores fingerprint templates from fingerprints/ to the given device.
 * For each user currently on the device, looks up a backup by employeeId (userId) and writes templates
 * using uid = user.uid (same as Odoo barcode, keeping ID/UID in sync).
 *
 * @param {Object} device - device config { ip, port, name }
 * @returns {{ restored: number, errors: number }}
 */
async function restoreFingerprintsFromBackup(device) {
  const deviceLabel = `${device.name} (${device.ip})`;
  const byEmployee = loadBackupsByEmployee();
  if (byEmployee.size === 0) {
    logger.info(`${deviceLabel}: no fingerprint backups in ${FINGERPRINTS_DIR}, skipping restore`);
    return { restored: 0, errors: 0 };
  }

  try {
    await zkClient.freeData(device);
  } catch (err) {
    logger.warn(`${deviceLabel}: freeData before restore failed (continuing): ${err.message}`);
  }

  let users;
  try {
    users = await zkClient.getUsers(device);
  } catch (err) {
    logger.error(`${deviceLabel}: failed to get users for fingerprint restore: ${err.message}`);
    return { restored: 0, errors: 1 };
  }

  if (users.length === 0) {
    logger.info(`${deviceLabel}: no users on device, skipping fingerprint restore`);
    return { restored: 0, errors: 0 };
  }

  let restored = 0;
  let errors = 0;
  for (const user of users) {
    const employeeId = parseInt(user.userId, 10);
    if (isNaN(employeeId)) continue;

    const backup = byEmployee.get(employeeId);
    if (!backup || !backup.templates || backup.templates.length === 0) continue;

    try {
      await zkClient.setUserFingerprints(device, user.uid, backup.templates);
      logger.info(`${deviceLabel}: restored ${backup.templates.length} template(s) for [${employeeId}] ${user.name} (uid=${user.uid})`);
      restored++;
    } catch (err) {
      logger.error(`${deviceLabel}: failed to restore fingerprints for [${employeeId}] ${user.name}: ${err.message}`);
      errors++;
    }
  }

  if (restored > 0 || errors > 0) {
    logger.info(`${deviceLabel}: fingerprint restore complete — ${restored} users restored, ${errors} errors`);
  }
  return { restored, errors };
}

/**
 * For the given device, finds users that have no fingerprints; if a backup exists for that
 * employee (userId = employeeId), writes templates from the backup using the device's uid.
 * Only considers users that exist in Odoo with barcode (enrolled). Does not create users
 * or read from other devices — Odoo and fingerprints/ are the single source of truth.
 *
 * @param {Object} device - device config { ip, port, name }
 * @param {Object} odoo - authenticated OdooClient instance
 * @param {{ dryRun?: boolean }} [opts] - dryRun: true to only report what would be synced, no writes
 * @returns {Promise<{ restored: number, skipped: number, errors: number, wouldRestore?: Array<{ employeeId: number, name: string, uid: string }> }>}
 */
async function syncMissingFingerprintsToDevice(device, odoo, opts = {}) {
  const { dryRun = false } = opts;
  const deviceLabel = `${device.name} (${device.ip})`;
  const byEmployee = loadBackupsByEmployee();
  if (byEmployee.size === 0) {
    logger.info(`${deviceLabel}: no fingerprint backups, skipping sync missing`);
    return { restored: 0, skipped: 0, errors: 0, wouldRestore: [] };
  }

  let users;
  try {
    users = await zkClient.getUsers(device);
  } catch (err) {
    logger.error(`${deviceLabel}: failed to get users: ${err.message}`);
    return { restored: 0, skipped: 0, errors: 1, wouldRestore: [] };
  }

  if (users.length === 0) {
    logger.info(`${deviceLabel}: no users on device, skipping sync missing`);
    return { restored: 0, skipped: 0, errors: 0, wouldRestore: [] };
  }

  const employees = await odoo.getAllEmployees(['id', 'name', 'barcode']);
  const odooIdsWithBarcode = new Set(employees.filter((e) => e.barcode).map((e) => String(e.id)));
  const deviceUsersFromOdoo = users.filter((u) => odooIdsWithBarcode.has(String(u.userId)));

  if (deviceUsersFromOdoo.length === 0) {
    logger.info(`${deviceLabel}: no device users matching Odoo (with barcode), skipping`);
    return { restored: 0, skipped: 0, errors: 0, wouldRestore: [] };
  }

  if (!dryRun) {
    try {
      await zkClient.freeData(device);
    } catch (err) {
      logger.warn(`${deviceLabel}: freeData before sync failed (continuing): ${err.message}`);
    }
  }

  let restored = 0;
  let skipped = 0;
  let errors = 0;
  const wouldRestore = [];

  for (const user of deviceUsersFromOdoo) {
    const employeeId = parseInt(user.userId, 10);
    if (isNaN(employeeId)) continue;

    let templates;
    try {
      templates = await zkClient.getUserFingerprints(device, user.uid);
    } catch (err) {
      logger.error(`${deviceLabel}: failed to get fingerprints for [${employeeId}] ${user.name}: ${err.message}`);
      errors++;
      continue;
    }

    if (templates.length > 0) {
      skipped++;
      continue;
    }

    const backup = byEmployee.get(employeeId);
    if (!backup || !backup.templates || backup.templates.length === 0) {
      logger.debug(`${deviceLabel}: [${employeeId}] ${user.name} has no fingerprints and no backup, skipping`);
      continue;
    }

    if (dryRun) {
      wouldRestore.push({ employeeId, name: user.name, uid: user.uid, templateCount: backup.templates.length });
      continue;
    }

    try {
      await zkClient.setUserFingerprints(device, user.uid, backup.templates);
      logger.info(`${deviceLabel}: synced ${backup.templates.length} template(s) from backup for [${employeeId}] ${user.name} (uid=${user.uid})`);
      restored++;
    } catch (err) {
      logger.error(`${deviceLabel}: failed to set fingerprints for [${employeeId}] ${user.name}: ${err.message}`);
      errors++;
    }
  }

  if (restored > 0 || errors > 0) {
    logger.info(`${deviceLabel}: sync missing fingerprints — ${restored} restored, ${skipped} already had fingerprints, ${errors} errors`);
  }
  return { restored, skipped, errors, wouldRestore };
}

module.exports = { restoreFingerprintsFromBackup, loadBackupsByEmployee, syncMissingFingerprintsToDevice, FINGERPRINTS_DIR };
