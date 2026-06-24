// cliente-email.js · Actualiza el CORREO de un cliente: lo escribe en SAP (BusinessPartners) y en
// Supabase (customers + customer_users) para que sea el correo con que el cliente entra a su portal.
// Lo usa el portal de ventas. Valida que quien lo pide sea un vendedor (tabla sellers).
const { getEmpresa } = require('./lib/empresa-config');
const { getSupabase } = require('./lib/supabase');
const { SAP_URL, sapLogin } = require('./lib/sap-ventas');

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (c, o) => ({ statusCode: c, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify(o) });
const emailOK = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || '');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, { ok: true });
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });
  try {
    const body = JSON.parse(event.body || '{}');
    const empresa = getEmpresa();
    const sb = getSupabase(empresa);
    if (!sb) return reply(500, { ok: false, error: 'Supabase no configurado' });

    const vendor = (body.email || '').trim().toLowerCase();
    const cardCode = (body.cardCode || '').trim();
    const nuevo = (body.nuevoEmail || '').trim().toLowerCase();
    if (!cardCode) return reply(200, { ok: false, error: 'Falta el código del cliente' });
    if (!emailOK(nuevo)) return reply(200, { ok: false, error: 'Correo inválido' });

    // Validar que quien pide sea un vendedor/usuario válido del portal.
    const { data: seller } = await sb.from('sellers').select('id,active').eq('email', vendor).maybeSingle();
    if (!seller || seller.active === false) return reply(403, { ok: false, error: 'No autorizado' });

    // 1) Supabase: customers (lo que usa el registro/login del portal de clientes) + customer_users si existe.
    const { error: e1 } = await sb.from('customers').update({ email: nuevo }).eq('sap_card_code', cardCode);
    if (e1) return reply(200, { ok: false, error: 'customers: ' + e1.message });
    await sb.from('customer_users').update({ email: nuevo }).eq('sap_card_code', cardCode);   // si ya tiene cuenta

    // 2) SAP: BusinessPartners EmailAddress (para que el sync nocturno no lo revierta).
    let sapOk = false, sapMsg = '';
    try {
      const cookie = await sapLogin();
      const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 12000);
      const r = await fetch(`${SAP_URL}/BusinessPartners('${encodeURIComponent(cardCode)}')`, {
        method: 'PATCH', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ EmailAddress: nuevo }), signal: ac.signal
      });
      clearTimeout(t);
      sapOk = r.ok || r.status === 204;
      if (!sapOk) sapMsg = ('SAP ' + r.status + ' ' + (await r.text())).slice(0, 200);
    } catch (e) { sapMsg = 'SAP: ' + (e.message || String(e)); }

    // El correo ya quedó en Supabase (el cliente ya puede registrarse/entrar). SAP es respaldo.
    return reply(200, { ok: true, email: nuevo, sap: sapOk, sap_nota: sapOk ? 'actualizado en SAP' : ('guardado en el portal; SAP pendiente — ' + sapMsg) });
  } catch (e) {
    return reply(200, { ok: false, error: e.message || String(e) });
  }
};
