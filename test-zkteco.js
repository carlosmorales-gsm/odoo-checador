#!/usr/bin/env node

/**
 * Prueba de concepto: conectar al checador ZKTeco y mostrar datos en consola.
 *
 * Uso:
 *   node test-zkteco.js                    # usa ZKTECO_DEVICES del .env
 *   node test-zkteco.js 192.168.1.100      # IP directa, puerto default 4370
 *   node test-zkteco.js 192.168.1.100 4370 # IP y puerto explícitos
 */

require('dotenv').config();
const ZKTeco = require('zkteco-js');
const fs = require('fs');

function formatTime(raw) {
  const d = new Date(raw);
  if (isNaN(d.getTime())) return raw;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function main() {
  // Determinar dispositivos a probar
  const devices = [];

  if (process.argv[2]) {
    // IP pasada como argumento
    devices.push({
      name: 'CLI',
      ip: process.argv[2],
      port: parseInt(process.argv[3], 10) || 4370,
    });
  } else if (process.env.ZKTECO_DEVICES) {
    const parsed = JSON.parse(process.env.ZKTECO_DEVICES);
    parsed.forEach((d, i) => devices.push({
      name: d.name || `Device-${i + 1}`,
      ip: d.ip,
      port: d.port || 4370,
    }));
  } else {
    console.error('Uso: node test-zkteco.js <IP> [PUERTO]');
    console.error('  o define ZKTECO_DEVICES en .env');
    process.exit(1);
  }

  for (const dev of devices) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Dispositivo: ${dev.name} — ${dev.ip}:${dev.port}`);
    console.log('='.repeat(60));

    const device = new ZKTeco(dev.ip, dev.port, 5000, 4000);

    try {
      console.log('\nConectando...');
      await device.createSocket();
      console.log('Conectado OK\n');

      // --- Info del dispositivo ---
      console.log('--- INFO DEL DISPOSITIVO ---');
      try {
        const info = await device.getInfo();
        console.log(JSON.stringify(info, null, 2));
      } catch (e) {
        console.log(`(getInfo no disponible: ${e.message})`);
      }

      // --- Usuarios registrados ---
      console.log('\n--- USUARIOS REGISTRADOS ---');
      const usersResult = await device.getUsers();
      const users = usersResult.data || usersResult || [];
      console.log(`Total: ${users.length} usuarios\n`);

      if (users.length > 0) {
        // Mostrar estructura raw del primer registro
        console.log('Estructura raw del primer usuario:');
        console.log(JSON.stringify(users[0], null, 2));
        console.log('');

        // Tabla resumen
        console.log('ID\tNombre');
        console.log('-'.repeat(40));
        for (const u of users) {
          const id = u.deviceUserId || u.userId || u.uid;
          console.log(`${id}\t${u.name}`);
        }
      }

      // --- Registros de asistencia ---
      console.log('\n--- REGISTROS DE ASISTENCIA ---');
      const logsResult = await device.getAttendances();
      const logsRaw = logsResult.data || logsResult || [];

      // Mapa de usuarios para resolver nombres
      const userMap = new Map();
      for (const u of users) {
        const id = String(u.deviceUserId || u.userId || u.uid);
        userMap.set(id, u.name);
      }

      // Filtrar registros válidos (descartar los que tienen fecha 2000-01-01 o sin user_id)
      const logs = logsRaw.filter((r) => {
        const uid = r.deviceUserId || r.user_id || r.userId;
        const time = r.recordTime || r.record_time || r.timestamp;
        if (!uid || !time) return false;
        const d = new Date(time);
        return !isNaN(d.getTime()) && d.getFullYear() > 2000;
      });

      console.log(`Total: ${logsRaw.length} registros (${logs.length} válidos)\n`);

      if (logs.length > 0) {
        // Mostrar estructura raw del primer registro válido
        console.log('Estructura raw del primer registro:');
        console.log(JSON.stringify(logs[0], null, 2));
        console.log('');

        // Últimos 30 registros válidos
        const recent = logs.slice(-30);
        console.log(`Últimos ${recent.length} registros:\n`);
        console.log('UserID\tNombre\t\t\t\tFecha/Hora\t\tTipo');
        console.log('-'.repeat(80));
        for (const r of recent) {
          const uid = String(r.deviceUserId || r.user_id || r.userId);
          const name = (userMap.get(uid) || '???').substring(0, 25).padEnd(25);
          const time = formatTime(r.recordTime || r.record_time || r.timestamp);
          const type = r.type ?? r.status ?? '';
          console.log(`${uid}\t${name}\t${time}\t\t${type}`);
        }
      }

      // --- Generar Markdown ---
      const md = [];
      md.push(`# Reporte ZKTeco — ${dev.name} (${dev.ip}:${dev.port})`);
      md.push('');
      md.push(`**Fecha:** ${new Date().toLocaleString('es-MX', { timeZone: process.env.TIMEZONE || 'America/Mexico_City' })}`);
      md.push(`**Usuarios:** ${users.length} | **Registros:** ${logsRaw.length} (${logs.length} válidos)`);
      md.push('');

      // Tabla usuarios
      md.push('## Usuarios');
      md.push('');
      md.push('| ID | Nombre |');
      md.push('|---|---|');
      for (const u of users) {
        const id = u.deviceUserId || u.userId || u.uid;
        md.push(`| ${id} | ${u.name} |`);
      }
      md.push('');

      // Tabla asistencia completa
      md.push('## Registros de Asistencia');
      md.push('');
      md.push('| # | UserID | Nombre | Fecha/Hora | Tipo |');
      md.push('|---|---|---|---|---|');
      logs.forEach((r, i) => {
        const uid = String(r.deviceUserId || r.user_id || r.userId);
        const name = userMap.get(uid) || '???';
        const time = formatTime(r.recordTime || r.record_time || r.timestamp);
        const type = r.type ?? r.status ?? '';
        md.push(`| ${i + 1} | ${uid} | ${name} | ${time} | ${type} |`);
      });

      const filename = `reporte-${dev.ip.replace(/\./g, '_')}.md`;
      fs.writeFileSync(filename, md.join('\n'));
      console.log(`\nReporte guardado en: ${filename}`);

    } catch (err) {
      console.error(`Error: ${err.message}`);
    } finally {
      try {
        await device.disconnect();
        console.log('\nDesconectado.');
      } catch (_) {}
    }
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
