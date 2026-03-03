const zkClient = require('../zkteco/client');
const OdooClient = require('../odoo/client');
const config = require('../config');
const { createChild } = require('../logger');

const logger = createChild('enrollment');

async function enrollNewEmployees({ dryRun = false } = {}) {
  logger.info(`--- Enrollment ${dryRun ? 'DRY-RUN' : 'REAL'} starting ---`);

  const odoo = new OdooClient(config.odoo);
  await odoo.authenticate();
  logger.info('Odoo autenticado');

  const allEmployees = await odoo.getAllEmployees(['id', 'name', 'barcode']);
  const pending = allEmployees.filter((e) => !e.barcode);
  logger.info(`Empleados en Odoo: ${allEmployees.length} total, ${pending.length} sin barcode`);

  if (pending.length === 0) {
    logger.info('No hay empleados nuevos para registrar');
    return { enrolled: 0, errors: 0, details: [] };
  }

  const deviceUsers = {};
  for (const device of config.zkteco.devices) {
    try {
      const users = await zkClient.getUsers(device);
      deviceUsers[device.name] = { device, users };
      logger.info(`${device.name}: ${users.length} usuarios actuales`);
    } catch (err) {
      logger.error(`Error leyendo ${device.name}: ${err.message}`);
      deviceUsers[device.name] = { device, users: [] };
    }
  }

  let enrolled = 0;
  let errors = 0;
  const details = [];

  for (const emp of pending) {
    const empLabel = `[${emp.id}] ${emp.name}`;

    if (dryRun) {
      logger.info(`[DRY-RUN] Registraria: ${empLabel} → userid=${emp.id}`);
      details.push({ employeeId: emp.id, name: emp.name, action: 'would_enroll' });
      enrolled++;
      continue;
    }

    let assignedUid = null;
    let enrolledInAll = true;

    for (const device of config.zkteco.devices) {
      const { users } = deviceUsers[device.name];
      const existing = users.find((u) => u.userId === String(emp.id));
      if (existing) {
        logger.info(`${empLabel} ya existe en ${device.name} (uid=${existing.uid})`);
        if (!assignedUid) assignedUid = existing.uid;
        continue;
      }

      const maxUid = users.length > 0
        ? Math.max(...users.map((u) => parseInt(u.uid, 10)))
        : 0;
      const nextUid = maxUid + 1;

      try {
        await zkClient.setUser(device, {
          uid: nextUid,
          userid: emp.id,
          name: emp.name,
        });
        logger.info(`${empLabel} registrado en ${device.name} con uid=${nextUid}`);
        if (!assignedUid) assignedUid = String(nextUid);
        deviceUsers[device.name].users.push({
          uid: String(nextUid),
          userId: String(emp.id),
          name: emp.name,
        });
      } catch (err) {
        logger.error(`Error registrando ${empLabel} en ${device.name}: ${err.message}`);
        enrolledInAll = false;
        errors++;
      }
    }

    if (assignedUid && enrolledInAll) {
      try {
        await odoo.setEmployeeBarcode(emp.id, assignedUid);
        logger.info(`${empLabel} barcode actualizado en Odoo: ${assignedUid}`);
        details.push({ employeeId: emp.id, name: emp.name, uid: assignedUid, action: 'enrolled' });
        enrolled++;
      } catch (err) {
        logger.error(`Error escribiendo barcode para ${empLabel}: ${err.message}`);
        errors++;
      }
    }
  }

  logger.info(`--- Enrollment ${dryRun ? 'DRY-RUN' : 'REAL'} complete: ${enrolled} enrolled, ${errors} errors ---`);
  return { enrolled, errors, details };
}

module.exports = { enrollNewEmployees };
