#!/usr/bin/env node

/**
 * Dry-run de sincronizacion entre dispositivos ZKTeco.
 * Compara usuarios en todos los checadores y muestra diferencias.
 *
 * Uso:
 *   node scripts/dry-run-sync-devices.js          # Solo muestra diferencias
 *   node scripts/dry-run-sync-devices.js --fix     # Sincroniza usuarios faltantes
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const zkClient = require('../src/zkteco/client');
const config = require('../src/config');

const fix = process.argv.includes('--fix');

(async () => {
  try {
    const devices = config.zkteco.devices;

    if (devices.length < 2) {
      console.log('Solo hay 1 dispositivo configurado. La sincronizacion entre checadores requiere al menos 2.');
      console.log('Mostrando usuarios del dispositivo unico:\n');
    }

    console.log(`Modo: ${fix ? 'SYNC REAL (--fix)' : 'DRY-RUN (solo lectura)'}`);
    console.log(`Dispositivos: ${devices.length}\n`);

    const result = await zkClient.validateUsersAcrossDevices(devices, { fix });

    // Resumen por dispositivo
    for (const devName of result.devices) {
      const devUsers = result.masterList.filter((u) => u.presentIn.includes(devName));
      console.log(`=== ${devName} ===`);
      console.log(`  Usuarios registrados: ${devUsers.length}`);
      console.log(`  Faltantes:            ${result.missing[devName].length}`);

      if (result.missing[devName].length > 0) {
        console.log('');
        for (const u of result.missing[devName]) {
          const from = u.presentIn.join(', ');
          const action = fix ? 'SINCRONIZADO' : 'falta';
          console.log(`  [${action}] ${u.name} (ID ${u.userId}) — presente en: ${from}`);
        }
      }

      if (fix && result.synced[devName] && result.synced[devName].length > 0) {
        console.log(`\n  Sincronizados: ${result.synced[devName].length} usuarios`);
      }

      console.log('');
    }

    // Lista maestra
    console.log('========================================');
    console.log(`  Lista maestra: ${result.masterList.length} usuarios unicos`);
    console.log(`  Consistente:   ${result.consistent ? 'SI — todos los dispositivos iguales' : 'NO — hay diferencias'}`);

    if (fix && !result.consistent) {
      console.log('  Accion:        Usuarios faltantes sincronizados');
    } else if (!fix && !result.consistent) {
      console.log('  Accion:        Ejecuta con --fix para sincronizar');
    }

    console.log('========================================\n');

    process.exit(result.consistent ? 0 : (fix ? 0 : 1));
  } catch (err) {
    console.error('Error fatal:', err.message);
    process.exit(1);
  }
})();
