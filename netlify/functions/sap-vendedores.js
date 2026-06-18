// netlify/functions/sap-vendedores.js
// Diagnóstico: lista los vendedores (SalesPersons) que existen en SAP.
// GET o POST -> { ok, count, vendedores:[{code,name,active}] }

const https = require('https');
const agent = new https.Agent({ rejectUnauthorized: false });
const SAP_URL = process.env.SAP_SERVICE_LAYER_URL;
const SAP_DB = process.env.SAP_COMPANY_DB;
const SAP_USER = process.env.SAP_USER || process.env.SAP_USERNAME;
const SAP_PASS = process.env.SAP_PASSWORD;

const reply = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(obj) });

async function sapLogin() {
  const r = await fetch(`${SAP_URL}/Login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ CompanyDB: SAP_DB, UserName: SAP_USER, Password: SAP_PASS }), agent
  });
  if (!r.ok) throw new Error(`SAP login ${r.status}`);
  const sc = r.headers.get('set-cookie') || '';
  return sc.split(',').map(c => c.split(';')[0].trim()).filter(Boolean).join('; ');
}

exports.handler = async () => {
  try {
    const cookies = await sapLogin();
    const res = await fetch(`${SAP_URL}/SalesPersons?$select=SalesEmployeeCode,SalesEmployeeName,Active`, {
      headers: { 'Cookie': cookies, 'Content-Type': 'application/json', 'Prefer': 'odata.maxpagesize=0' }, agent
    });
    if (!res.ok) return reply(200, { ok: false, error: `SAP ${res.status}: ${await res.text()}` });
    const j = await res.json();
    const vendedores = (j.value || [])
      .filter(s => s.SalesEmployeeCode > 0)
      .map(s => ({ code: s.SalesEmployeeCode, name: s.SalesEmployeeName, active: s.Active }));
    return reply(200, { ok: true, count: vendedores.length, vendedores });
  } catch (e) {
    return reply(500, { ok: false, error: e.message });
  }
};
