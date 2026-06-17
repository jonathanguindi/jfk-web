// netlify/functions/actualizar-correo.js
// Actualiza el correo (EmailAddress) de un cliente en SAP y en Supabase.
// Recibe: POST { cardCode, email }

const https = require('https');
const agent = new https.Agent({ rejectUnauthorized: false });
const { getEmpresa } = require('./lib/empresa-config');
const { getSupabase } = require('./lib/supabase');

const SAP_URL = process.env.SAP_SERVICE_LAYER_URL;
const SAP_DB = process.env.SAP_COMPANY_DB;
const SAP_USER = process.env.SAP_USER || process.env.SAP_USERNAME;
const SAP_PASS = process.env.SAP_PASSWORD;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const reply = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify(obj) });

async function sapLogin() {
  const r = await fetch(`${SAP_URL}/Login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ CompanyDB: SAP_DB, UserName: SAP_USER, Password: SAP_PASS }), agent
  });
  if (!r.ok) throw new Error(`SAP login ${r.status}`);
  const sc = r.headers.get('set-cookie') || '';
  return sc.split(',').map(c => c.split(';')[0].trim()).filter(Boolean).join('; ');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, { ok: true });
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Método no permitido' });

  try {
    const { cardCode, email } = JSON.parse(event.body || '{}');
    if (!cardCode) return reply(400, { ok: false, error: 'Falta cardCode' });
    const correo = (email || '').trim();
    if (!EMAIL_RE.test(correo)) return reply(400, { ok: false, error: 'Correo inválido' });

    // 1) Actualizar en SAP
    const cookies = await sapLogin();
    const cc = String(cardCode).replace(/'/g, "''");
    const res = await fetch(`${SAP_URL}/BusinessPartners('${cc}')`, {
      method: 'PATCH',
      headers: { 'Cookie': cookies, 'Content-Type': 'application/json' },
      body: JSON.stringify({ EmailAddress: correo }),
      agent
    });
    if (res.status !== 204 && !res.ok) {
      const txt = await res.text();
      return reply(200, { ok: false, error: `SAP no aceptó el cambio (${res.status}): ${txt.slice(0, 200)}` });
    }
    try { await fetch(`${SAP_URL}/Logout`, { method: 'POST', headers: { Cookie: cookies }, agent }); } catch (_) {}

    // 2) Reflejarlo en Supabase (best-effort, para que el portal lo vea de una)
    try {
      const sb = getSupabase(getEmpresa());
      if (sb) await sb.from('customers').update({ email: correo }).eq('sap_card_code', cardCode);
    } catch (e) { console.error('Supabase email update:', e.message); }

    return reply(200, { ok: true, email: correo });
  } catch (e) {
    return reply(500, { ok: false, error: e.message });
  }
};
