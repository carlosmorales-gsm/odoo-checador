#!/usr/bin/env node

/**
 * Valida que los empleados de Odoo estén en todos los checadores con IDs consistentes.
 * Detecta:
 *   - Empleados faltantes en algún dispositivo
 *   - uid diferente entre dispositivos para el mismo empleado
 *   - uid del dispositivo que no coincide con el barcode de Odoo
 *   - Usuarios en checadores que no existen en Odoo
 *
 * No modifica nada. Solo lectura.
 *
 * Uso: node scripts/validate-users-across-devices.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const config = require('../src/config');
const OdooClient = require('../src/odoo/client');
const zkClient = require('../src/zkteco/client');

function pad(str, len) {
  const s = String(str);
  return s.length >= len ? s : s + ' '.repeat(len - s.length);
}

function padLeft(str, len) {
  const s = String(str);
  return s.length >= len ? s : ' '.repeat(len - s.length) + s;
}

(async () => {
  try {
    const devices = config.zkteco.devices;
    if (devices.length < 2) {
      console.log('Solo hay 1 dispositivo configurado. Este script compara entre dispositivos y contra Odoo.\n');
    }

    const odoo = new OdooClient(config.odoo);
    console.log('Conectando a Odoo...');
    await odoo.authenticate();
    console.log('OK\n');

    const employees = await odoo.getAllEmployees(['id', 'name', 'barcode']);
    const withBarcode = employees.filter((e) => e.barcode);
    console.log(`Empleados Odoo: ${employees.length} total, ${withBarcode.length} con barcode\n`);

    const deviceUsers = {};
    for (const device of devices) {
      const label = `${device.name} (${device.ip})`;
      process.stdout.write(`Leyendo ${label}... `);
      try {
        const users = await zkClient.getUsers(device);
        deviceUsers[device.name] = users;
        console.log(`${users.length} usuarios`);
      } catch (err) {
        deviceUsers[device.name] = null;
        console.log(`ERROR: ${err.message}`);
      }
    }

    const devNames = devices.map((d) => d.name);
    const issues = [];
    const rows = [];

    // --- Validate each Odoo employee across all devices ---
    for (const emp of withBarcode) {
      const row = {
        odooId: emp.id,
        name: (emp.name || '').substring(0, 25),
        barcode: String(emp.barcode),
        devices: {},
        status: 'OK',
        problems: [],
      };

      const uidsFound = new Set();

      for (const dName of devNames) {
        const users = deviceUsers[dName];
        if (users === null) {
          row.devices[dName] = { uid: '—', note: 'sin conexion' };
          continue;
        }

        const match = users.find((u) => String(u.userId) === String(emp.id));
        if (!match) {
          row.devices[dName] = { uid: '—', note: 'FALTA' };
          row.problems.push(`Falta en ${dName}`);
        } else {
          row.devices[dName] = { uid: match.uid, note: '' };
          uidsFound.add(match.uid);

          if (String(match.uid) !== String(emp.barcode)) {
            row.devices[dName].note = `uid≠barcode (${emp.barcode})`;
            row.problems.push(`${dName}: uid=${match.uid} ≠ barcode=${emp.barcode}`);
          }
        }
      }

      if (uidsFound.size > 1) {
        row.problems.push(`uid diferente entre dispositivos: ${[...uidsFound].join(', ')}`);
      }

      if (row.problems.length > 0) {
        row.status = 'ERROR';
        issues.push(...row.problems.map((p) => `[${emp.id}] ${emp.name}: ${p}`));
      }

      rows.push(row);
    }

    // --- Detect users on devices that don't exist in Odoo ---
    const odooIds = new Set(employees.map((e) => String(e.id)));
    const orphans = [];
    for (const dName of devNames) {
      const users = deviceUsers[dName];
      if (!users) continue;
      for (const u of users) {
        if (!odooIds.has(u.userId)) {
          orphans.push({ device: dName, uid: u.uid, userId: u.userId, name: u.name });
        }
      }
    }

    // --- Print table ---
    console.log('\n=== Empleados Odoo vs Checadores ===\n');

    const devHeaders = devNames.map((n) => pad(n, 20)).join(' ');
    const hdr = `${pad('ID', 6)} ${pad('Nombre', 25)} ${pad('Barcode', 8)} ${devHeaders}  Estado`;
    console.log(hdr);
    console.log('─'.repeat(hdr.length));

    for (const row of rows) {
      const devCols = devNames.map((dName) => {
        const d = row.devices[dName];
        if (!d) return pad('—', 20);
        if (d.note === 'FALTA') return pad('FALTA', 20);
        if (d.note === 'sin conexion') return pad('sin conexion', 20);
        const label = `uid=${d.uid}` + (d.note ? ` (!)` : '');
        return pad(label, 20);
      }).join(' ');

      const tag = row.status === 'OK' ? 'OK' : 'ERROR';
      console.log(`${pad(row.odooId, 6)} ${pad(row.name, 25)} ${pad(row.barcode, 8)} ${devCols}  ${tag}`);
    }

    console.log('─'.repeat(hdr.length));

    // --- Orphans ---
    if (orphans.length > 0) {
      console.log(`\n=== Usuarios en checador sin empleado en Odoo (${orphans.length}) ===\n`);
      console.log(`${pad('Checador', 20)} ${pad('uid', 8)} ${pad('userId', 10)} Nombre`);
      console.log('─'.repeat(60));
      for (const o of orphans) {
        console.log(`${pad(o.device, 20)} ${pad(o.uid, 8)} ${pad(o.userId, 10)} ${o.name || '—'}`);
      }
    }

    // --- Summary ---
    const okCount = rows.filter((r) => r.status === 'OK').length;
    const errCount = rows.filter((r) => r.status === 'ERROR').length;
    const missingCount = rows.filter((r) => Object.values(r.devices).some((d) => d.note === 'FALTA')).length;
    const uidMismatch = rows.filter((r) => r.problems.some((p) => p.includes('uid diferente') || p.includes('uid≠barcode'))).length;

    console.log('\n=== Resumen ===\n');
    console.log(`  Empleados validados:    ${rows.length}`);
    console.log(`  OK (consistentes):      ${okCount}`);
    console.log(`  Con problemas:          ${errCount}`);
    if (missingCount > 0) console.log(`    - Falta en algun dispositivo: ${missingCount}`);
    if (uidMismatch > 0) console.log(`    - uid inconsistente:          ${uidMismatch}`);
    if (orphans.length > 0) console.log(`  Huerfanos en checadores:  ${orphans.length}`);
    console.log('');

    if (issues.length > 0) {
      console.log('=== Detalle de problemas ===\n');
      issues.forEach((msg) => console.log(`  • ${msg}`));
      console.log('');
    }

  } catch (err) {
    console.error('Error fatal:', err.message);
    process.exit(1);
  }
})();
