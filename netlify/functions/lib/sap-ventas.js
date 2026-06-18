// lib/sap-ventas.js · acceso a SAP B1 Service Layer para el dashboard de ventas.
// - Login + fetch con timeout (mismo patrón resiliente que historial-cliente.js).
// - Mapas cacheables por invocación: vendedores, países, familias de producto, país por cliente.
// - Paginado de Invoices / CreditNotes por DocEntry (cursor reanudable).

const https = require('https');
const agent = new https.Agent({ rejectUnauthorized: false });

const SAP_URL  = process.env.SAP_SERVICE_LAYER_URL || '';
const SAP_DB   = process.env.SAP_COMPANY_DB || '';
const SAP_USER = process.env.SAP_USER || process.env.SAP_USERNAME || '';
const SAP_PASS = process.env.SAP_PASSWORD || '';

const CALL_TIMEOUT_MS = 8000;

async function sapFetch(url, opts = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), CALL_TIMEOUT_MS);
  try { return await fetch(url, { agent, ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

async function sapLogin() {
  const r = await sapFetch(`${SAP_URL}/Login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ CompanyDB: SAP_DB, UserName: SAP_USER, Password: SAP_PASS })
  });
  if (!r.ok) throw new Error(`SAP login ${r.status}: ${await r.text()}`);
  const sc = r.headers.get('set-cookie') || '';
  return sc.split(',').map(c => c.split(';')[0].trim()).filter(Boolean).join('; ');
}

async function sapLogout(cookie) {
  try { await sapFetch(`${SAP_URL}/Logout`, { method: 'POST', headers: { Cookie: cookie } }); } catch (_) {}
}

// GET que sigue @odata.nextLink hasta traer todo (para catálogos acotados).
async function sapGetAll(cookie, path) {
  const out = [];
  let url = `${SAP_URL}/${path}`;
  const headers = { Cookie: cookie, 'Content-Type': 'application/json', Prefer: 'odata.maxpagesize=0' };
  for (let i = 0; i < 200 && url; i++) {
    const r = await sapFetch(url, { headers });
    if (!r.ok) throw new Error(`SAP ${path} ${r.status}: ${await r.text()}`);
    const j = await r.json();
    (j.value || []).forEach(x => out.push(x));
    const next = j['@odata.nextLink'];
    url = next ? (next.startsWith('http') ? next : `${SAP_URL}/${next}`) : null;
  }
  return out;
}

// ── Mapas de catálogo (se cargan una vez por sincronización) ──────────────────
async function cargarMapas(cookie) {
  const bpSelect = 'BusinessPartners?$select=CardCode,CardName,EmailAddress,Phone1,Phone2,Cellular,Address,City,Country,ContactPerson,SalesPersonCode,Valid';
  const [vend, items, grupos, bps, paises] = await Promise.all([
    sapGetAll(cookie, 'SalesPersons?$select=SalesEmployeeCode,SalesEmployeeName').catch(() => []),
    sapGetAll(cookie, 'Items?$select=ItemCode,ItemName,ItemsGroupCode').catch(() => []),
    sapGetAll(cookie, 'ItemGroups?$select=Number,GroupName').catch(() => []),
    // Con contacto. Si tu SAP rechaza algún campo, cae al mínimo (CardCode,Country).
    sapGetAll(cookie, bpSelect).catch(() => sapGetAll(cookie, 'BusinessPartners?$select=CardCode,Country').catch(() => [])),
    sapGetAll(cookie, 'Countries?$select=Code,Name').catch(() => []),
  ]);

  const vendedor = new Map();
  vend.forEach(v => vendedor.set(v.SalesEmployeeCode, v.SalesEmployeeName));

  const grupoNombre = new Map();
  grupos.forEach(g => grupoNombre.set(g.Number, g.GroupName));

  const itemGrupo = new Map();      // itemCode -> groupCode
  items.forEach(it => itemGrupo.set(it.ItemCode, it.ItemsGroupCode));

  const paisNombre = new Map();
  paises.forEach(p => paisNombre.set(p.Code, p.Name));

  const clientePais = new Map();    // cardCode -> countryCode
  bps.forEach(b => clientePais.set(b.CardCode, b.Country));

  // Filas de ficha de cliente para ventas_clientes (datos de contacto).
  const clientes = bps.map(b => ({
    card_code: b.CardCode,
    card_name: b.CardName || null,
    email: b.EmailAddress || null,
    phone1: b.Phone1 || null,
    phone2: b.Phone2 || null,
    cellular: b.Cellular || null,
    address: b.Address || null,
    city: b.City || null,
    country_code: b.Country || null,
    country_name: b.Country ? (paisNombre.get(b.Country) || b.Country) : null,
    contact_person: b.ContactPerson || null,
    sales_person_code: (b.SalesPersonCode != null && b.SalesPersonCode > 0) ? b.SalesPersonCode : null,
    valid: b.Valid || null,
  }));

  return { vendedor, grupoNombre, itemGrupo, paisNombre, clientePais, clientes };
}

// ── Una página de documentos (Invoices o CreditNotes) por DocEntry asc ────────
// Devuelve { docs, nextCursor, fin }.
async function paginaDocumentos(cookie, recurso, cursor, pageSize) {
  const select = '$select=DocEntry,DocNum,DocDate,CardCode,CardName,SalesPersonCode,DocumentLines';
  const filtro = `$filter=DocEntry gt ${cursor}&$orderby=DocEntry asc`;
  const url = `${SAP_URL}/${recurso}?${select}&${filtro}`;
  const headers = { Cookie: cookie, 'Content-Type': 'application/json', Prefer: `odata.maxpagesize=${pageSize}` };
  const r = await sapFetch(url, { headers });
  if (!r.ok) throw new Error(`SAP ${recurso} ${r.status}: ${await r.text()}`);
  const j = await r.json();
  const docs = j.value || [];
  const nextCursor = docs.length ? docs[docs.length - 1].DocEntry : cursor;
  return { docs, nextCursor, fin: docs.length < pageSize };
}

module.exports = { SAP_URL, sapLogin, sapLogout, sapGetAll, cargarMapas, paginaDocumentos };
