// netlify/functions/descargar-facturas.js
// Genera y devuelve el PDF de facturas (con fotos) del cliente para descargar.
// Recibe: POST { cardCode, desde?, hasta?, lang? }  ->  application/pdf

const { fetchFacturasConLineas } = require('./lib/sap-estado');
const { buildFacturasPDF } = require('./lib/facturas-pdf');
const { getEmpresa } = require('./lib/empresa-config');

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const err = (code, msg) => ({ statusCode: code, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify({ ok: false, error: msg }) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return err(405, 'Método no permitido');
  try {
    const { cardCode, desde, hasta, lang } = JSON.parse(event.body || '{}');
    if (!cardCode) return err(400, 'Falta cardCode');
    const empresa = getEmpresa();
    const facturas = await fetchFacturasConLineas({ cardCode, desde, hasta, max: 40 });
    if (!facturas.length) return err(200, 'El cliente no tiene facturas en el período');
    const pdf = await buildFacturasPDF(facturas, empresa, lang === 'en' ? 'en' : 'es');
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="Facturas-${cardCode}.pdf"`,
        ...cors
      },
      body: pdf.toString('base64'),
      isBase64Encoded: true
    };
  } catch (e) {
    return err(500, e.message);
  }
};
