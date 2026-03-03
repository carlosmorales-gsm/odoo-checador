const path = require('path');
const fs = require('fs');
const zkClient = require('../zkteco/client');
const config = require('../config');
const { loadBackupsByEmployee, FINGERPRINTS_DIR } = require('./fingerprint-restore');

function slugify(name) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Runs incremental fingerprint backup: only backs up users that do not yet have a file
 * in fingerprints/ (unless force is true). Used by the CLI script and by the weekly cron.
 *
 * @param {{ deviceFilter?: string, uidFilter?: string, force?: boolean, debug?: boolean, dryRun?: boolean, log?: (msg: string) => void }} opts
 * @returns {Promise<{ totalUsers: number, totalTemplates: number, totalErrors: number }>}
 */
async function runBackupIncremental(opts = {}) {
  const {
    deviceFilter = null,
    uidFilter = null,
    force = false,
    debug = false,
    dryRun = false,
    log = (msg) => console.log(msg),
  } = opts;

  if (!fs.existsSync(FINGERPRINTS_DIR)) {
    fs.mkdirSync(FINGERPRINTS_DIR, { recursive: true });
  }

  const existingBackups = loadBackupsByEmployee();
  const devices = deviceFilter
    ? config.zkteco.devices.filter((d) => d.name === deviceFilter)
    : config.zkteco.devices;

  let totalUsers = 0;
  let totalTemplates = 0;
  let totalErrors = 0;
  const backedUpThisRun = new Set();

  for (const device of devices) {
    const label = `${device.name} (${device.ip})`;
    log(`\n=== ${label} ===`);
    log(`Conectando y leyendo lista de usuarios...`);

    let users;
    try {
      users = await zkClient.getUsers(device);
    } catch (err) {
      log(`  ERROR leyendo usuarios: ${err.message}`);
      totalErrors++;
      continue;
    }

    if (users.length === 0) {
      log(`  Sin usuarios en el dispositivo.`);
      continue;
    }

    if (uidFilter != null) {
      users = users.filter((u) => String(u.uid) === String(uidFilter));
      if (users.length === 0) continue;
    }

    log(`  ${users.length} usuario(s). Leyendo huellas (puede tardar)...\n`);

    const total = users.length;
    let idx = 0;

    for (const user of users) {
      idx++;
      log(`  [${idx}/${total}] ${user.name} (uid=${user.uid})...`);
      let templates;
      try {
        templates = await zkClient.getUserFingerprints(device, user.uid, { debug });
      } catch (err) {
        log(`      ERROR: ${err.message}`);
        totalErrors++;
        continue;
      }

      if (templates.length === 0) {
        log(`      sin huellas, omitiendo.`);
        continue;
      }

      const employeeId = parseInt(user.userId, 10);
      if (!force && (existingBackups.has(employeeId) || backedUpThisRun.has(employeeId))) {
        log(`      ya existe respaldo, omitiendo.`);
        continue;
      }

      const filename = `${user.userId}-${slugify(user.name)}.json`;
      const filePath = path.join(FINGERPRINTS_DIR, filename);
      const backup = {
        employeeId,
        zkUserId: user.userId,
        zkUid: user.uid,
        name: user.name,
        device: device.name,
        backedUpAt: new Date().toISOString(),
        templates,
      };

      try {
        if (!dryRun) {
          fs.writeFileSync(filePath, JSON.stringify(backup, null, 2));
        }
        log(dryRun
          ? `      [DRY-RUN] respaldaría ${templates.length} template(s) → ${filename}`
          : `      OK — ${templates.length} template(s) → ${filename}`);
        backedUpThisRun.add(employeeId);
        totalUsers++;
        totalTemplates += templates.length;
      } catch (err) {
        log(`      ERROR escribiendo: ${err.message}`);
        totalErrors++;
      }
    }
  }

  return { totalUsers, totalTemplates, totalErrors };
}

module.exports = { runBackupIncremental, FINGERPRINTS_DIR };
