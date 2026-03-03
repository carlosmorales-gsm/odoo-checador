const config = require('./config');
const { logger } = require('./logger');
const cron = require('node-cron');
const http = require('http');
const stateDb = require('./db/state');
const { syncAll } = require('./sync/attendance');
const { enrollNewEmployees } = require('./sync/enrollment');

// Initialize SQLite
logger.info('Initializing database...');
stateDb.init();

let syncing = false;
let enrolling = false;

async function runSync() {
  if (syncing) {
    logger.warn('Previous sync still running, skipping this cycle');
    return;
  }
  syncing = true;
  try {
    await syncAll();
  } catch (err) {
    logger.error(`Sync failed: ${err.message}`);
  } finally {
    syncing = false;
  }
}

async function runEnrollment() {
  if (enrolling) {
    logger.warn('Previous enrollment still running, skipping');
    return;
  }
  enrolling = true;
  try {
    await enrollNewEmployees();
  } catch (err) {
    logger.error(`Enrollment failed: ${err.message}`);
  } finally {
    enrolling = false;
  }
}

// Cron 1 — Sync asistencia (cada 30 min por defecto)
logger.info(`Scheduling attendance sync: ${config.sync.interval}`);
cron.schedule(config.sync.interval, runSync);

// Cron 2 — Enrollment semanal (martes 8am por defecto)
logger.info(`Scheduling enrollment: ${config.enroll.interval}`);
cron.schedule(config.enroll.interval, runEnrollment);

// Sync inicial al arrancar
logger.info('Running initial sync...');
runSync();

function parseQuery(urlStr) {
  const url = new URL(urlStr, 'http://localhost');
  return Object.fromEntries(url.searchParams.entries());
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data, null, 2));
}

const CONSOLE_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Checador Sync — Consola</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;padding:1.5rem}
  h1{font-size:1.4rem;margin-bottom:1rem;color:#38bdf8}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1rem;margin-bottom:1.5rem}
  .card{background:#1e293b;border-radius:8px;padding:1.2rem}
  .card h3{font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;color:#94a3b8;margin-bottom:.4rem}
  .card .val{font-size:1.8rem;font-weight:700;color:#f8fafc}
  .card .val.ok{color:#4ade80} .card .val.warn{color:#fbbf24}
  table{width:100%;border-collapse:collapse;background:#1e293b;border-radius:8px;overflow:hidden;margin-bottom:1.5rem}
  th{background:#334155;text-align:left;padding:.6rem .8rem;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;color:#94a3b8}
  td{padding:.5rem .8rem;border-top:1px solid #334155;font-size:.85rem}
  tr:hover td{background:#262f3f}
  .tag{display:inline-block;padding:.15rem .5rem;border-radius:4px;font-size:.75rem;font-weight:600}
  .tag.in{background:#064e3b;color:#6ee7b7} .tag.out{background:#7c2d12;color:#fdba74}
  .refresh{background:#334155;color:#e2e8f0;border:none;padding:.5rem 1rem;border-radius:6px;cursor:pointer;font-size:.85rem;margin-bottom:1rem}
  .refresh:hover{background:#475569}
  .section{margin-bottom:1.5rem}
  .section h2{font-size:1rem;color:#cbd5e1;margin-bottom:.6rem;border-bottom:1px solid #334155;padding-bottom:.4rem}
  .empty{color:#64748b;font-style:italic;padding:1rem}
  .mono{font-family:'SF Mono',Consolas,monospace;font-size:.8rem}
</style>
</head>
<body>
<h1>Checador Sync — Consola</h1>
<button class="refresh" onclick="load()">Actualizar</button>
<div class="grid" id="stats"></div>
<div class="section"><h2>Estado de Dispositivos</h2><div id="devices"></div></div>
<div class="section"><h2>Ultimos Registros de Sync</h2><div id="logs"></div></div>
<script>
async function load(){
  const [stats,state,logs]=await Promise.all([
    fetch('/api/stats').then(r=>r.json()),
    fetch('/api/sync-state').then(r=>r.json()),
    fetch('/api/sync-log?limit=50').then(r=>r.json())
  ]);
  document.getElementById('stats').innerHTML=
    card('Total Registros',stats.total)+
    card('Hoy',stats.today)+
    card('Check-ins',stats.byAction.check_in||0,'ok')+
    card('Check-outs',stats.byAction.check_out||0,'warn');
  const devRows=state.map(d=>'<tr><td class="mono">'+d.device_ip+'</td><td>'+d.last_synced_timestamp+'</td></tr>').join('');
  document.getElementById('devices').innerHTML=devRows?'<table><tr><th>Dispositivo</th><th>Ultimo Sync</th></tr>'+devRows+'</table>':'<div class="empty">Sin datos de sincronizacion</div>';
  const logRows=logs.map(l=>'<tr><td>'+l.id+'</td><td class="mono">'+l.device_ip+'</td><td>'+l.zk_user_id+'</td><td><span class="tag '+(l.action==='check_in'?'in':'out')+'">'+l.action+'</span></td><td>'+l.timestamp+'</td><td>'+(l.odoo_attendance_id||'-')+'</td><td>'+l.synced_at+'</td></tr>').join('');
  document.getElementById('logs').innerHTML=logRows?'<table><tr><th>#</th><th>Dispositivo</th><th>User ID</th><th>Accion</th><th>Timestamp</th><th>Odoo ID</th><th>Synced At</th></tr>'+logRows+'</table>':'<div class="empty">Sin registros de sincronizacion</div>';
}
function card(t,v,cls){return '<div class="card"><h3>'+t+'</h3><div class="val '+(cls||'')+'">'+v+'</div></div>'}
load();
</script>
</body></html>`;

const server = http.createServer((req, res) => {
  const path = req.url.split('?')[0];
  const query = parseQuery(req.url);

  if (path === '/health') {
    json(res, { status: 'ok', syncing, enrolling });

  } else if (path === '/api/sync-state') {
    json(res, stateDb.getAllSyncStates());

  } else if (path === '/api/sync-log') {
    const opts = {
      deviceIp: query.device,
      action: query.action,
      limit: Math.min(parseInt(query.limit, 10) || 100, 1000),
      offset: parseInt(query.offset, 10) || 0,
    };
    json(res, stateDb.getSyncLogs(opts));

  } else if (path === '/api/stats') {
    json(res, stateDb.getSyncStats());

  } else if (path === '/' || path === '/console') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(CONSOLE_HTML);

  } else {
    json(res, { error: 'Not found' }, 404);
  }
});

server.listen(config.healthPort, () => {
  logger.info(`Health check server listening on port ${config.healthPort}`);
});

// Graceful shutdown
function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down...`);
  server.close();
  stateDb.close();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
