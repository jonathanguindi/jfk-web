// ventas-sync-run.js · Disparo MANUAL de la sincronización (botón "Sincronizar ahora").
// Protegido por token: POST { token, reset? }. token debe coincidir con env VENTAS_SYNC_TOKEN
// (o COBRANZA_RUN_TOKEN como respaldo). reset=true re-baja todo desde cero.
const { runVentasSync } = require('./lib/ventas-sync-core');

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, { ok: true });
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Método no permitido' });

  const expected = process.env.VENTAS_SYNC_TOKEN || process.env.COBRANZA_RUN_TOKEN;
  if (!expected) return reply(500, { ok: false, error: 'VENTAS_SYNC_TOKEN no configurado' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) {}
  if (body.token !== expected) return reply(401, { ok: false, error: 'Token inválido' });

  try {
    const res = await runVentasSync({ reset: !!body.reset, refreshBP: !!body.bp });
    return reply(200, res);
  } catch (e) {
    return reply(500, { ok: false, error: e.message });
  }
};
