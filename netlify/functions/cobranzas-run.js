// netlify/functions/cobranzas-run.js
// Disparo MANUAL del job de cobranzas (para probar sin esperar al horario diario).
// Protegido por token: POST { token } debe coincidir con la env COBRANZA_RUN_TOKEN.
// Útil también para un botón "Correr ahora" en el portal (admin).

const { runCobranzasJob } = require('./lib/cobranzas-job-core');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const reply = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, { ok: true });
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Método no permitido' });

  const expected = process.env.COBRANZA_RUN_TOKEN;
  if (!expected) return reply(500, { ok: false, error: 'COBRANZA_RUN_TOKEN no configurado' });

  let token;
  try { token = JSON.parse(event.body || '{}').token; } catch (_) {}
  if (token !== expected) return reply(401, { ok: false, error: 'Token inválido' });

  try {
    const res = await runCobranzasJob();
    return reply(200, res);
  } catch (e) {
    return reply(500, { ok: false, error: e.message });
  }
};
