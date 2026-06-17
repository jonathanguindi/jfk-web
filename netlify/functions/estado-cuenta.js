// netlify/functions/estado-cuenta.js
// Estado de cuenta de un cliente leyendo Facturas, Pagos y Notas de Crédito de SAP.
// Recibe: { cardCode, desde, hasta }  (fechas YYYY-MM-DD)
// Devuelve: { cliente, movimientos[], saldoAnterior, saldoFinal, totalDebito, totalCredito, aging }
//
// La lógica de cálculo vive ahora en lib/sap-estado.js (compartida con enviar-estado-cuenta.js
// y cobranzas-job.js). Este handler solo envuelve esa función con CORS/HTTP.

const { computeEstadoCuenta } = require('./lib/sap-estado');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Método no permitido' }) };

  try {
    const { cardCode, desde, hasta } = JSON.parse(event.body || '{}');
    if (!cardCode) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Falta cardCode' }) };

    const data = await computeEstadoCuenta({ cardCode, desde, hasta });
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
