// netlify/functions/cobranzas-job.js
// Función PROGRAMADA (diaria). El horario se define en netlify.toml ([functions."cobranzas-job"]).
// Revisa clientes en mora con cobranza_auto=true, los encola para aprobación y avisa al admin.
// NO envía correos a clientes (eso ocurre al aprobar desde el portal).

const { runCobranzasJob } = require('./lib/cobranzas-job-core');

exports.handler = async () => {
  try {
    const res = await runCobranzasJob();
    console.log('cobranzas-job:', JSON.stringify(res));
    return { statusCode: 200, body: JSON.stringify(res) };
  } catch (e) {
    console.error('cobranzas-job error:', e);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
