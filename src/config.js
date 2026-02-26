require('dotenv').config();

function parseDevices(raw) {
  try {
    const devices = JSON.parse(raw);
    if (!Array.isArray(devices) || devices.length === 0) {
      throw new Error('ZKTECO_DEVICES must be a non-empty JSON array');
    }
    return devices.map((d, i) => ({
      name: d.name || `Device-${i + 1}`,
      ip: d.ip,
      port: d.port || 4370,
    }));
  } catch (err) {
    throw new Error(`Invalid ZKTECO_DEVICES: ${err.message}`);
  }
}

function required(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

const config = {
  odoo: {
    url: required('ODOO_URL').replace(/\/+$/, ''),
    db: required('ODOO_DB'),
    user: required('ODOO_USER'),
    apiKey: required('ODOO_API_KEY'),
  },
  zkteco: {
    devices: parseDevices(required('ZKTECO_DEVICES')),
  },
  sync: {
    interval: process.env.SYNC_INTERVAL || '*/5 * * * *',
    timezone: process.env.TIMEZONE || 'America/Mexico_City',
  },
  log: {
    level: process.env.LOG_LEVEL || 'info',
  },
  healthPort: parseInt(process.env.HEALTH_PORT, 10) || 3000,
};

module.exports = config;
