// netlify/functions/enviar-estado-cuenta.js
// Envía al cliente su estado de cuenta en PDF (con CC a cobros) vía Resend.
// Recibe: POST { cardCode, desde?, hasta?, toOverride?, tipo?, envioId?, aprobadoPor? }
//   - tipo: 'manual' (botón del portal) | 'auto' (aprobación de la lista automática)
//   - envioId: si se aprueba un envío que ya estaba en cola (cobranza_envios), su id
// Devuelve: { ok, to?, error? }

const { enviarEstadoCuenta } = require('./lib/enviar-core');

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
    const body = JSON.parse(event.body || '{}');
    if (!body.cardCode) return reply(400, { ok: false, error: 'Falta cardCode' });
    const result = await enviarEstadoCuenta(body);
    return reply(result.ok ? 200 : 200, result); // 200 con ok:false para que el front lea el error
  } catch (e) {
    return reply(500, { ok: false, error: e.message });
  }
};
