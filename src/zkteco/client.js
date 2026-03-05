const ZKTeco = require('zkteco-js');
const config = require('../config');

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
  const timeoutMs = (config.zkteco && config.zkteco.timeoutMs) || 30000;
  const device = new ZKTeco(deviceConfig.ip, deviceConfig.port, timeoutMs, timeoutMs);
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

/**
 * Libera el buffer de datos del dispositivo (CMD_FREE_DATA).
 * Útil antes de escribir templates para evitar rechazos (ej. cmd 4995).
 *
 * @param {Object} deviceConfig - { ip, port, name }
 */
async function freeData(deviceConfig) {
  return withDevice(deviceConfig, async (device) => {
    await device.freeData();
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
 * Itera dedos 0..9; algunos dispositivos usan 1..10 — si se detectan 0 templates
 * se intenta tambien 1..10 para no perder la segunda huella.
 *
 * @param {Object} deviceConfig - { ip, port, name }
 * @param {number|string} uid   - uid interno del dispositivo (slot ID)
 * @param {{ debug?: boolean }} [opts] - debug: true para imprimir respuesta de cada dedo (diagnostico)
 * @returns {Array<{ finger: number, size: number, data: string }>}
 */
async function getUserFingerprints(deviceConfig, uid, opts = {}) {
  const debug = opts && opts.debug;
  return withDevice(deviceConfig, async (device) => {
    const CMD_USERTEMP_RRQ = 9;
    async function readFingerRange(start, end) {
      const out = [];
      for (let finger = start; finger <= end; finger++) {
        try {
          const templateBuffer = await device.getUserTemplate(uid, finger);
          if (templateBuffer && templateBuffer.length > 0) {
            if (debug) {
              console.log(`    [uid=${uid} finger=${finger}] size=${templateBuffer.length}`);
            }
            if (templateBuffer.length > 50) {
              out.push({
                finger,
                size: templateBuffer.length,
                data: templateBuffer.toString('base64'),
              });
            }
          } else {
            if (debug) {
              const reqData = Buffer.alloc(3);
              reqData.writeUInt16LE(parseInt(uid, 10), 0);
              reqData.writeUInt8(finger, 2);
              try {
                const raw = await device.executeCmd(CMD_USERTEMP_RRQ, reqData);
                if (raw && raw.length >= 2) {
                  const cmdId = raw.readUInt16LE(0);
                  const payload = raw.length > 8 ? raw.slice(8) : Buffer.alloc(0);
                  console.log(`    [uid=${uid} finger=${finger}] raw cmdId=${cmdId} payloadLen=${payload.length} payloadHex=${payload.slice(0, 32).toString('hex')}`);
                } else {
                  console.log(`    [uid=${uid} finger=${finger}] no template`);
                }
              } catch (e) {
                console.log(`    [uid=${uid} finger=${finger}] no template (raw req failed: ${e.message})`);
              }
            }
          }
        } catch (err) {
          if (debug) console.log(`    [uid=${uid} finger=${finger}] ERROR: ${err.message}`);
        }
        if (finger < end) await new Promise((r) => setTimeout(r, 80));
      }
      return out;
    }

    let templates = await readFingerRange(0, 9);
    if (templates.length === 0) {
      if (debug) console.log(`    Reintentando con dedos 1-10...`);
      templates = await readFingerRange(1, 10);
    }
    return templates;
  });
}

/** ZK protocol: write request for user template (counterpart of CMD_USERTEMP_RRQ 9). */
const CMD_USERTEMP_WRQ = 10;
const CMD_PREPARE_DATA = 1500;
const CMD_DATA = 1501;
const CMD_FREE_DATA = 1502;
const CMD_TMP_WRITE = 87;
const CMD_CHECKSUM_BUFFER = 119;
const CMD_REFRESHDATA = 1013;
const CMD_DELETE_USERTEMP = 19;
const CMD_DEL_FPTMP = 134;
const CMD_ACK_OK = 2000;
/** Reply when device does not support the command (e.g. F22ID with CMD_DELETE_USERTEMP). */
const CMD_ACK_ERROR_CMD = 65533;

/**
 * Writes fingerprint templates using the "Upload Fingerprint Template" flow from zk-protocol:
 * CMD_PREPARE_DATA → CMD_DATA (template) → CMD_CHECKSUM_BUFFER → CMD_TMP_WRITE (87).
 * Use when CMD_USERTEMP_WRQ (10) is rejected (e.g. cmd=4995 on F22ID).
 */
async function setUserFingerprintsTmpWriteFlow(device, uidNum, templates) {
  await device.disableDevice();
  try {
    for (const t of templates) {
      const finger = parseInt(t.finger, 10);
      if (finger < 0 || finger > 10) continue;
      const raw = Buffer.from(t.data, 'base64');
      if (raw.length === 0) continue;

      const prepBuf = Buffer.alloc(4);
      prepBuf.writeUInt16LE(raw.length, 0);

      let reply = await device.executeCmd(CMD_PREPARE_DATA, prepBuf);
      if (!reply || reply.length < 2 || reply.readUInt16LE(0) !== CMD_ACK_OK) {
        throw new Error(`Prepare data failed (uid=${uidNum} finger=${finger})`);
      }

      reply = await device.executeCmd(CMD_DATA, raw);
      if (!reply || reply.length < 2 || reply.readUInt16LE(0) !== CMD_ACK_OK) {
        throw new Error(`Send template data failed (uid=${uidNum} finger=${finger})`);
      }

      await device.executeCmd(CMD_CHECKSUM_BUFFER, Buffer.alloc(0));

      const tmpWriteBuf = Buffer.alloc(6);
      tmpWriteBuf.writeUInt16LE(uidNum, 0);
      tmpWriteBuf.writeUInt8(finger, 2);
      tmpWriteBuf.writeUInt8(1, 3);
      tmpWriteBuf.writeUInt16LE(raw.length, 4);

      reply = await device.executeCmd(CMD_TMP_WRITE, tmpWriteBuf);
      if (!reply || reply.length < 2 || reply.readUInt16LE(0) !== CMD_ACK_OK) {
        throw new Error(`TMP_WRITE rejected (uid=${uidNum} finger=${finger} cmd=${reply ? reply.readUInt16LE(0) : 'none'})`);
      }

      await device.freeData();
      await new Promise((r) => setTimeout(r, 80));
    }
    await device.executeCmd(CMD_REFRESHDATA, Buffer.alloc(0));
  } finally {
    await device.enableDevice();
  }
}

/**
 * Writes fingerprint templates for a user to the device.
 * Uses the zk-protocol "Upload Fingerprint Template" flow (CMD_PREPARE_DATA → CMD_DATA → CMD_TMP_WRITE)
 * so that devices like F22ID that reject CMD_USERTEMP_WRQ (10) with cmd=4995 accept the template.
 *
 * @param {Object} deviceConfig - { ip, port, name }
 * @param {number|string} uid - internal device uid (slot ID)
 * @param {Array<{ finger: number, size?: number, data: string }>} templates - from backup (data is base64)
 */
async function setUserFingerprints(deviceConfig, uid, templates) {
  if (!Array.isArray(templates) || templates.length === 0) return;

  return withDevice(deviceConfig, async (device) => {
    const uidNum = parseInt(uid, 10);
    await setUserFingerprintsTmpWriteFlow(device, uidNum, templates);
  });
}

/**
 * Elimina todas las huellas digitales de un usuario en el dispositivo.
 * Primero intenta CMD_DELETE_USERTEMP (19). Si el dispositivo responde 4991/65533 (no soportado),
 * usa fallback con CMD_DEL_FPTMP (134) borrando por dedo (0-9); requiere userId para el payload.
 * No borra el usuario, solo sus templates biométricos.
 *
 * @param {Object} deviceConfig - { ip, port, name }
 * @param {number|string} uid - uid interno del usuario en el dispositivo (slot)
 * @param {string} [userId] - ID lógico del usuario (ej. id Odoo como string); obligatorio para fallback F22ID
 */
async function deleteUserFingerprints(deviceConfig, uid, userId) {
  return withDevice(deviceConfig, async (device) => {
    const uidNum = parseInt(uid, 10);
    const reqData = Buffer.alloc(3);
    reqData.writeUInt16LE(uidNum, 0);
    reqData.writeUInt8(0, 2);

    const reply = await device.executeCmd(CMD_DELETE_USERTEMP, reqData);
    if (!reply || reply.length < 2) {
      throw new Error(`deleteUserFingerprints: no reply (uid=${uid})`);
    }
    const cmdId = reply.readUInt16LE(0);
    if (cmdId === CMD_ACK_OK || cmdId === 2002) {
      await device.executeCmd(CMD_REFRESHDATA, Buffer.alloc(0));
      return;
    }
    // F22ID y similares rechazan 19 con 4991/65533 → borrar por dedo con CMD_DEL_FPTMP (134)
    if (cmdId === 4991 || cmdId === CMD_ACK_ERROR_CMD) {
      if (userId == null || userId === '') {
        throw new Error(`deleteUserFingerprints: device rejected CMD_DELETE_USERTEMP (cmd=${cmdId}); need userId for fallback`);
      }
      await deleteUserFingerprintsByFinger(device, String(userId));
      return;
    }
    throw new Error(`deleteUserFingerprints: device rejected (uid=${uid} cmd=${cmdId})`);
  });
}

/**
 * Borra todos los templates del usuario enviando CMD_DEL_FPTMP (134) por cada dedo 0-9.
 * Payload: user id string (24 bytes null-padded) + 1 byte finger index (zk-protocol "del info").
 *
 * @param {Object} device - instancia ZKTeco ya conectada
 * @param {string} userId - ID del usuario en el dispositivo (ej. "4", "801")
 */
async function deleteUserFingerprintsByFinger(device, userId) {
  const USER_ID_PAYLOAD_SIZE = 24;
  let deleted = 0;
  for (let finger = 0; finger <= 9; finger++) {
    const payload = Buffer.alloc(USER_ID_PAYLOAD_SIZE + 1);
    const idBytes = Buffer.from(userId, 'utf8');
    const copyLen = Math.min(idBytes.length, USER_ID_PAYLOAD_SIZE);
    idBytes.copy(payload, 0, 0, copyLen);
    payload.writeUInt8(finger, USER_ID_PAYLOAD_SIZE);

    const reply = await device.executeCmd(CMD_DEL_FPTMP, payload);
    if (reply && reply.length >= 2 && reply.readUInt16LE(0) === CMD_ACK_OK) {
      deleted++;
    }
    // 2001 = CMD_ACK_ERROR (no hay template en ese dedo): se ignora
  }
  await device.executeCmd(CMD_REFRESHDATA, Buffer.alloc(0));
}

/**
 * Elimina un usuario del dispositivo (registro de usuario). Borra huellas y registro.
 * Para solo borrar huellas use deleteUserFingerprints.
 *
 * @param {Object} deviceConfig - { ip, port, name }
 * @param {number|string} uid - uid interno del usuario en el dispositivo (slot)
 */
async function deleteUser(deviceConfig, uid) {
  return withDevice(deviceConfig, async (device) => {
    await device.deleteUser(parseInt(uid, 10));
  });
}

module.exports = { getDeviceInfo, getAttendanceLogs, getUsers, setUser, getUserFingerprints, clearDevice, freeData, setUserFingerprints, deleteUserFingerprints, deleteUser };
