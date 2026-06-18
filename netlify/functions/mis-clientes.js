// netlify/functions/mis-clientes.js
// Devuelve los códigos de cliente (CardCode) que un vendedor ha facturado.
// Identifica al vendedor por su correo (mapeo cobranza_vendedores email -> sap_code).
// Recibe: POST { email }  ->  { ok, sap_codes:[...], codes:[CardCode...] }

const https = require('https');
const agent = new https.Agent({ rejectUnauthorized: false });
const { getEmpresa } = require('./lib/empresa-config');
const { getSupabase } = require('./lib/supabase');

const SAP_URL = process.env.SAP_SERVICE_LAYER_URL;
const SAP_DB = process.env.SAP_COMPANY_DB;
const SAP_USER = process.env.SAP_USER || process.env.SAP_USERNAME;
const SAP_PASS = process.env.SAP_PASSWORD;
const ANOS = 2;   // facturas de los últimos 2 años

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, { ok: true });
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Método no permitido' });
  try {
    const { email } = JSON.parse(event.body || '{}');
    if (!email) return reply(400, { ok: false, error: 'Falta email' });
    const empresa = getEmpresa();
    const sb = getSupabase(empresa);
    if (!sb) return reply(500, { ok: false, error: 'Supabase no configurado' });

    // 1) Códigos de vendedor (SAP) asociados a ese correo (puede ser más de uno)
    const { data: rows } = await sb.from('cobranza_vendedores').select('sap_code').ilike('email', email.trim()).eq('activo', true);
    const sapCodes = (rows || []).map(r => r.sap_code).filter(c => c != null);
    if (!sapCodes.length) return reply(200, { ok: true, sap_codes: [], codes: [] });

    // 2) Clientes facturados por esos códigos (últimos N años)
    const cookies = await sapLogin();
    const desde = new Date(Date.now() - ANOS * 365 * 86400000).toISOString().slice(0, 10);
    const cardSet = new Set();
    for (const code of sapCodes) {
      let got = false;
      try {
        const j = await sapGet(cookies, `Invoices?$apply=filter(SalesPersonCode eq ${code} and DocDate ge '${desde}')/groupby((CardCode))`);
        (j.value || []).forEach(x => { if (x.CardCode) cardSet.add(x.CardCode); });
        got = true;
      } catch (_) { /* $apply no soportado */ }
      if (!got) {
        try {
          const j = await sapGet(cookies, `Invoices?$select=CardCode&$filter=SalesPersonCode eq ${code} and DocDate ge '${desde}'`);
          (j.value || []).forEach(x => { if (x.CardCode) cardSet.add(x.CardCode); });
        } catch (_) {}
      }
    }
    return reply(200, { ok: true, sap_codes: sapCodes, codes: [...cardSet] });
  } catch (e) {
    return reply(500, { ok: false, error: e.message });
  }
};
