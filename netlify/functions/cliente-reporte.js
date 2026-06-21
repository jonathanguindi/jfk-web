// netlify/functions/cliente-reporte.js
// Reporte de historial de compras de un cliente (con imágenes).
// POST { email, cardCode, vendedor_email?, vendedor_nombre?, modo:'download'|'email' }
//  - download -> { ok, pdf:base64, filename }
//  - email    -> manda el PDF al vendedor (BCC admin) y { ok, sent }
const { getEmpresa } = require('./lib/empresa-config');
const { getSupabase } = require('./lib/supabase');
const { generarReporteCliente } = require('./lib/cliente-reporte-pdf');
let Resend; try { Resend = require('resend').Resend; } catch (e) {}

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (c, o) => ({ statusCode: c, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify(o) });

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, { ok: true });
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Método no permitido' });
  let b = {}; try { b = JSON.parse(event.body || '{}'); } catch (_) {}

  const empresa = getEmpresa();
  const sb = getSupabase(empresa);
  if (!sb) return reply(500, { ok: false, error: 'Supabase no configurado' });
  const email = (b.email || '').trim().toLowerCase();
  if (!email) return reply(401, { ok: false, error: 'Sin sesión' });
  const cardCode = (b.cardCode || '').trim();
  if (!cardCode) return reply(400, { ok: false, error: 'Falta cliente' });

  try {
    const { pdf, filename, nombre } = await generarReporteCliente(empresa, sb, cardCode, b.vendedor_nombre);

    if (b.modo === 'email') {
      const to = (b.vendedor_email || email || '').trim();
      if (!Resend || !process.env.RESEND_API_KEY) return reply(200, { ok: false, error: 'Correo no configurado' });
      if (!to || to.indexOf('@') < 0) return reply(200, { ok: false, error: 'Correo de destino inválido' });
      const r = new Resend(process.env.RESEND_API_KEY);
      const adminBcc = (process.env.VENTAS_ADMIN_EMAIL || empresa.admin || '').trim();
      const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#0E1016">
        <p>Hola ${b.vendedor_nombre || ''},</p>
        <p>Adjunto el <b>historial de compras de ${nombre || 'este cliente'}</b> (todo lo que nos ha comprado, con imágenes) para que lo trabajes.</p>
        <p style="color:#888;font-size:12px">${empresa.nombreCorto || ''}</p></div>`;
      const { error: e2 } = await r.emails.send({
        from: empresa.from, to: [to], bcc: adminBcc ? [adminBcc] : undefined,
        subject: `Historial de cliente: ${nombre || ''}`, html, attachments: [{ filename, content: pdf }]
      });
      if (e2) return reply(200, { ok: false, error: (e2.message || JSON.stringify(e2)) });
      return reply(200, { ok: true, sent: true, to });
    }

    return reply(200, { ok: true, pdf: pdf.toString('base64'), filename });
  } catch (e) {
    return reply(500, { ok: false, error: e.message });
  }
};
