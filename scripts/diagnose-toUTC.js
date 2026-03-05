#!/usr/bin/env node
/**
 * Diagnóstico de toUTC: reproduce en local o en el Pi los pasos de conversión
 * de timestamp ZKTeco ("YYYY-MM-DD HH:mm:ss" en hora local) a UTC.
 *
 * Uso (desde la raíz del proyecto):
 *   node scripts/diagnose-toUTC.js
 *   node scripts/diagnose-toUTC.js "2026-03-05 07:00:19"
 *
 * Con esto se ve el valor real de TIMEZONE, el resultado de formatToParts
 * y por qué tzDisplay puede ser inválido en el Pi.
 */

require('dotenv').config();

const timezone = process.env.TIMEZONE || 'America/Mexico_City';
const sample = process.argv[2] || '2026-03-05 07:00:19';

function pad(n) {
  return String(n).padStart(2, '0');
}

console.log('=== Diagnóstico toUTC ===\n');
console.log('TIMEZONE (env):', JSON.stringify(process.env.TIMEZONE));
console.log('TIMEZONE (usado):', JSON.stringify(timezone));
console.log('TIMEZONE length:', timezone.length);
console.log("TIMEZONE === 'America/Mexico_City':", timezone === 'America/Mexico_City');
console.log('Muestra (localDateStr):', JSON.stringify(sample));
console.log('');

const localDateStr = sample;

// Paso 1: anchor
const anchorStr = localDateStr.replace(' ', 'T') + 'Z';
const anchor = new Date(anchorStr);
console.log('1. anchor string:', anchorStr);
console.log('   anchor.getTime():', anchor.getTime());
console.log('   isNaN(anchor.getTime()):', isNaN(anchor.getTime()));
console.log('');

if (isNaN(anchor.getTime())) {
  console.log('>>> anchor inválido, no se puede continuar con Intl.');
  process.exit(1);
}

// Paso 2: Intl formatter y formatToParts
const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: timezone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

let parts;
try {
  parts = formatter.formatToParts(anchor);
} catch (e) {
  console.log('2. formatter.formatToParts(anchor) LANZÓ:', e.message);
  process.exit(1);
}

console.log('2. formatToParts(anchor) cantidad:', parts.length);
parts.forEach((p, i) => {
  console.log(`   [${i}] type=${JSON.stringify(p.type)} value=${JSON.stringify(p.value)}`);
});

const get = (type) => parts.find((p) => p.type === type)?.value;
const y = get('year'), mo = get('month'), d = get('day');
const h = get('hour'), mi = get('minute'), s = get('second');

console.log('');
console.log('   get("year"):', JSON.stringify(y));
console.log('   get("month"):', JSON.stringify(mo));
console.log('   get("day"):', JSON.stringify(d));
console.log('   get("hour"):', JSON.stringify(h));
console.log('   get("minute"):', JSON.stringify(mi));
console.log('   get("second"):', JSON.stringify(s));

// Paso 3: construir tzDisplay
const tzDisplayStr = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(s).padStart(2, '0')}Z`;
console.log('');
console.log('3. tzDisplay string:', tzDisplayStr);
const tzDisplay = new Date(tzDisplayStr);
console.log('   tzDisplay.getTime():', tzDisplay.getTime());
console.log('   isNaN(tzDisplay.getTime()):', isNaN(tzDisplay.getTime()));

if (isNaN(tzDisplay.getTime())) {
  console.log('');
  console.log('>>> tzDisplay es inválido. En toUTC() se lanza "invalid tzDisplay"');
  console.log('    a menos que timezone === "America/Mexico_City" para usar fallback.');
}

// Fallback manual (Mexico UTC-6)
console.log('');
console.log('4. Fallback Mexico (UTC-6):');
const m = localDateStr.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
if (m) {
  const [, yy, mm, dd, hh, min, sec] = m;
  const localAsUtc = Date.UTC(
    parseInt(yy, 10), parseInt(mm, 10) - 1, parseInt(dd, 10),
    parseInt(hh, 10), parseInt(min, 10), parseInt(sec, 10)
  );
  const utcDate = new Date(localAsUtc + 6 * 60 * 60 * 1000);
  const result = utcDate.toISOString().replace('T', ' ').substring(0, 19);
  console.log('   UTC result:', result);
} else {
  console.log('   No coincide regex YYYY-MM-DD HH:mm:ss');
}

console.log('');
console.log('=== Fin diagnóstico ===');
