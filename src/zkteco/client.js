const ZKTeco = require('zkteco-js');

/**
 * Normalize timestamp from ZKTeco to "YYYY-MM-DD HH:mm:ss" format.
 * The device may return a JS Date string like "Wed Feb 25 2026 12:40:32 GMT-0700 ..."
 */
function normalizeTimestamp(raw) {
  const d = new Date(raw);
  if (isNaN(d.getTime())) return raw;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function withDevice(deviceConfig, fn) {
  const device = new ZKTeco(deviceConfig.ip, deviceConfig.port, 5000, 4000);
  await device.createSocket();
  try {
    return await fn(device);
  } finally {
    await device.disconnect();
  }
}

async function getAttendanceLogs(deviceConfig) {
  return withDevice(deviceConfig, async (device) => {
    const logs = await device.getAttendances();
    // zkteco-js returns { data: [...] }
    const records = logs.data || logs || [];
    return records.map((r) => ({
      userId: String(r.deviceUserId || r.user_id || r.userId),
      timestamp: normalizeTimestamp(r.recordTime || r.record_time),
    }));
  });
}

async function getUsers(deviceConfig) {
  return withDevice(deviceConfig, async (device) => {
    const users = await device.getUsers();
    const records = users.data || users || [];
    return records.map((u) => ({
      userId: String(u.deviceUserId || u.user_id || u.userId),
      name: u.name,
    }));
  });
}

module.exports = { getAttendanceLogs, getUsers };
