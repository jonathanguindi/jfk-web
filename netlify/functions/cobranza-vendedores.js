// netlify/functions/cobranza-vendedores.js
// Administra el mapeo de vendedores de SAP -> correo / activo / reasignación,
// y el switch global "enviar copia al vendedor".
//   POST {action:'list'}   -> vendedores con venta en el último año + su config + ccVendedor
//   POST {action:'save', sap_code, nombre, email, activo, reasignar_a}
//   POST {action:'config', ccVendedor:boolean}

const https = require('https');
const agent = new https.Agent({ rejectUnauthorized: false });
const { getEmpresa } = require('./lib/empresa-config');
const { getSupabase } = require('./lib/supabase');

const SAP_URL = process.env.SAP_SERVICE_LAYER_URL;
const SAP_DB = process.env.SAP_COMPANY_DB;
const SAP_USER = process.env.SAP_USER || process.env.SAP_USERNAME;
const SAP_PASS = process.env.SAP_PASSWORD;

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' };
const reply = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify(obj) });

async function sapLogin() {
  const r = await fetch(`${SAP_URL}/Login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ CompanyDB: SAP_DB, UserName: SAP_USER, Password: SAP_PASS }), agent });
  if (!r.ok) throw new Error(`SAP login ${r.status}`);
  const sc = r.headers.get('set-cookie') || '';
  return sc.split(',').map(c => c.split(';')[0].trim()).filter(Boolean).join('; ');
}
const sapGet = async (cookies, path) => {
  const r = await fetch(`${SAP_URL}/${path}`, { headers: { 'Cookie': cookies, 'Content-Type': 'application/json', 'Prefer': 'odata.maxpagesize=0' }, agent });
  if (!r.ok) throw new Error(`SAP ${r.status}`);
  return r.json();
};

// Códigos de vendedor con al menos una factura en los últimos 365 días.
async function codigosConVentaReciente(cookies) {
  const desde = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  // Intento rápido: agrupar
  try {
    const j = await sapGet(cookies, `Invoices?$apply=filter(DocDate ge '${desde}')/groupby((SalesPersonCode))`);
    const set = new Set((j.value || []).map(x => x.SalesPersonCode).filter(c => c > 0));
    if (set.size) return set;
  } catch (_) { /* algunas instalaciones no soportan $apply */ }
  // Respaldo: traer SalesPersonCode (más pesado)
  try {
    const j = await sapGet(cookies, `Invoices?$select=SalesPersonCode&$filter=DocDate ge '${desde}'`);
    return new Set((j.value || []).map(x => x.SalesPersonCode).filter(c => c > 0));
  } catch (_) { return null; }
}

const esNoPersona = (name) => /sin agente|trafico|muestras/i.test(name || '');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, { ok: true });
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) {}
  const action = body.action || 'list';
  const empresa = getEmpresa();
  const sb = getSupabase(empresa);

  try {
    if (action === 'save') {
      if (!sb) return reply(500, { ok: false, error: 'Supabase no configurado' });
      if (body.sap_code == null) return reply(400, { ok: false, error: 'Falta sap_code' });
      const row = {
        sap_code: body.sap_code, nombre: body.nombre || null,
        email: (body.email || '').trim() || null,
        activo: body.activo !== false,
        reasignar_a: (body.reasignar_a === '' || body.reasignar_a == null) ? null : Number(body.reasignar_a),
        updated_at: new Date().toISOString()
      };
      const { error } = await sb.from('cobranza_vendedores').upsert(row, { onConflict: 'sap_code' });
      if (error) return reply(200, { ok: false, error: error.message });
      return reply(200, { ok: true });
    }

    if (action === 'config') {
      if (!sb) return reply(500, { ok: false, error: 'Supabase no configurado' });
      const val = body.ccVendedor ? 'true' : 'false';
      const { error } = await sb.from('cobranza_config').upsert({ key: 'cc_vendedor', value: val }, { onConflict: 'key' });
      if (error) return reply(200, { ok: false, error: error.message });
      return reply(200, { ok: true, ccVendedor: body.ccVendedor !== false });
    }

    // list
    const cookies = await sapLogin();
    const [sapList, recientes] = await Promise.all([
      sapGet(cookies, `SalesPersons?$select=SalesEmployeeCode,SalesEmployeeName`).then(j => (j.value || []).filter(s => s.SalesEmployeeCode > 0)),
      codigosConVentaReciente(cookies)
    ]);

    const map = {}; let ccVendedor = true;
    if (sb) {
      const { data } = await sb.from('cobranza_vendedores').select('*'); (data || []).forEach(r => { map[r.sap_code] = r; });
      const { data: cfg } = await sb.from('cobranza_config').select('value').eq('key', 'cc_vendedor').maybeSingle();
      if (cfg && cfg.value != null) ccVendedor = cfg.value !== 'false';
    }

    let vendedores = sapList
      .filter(s => !esNoPersona(s.SalesEmployeeName))
      .filter(s => !recientes || recientes.has(s.SalesEmployeeCode))   // solo con venta reciente (si pudimos calcularlo)
      .map(s => {
        const m = map[s.SalesEmployeeCode];
        return { code: s.SalesEmployeeCode, name: s.SalesEmployeeName, email: m ? m.email : null, activo: m ? m.activo : true, reasignar_a: m ? m.reasignar_a : null, configurado: !!m };
      })
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    return reply(200, { ok: true, count: vendedores.length, ccVendedor, filtrado: !!recientes, vendedores });
  } catch (e) {
    return reply(500, { ok: false, error: e.message });
  }
};
