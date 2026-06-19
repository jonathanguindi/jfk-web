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
const CATALOG_TIMEOUT_MS = 25000;   // catálogos (Items es grande): más holgura

async function sapFetch(url, opts = {}, timeoutMs = CALL_TIMEOUT_MS) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
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

// Trae TODO un catálogo paginando MANUALMENTE con $skip (este Service Layer de SAP
// no devuelve @odata.nextLink al fijar maxpagesize, así que el skip explícito es la
// forma confiable). Reintenta cada página; si una falla del todo, devuelve lo parcial.
const PAGE = 500;
async function sapGetAll(cookie, path) {
  const out = [];
  const sep = path.includes('?') ? '&' : '?';
  const headers = { Cookie: cookie, 'Content-Type': 'application/json', Prefer: `odata.maxpagesize=${PAGE}` };
  for (let skip = 0; skip < 2000000; skip += PAGE) {
    const url = `${SAP_URL}/${path}${sep}$top=${PAGE}&$skip=${skip}`;
    let j = null;
    for (let intento = 0; intento < 3 && j === null; intento++) {
      try {
        const r = await sapFetch(url, { headers }, CATALOG_TIMEOUT_MS);
        if (!r.ok) { if (intento === 2) return out; continue; }
        j = await r.json();
      } catch (e) { if (intento === 2) return out; }
    }
    if (j === null) break;
    const batch = j.value || [];
    batch.forEach(x => out.push(x));
    if (batch.length < PAGE) break;   // última página
  }
  return out;
}

// ── Mapas de catálogo (se cargan una vez por sincronización) ──────────────────
async function cargarMapas(cookie) {
  const bpSelect = 'BusinessPartners?$select=CardCode,CardName,EmailAddress,Phone1,Phone2,Cellular,Address,City,Country,ContactPerson,SalesPersonCode,Valid,CurrentAccountBalance';
  // IMPORTANTE: en SECUENCIA, no en paralelo. El Service Layer de SAP B1 limita las
  // peticiones concurrentes por sesión y varias fallaban en silencio (nombres vacíos).
  const vend   = await sapGetAll(cookie, 'SalesPersons?$select=SalesEmployeeCode,SalesEmployeeName').catch(() => []);
  const grupos = await sapGetAll(cookie, 'ItemGroups?$select=Number,GroupName').catch(() => []);
  const paises = await sapGetAll(cookie, 'Countries?$select=Code,Name').catch(() => []);
  const items  = await sapGetAll(cookie, 'Items?$select=ItemCode,ItemsGroupCode').catch(() => []);
  // Con contacto. Si tu SAP rechaza algún campo, cae al mínimo (CardCode,Country).
  const bps    = await sapGetAll(cookie, bpSelect).catch(() => sapGetAll(cookie, 'BusinessPartners?$select=CardCode,Country').catch(() => []));

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
    balance: Number(b.CurrentAccountBalance) || 0,
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

// Primer DocEntry de un recurso con DocDate >= fecha (para saltar el cursor a años recientes).
async function primerDocEntryDesde(cookie, recurso, fecha) {
  const url = `${SAP_URL}/${recurso}?$select=DocEntry&$filter=DocDate ge '${fecha}'&$orderby=DocEntry asc`;
  const headers = { Cookie: cookie, 'Content-Type': 'application/json', Prefer: 'odata.maxpagesize=1' };
  const r = await sapFetch(url, { headers });
  if (!r.ok) throw new Error(`SAP ${recurso} ${r.status}: ${await r.text()}`);
  const j = await r.json();
  const v = j.value || [];
  return v.length ? v[0].DocEntry : null;
}

module.exports = { SAP_URL, sapLogin, sapLogout, sapGetAll, cargarMapas, paginaDocumentos, primerDocEntryDesde };
