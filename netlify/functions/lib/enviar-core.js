// netlify/functions/lib/enviar-core.js
// Lógica de "enviar estado de cuenta": calcula estado -> arma PDF -> envía por Resend
// (con CC a cobros y PDF adjunto) -> registra el envío en Supabase (best-effort).
// La usan el botón manual (enviar-estado-cuenta.js) y la aprobación del envío automático.

const { Resend } = require('resend');
const { computeEstadoCuenta, fetchFacturasConLineas } = require('./sap-estado');
const { buildEstadoCuentaPDF, fmt } = require('./estado-pdf');
const { buildFacturasPDF } = require('./facturas-pdf');
const { getEmpresa } = require('./empresa-config');
const { getSupabase } = require('./supabase');
const { idioma, bancoLabel, bancoValue } = require('./idioma');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

// Textos del correo por idioma.
const EMAIL_T = {
  es: {
    saludo: 'Estimados', subject: (e) => `Estado de Cuenta — ${e}`,
    vencido: 'Le escribimos para recordarle amablemente que su cuenta mantiene un saldo pendiente, parte del cual se encuentra vencido. Agradeceremos su gestión de pago a la brevedad posible.',
    alDia: 'Adjuntamos su estado de cuenta para su control y referencia.',
    saldoFecha: 'Saldo a la fecha', periodo: 'Período', al: 'al',
    adjunto: 'En el <b>PDF adjunto</b> encontrará el detalle de los movimientos, la antigüedad del saldo y las instrucciones de pago.',
    instr: 'Instrucciones de pago',
    cierre: 'Quedamos atentos a cualquier consulta. Agradecemos su preferencia.',
    firma: 'Cordialmente,', depto: 'Cuentas por Cobrar',
    pie: (e) => `Este es un mensaje de cobranzas de ${e}.`
  },
  en: {
    saludo: 'Dear', subject: (e) => `Account Statement — ${e}`,
    vencido: 'This is a friendly reminder that your account has an outstanding balance, part of which is past due. We kindly ask you to arrange payment at your earliest convenience.',
    alDia: 'Please find attached your account statement for your records.',
    saldoFecha: 'Balance to date', periodo: 'Period', al: 'to',
    adjunto: 'In the <b>attached PDF</b> you will find the transaction detail, the aging of the balance and the payment instructions.',
    instr: 'Payment instructions',
    cierre: 'We remain at your disposal for any questions. Thank you for your business.',
    firma: 'Sincerely,', depto: 'Accounts Receivable',
    pie: (e) => `This is a collections message from ${e}.`
  }
};

function emailHTML(data, empresa, lang = 'es') {
  const t = EMAIL_T[lang] || EMAIL_T.es;
  const accent = empresa.accent || [255, 107, 53];
  const A = `rgb(${accent[0]},${accent[1]},${accent[2]})`;
  const c = data.cliente;
  const bancoRows = (empresa.banco || []).map(b =>
    `<tr><td style="padding:3px 12px 3px 0;color:#555;font-weight:600;white-space:nowrap">${esc(bancoLabel(b.label, lang))}</td><td style="padding:3px 0;color:#111">${esc(bancoValue(b, lang))}</td></tr>`
  ).join('');
  const intro = (data.vencido > 0.01) ? t.vencido : t.alDia;

  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f5f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111">
  <div style="max-width:620px;margin:0 auto;padding:28px 16px">
    <div style="background:#fff;border:1px solid #e6e6ea;border-radius:12px;overflow:hidden">
      <div style="padding:22px 26px;border-bottom:3px solid ${A}">
        <div style="font-size:20px;font-weight:800;letter-spacing:.3px">${esc(empresa.nombreLegal)}</div>
        <div style="font-size:12px;color:#888;margin-top:4px">${esc(empresa.subtitulo)}</div>
      </div>
      <div style="padding:26px">
        <p style="margin:0 0 14px;color:#111">${t.saludo} <b>${esc(c.nombre)}</b>,</p>
        <p style="margin:0 0 14px;color:#444">${intro}</p>
        <div style="background:#fafafb;border:1px solid #ececf0;border-radius:10px;padding:16px 18px;margin:0 0 18px">
          <div style="font-size:13px;color:#777">${t.saldoFecha}</div>
          <div style="font-size:24px;font-weight:800;color:${A};margin-top:2px">${fmt(c.saldoActual)}</div>
          <div style="font-size:12px;color:#999;margin-top:4px">${t.periodo} ${esc(data.rango.desde)} ${t.al} ${esc(data.rango.hasta)}</div>
        </div>
        <p style="margin:0 0 6px;color:#444">${t.adjunto}</p>
        ${bancoRows ? `<div style="margin:18px 0 6px;font-weight:700;color:${A}">${t.instr}</div>
        <table style="font-size:13px;border-collapse:collapse">${bancoRows}</table>` : ''}
        <p style="margin:20px 0 0;color:#444">${t.cierre}</p>
        <p style="margin:14px 0 0;color:#111">${t.firma}<br><b>${esc(empresa.nombreCorto)}</b> · ${t.depto}</p>
      </div>
    </div>
    <div style="text-align:center;color:#aaa;font-size:11px;margin-top:14px">${t.pie(esc(empresa.nombreCorto))}</div>
  </div></body></html>`;
}

// Empareja el nombre del vendedor de SAP con la tabla sellers para obtener su correo.
async function resolverEmailVendedor(empresa, vendedor, destinatario) {
  if (!vendedor || !vendedor.nombre) return null;
  try {
    const sb = getSupabase(empresa);
    if (!sb) return null;
    const { data: sellers } = await sb.from('sellers').select('name,email,active').eq('active', true);
    if (!sellers || !sellers.length) return null;
    const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    const target = norm(vendedor.nombre);
    const ttoks = target.split(' ').filter(Boolean);
    const tset = new Set(ttoks);
    let best = null, bestScore = 0;
    for (const s of sellers) {
      const email = (s.email || '').trim();
      if (!EMAIL_RE.test(email)) continue;
      if (email.toLowerCase() === (destinatario || '').toLowerCase()) continue; // no CC al mismo destinatario
      const sn = norm(s.name);
      if (sn === target) return email;
      const stoks = sn.split(' ').filter(Boolean);
      if (stoks.length && stoks.every(t => tset.has(t))) return email;   // nombre del seller ⊆ nombre SAP
      const shared = stoks.filter(t => tset.has(t)).length;
      if (shared > bestScore) { bestScore = shared; best = email; }
    }
    const need = Math.min(2, ttoks.length || 1);   // 1 token -> 1; 2+ -> 2 en común
    return bestScore >= need ? best : null;
  } catch (e) { console.error('resolverEmailVendedor:', e.message); return null; }
}

// opts: { cardCode, desde?, hasta?, toOverride?, tipo?, envioId?, aprobadoPor?, incluirFacturas? }
async function enviarEstadoCuenta(opts = {}) {
  const { cardCode, desde, hasta, toOverride, tipo = 'manual', envioId = null, aprobadoPor = null, incluirFacturas = false } = opts;
  if (!cardCode) return { ok: false, error: 'Falta cardCode' };

  const empresa = getEmpresa();
  if (!process.env.RESEND_API_KEY) return { ok: false, error: 'RESEND_API_KEY no configurada en este sitio' };

  // 1) Estado de cuenta desde SAP
  const data = await computeEstadoCuenta({ cardCode, desde, hasta });

  // 2) Destinatario
  const to = (toOverride && EMAIL_RE.test(toOverride)) ? toOverride : (data.cliente.email || '').trim();
  if (!EMAIL_RE.test(to)) {
    await registrar(empresa, { envioId, cardCode, data, tipo, status: 'error', error: 'Cliente sin correo válido', to, aprobadoPor });
    return { ok: false, error: 'El cliente no tiene un correo válido registrado en SAP', sinCorreo: true };
  }

  // Idioma según el país del cliente (hispanohablante -> es, resto -> en)
  const lang = idioma(data.cliente.pais);

  // 3) PDF del estado de cuenta (en el idioma del cliente)
  const pdf = await buildEstadoCuentaPDF(data, empresa, lang);
  const filename = `EstadoCuenta-${data.cliente.codigo}-${data.rango.hasta}.pdf`;
  const attachments = [{ filename, content: pdf }];

  // 3b) Opcional: PDF de facturas con fotos de productos
  if (incluirFacturas) {
    try {
      const facturas = await fetchFacturasConLineas({ cardCode, desde: data.rango.desde, hasta: data.rango.hasta, max: 40 });
      if (facturas.length) {
        const fpdf = await buildFacturasPDF(facturas, empresa, lang);
        attachments.push({ filename: `Facturas-${data.cliente.codigo}-${data.rango.hasta}.pdf`, content: fpdf });
      }
    } catch (e) { console.error('PDF de facturas falló (se envía solo el estado):', e.message); }
  }

  // 4) CC: cobros + el vendedor de la última factura (si lo ubicamos en sellers)
  const ccList = [];
  if (empresa.cc) ccList.push(empresa.cc);
  const vendedorEmail = await resolverEmailVendedor(empresa, data.vendedor, to);
  if (vendedorEmail && !ccList.includes(vendedorEmail)) ccList.push(vendedorEmail);

  // 5) Enviar por Resend
  const resend = new Resend(process.env.RESEND_API_KEY);
  const subject = (EMAIL_T[lang] || EMAIL_T.es).subject(empresa.nombreCorto);
  const { data: sent, error: sendErr } = await resend.emails.send({
    from: empresa.from,
    to: [to],
    cc: ccList.length ? ccList : undefined,
    bcc: empresa.bcc ? [empresa.bcc] : undefined,
    subject,
    html: emailHTML(data, empresa, lang),
    attachments
  });

  if (sendErr) {
    await registrar(empresa, { envioId, cardCode, data, tipo, status: 'error', error: sendErr.message || String(sendErr), to, aprobadoPor });
    return { ok: false, error: sendErr.message || 'Error al enviar con Resend' };
  }

  // 5) Registro (best-effort)
  await registrar(empresa, { envioId, cardCode, data, tipo, status: 'enviado', to, aprobadoPor, messageId: sent && sent.id });

  return { ok: true, to, saldo: data.cliente.saldoActual, vencido: data.vencido, messageId: sent && sent.id };
}

// Registra/actualiza el envío en Supabase y refresca cobranza_last_sent. Nunca lanza.
async function registrar(empresa, info) {
  try {
    const sb = getSupabase(empresa);
    if (!sb) return;
    const { envioId, cardCode, data, tipo, status, error, to, aprobadoPor, messageId } = info;
    const row = {
      sap_card_code: cardCode,
      customer_name: data && data.cliente ? data.cliente.nombre : null,
      email: to || null,
      empresa: empresa.id,
      saldo: data ? data.cliente.saldoActual : null,
      vencido: data ? data.vencido : null,
      atraso_dias: data ? data.maxAtraso : null,
      tipo,
      status,
      error: error || null,
      message_id: messageId || null,
      approved_by: aprobadoPor || null,
      sent_at: status === 'enviado' ? new Date().toISOString() : null
    };
    if (envioId) {
      await sb.from('cobranza_envios').update(row).eq('id', envioId);
    } else {
      await sb.from('cobranza_envios').insert(row);
    }
    if (status === 'enviado') {
      await sb.from('customers').update({ cobranza_last_sent: new Date().toISOString() }).eq('sap_card_code', cardCode);
    }
  } catch (e) {
    console.error('registrar() best-effort falló:', e.message);
  }
}

module.exports = { enviarEstadoCuenta, emailHTML };
