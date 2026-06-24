// gastos-cuentas.js · Lee de SAP los GASTOS REALES del año por cuenta contable (saldo de cada cuenta
// de gasto: incluye planilla/salarios, seguros, alquiler, todo — no solo facturas de proveedor).
// SOLO LECTURA, SOLO ADMIN. Sirve para la ganancia neta exacta y el desglose de gastos.
const { getEmpresa } = require('./lib/empresa-config');
const { sapLogin, sapGetAll } = require('./lib/sap-ventas');

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (c, o) => ({ statusCode: c, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify(o) });
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Palabras que identifican cuentas de PLANILLA / personal.
const PLANILLA_KW = ['SALARIO', 'SUELDO', 'SEGURO SOCIAL', 'SEGURO EDUCATIVO', 'VACACION', 'BONIFICAC', 'PRIMA DE ANT', 'PRIMA DE PROD', 'DECIMO', 'DÉCIMO', 'XIII', 'XIII MES', 'COMISION EN VENTA', 'GASTO DE PERSONAL', 'PLANILLA', 'RIESGO PROFESION'];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, { ok: true });
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });
  try {
    const body = JSON.parse(event.body || '{}');
    const empresa = getEmpresa();
    const adminEmail = (process.env.VENTAS_ADMIN_EMAIL || empresa.admin || '').trim().toLowerCase();
    if ((body.email || '').trim().toLowerCase() !== adminEmail) return reply(403, { ok: false, error: 'Solo el administrador' });

    const prefijo = process.env.SAP_GASTO_PREFIX || '61';   // 61 JFK · 7 BDB
    const cookie = await sapLogin();
    const rows = await sapGetAll(cookie, `ChartOfAccounts?$filter=startswith(Code,'${prefijo}') and ActiveAccount eq 'tYES'&$select=Code,Name,Balance`);

    const cuentas = (rows || [])
      .map(c => ({ code: c.Code, nombre: c.Name, saldo: r2(c.Balance) }))
      .filter(c => Math.abs(c.saldo) > 0.01)
      .sort((a, b) => b.saldo - a.saldo);

    const esPlanilla = (n) => { const u = (n || '').toUpperCase(); return PLANILLA_KW.some(k => u.includes(k)); };
    const planilla = cuentas.filter(c => esPlanilla(c.nombre));
    const planillaTotal = planilla.reduce((s, c) => s + c.saldo, 0);
    const total = cuentas.reduce((s, c) => s + c.saldo, 0);

    return reply(200, {
      ok: true, empresa: empresa.nombreCorto, prefijo,
      total_gastos: r2(total),
      planilla_total: r2(planillaTotal),
      planilla_cuentas: planilla,
      cuentas,
      _nota: 'Saldos de cuentas de gasto del año fiscal en curso (de SAP). Incluye planilla y todo gasto operativo.'
    });
  } catch (e) {
    return reply(200, { ok: false, error: e.message || String(e) });
  }
};
