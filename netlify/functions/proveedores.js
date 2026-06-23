// proveedores.js · Buscar proveedores en SAP y crear nuevos (BusinessPartners cSupplier). SOLO ADMIN.
// acciones: buscar (lectura) | crear (ESCRITURA en SAP). Crea con la serie/grupo del cliente (88/101).
const { getEmpresa } = require('./lib/empresa-config');
const { SAP_URL, sapLogin, sapGetAll } = require('./lib/sap-ventas');

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (c, o) => ({ statusCode: c, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify(o) });

// Serie/grupo de proveedor por empresa (de lo visto en SAP). Override por env si hace falta.
const PROV_CFG = {
  JFK: { series: Number(process.env.SAP_PROV_SERIES || 88), group: Number(process.env.SAP_PROV_GROUP || 101) },
  BDB: { series: Number(process.env.SAP_PROV_SERIES || 0) || null, group: Number(process.env.SAP_PROV_GROUP || 0) || null }
};

async function sapPost(cookie, path, bodyObj) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 12000);
  try {
    const r = await fetch(`${SAP_URL}/${path}`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj), signal: ac.signal
    });
    const txt = await r.text();
    let j = null; try { j = txt ? JSON.parse(txt) : null; } catch (_) {}
    return { ok: r.ok, status: r.status, json: j, text: txt };
  } finally { clearTimeout(t); }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, { ok: true });
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });
  try {
    const body = JSON.parse(event.body || '{}');
    const empresa = getEmpresa();
    const adminEmail = (process.env.VENTAS_ADMIN_EMAIL || empresa.admin || '').trim().toLowerCase();
    if ((body.email || '').trim().toLowerCase() !== adminEmail) return reply(403, { ok: false, error: 'Solo el administrador' });

    const cookie = await sapLogin();
    const accion = body.accion || 'buscar';

    if (accion === 'buscar') {
      const q = (body.q || '').trim().replace(/'/g, "''");
      let filtro = "CardType eq 'cSupplier'";
      if (q) filtro += ` and contains(CardName,'${q}')`;
      const path = `BusinessPartners?$filter=${encodeURIComponent(filtro)}&$orderby=CardName&$select=CardCode,CardName,FederalTaxID,Phone1,EmailAddress&$top=25`;
      const rows = await sapGetAll(cookie, path);
      return reply(200, { ok: true, proveedores: (rows || []).slice(0, 25).map(p => ({ card_code: p.CardCode, nombre: p.CardName, ruc: p.FederalTaxID || '', telefono: p.Phone1 || '', email: p.EmailAddress || '' })) });
    }

    if (accion === 'crear') {
      const p = body.proveedor || {};
      if (!p.nombre) return reply(200, { ok: false, error: 'El nombre es requerido' });
      const cfg = PROV_CFG[empresa.id] || {};
      const bp = {
        CardName: String(p.nombre).slice(0, 100),
        CardType: 'cSupplier',
        FederalTaxID: p.ruc || null,
        Phone1: p.telefono || null,
        Cellular: p.celular || null,
        EmailAddress: p.email || null,
        Address: p.direccion || null,
        ContactPerson: p.contacto || null
      };
      if (cfg.series) bp.Series = cfg.series;
      if (cfg.group) bp.GroupCode = cfg.group;
      // Si el cliente fuerza un CardCode manual, lo respetamos; si no, SAP lo asigna por la serie.
      if (p.card_code) bp.CardCode = p.card_code;

      const res = await sapPost(cookie, 'BusinessPartners', bp);
      if (!res.ok) {
        // Mensaje de error legible de SAP
        const msg = (res.json && res.json.error && (res.json.error.message?.value || res.json.error.message)) || res.text || ('HTTP ' + res.status);
        return reply(200, { ok: false, error: String(msg).slice(0, 300) });
      }
      const creado = res.json || {};
      return reply(200, { ok: true, card_code: creado.CardCode, nombre: creado.CardName, ruc: creado.FederalTaxID || '' });
    }

    if (accion === 'eliminar') {
      const code = (body.card_code || '').trim();
      if (!code) return reply(200, { ok: false, error: 'card_code requerido' });
      const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 12000);
      try {
        const r = await fetch(`${SAP_URL}/BusinessPartners('${encodeURIComponent(code)}')`, { method: 'DELETE', headers: { Cookie: cookie }, signal: ac.signal });
        if (r.ok || r.status === 204) return reply(200, { ok: true });
        const txt = await r.text();
        return reply(200, { ok: false, error: ('HTTP ' + r.status + ' ' + txt).slice(0, 250) });
      } finally { clearTimeout(t); }
    }

    return reply(200, { ok: false, error: 'acción no válida' });
  } catch (e) {
    return reply(200, { ok: false, error: e.message || String(e) });
  }
};
