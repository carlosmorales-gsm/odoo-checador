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

  // Límites del protocolo ZKTeco
  const safeName = name.substring(0, 24);
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
    return { uid, userid, name, role, cardno };
  });
}

/**
 * Valida que todos los dispositivos tengan los mismos usuarios con IDs idénticos.
 * Devuelve un reporte con las diferencias encontradas y puede opcionalmente
 * sincronizar los usuarios faltantes.
 *
 * @param {Array}   devices          - Lista de dispositivos [{ name, ip, port }]
 * @param {Object}  [options]
 * @param {boolean} [options.fix=false] - Si es true, agrega los usuarios faltantes
 * @returns {Object} { consistent, devices, masterList, missing, synced }
 */
async function validateUsersAcrossDevices(devices, options = {}) {
  const { fix = false } = options;

  // 1. Leer usuarios de todos los dispositivos
  const deviceUsers = {};
  for (const dev of devices) {
    const users = await getUsers(dev);
    deviceUsers[dev.name] = { device: dev, users };
  }

  // 2. Construir lista maestra (unión de todos los usuarios por ID)
  const masterMap = new Map();
  for (const [deviceName, { users }] of Object.entries(deviceUsers)) {
    for (const u of users) {
      if (!masterMap.has(u.userId)) {
        masterMap.set(u.userId, { userId: u.userId, name: u.name, presentIn: [] });
      }
      masterMap.get(u.userId).presentIn.push(deviceName);
    }
  }

  const masterList = Array.from(masterMap.values()).sort(
    (a, b) => parseInt(a.userId) - parseInt(b.userId)
  );

  // 3. Detectar faltantes por dispositivo
  const deviceNames = devices.map((d) => d.name);
  const missing = {};
  let consistent = true;

  for (const devName of deviceNames) {
    const deviceIdSet = new Set(deviceUsers[devName].users.map((u) => u.userId));
    const faltantes = masterList.filter((u) => !deviceIdSet.has(u.userId));
    missing[devName] = faltantes;
    if (faltantes.length > 0) consistent = false;
  }

  // 4. Si fix=true, sincronizar usuarios faltantes
  const synced = {};
  if (fix) {
    for (const devName of deviceNames) {
      synced[devName] = [];
      const dev = deviceUsers[devName].device;
      for (const u of missing[devName]) {
        await setUser(dev, { uid: u.userId, userid: u.userId, name: u.name });
        synced[devName].push(u);
      }
    }
  }

  return { consistent, devices: deviceNames, masterList, missing, synced };
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

module.exports = { getDeviceInfo, getAttendanceLogs, getUsers, setUser, validateUsersAcrossDevices, getUserFingerprints };
