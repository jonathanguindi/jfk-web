// netlify/functions/cobranza-marcar.js
// Marca/desmarca un cliente para envío recurrente y fija su cadencia.
// Usa la SERVICE KEY (omite RLS) para escribir en customers desde el servidor.
// Recibe: POST { cardCode, auto:boolean, cadencia?: 'semanal'|'diario' }

const { getEmpresa } = require('./lib/empresa-config');
const { getSupabase } = require('./lib/supabase');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const reply = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, { ok: true });
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Método no permitido' });

  try {
    const { cardCode, auto, cadencia } = JSON.parse(event.body || '{}');
    if (!cardCode) return reply(400, { ok: false, error: 'Falta cardCode' });

    const sb = getSupabase(getEmpresa());
    if (!sb) return reply(500, { ok: false, error: 'Supabase no configurado (SUPABASE_SERVICE_KEY)' });

    const cad = auto ? (cadencia === 'diario' ? 'diario' : 'semanal') : null;
    const { error } = await sb.from('customers')
      .update({ cobranza_auto: !!auto, cobranza_cadencia: cad })
      .eq('sap_card_code', cardCode);
    if (error) return reply(200, { ok: false, error: error.message });

    return reply(200, { ok: true, auto: !!auto, cadencia: cad });
  } catch (e) {
    return reply(500, { ok: false, error: e.message });
  }
};
