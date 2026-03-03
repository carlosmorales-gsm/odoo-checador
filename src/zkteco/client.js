const ZKTeco = require('zkteco-js');

/**
 * Normalize name for ZKTeco device display: remove accents, ñ→N, uppercase.
 * Devices often use limited encoding and display ñ/accents incorrectly.
 */
function normalizeNameForDevice(name) {
  if (typeof name !== 'string') return '';
  return name
    .replace(/ñ/gi, 'N')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .trim();
}

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
  const device = new ZKTeco(deviceConfig.ip, deviceConfig.port, 10000, 10000);
  await device.createSocket();
  try {
    return await fn(device);
  } finally {
    await device.disconnect();
  }
}

async function getDeviceInfo(deviceConfig) {
  return withDevice(deviceConfig, async (device) => {
    return device.getInfo();
  });
}

/**
 * Clears all data on the device: users, fingerprint/face templates, and attendance logs.
 * Uses disableDevice → clearData → enableDevice (same as scripts/clear-device.js).
 *
 * @param {Object} deviceConfig - { ip, port, name }
 */
async function clearDevice(deviceConfig) {
  return withDevice(deviceConfig, async (device) => {
    await device.disableDevice();
    await device.clearData();
    await device.enableDevice();
  });
}

async function getAttendanceLogs(deviceConfig) {
  return withDevice(deviceConfig, async (device) => {
    // Query directly without trusting info.logCounts — the counter can be stale.
    // Wrap in try/catch: the library throws on timeout when there are truly 0 records.
    let logs;
    try {
      logs = await device.getAttendances();
    } catch {
      return [];
    }
    const records = logs.data || logs || [];
    return records.map((r) => ({
      userId: String(r.deviceUserId || r.user_id || r.userId),
      timestamp: normalizeTimestamp(r.recordTime || r.record_time),
    }));
  });
}

async function getUsers(deviceConfig) {
  return withDevice(deviceConfig, async (device) => {
    // Query directly without trusting info.userCounts — the counter can be stale
    // (e.g. F22ID reports 0 when fingerprint-only users exist).
    // Wrap in try/catch: the library throws on timeout when there are truly 0 users.
    let users;
    try {
      users = await device.getUsers();
    } catch {
      return [];
    }
    const records = users.data || users || [];
    return records.map((u) => ({
      uid: String(u.uid),
      userId: String(u.deviceUserId || u.user_id || u.userId),
      name: u.name,
    }));
  });
}

/**
 * Registra un usuario en el dispositivo ZKTeco.
 *
 * @param {Object} deviceConfig        - { ip, port, name }
 * @param {Object} userData
 * @param {string|number} userData.uid       - ID interno del dispositivo (obligatorio)
 * @param {string|number} userData.userid    - ID de usuario (obligatorio)
 * @param {string}        userData.name      - Nombre del usuario (obligatorio)
 * @param {string}        [userData.password=''] - PIN de acceso (opcional)
 * @param {number}        [userData.role=0]      - Rol: 0=usuario, 14=admin (opcional)
 * @param {number}        [userData.cardno=0]    - Número de tarjeta RFID (opcional)
 */
async function setUser(deviceConfig, userData) {
  const { uid, userid, name, password = '', role = 0, cardno = 0 } = userData;

  if (uid == null || userid == null || !name) {
    throw new Error('Campos obligatorios: uid, userid, name');
  }

  const displayName = normalizeNameForDevice(name);
  // Límites del protocolo ZKTeco
  const safeName = displayName.substring(0, 24);
  const safePassword = String(password).substring(0, 8);
  const safeUserid = String(userid).substring(0, 9);

  return withDevice(deviceConfig, async (device) => {
    await device.setUser(
      String(uid),
      safeUserid,
      safeName,
      safePassword,
      role,
      cardno
    );
    return { uid, userid, name: displayName, role, cardno };
  });
}

/**
 * Lee los templates de huellas digitales de un usuario especifico.
 * Usa CMD_USERTEMP_RRQ (9) a bajo nivel: uid(2 bytes LE) + finger(1 byte).
 *
 * @param {Object} deviceConfig - { ip, port, name }
 * @param {number|string} uid   - uid interno del dispositivo (slot ID)
 * @returns {Array<{ finger: number, size: number, data: string }>}
 */
async function getUserFingerprints(deviceConfig, uid) {
  return withDevice(deviceConfig, async (device) => {
    const templates = [];
    const CMD_USERTEMP_RRQ = 9;

    for (let finger = 0; finger < 10; finger++) {
      try {
        const reqData = Buffer.alloc(3);
        reqData.writeUInt16LE(parseInt(uid, 10), 0);
        reqData.writeUInt8(finger, 2);

        const reply = await device.executeCmd(CMD_USERTEMP_RRQ, reqData);

        if (reply && reply.length > 8) {
          const cmdId = reply.readUInt16LE(0);
          // CMD_ACK_OK (2000) o CMD_ACK_DATA (2002) = exito
          if (cmdId === 2000 || cmdId === 2002) {
            const templateData = reply.slice(8);
            if (templateData.length > 0) {
              templates.push({
                finger,
                size: templateData.length,
                data: templateData.toString('base64'),
              });
            }
          }
        }
      } catch {
        // Sin template para este dedo — continuar
      }
    }

    return templates;
  });
}

/** ZK protocol: write request for user template (counterpart of CMD_USERTEMP_RRQ 9). */
const CMD_USERTEMP_WRQ = 10;

/**
 * Writes fingerprint templates for a user to the device.
 * Uses CMD_USERTEMP_WRQ at low level: uid(2 bytes LE) + finger(1 byte) + template data.
 *
 * @param {Object} deviceConfig - { ip, port, name }
 * @param {number|string} uid - internal device uid (slot ID)
 * @param {Array<{ finger: number, size?: number, data: string }>} templates - from backup (data is base64)
 */
async function setUserFingerprints(deviceConfig, uid, templates) {
  if (!Array.isArray(templates) || templates.length === 0) return;

  return withDevice(deviceConfig, async (device) => {
    const uidNum = parseInt(uid, 10);
    for (const t of templates) {
      const finger = parseInt(t.finger, 10);
      if (finger < 0 || finger > 9) continue;
      const raw = Buffer.from(t.data, 'base64');
      if (raw.length === 0) continue;

      const reqData = Buffer.alloc(3 + raw.length);
      reqData.writeUInt16LE(uidNum, 0);
      reqData.writeUInt8(finger, 2);
      raw.copy(reqData, 3);

      const reply = await device.executeCmd(CMD_USERTEMP_WRQ, reqData);
      if (reply && reply.length >= 2) {
        const cmdId = reply.readUInt16LE(0);
        if (cmdId !== 2000 && cmdId !== 2002) {
          throw new Error(`setUserFingerprints: device rejected template uid=${uid} finger=${finger} (cmd=${cmdId})`);
        }
      }
    }
  });
}

module.exports = { getDeviceInfo, getAttendanceLogs, getUsers, setUser, getUserFingerprints, clearDevice, setUserFingerprints };
