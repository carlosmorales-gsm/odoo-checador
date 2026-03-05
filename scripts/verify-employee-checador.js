#!/usr/bin/env node

/**
 * Verifica por cada empleado Odoo (con barcode) si está en cada checador y si tiene huellas.
 * Con --fix da de alta en el checador solo cuando: Odoo tiene barcode y nombre, no está en el
 * checador y el uid no está ocupado. Antes de cada alta se re-verifica en el dispositivo.
 *
 * Uso:
 *   node scripts/verify-employee-checador.js                    # Solo verificar (no modifica)
 *   node scripts/verify-employee-checador.js --fix              # Verificar y dar de alta los que falten (uid libre)
 *   node scripts/verify-employee-checador.js --ids 350,351      # Solo esos IDs
 *   node scripts/verify-employee-checador.js --device "Fune Zapata"  # Solo ese checador
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const config = require('../src/config');
const OdooClient = require('../src/odoo/client');
const zkClient = require('../src/zkteco/client');

function parseArgs() {
  const args = process.argv.slice(2);
  const idsIdx = args.indexOf('--ids');
  const deviceIdx = args.indexOf('--device');
  const idsRaw = idsIdx !== -1 ? args[idsIdx + 1] : null;
  const deviceName = deviceIdx !== -1 ? args[deviceIdx + 1] : null;
  const fix = args.includes('--fix');
  const ids = idsRaw
    ? idsRaw.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n))
    : null;
  return { ids, deviceName, fix };
}

async function main() {
  const { ids, deviceName, fix } = parseArgs();

  console.log('Verificación: empleado Odoo ↔ checador + huellas');
  if (fix) console.log('Modo --fix: se darán de alta los que falten (uid libre).');
  console.log('================================================\n');

  const odoo = new OdooClient(config.odoo);
  console.log('Conectando a Odoo...');
  await odoo.authenticate();
  console.log('OK\n');

  let employees = await odoo.getAllEmployees(['id', 'name', 'barcode']);
  employees = employees.filter((e) => e.barcode);
  if (employees.length === 0) {
    console.log('No hay empleados con barcode en Odoo.');
    process.exit(0);
  }

  if (ids && ids.length > 0) {
    const idSet = new Set(ids);
    employees = employees.filter((e) => idSet.has(e.id));
    if (employees.length === 0) {
      console.log('Ninguno de los IDs indicados tiene barcode en Odoo.');
      process.exit(1);
    }
    console.log(`Filtrando empleados: ${ids.join(', ')}\n`);
  }

  let devices = config.zkteco.devices;
  if (deviceName) {
    devices = devices.filter((d) => d.name === deviceName);
    if (devices.length === 0) {
      console.error(`No se encontró el dispositivo "${deviceName}".`);
      process.exit(1);
    }
    console.log(`Solo checador: ${deviceName}\n`);
  }

  // Por cada dispositivo: obtener usuarios y luego huellas por usuario
  const deviceData = {};
  for (const device of devices) {
    const label = `${device.name} (${device.ip})`;
    process.stdout.write(`Leyendo ${label}...`);
    try {
      const users = await zkClient.getUsers(device);
      deviceData[device.name] = { device, users, error: null };
      console.log(` ${users.length} usuarios`);
    } catch (err) {
      deviceData[device.name] = { device, users: [], error: err.message };
      console.log(` ERROR: ${err.message}`);
    }
  }

  console.log('\n--- Resultado ---\n');
  console.log('ID Odoo\tNombre\t\t\tBarcode\tChecador\t\tEn checador\tUID ocupado\t\tHuellas');
  console.log('-'.repeat(100));

  const toFix = [];

  for (const emp of employees) {
    const nameShort = (emp.name || '').substring(0, 20).padEnd(20);
    const barcode = (emp.barcode || '').toString();

    for (const device of devices) {
      const data = deviceData[device.name];
      const devName = device.name.padEnd(18);

      if (data.error) {
        console.log(`${emp.id}\t${nameShort}\t${barcode}\t${devName}\t—\t\t—\t\t\t${data.error}`);
        continue;
      }

      const userOnDevice = data.users.find((u) => String(u.userId) === String(emp.id));
      if (!userOnDevice) {
        const uidOccupant = data.users.find((u) => String(u.uid) === String(barcode));
        if (uidOccupant) {
          const uidStatus = `Sí por [${uidOccupant.userId}] ${(uidOccupant.name || '').substring(0, 15)}`;
          console.log(`${emp.id}\t${nameShort}\t${barcode}\t${devName}\tNo\t\t${uidStatus.padEnd(20)}\t—`);
          continue;
        }
        if (emp.name && emp.barcode) {
          toFix.push({ emp, device: data.device, devName });
        }
        console.log(`${emp.id}\t${nameShort}\t${barcode}\t${devName}\tNo\t\t${'No'.padEnd(20)}\t—`);
        continue;
      }

      let fingerprintCount = '?';
      try {
        const templates = await zkClient.getUserFingerprints(device, userOnDevice.uid);
        fingerprintCount = templates.length === 0 ? 'No' : templates.length.toString();
      } catch {
        fingerprintCount = 'error';
      }
      console.log(`${emp.id}\t${nameShort}\t${barcode}\t${devName}\tSí (uid=${userOnDevice.uid})\t—\t\t\t${fingerprintCount}`);
    }
  }

  console.log('-'.repeat(100));
  console.log('\n(En checador = usuario con ese userId existe. UID ocupado = cuando no está en checador, si otro usuario ya usa ese uid/barcode. Huellas = templates en el dispositivo)\n');

  if (fix && toFix.length > 0) {
    console.log('--- Dar de alta (--fix) ---');
    console.log('Solo se da de alta si: Odoo tiene barcode y nombre, no está en checador y uid no ocupado.\n');
    let totalRestored = 0;
    let totalSkipped = 0;
    for (const { emp, device, devName } of toFix) {
      try {
        const currentUsers = await zkClient.getUsers(device);
        const alreadyExists = currentUsers.some((u) => String(u.userId) === String(emp.id));
        const uidTaken = currentUsers.some((u) => String(u.uid) === String(emp.barcode));
        if (alreadyExists) {
          console.log(`  [OMITIDO] [${emp.id}] ${emp.name} → ${device.name}: ya está en el checador.`);
          totalSkipped++;
          continue;
        }
        if (uidTaken) {
          const occupant = currentUsers.find((u) => String(u.uid) === String(emp.barcode));
          console.log(`  [OMITIDO] [${emp.id}] ${emp.name} → ${device.name}: uid ${emp.barcode} ocupado por [${occupant ? occupant.userId : '?'}].`);
          totalSkipped++;
          continue;
        }
        await zkClient.setUser(device, {
          uid: parseInt(emp.barcode, 10),
          userid: emp.id,
          name: emp.name,
        });
        console.log(`  [OK] [${emp.id}] ${emp.name} → ${device.name} (uid=${emp.barcode})`);
        totalRestored++;
      } catch (err) {
        console.log(`  [ERR] [${emp.id}] ${emp.name} → ${device.name}: ${err.message}`);
      }
    }
    console.log(`\nRestaurados: ${totalRestored}${totalSkipped > 0 ? ` | Omitidos (ya en checador o uid ocupado): ${totalSkipped}` : ''}`);
  } else if (fix && toFix.length === 0) {
    console.log('Nada que dar de alta (todos están en checador, uid ocupado o faltan datos en Odoo).\n');
  }
}

main().catch((err) => {
  console.error('Error fatal:', err.message);
  process.exit(1);
});
