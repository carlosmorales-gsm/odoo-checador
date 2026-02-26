#!/usr/bin/env node

/**
 * Crea el campo x_zkteco_user_id en hr.employee y asigna valores.
 */

require('dotenv').config();
const OdooClient = require('./src/odoo/client');

async function main() {
  const odoo = new OdooClient({
    url: process.env.ODOO_URL.replace(/\/+$/, ''),
    db: process.env.ODOO_DB,
    user: process.env.ODOO_USER,
    apiKey: process.env.ODOO_API_KEY,
  });

  console.log('Autenticando...');
  await odoo.authenticate();
  console.log('OK\n');

  // 1. Verificar si el campo ya existe
  console.log('--- Verificando campo x_zkteco_user_id ---');
  const existingFields = await odoo._call('ir.model.fields', 'search', [
    [['model', '=', 'hr.employee'], ['name', '=', 'x_zkteco_user_id']],
  ]);

  if (existingFields.length > 0) {
    console.log('El campo ya existe.\n');
  } else {
    console.log('Creando campo...');
    await odoo._call('ir.model.fields', 'create', [{
      model_id: (await odoo._call('ir.model', 'search', [[['model', '=', 'hr.employee']]]))[0],
      name: 'x_zkteco_user_id',
      field_description: 'ID Usuario ZKTeco',
      ttype: 'char',
      store: true,
    }]);
    console.log('Campo creado.\n');
  }

  // 2. Mapear Carlos (employee_id 2 en Odoo = user_id 38 en ZKTeco)
  console.log('--- Asignando ZKTeco IDs ---');
  await odoo._call('hr.employee', 'write', [[2], { x_zkteco_user_id: '38' }]);
  console.log('Carlos Alberto Morales Heras → ZKTeco ID: 38');

  // 3. Verificar
  console.log('\n--- Verificación ---');
  const emps = await odoo._call('hr.employee', 'search_read', [
    [['x_zkteco_user_id', '!=', false]],
    ['id', 'name', 'x_zkteco_user_id'],
  ]);
  for (const e of emps) {
    console.log(`${e.name} → x_zkteco_user_id: ${e.x_zkteco_user_id}`);
  }

  console.log('\nListo. Ya puedes correr el sync.');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
