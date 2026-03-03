#!/usr/bin/env node

/**
 * Dry-run: cruza empleados de Odoo (sin barcode) contra usuarios del ZKTeco
 * y muestra el plan de enrollment sin modificar nada.
 *
 * Uso:
 *   node scripts/dry-run-enrollment.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const config = require('../src/config');
const OdooClient = require('../src/odoo/client');
const { getUsers, getDeviceInfo } = require('../src/zkteco/client');

const SEP = '='.repeat(70);
const LINE = '-'.repeat(70);

function normalize(name) {
  return (name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

async function fetchOdooEmployees() {
  const odoo = new OdooClient(config.odoo);

  console.log('Autenticando con Odoo...');
  await odoo.authenticate();
  console.log('OK\n');

  const employees = await odoo.getAllEmployees(['id', 'name', 'barcode']);
  return employees.sort((a, b) => a.id - b.id);
}

async function fetchZktecoUsers() {
  const devices = config.zkteco.devices;
  const result = {};
  for (const dev of devices) {
    try {
      console.log(`Conectando a ${dev.name} (${dev.ip})...`);
      const info = await getDeviceInfo(dev);
      console.log(`  Info: ${info.userCounts} usuarios, ${info.logCounts} registros, capacidad: ${info.logCapacity}`);
      const users = await getUsers(dev);
      result[dev.name] = { device: dev, users, info, error: null };
      console.log(`  ${users.length} usuarios leídos OK`);
    } catch (err) {
      const msg = err.message || err?.err?.message || JSON.stringify(err);
      result[dev.name] = { device: dev, users: [], info: null, error: msg };
      console.log(`  NO ACCESIBLE: ${msg}`);
    }
  }
  return result;
}

function printSection1(employees) {
  console.log(`\n${SEP}`);
  console.log('SECCIÓN 1: EMPLEADOS EN ODOO');
  console.log(SEP);

  const withBarcode = employees.filter((e) => e.barcode);
  const withoutBarcode = employees.filter((e) => !e.barcode);

  console.log(`Total: ${employees.length} | Con barcode: ${withBarcode.length} | Sin barcode: ${withoutBarcode.length}\n`);

  console.log('ID\tBarcode\t\tNombre');
  console.log(LINE);
  for (const e of employees) {
    const bc = e.barcode || '(vacío)';
    console.log(`${e.id}\t${bc.padEnd(12)}\t${e.name}`);
  }

  return { withBarcode, withoutBarcode };
}

function printSection2(deviceUsers) {
  console.log(`\n${SEP}`);
  console.log('SECCIÓN 2: USUARIOS EN ZKTECO');
  console.log(SEP);

  for (const [devName, { users, info, error }] of Object.entries(deviceUsers)) {
    console.log(`\n--- ${devName} ---`);
    if (error) {
      console.log(`  ERROR: ${error}`);
      continue;
    }
    if (info) {
      console.log(`  Capacidad: ${info.logCapacity} registros | Usuarios: ${info.userCounts} | Registros: ${info.logCounts}`);
    }
    console.log(`  ${users.length} usuarios\n`);
    if (users.length === 0) {
      console.log('  (dispositivo vacío — listo para enrollment)');
    } else {
      console.log('  UID\tUserID\tNombre');
      console.log(`  ${'-'.repeat(50)}`);
      const sorted = [...users].sort((a, b) => parseInt(a.userId) - parseInt(b.userId));
      for (const u of sorted) {
        console.log(`  ${u.uid}\t${u.userId}\t${u.name}`);
      }
    }
  }
}

function printSection3(withoutBarcode, deviceUsers) {
  console.log(`\n${SEP}`);
  console.log('SECCIÓN 3: CRUCE — EMPLEADOS SIN BARCODE vs ZKTECO');
  console.log(SEP);

  const allZkUsers = [];
  for (const { users } of Object.values(deviceUsers)) {
    for (const u of users) {
      if (!allZkUsers.find((x) => x.userId === u.userId)) {
        allZkUsers.push(u);
      }
    }
  }

  const zkByName = new Map();
  for (const u of allZkUsers) {
    const key = normalize(u.name);
    if (!zkByName.has(key)) zkByName.set(key, []);
    zkByName.get(key).push(u);
  }

  const matched = [];
  const unmatched = [];

  for (const emp of withoutBarcode) {
    const key = normalize(emp.name);
    const found = zkByName.get(key);
    if (found && found.length > 0) {
      matched.push({ employee: emp, zkUsers: found });
    } else {
      unmatched.push(emp);
    }
  }

  console.log(`\nEmpleados sin barcode: ${withoutBarcode.length}`);
  console.log(`  Encontrados en ZKTeco (por nombre): ${matched.length}`);
  console.log(`  NO encontrados en ZKTeco:           ${unmatched.length}`);

  if (matched.length > 0) {
    console.log(`\n--- COINCIDENCIAS POR NOMBRE ---\n`);
    console.log('Odoo ID\tNombre Odoo\t\t\tZK UID\tZK UserID');
    console.log(LINE);
    for (const m of matched) {
      for (const zk of m.zkUsers) {
        const name = m.employee.name.substring(0, 28).padEnd(28);
        console.log(`${m.employee.id}\t${name}\t${zk.uid}\t${zk.userId}`);
      }
    }
  }

  if (unmatched.length > 0) {
    console.log(`\n--- SIN COINCIDENCIA EN ZKTECO ---\n`);
    console.log('Odoo ID\tNombre');
    console.log(LINE);
    for (const emp of unmatched) {
      console.log(`${emp.id}\t${emp.name}`);
    }
  }

  return { matched, unmatched };
}

function printSection4(withoutBarcode, deviceUsers, matched, unmatched) {
  console.log(`\n${SEP}`);
  console.log('SECCIÓN 4: PLAN DE ENROLLMENT (DRY-RUN)');
  console.log(SEP);
  console.log('\nEsquema: Odoo employee.id → ZKTeco userid | ZKTeco uid (secuencial) → Odoo barcode\n');

  const deviceNames = Object.keys(deviceUsers).filter((d) => !deviceUsers[d].error);

  if (deviceNames.length === 0) {
    console.log('*** No hay dispositivos accesibles. No se puede generar plan. ***');
    return;
  }

  // Determinar el siguiente uid disponible por dispositivo
  const nextUid = {};
  for (const devName of deviceNames) {
    const maxUid = deviceUsers[devName].users.reduce(
      (max, u) => Math.max(max, parseInt(u.uid) || 0), 0
    );
    nextUid[devName] = maxUid + 1;
  }

  let totalOps = 0;

  console.log('Acción\t\tOdoo ID\tZK userid\tZK uid\t\tNombre\t\t\t\tDispositivo(s)');
  console.log('='.repeat(110));

  for (const emp of withoutBarcode) {
    const devList = deviceNames.join(', ');
    // uid será secuencial; usamos el del primer dispositivo como referencia
    const uid = nextUid[deviceNames[0]];

    console.log(`CREAR ZK\t${emp.id}\t${emp.id}\t\t${uid}\t\t${emp.name.substring(0, 28).padEnd(28)}\t${devList}`);
    console.log(`WRITE ODOO\t${emp.id}\t-\t\tbarcode=${uid}\t${emp.name.substring(0, 28)}`);

    for (const devName of deviceNames) {
      nextUid[devName]++;
    }
    totalOps += deviceNames.length + 1;
  }

  console.log(`\n${LINE}`);
  console.log('RESUMEN DEL PLAN');
  console.log(LINE);
  console.log(`  Empleados a registrar en ZKTeco:  ${withoutBarcode.length}`);
  console.log(`  Dispositivos destino:             ${deviceNames.length} (${deviceNames.join(', ')})`);
  console.log(`  Operaciones ZKTeco (setUser):     ${withoutBarcode.length * deviceNames.length}`);
  console.log(`  Operaciones Odoo (write barcode): ${withoutBarcode.length}`);
  console.log(`  Total operaciones:                ${totalOps}`);
  console.log(`\n  *** ESTO ES UN DRY-RUN — NO SE EJECUTÓ NINGUNA ACCIÓN ***`);
  console.log(SEP);
}

async function main() {
  console.log(SEP);
  console.log('DRY-RUN: ENROLLMENT ZKTECO ↔ ODOO');
  console.log(`Fecha: ${new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' })}`);
  console.log(SEP);

  const employees = await fetchOdooEmployees();
  const deviceUsers = await fetchZktecoUsers();

  const { withoutBarcode } = printSection1(employees);
  printSection2(deviceUsers);
  const { matched, unmatched } = printSection3(withoutBarcode, deviceUsers);
  printSection4(withoutBarcode, deviceUsers, matched, unmatched);
}

main().catch((err) => {
  console.error(`\nError fatal: ${err.message}`);
  process.exit(1);
});
