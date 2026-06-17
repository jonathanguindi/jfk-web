// netlify/functions/cobranza-run-background.js
// Función EN SEGUNDO PLANO (sufijo -background => hasta 15 min) para disparar el
// job de cobranzas a demanda desde el portal ("Correr ahora").
// Revisa los clientes recurrentes en mora, los encola en Pendientes y avisa al admin.

const { runCobranzasJob } = require('./lib/cobranzas-job-core');

exports.handler = async () => {
  try {
    const res = await runCobranzasJob();
    console.log('cobranza-run-background:', JSON.stringify(res));
    return { statusCode: 200, body: JSON.stringify(res) };
  } catch (e) {
    console.error('cobranza-run-background error:', e);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
