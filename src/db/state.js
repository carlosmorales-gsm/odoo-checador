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

function close() {
  if (db) db.close();
}

module.exports = { init, getLastSyncedTimestamp, setLastSyncedTimestamp, logSync, close };
