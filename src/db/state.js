const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'sync-state.db');

let db;

function init() {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_state (
      device_ip TEXT PRIMARY KEY,
      last_synced_timestamp TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_ip TEXT NOT NULL,
      zk_user_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      action TEXT NOT NULL,
      odoo_attendance_id INTEGER,
      synced_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sync_log_lookup
      ON sync_log (device_ip, zk_user_id, timestamp);
  `);

  return db;
}

function getLastSyncedTimestamp(deviceIp) {
  const row = db.prepare('SELECT last_synced_timestamp FROM sync_state WHERE device_ip = ?').get(deviceIp);
  return row ? row.last_synced_timestamp : null;
}

function setLastSyncedTimestamp(deviceIp, timestamp) {
  db.prepare(`
    INSERT INTO sync_state (device_ip, last_synced_timestamp)
    VALUES (?, ?)
    ON CONFLICT(device_ip) DO UPDATE SET last_synced_timestamp = excluded.last_synced_timestamp
  `).run(deviceIp, timestamp);
}

function logSync(deviceIp, zkUserId, timestamp, action, odooAttendanceId) {
  db.prepare(`
    INSERT INTO sync_log (device_ip, zk_user_id, timestamp, action, odoo_attendance_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(deviceIp, zkUserId, timestamp, action, odooAttendanceId || null);
}

function isAlreadySynced(deviceIp, zkUserId, timestamp) {
  const row = db.prepare(`
    SELECT id FROM sync_log
    WHERE device_ip = ? AND zk_user_id = ? AND timestamp = ?
    LIMIT 1
  `).get(deviceIp, zkUserId, timestamp);
  return !!row;
}

function getAllSyncStates() {
  return db.prepare('SELECT device_ip, last_synced_timestamp FROM sync_state ORDER BY device_ip').all();
}

function getSyncLogs({ deviceIp, limit = 100, offset = 0, action } = {}) {
  let sql = 'SELECT * FROM sync_log WHERE 1=1';
  const params = [];

  if (deviceIp) {
    sql += ' AND device_ip = ?';
    params.push(deviceIp);
  }
  if (action) {
    sql += ' AND action = ?';
    params.push(action);
  }

  sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return db.prepare(sql).all(...params);
}

function getSyncStats() {
  const total = db.prepare('SELECT COUNT(*) as count FROM sync_log').get();
  const byAction = db.prepare(
    'SELECT action, COUNT(*) as count FROM sync_log GROUP BY action'
  ).all();
  const byDevice = db.prepare(
    'SELECT device_ip, COUNT(*) as count, MAX(synced_at) as last_synced_at FROM sync_log GROUP BY device_ip'
  ).all();
  const today = new Date().toISOString().substring(0, 10);
  const todayCount = db.prepare(
    "SELECT COUNT(*) as count FROM sync_log WHERE synced_at >= ?"
  ).get(today);

  return {
    total: total.count,
    today: todayCount.count,
    byAction: Object.fromEntries(byAction.map((r) => [r.action, r.count])),
    byDevice,
  };
}

function close() {
  if (db) db.close();
}

module.exports = {
  init, getLastSyncedTimestamp, setLastSyncedTimestamp, logSync, isAlreadySynced,
  getAllSyncStates, getSyncLogs, getSyncStats, close,
};
