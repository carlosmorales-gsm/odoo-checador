#!/usr/bin/env node

/**
 * Elimina todas las huellas digitales de un usuario (por ID de Odoo) en todos los checadores
 * y borra sus respaldos en fingerprints/ para que no se re-suban en futuras restauraciones.
 * El usuario sigue existiendo en el dispositivo; solo se borran sus templates biométricos.
 *
 * Uso:
 *   node scripts/delete-user-fingerprints.js --id 801
 *   node scripts/delete-user-fingerprints.js --id 801 --device "Fune Navolato"
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
  if (idIdx === -1 || !args[idIdx + 1]) {
    return { employeeId: null, deviceFilter: null };
  }
  return {
    employeeId: args[idIdx + 1].trim(),
    deviceFilter: deviceIdx !== -1 ? args[deviceIdx + 1] : null,
  };
}

(async () => {
  const { employeeId, deviceFilter } = parseArgs();

  if (!employeeId) {
    console.error('Uso: node scripts/delete-user-fingerprints.js --id <id_odoo>');
    console.error('  Ejemplo: node scripts/delete-user-fingerprints.js --id 801');
    console.error('  Opcional: --device "Nombre" para un solo checador');
    process.exit(1);
  }

  const devices = deviceFilter
    ? config.zkteco.devices.filter((d) => d.name === deviceFilter)
    : config.zkteco.devices;

  if (devices.length === 0) {
    console.error(deviceFilter ? `No se encontró el dispositivo "${deviceFilter}".` : 'No hay dispositivos configurados.');
    process.exit(1);
  }

  console.log(`Eliminando huellas del usuario Odoo id=${employeeId} en ${devices.length} dispositivo(s)...\n`);

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

      await zkClient.deleteUserFingerprints(device, user.uid, user.userId);
      console.log(`  ${label}: huellas eliminadas para [${employeeId}] ${user.name} (uid=${user.uid})`);
      ok++;
    } catch (e) {
      console.error(`  ${label}: ERROR — ${e.message}`);
      err++;
    }
  }

  // Eliminar respaldos en fingerprints/ para este empleado (evitar que se re-suban en restauraciones)
  let backupsRemoved = 0;
  if (fs.existsSync(FINGERPRINTS_DIR)) {
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
        // Ignorar archivos no válidos o inaccesibles
      }
    }
  }
  if (backupsRemoved > 0) {
    console.log(`\n  ${backupsRemoved} archivo(s) de respaldo eliminado(s) para id=${employeeId}.`);
  }

  console.log(`\nResultado: ${ok} dispositivo(s) actualizado(s), ${err} error(es).`);
  process.exit(err > 0 ? 1 : 0);
})();
