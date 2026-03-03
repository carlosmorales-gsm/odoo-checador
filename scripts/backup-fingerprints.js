#!/usr/bin/env node

/**
 * Respaldo de huellas digitales de los dispositivos ZKTeco.
 * Por defecto solo respalda usuarios que aún no tienen archivo en fingerprints/ (incremental).
 * Use --force para sobrescribir respaldos existentes.
 *
 * Uso:
 *   node scripts/backup-fingerprints.js                          # Todos los dispositivos (incremental)
 *   node scripts/backup-fingerprints.js --dry-run                # Simular sin escribir en fingerprints/
 *   node scripts/backup-fingerprints.js --force                 # Sobrescribir respaldos existentes
 *   node scripts/backup-fingerprints.js --device "Fune Navolato" # Un dispositivo
 *   node scripts/backup-fingerprints.js --uid 128                # Solo el usuario con uid 128
 *   node scripts/backup-fingerprints.js --debug                  # Diagnóstico por dedo
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const config = require('../src/config');
const { runBackupIncremental } = require('../src/sync/fingerprint-backup');

function parseArgs() {
  const args = process.argv.slice(2);
  const deviceIdx = args.indexOf('--device');
  const uidIdx = args.indexOf('--uid');
  const debug = process.env.BACKUP_FINGERPRINTS_DEBUG === '1' || args.includes('--debug');
  const force = args.includes('--force');
  const dryRun = args.includes('--dry-run');
  return {
    deviceFilter: deviceIdx !== -1 ? args[deviceIdx + 1] : null,
    uidFilter: uidIdx !== -1 ? args[uidIdx + 1] : null,
    debug,
    force,
    dryRun,
  };
}

(async () => {
  const { deviceFilter, uidFilter, debug, force, dryRun } = parseArgs();
  if (dryRun) console.log('*** DRY-RUN: no se escribirá ningún archivo en fingerprints/ ***\n');
  if (debug) console.log('Modo debug: se mostrara la respuesta del dispositivo por cada dedo.\n');
  if (uidFilter) console.log(`Solo usuario con uid=${uidFilter}\n`);
  if (force && !dryRun) console.log('Modo --force: se sobrescribiran respaldos existentes.\n');
  if (!force && !dryRun) console.log('Modo incremental: solo se respaldan usuarios sin archivo en fingerprints/.\n');

  const devices = deviceFilter
    ? config.zkteco.devices.filter((d) => d.name === deviceFilter)
    : config.zkteco.devices;

  if (devices.length === 0) {
    console.error(`No se encontro el dispositivo "${deviceFilter}"`);
    process.exit(1);
  }

  console.log('Cargando respaldo...');
  console.log(`Dispositivo(s): ${devices.map((d) => d.name).join(', ')}`);
  console.log('');

  const result = await runBackupIncremental({
    deviceFilter,
    uidFilter,
    force,
    debug,
    dryRun,
    log: (msg) => console.log(msg),
  });

  console.log('\n========================================');
  if (dryRun) {
    console.log(`  [DRY-RUN] Se respaldarían: ${result.totalUsers} usuarios, ${result.totalTemplates} templates`);
  } else {
    console.log(`  Usuarios respaldados: ${result.totalUsers}`);
    console.log(`  Templates totales:    ${result.totalTemplates}`);
  }
  console.log(`  Errores:              ${result.totalErrors}`);
  console.log('========================================\n');

  process.exit(result.totalErrors > 0 ? 1 : 0);
})();
