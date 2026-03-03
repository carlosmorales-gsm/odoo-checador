#!/usr/bin/env node

/**
 * Respaldo de huellas digitales de todos los dispositivos ZKTeco.
 *
 * Uso:
 *   node scripts/backup-fingerprints.js                          # Todos los dispositivos
 *   node scripts/backup-fingerprints.js --device "Fune Navolato"  # Un dispositivo
 *   node scripts/backup-fingerprints.js --uid 128                 # Solo el usuario con uid 128 (ej. Jorge Rivera)
 *   node scripts/backup-fingerprints.js --debug                  # Ver respuesta del dispositivo por dedo (diagnostico)
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const zkClient = require('../src/zkteco/client');
const config = require('../src/config');

const FINGERPRINTS_DIR = path.resolve(__dirname, '..', 'fingerprints');

function slugify(name) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function parseArgs() {
  const args = process.argv.slice(2);
  const deviceIdx = args.indexOf('--device');
  const uidIdx = args.indexOf('--uid');
  const debug = process.env.BACKUP_FINGERPRINTS_DEBUG === '1' || args.includes('--debug');
  return {
    deviceFilter: deviceIdx !== -1 ? args[deviceIdx + 1] : null,
    uidFilter: uidIdx !== -1 ? args[uidIdx + 1] : null,
    debug,
  };
}

(async () => {
  const { deviceFilter, uidFilter, debug } = parseArgs();
  if (debug) console.log('Modo debug: se mostrara la respuesta del dispositivo por cada dedo.\n');
  if (uidFilter) console.log(`Solo usuario con uid=${uidFilter}\n`);

  if (!fs.existsSync(FINGERPRINTS_DIR)) {
    fs.mkdirSync(FINGERPRINTS_DIR, { recursive: true });
  }

  const devices = deviceFilter
    ? config.zkteco.devices.filter((d) => d.name === deviceFilter)
    : config.zkteco.devices;

  if (devices.length === 0) {
    console.error(`No se encontro el dispositivo "${deviceFilter}"`);
    process.exit(1);
  }

  let totalUsers = 0;
  let totalTemplates = 0;
  let totalErrors = 0;

  for (const device of devices) {
    const label = `${device.name} (${device.ip})`;
    console.log(`\n=== ${label} ===`);

    let users;
    try {
      users = await zkClient.getUsers(device);
    } catch (err) {
      console.error(`  ERROR leyendo usuarios: ${err.message}`);
      totalErrors++;
      continue;
    }

    if (users.length === 0) {
      console.log('  Sin usuarios registrados');
      continue;
    }

    if (uidFilter !== null && uidFilter !== undefined) {
      users = users.filter((u) => String(u.uid) === String(uidFilter));
      if (users.length === 0) {
        console.log(`  No hay usuario con uid=${uidFilter} en este dispositivo`);
        continue;
      }
    }

    console.log(`  ${users.length} usuario(s) a procesar\n`);

    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      const idx = `[${i + 1}/${users.length}]`;

      let templates;
      try {
        templates = await zkClient.getUserFingerprints(device, user.uid, { debug });
      } catch (err) {
        console.log(`  ${idx} ${user.name} (uid=${user.uid}) — ERROR: ${err.message}`);
        totalErrors++;
        continue;
      }

      if (templates.length === 0) {
        console.log(`  ${idx} ${user.name} (uid=${user.uid}) — sin huellas, saltando`);
        continue;
      }

      const filename = `${user.userId}-${slugify(user.name)}.json`;
      const filePath = path.join(FINGERPRINTS_DIR, filename);

      const backup = {
        employeeId: parseInt(user.userId, 10),
        zkUserId: user.userId,
        zkUid: user.uid,
        name: user.name,
        device: device.name,
        backedUpAt: new Date().toISOString(),
        templates,
      };

      fs.writeFileSync(filePath, JSON.stringify(backup, null, 2));
      console.log(`  ${idx} ${user.name} — ${templates.length} huella(s) OK → ${filename}`);

      totalUsers++;
      totalTemplates += templates.length;
    }
  }

  console.log('\n========================================');
  console.log(`  Usuarios respaldados: ${totalUsers}`);
  console.log(`  Templates totales:    ${totalTemplates}`);
  console.log(`  Errores:              ${totalErrors}`);
  console.log('========================================\n');

  process.exit(totalErrors > 0 ? 1 : 0);
})();
