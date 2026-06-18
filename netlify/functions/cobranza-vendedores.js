// netlify/functions/cobranza-vendedores.js
// Administra el mapeo de vendedores de SAP -> correo / activo / reasignación.
//   GET (o POST {action:'list'})  -> lista vendedores de SAP + su config guardada
//   POST {action:'save', sap_code, nombre, email, activo, reasignar_a} -> guarda (service key)

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

async function listSAP() {
  const cookies = await sapLogin();
  const res = await fetch(`${SAP_URL}/SalesPersons?$select=SalesEmployeeCode,SalesEmployeeName`, { headers: { 'Cookie': cookies, 'Content-Type': 'application/json', 'Prefer': 'odata.maxpagesize=0' }, agent });
  if (!res.ok) throw new Error(`SAP ${res.status}`);
  const j = await res.json();
  return (j.value || []).filter(s => s.SalesEmployeeCode > 0).map(s => ({ code: s.SalesEmployeeCode, name: s.SalesEmployeeName }));
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, { ok: true });
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) {}
  const action = body.action || (event.httpMethod === 'GET' ? 'list' : 'list');
  const empresa = getEmpresa();
  const sb = getSupabase(empresa);

  try {
    if (action === 'save') {
      if (!sb) return reply(500, { ok: false, error: 'Supabase no configurado' });
      if (body.sap_code == null) return reply(400, { ok: false, error: 'Falta sap_code' });
      const row = {
        sap_code: body.sap_code,
        nombre: body.nombre || null,
        email: (body.email || '').trim() || null,
        activo: body.activo !== false,
        reasignar_a: (body.reasignar_a === '' || body.reasignar_a == null) ? null : Number(body.reasignar_a),
        updated_at: new Date().toISOString()
      };
      const { error } = await sb.from('cobranza_vendedores').upsert(row, { onConflict: 'sap_code' });
      if (error) return reply(200, { ok: false, error: error.message });
      return reply(200, { ok: true });
    }

    // list
    const sap = await listSAP();
    const map = {};
    if (sb) { const { data } = await sb.from('cobranza_vendedores').select('*'); (data || []).forEach(r => { map[r.sap_code] = r; }); }
    const vendedores = sap.map(s => {
      const m = map[s.code];
      return { code: s.code, name: s.name, email: m ? m.email : null, activo: m ? m.activo : true, reasignar_a: m ? m.reasignar_a : null, configurado: !!m };
    });
    return reply(200, { ok: true, count: vendedores.length, vendedores });
  } catch (e) {
    return reply(500, { ok: false, error: e.message });
  }
};
