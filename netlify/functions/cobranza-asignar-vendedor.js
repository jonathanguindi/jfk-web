// netlify/functions/cobranza-asignar-vendedor.js
// Asigna manualmente un vendedor a un cliente (se guarda y manda al CC / scope).
// Recibe: POST { cardCode, email }  (email vacío = quitar asignación, vuelve a automático)

const { getEmpresa } = require('./lib/empresa-config');
const { getSupabase } = require('./lib/supabase');

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, { ok: true });
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Método no permitido' });
  try {
    const { cardCode, email } = JSON.parse(event.body || '{}');
    if (!cardCode) return reply(400, { ok: false, error: 'Falta cardCode' });
    const sb = getSupabase(getEmpresa());
    if (!sb) return reply(500, { ok: false, error: 'Supabase no configurado' });
    const { error } = await sb.from('cobranza_cliente_vendedor')
      .upsert({ sap_card_code: cardCode, vendedor_email: (email || '').trim() || null, updated_at: new Date().toISOString() }, { onConflict: 'sap_card_code' });
    if (error) return reply(200, { ok: false, error: error.message });
    return reply(200, { ok: true });
  } catch (e) {
    return reply(500, { ok: false, error: e.message });
  }
};
