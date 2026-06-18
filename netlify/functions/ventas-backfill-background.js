// ventas-backfill-background.js · Backfill histórico en SEGUNDO PLANO (hasta ~15 min).
// Carga los catálogos de SAP UNA sola vez y avanza muchísimas facturas de corrido,
// en vez de re-descargarlos en cada pasada corta. Ideal para la carga inicial.
// POST { token, reset? }. Responde 202 al instante; sigue corriendo en background.
// Mira el avance en el Dashboard (líneas / cursor) o repítelo hasta "Completo".
const { runVentasSync } = require('./lib/ventas-sync-core');

exports.handler = async (event) => {
  const expected = process.env.VENTAS_SYNC_TOKEN || process.env.COBRANZA_RUN_TOKEN;
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) {}
  if (!expected || body.token !== expected) {
    return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Token inválido o no configurado' }) };
  }
  // Presupuesto amplio: las funciones background de Netlify permiten hasta 15 min.
  const res = await runVentasSync({ reset: !!body.reset, budgetMs: 13 * 60 * 1000 });
  return { statusCode: 200, body: JSON.stringify(res) };
};
