// sap-explorar.js · Sonda de SOLO LECTURA para ver qué expone SAP (empleados y cuentas de gasto).
// Temporal/diagnóstico, SOLO ADMIN. No escribe nada.
const { getEmpresa } = require('./lib/empresa-config');
const { sapLogin, sapGetAll } = require('./lib/sap-ventas');

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (c, o) => ({ statusCode: c, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify(o) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, { ok: true });
  try {
    const body = JSON.parse(event.body || '{}');
    const empresa = getEmpresa();
    const adminEmail = (process.env.VENTAS_ADMIN_EMAIL || empresa.admin || '').trim().toLowerCase();
    if ((body.email || '').trim().toLowerCase() !== adminEmail) return reply(403, { ok: false, error: 'Solo el administrador' });

    const cookie = await sapLogin();
    const out = { ok: true, empresa: empresa.nombreCorto };

    // ¿SAP tiene empleados (módulo HR / EmployeesInfo)?
    try {
      const emp = await sapGetAll(cookie, 'EmployeesInfo?$top=3');
      out.empleados = { count_muestra: emp.length, campos: emp[0] ? Object.keys(emp[0]) : [], ejemplo: emp[0] || null };
    } catch (e) { out.empleados = { error: String(e.message || e) }; }

    // Cuentas contables (para P&L / gastos). Buscamos tipos de cuenta.
    try {
      const acc = await sapGetAll(cookie, "ChartOfAccounts?$top=5&$select=Code,Name,AccountType,ActiveAccount,Balance");
      out.cuentas = { muestra: acc, campos: acc[0] ? Object.keys(acc[0]) : [] };
    } catch (e) { out.cuentas = { error: String(e.message || e) }; }

    // ¿Hay endpoint de Journal Entries (asientos) para gastos por periodo?
    try {
      const je = await sapGetAll(cookie, 'JournalEntries?$top=1');
      out.journal = { hay: je.length > 0, campos: je[0] ? Object.keys(je[0]) : [] };
    } catch (e) { out.journal = { error: String(e.message || e) }; }

    return reply(200, out);
  } catch (e) {
    return reply(200, { ok: false, error: e.message || String(e) });
  }
};
