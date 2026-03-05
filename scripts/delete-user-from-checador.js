#!/usr/bin/env node

/**
 * Elimina un usuario (por ID de Odoo) de los checadores: borra sus huellas y su registro en el dispositivo.
 * Opcionalmente borra sus respaldos en fingerprints/ para que no se re-suban en restauraciones.
 *
 * Uso:
 *   node scripts/delete-user-from-checador.js --id 801
 *   node scripts/delete-user-from-checador.js --id 801 --device "Fune Navolato"
 *   node scripts/delete-user-from-checador.js --id 801 --dry-run
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const zkClient = require('../src/zkteco/client');
const config = require('../src/config');

const FINGERPRINTS_DIR = path.resolve(__dirname, '..', 'fingerprints');

function parseArgs() {
  const args = process.argv.slice(2);
  const idIdx = args.indexOf('--id');
  const deviceIdx = args.indexOf('--device');
  const dryRun = args.includes('--dry-run');
  if (idIdx === -1 || !args[idIdx + 1]) {
    return { employeeId: null, deviceFilter: null, dryRun: false };
  }
  return {
    employeeId: args[idIdx + 1].trim(),
    deviceFilter: deviceIdx !== -1 ? args[deviceIdx + 1] : null,
    dryRun,
  };
}

(async () => {
  const { employeeId, deviceFilter, dryRun } = parseArgs();

  if (!employeeId) {
    console.error('Uso: node scripts/delete-user-from-checador.js --id <id_odoo>');
    console.error('  Ejemplo: node scripts/delete-user-from-checador.js --id 801');
    console.error('  Opcional: --device "Nombre" (solo ese checador)');
    console.error('  Opcional: --dry-run (solo muestra qué se eliminaría)');
    process.exit(1);
  }

  const devices = deviceFilter
    ? config.zkteco.devices.filter((d) => d.name === deviceFilter)
    : config.zkteco.devices;

  if (devices.length === 0) {
    console.error(deviceFilter ? `No se encontró el dispositivo "${deviceFilter}".` : 'No hay dispositivos configurados.');
    process.exit(1);
  }

  if (dryRun) {
    console.log('--- DRY-RUN: no se modificará ningún dispositivo ni archivo ---\n');
  }

  console.log(`Usuario Odoo id=${employeeId} — ${devices.length} dispositivo(s)\n`);

  let ok = 0;
  let err = 0;

  for (const device of devices) {
    const label = `${device.name} (${device.ip})`;
    try {
      const users = await zkClient.getUsers(device);
      const user = users.find((u) => String(u.userId) === String(employeeId));

      if (!user) {
        console.log(`  ${label}: usuario id=${employeeId} no encontrado, omitiendo`);
        continue;
      }

      if (dryRun) {
        console.log(`  ${label}: [DRY-RUN] se eliminaría [${employeeId}] ${user.name} (uid=${user.uid}) — huellas y registro de usuario`);
        ok++;
        continue;
      }

      await zkClient.deleteUserFingerprints(device, user.uid, user.userId);
      await zkClient.deleteUser(device, user.uid);
      console.log(`  ${label}: usuario eliminado [${employeeId}] ${user.name} (uid=${user.uid})`);
      ok++;
    } catch (e) {
      console.error(`  ${label}: ERROR — ${e.message}`);
      err++;
    }
  }

  let backupsRemoved = 0;
  if (!dryRun && fs.existsSync(FINGERPRINTS_DIR)) {
    const files = fs.readdirSync(FINGERPRINTS_DIR).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(FINGERPRINTS_DIR, file), 'utf8');
        const backup = JSON.parse(raw);
        if (String(backup.employeeId) === String(employeeId)) {
          fs.unlinkSync(path.join(FINGERPRINTS_DIR, file));
          console.log(`  Respaldo eliminado: fingerprints/${file}`);
          backupsRemoved++;
        }
      } catch {
        // ignorar
      }
    }
  } else if (dryRun && fs.existsSync(FINGERPRINTS_DIR)) {
    const files = fs.readdirSync(FINGERPRINTS_DIR).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(FINGERPRINTS_DIR, file), 'utf8');
        const backup = JSON.parse(raw);
        if (String(backup.employeeId) === String(employeeId)) {
          console.log(`  [DRY-RUN] se eliminaría respaldo: fingerprints/${file}`);
          backupsRemoved++;
        }
      } catch {
        // ignorar
      }
    }
  }

  if (backupsRemoved > 0 && !dryRun) {
    console.log(`\n  ${backupsRemoved} archivo(s) de respaldo eliminado(s).`);
  }

  console.log(`\nResultado: ${ok} dispositivo(s) ${dryRun ? 'que se modificarían' : 'actualizado(s)'}, ${err} error(es).`);
  if (dryRun) {
    console.log('\nEjecute sin --dry-run para aplicar los cambios.\n');
  }
  process.exit(err > 0 ? 1 : 0);
})();
