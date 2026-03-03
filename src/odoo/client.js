const xmlrpc = require('xmlrpc');

class OdooClient {
  constructor(config) {
    const url = new URL(config.url.replace(/\/+$/, ''));
    this.db = config.db;
    this.user = config.user;
    this.apiKey = config.apiKey;
    this.uid = null;

    const clientOpts = { host: url.hostname, port: url.port || 443, path: '/xmlrpc/2/' };
    const createClient = url.protocol === 'https:'
      ? xmlrpc.createSecureClient
      : xmlrpc.createClient;

    this._common = createClient({ ...clientOpts, path: '/xmlrpc/2/common' });
    this._object = createClient({ ...clientOpts, path: '/xmlrpc/2/object' });
  }

  _rpc(client, method, params) {
    return new Promise((resolve, reject) => {
      client.methodCall(method, params, (err, value) => {
        if (err) return reject(new Error(`Odoo RPC error: ${err.message}`));
        resolve(value);
      });
    });
  }

  async authenticate() {
    const uid = await this._rpc(this._common, 'authenticate', [
      this.db, this.user, this.apiKey, {},
    ]);
    if (!uid || uid === false) {
      throw new Error('Odoo authentication failed: invalid credentials');
    }
    this.uid = uid;
    return this.uid;
  }

  async _call(model, method, args, kwargs = {}) {
    if (!this.uid) await this.authenticate();
    const cleanKwargs = {};
    if (kwargs.limit !== undefined) cleanKwargs.limit = kwargs.limit;
    if (kwargs.offset !== undefined) cleanKwargs.offset = kwargs.offset;
    if (kwargs.order !== undefined) cleanKwargs.order = kwargs.order;
    if (kwargs.context) cleanKwargs.context = kwargs.context;

    const params = [this.db, this.uid, this.apiKey, model, method, args];
    if (Object.keys(cleanKwargs).length > 0) params.push(cleanKwargs);

    return this._rpc(this._object, 'execute_kw', params);
  }

  async getAllEmployees(fields = ['id', 'name', 'barcode']) {
    const BATCH = 200;
    let offset = 0;
    const all = [];

    while (true) {
      const ids = await this._call(
        'hr.employee', 'search', [[]], { limit: BATCH, offset }
      );
      if (!ids || ids.length === 0) break;
      const records = await this._call('hr.employee', 'read', [ids, fields]);
      all.push(...records);
      if (ids.length < BATCH) break;
      offset += BATCH;
    }

    return all;
  }

  async getEmployeeById(employeeId) {
    const records = await this._call('hr.employee', 'read', [
      [employeeId],
      ['id', 'name', 'barcode'],
    ]);
    return records[0] || null;
  }

  async getLastOpenAttendance(employeeId) {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000)
      .toISOString().replace('T', ' ').substring(0, 19);

    const ids = await this._call('hr.attendance', 'search', [
      [
        ['employee_id', '=', employeeId],
        ['check_out', '=', false],
        ['check_in', '>=', cutoff],
      ],
    ], { limit: 1, order: 'check_in desc' });
    if (!ids || ids.length === 0) return null;
    const records = await this._call('hr.attendance', 'read', [
      ids,
      ['id', 'employee_id', 'check_in', 'check_out'],
    ]);
    return records[0] || null;
  }

  async setEmployeeBarcode(employeeId, barcode) {
    await this._call('hr.employee', 'write', [
      [employeeId],
      { barcode: String(barcode) },
    ]);
  }

  async createCheckIn(employeeId, timestamp) {
    const id = await this._call('hr.attendance', 'create', [
      { employee_id: employeeId, check_in: timestamp },
    ]);
    return id;
  }

  async updateCheckOut(attendanceId, timestamp) {
    await this._call('hr.attendance', 'write', [
      [attendanceId],
      { check_out: timestamp },
    ]);
  }
}

module.exports = OdooClient;
