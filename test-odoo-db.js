#!/usr/bin/env node

/**
 * Lista las bases de datos disponibles en la instancia Odoo.
 */

require('dotenv').config();
const axios = require('axios');

async function main() {
  const url = process.env.ODOO_URL.replace(/\/+$/, '');
  console.log(`Consultando bases de datos en: ${url}\n`);

  try {
    const { data } = await axios.post(`${url}/jsonrpc`, {
      jsonrpc: '2.0',
      id: 1,
      method: 'call',
      params: { service: 'db', method: 'list', args: [] },
    });

    if (data.result) {
      console.log('Bases de datos disponibles:');
      data.result.forEach((db) => console.log(`  - ${db}`));
    } else {
      console.log('No se pudo listar (puede estar deshabilitado).');
      console.log('Respuesta:', JSON.stringify(data, null, 2));
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
  }
}

main();
