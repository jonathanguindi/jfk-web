// cuentas-gasto.js · Lista las cuentas de gasto (610xxx) activas/posteable de SAP. SOLO LECTURA, ADMIN.
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
    // Prefijo de cuentas de gasto: 61 (gastos). Override por env si la empresa usa otro.
    const pref = process.env.SAP_GASTO_PREFIX || '61';
    const rows = await sapGetAll(cookie, `ChartOfAccounts?$filter=startswith(Code,'${pref}') and ActiveAccount eq 'tYES'&$select=Code,Name&$orderby=Code`);
    const cuentas = (rows || []).map(c => ({ code: c.Code, name: c.Name }));
    return reply(200, { ok: true, cuentas });
  } catch (e) {
    return reply(200, { ok: false, error: e.message || String(e) });
  }
};
