// cxp-marcar.js · Guarda la decisión (activa/cerrar) y nota de una factura por pagar. SOLO ADMIN.
// NO toca SAP: solo registra la decisión en cxp_revision para armar la lista de cierre.
const { getEmpresa } = require('./lib/empresa-config');
const { getSupabase } = require('./lib/supabase');

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (c, o) => ({ statusCode: c, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify(o) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, { ok: true });
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });
  try {
    const body = JSON.parse(event.body || '{}');
    const empresa = getEmpresa();
    const sb = getSupabase(empresa);
    if (!sb) return reply(500, { ok: false, error: 'Supabase no configurado' });
    const email = (body.email || '').trim().toLowerCase();
    const adminEmail = (process.env.VENTAS_ADMIN_EMAIL || empresa.admin || '').trim().toLowerCase();
    if (email !== adminEmail) return reply(403, { ok: false, error: 'Solo el administrador' });

    const docEntry = Number(body.doc_entry);
    if (!Number.isFinite(docEntry)) return reply(200, { ok: false, error: 'doc_entry requerido' });
    const decision = body.decision === 'activa' ? 'activa' : body.decision === 'cerrar' ? 'cerrar' : null;
    const nota = (body.nota != null) ? String(body.nota).slice(0, 500) : undefined;

    const patch = { decision, decision_por: email, decision_at: new Date().toISOString() };
    if (nota !== undefined) patch.nota = nota;

    const { error } = await sb.from('cxp_revision').update(patch).eq('doc_entry', docEntry);
    if (error) return reply(200, { ok: false, error: error.message });
    return reply(200, { ok: true });
  } catch (e) {
    return reply(200, { ok: false, error: e.message || String(e) });
  }
};
