// netlify/functions/enviar-con-facturas-background.js
// Envío del estado de cuenta + PDF de facturas con fotos. Va en segundo plano
// (sufijo -background => hasta 15 min) porque traer facturas + imágenes pesa.
// Recibe: POST { cardCode, desde?, hasta?, toOverride?, tipo?, envioId?, aprobadoPor? }

const { enviarEstadoCuenta } = require('./lib/enviar-core');

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body || '{}');
    const res = await enviarEstadoCuenta({ ...body, incluirFacturas: true });
    console.log('enviar-con-facturas:', JSON.stringify(res));
    return { statusCode: 200, body: JSON.stringify(res) };
  } catch (e) {
    console.error('enviar-con-facturas error:', e);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
