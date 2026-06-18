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
    pie: (e) => `Este es un mensaje de cobranzas de ${e}.`,
    subjectFacturas: (e) => `Facturas — ${e}`,
    facturasIntro: 'Según lo solicitado en nuestra comunicación anterior, adjuntamos sus facturas con el detalle de los productos comprados.',
    facturasAdjunto: 'En el <b>PDF adjunto</b> encontrará cada factura con su detalle y las fotos de los productos.'
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
    pie: (e) => `This is a collections message from ${e}.`,
    subjectFacturas: (e) => `Invoices — ${e}`,
    facturasIntro: 'As requested in our previous communication, please find attached your invoices with the detail of the products purchased.',
    facturasAdjunto: 'In the <b>attached PDF</b> you will find each invoice with its detail and product photos.'
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

// Correo para el modo "solo facturas" (más liviano, tono de seguimiento).
function emailFacturasHTML(data, empresa, lang = 'es') {
  const t = EMAIL_T[lang] || EMAIL_T.es;
  const accent = empresa.accent || [255, 107, 53];
  const A = `rgb(${accent[0]},${accent[1]},${accent[2]})`;
  const c = data.cliente;
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111">
  <div style="max-width:620px;margin:0 auto;padding:28px 16px">
    <div style="background:#fff;border:1px solid #e6e6ea;border-radius:12px;overflow:hidden">
      <div style="padding:22px 26px;border-bottom:3px solid ${A}">
        <div style="font-size:20px;font-weight:800;letter-spacing:.3px">${esc(empresa.nombreLegal)}</div>
        <div style="font-size:12px;color:#888;margin-top:4px">${esc(empresa.subtitulo)}</div>
      </div>
      <div style="padding:26px">
        <p style="margin:0 0 14px;color:#111">${t.saludo} <b>${esc(c.nombre)}</b>,</p>
        <p style="margin:0 0 14px;color:#444">${t.facturasIntro}</p>
        <p style="margin:0 0 6px;color:#444">${t.facturasAdjunto}</p>
        <p style="margin:20px 0 0;color:#444">${t.cierre}</p>
        <p style="margin:14px 0 0;color:#111">${t.firma}<br><b>${esc(empresa.nombreCorto)}</b> · ${t.depto}</p>
      </div>
    </div>
    <div style="text-align:center;color:#aaa;font-size:11px;margin-top:14px">${t.pie(esc(empresa.nombreCorto))}</div>
  </div></body></html>`;
}

// Switch global: ¿enviar copia al vendedor? (cobranza_config.cc_vendedor, default true)
async function ccVendedorActivado(empresa) {
  try {
    const sb = getSupabase(empresa);
    if (!sb) return true;
    const { data } = await sb.from('cobranza_config').select('value').eq('key', 'cc_vendedor').maybeSingle();
    return (!data || data.value == null) ? true : data.value !== 'false';
  } catch (e) { return true; }
}

// Asignación manual de vendedor por cliente (tabla cobranza_cliente_vendedor).
async function asignacionManualVendedor(empresa, cardCode, destinatario) {
  try {
    const sb = getSupabase(empresa);
    if (!sb) return [];
    const { data } = await sb.from('cobranza_cliente_vendedor').select('vendedor_email').eq('sap_card_code', cardCode).maybeSingle();
    if (!data || !data.vendedor_email) return [];
    return data.vendedor_email.split(/[,;]/).map(s => s.trim()).filter(e => EMAIL_RE.test(e) && e.toLowerCase() !== (destinatario || '').toLowerCase());
  } catch (e) { return []; }
}

// Resuelve los correos del vendedor de la última factura (puede ser más de uno
// si el código es compartido). Devuelve un array.
//  1) Mapeo administrado (cobranza_vendedores) por código SAP, siguiendo reasignación.
//  2) Si no está configurado, empareja por nombre con la tabla sellers.
async function resolverEmailsVendedor(empresa, vendedor, destinatario) {
  if (!vendedor) return [];
  const sb = getSupabase(empresa);
  const okMail = (e) => EMAIL_RE.test(e) && e.toLowerCase() !== (destinatario || '').toLowerCase();
  const split = (s) => (s || '').split(/[,;]/).map(x => x.trim()).filter(Boolean);

  // 1) Mapeo por código SAP (con reasignación). Un código puede tener varios correos.
  if (sb && vendedor.code != null) {
    try {
      const { data: first } = await sb.from('cobranza_vendedores').select('sap_code,email,activo,reasignar_a').eq('sap_code', vendedor.code).maybeSingle();
      if (first) {
        let row = first; const seen = new Set(); let hops = 0;
        while (row && hops < 6) {
          if (row.activo) return split(row.email).filter(okMail);
          if (row.reasignar_a == null || seen.has(row.reasignar_a)) return [];
          seen.add(row.reasignar_a);
          const { data: next } = await sb.from('cobranza_vendedores').select('sap_code,email,activo,reasignar_a').eq('sap_code', row.reasignar_a).maybeSingle();
          row = next; hops++;
        }
        return [];
      }
    } catch (e) { console.error('mapeo vendedor:', e.message); }
  }

  // 2) Respaldo: emparejar por nombre con sellers
  if (!vendedor.nombre) return [];
  try {
    if (!sb) return [];
    const { data: sellers } = await sb.from('sellers').select('name,email,active').eq('active', true);
    if (!sellers || !sellers.length) return [];
    const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    const target = norm(vendedor.nombre);
    const ttoks = target.split(' ').filter(Boolean);
    const tset = new Set(ttoks);
    let best = null, bestScore = 0;
    for (const s of sellers) {
      const email = (s.email || '').trim();
      if (!okMail(email)) continue;
      const sn = norm(s.name);
      if (sn === target) return [email];
      const stoks = sn.split(' ').filter(Boolean);
      if (stoks.length && stoks.every(t => tset.has(t))) return [email];
      const shared = stoks.filter(t => tset.has(t)).length;
      if (shared > bestScore) { bestScore = shared; best = email; }
    }
    const need = Math.min(2, ttoks.length || 1);
    return (bestScore >= need && best) ? [best] : [];
  } catch (e) { console.error('resolverEmailsVendedor:', e.message); return []; }
}

// opts: { cardCode, desde?, hasta?, toOverride?, tipo?, envioId?, aprobadoPor?, incluirFacturas? }
async function enviarEstadoCuenta(opts = {}) {
  const { cardCode, desde, hasta, toOverride, tipo = 'manual', envioId = null, aprobadoPor = null, incluirFacturas = false, soloFacturas = false, ccVendedor = true } = opts;
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

  // 3) Armar PDF(s), asunto y cuerpo según el modo
  const tdict = EMAIL_T[lang] || EMAIL_T.es;
  const facName = `Facturas-${data.cliente.codigo}-${data.rango.hasta}.pdf`;
  let attachments, subject, html;

  if (soloFacturas) {
    const facturas = await fetchFacturasConLineas({ cardCode, desde: data.rango.desde, hasta: data.rango.hasta, max: 40 });
    if (!facturas.length) {
      await registrar(empresa, { envioId, cardCode, data, tipo, status: 'error', error: 'Sin facturas en el período', to, aprobadoPor });
      return { ok: false, error: 'El cliente no tiene facturas en el período' };
    }
    attachments = [{ filename: facName, content: await buildFacturasPDF(facturas, empresa, lang) }];
    subject = tdict.subjectFacturas(empresa.nombreCorto);
    html = emailFacturasHTML(data, empresa, lang);
  } else {
    const pdf = await buildEstadoCuentaPDF(data, empresa, lang);
    attachments = [{ filename: `EstadoCuenta-${data.cliente.codigo}-${data.rango.hasta}.pdf`, content: pdf }];
    if (incluirFacturas) {
      try {
        const facturas = await fetchFacturasConLineas({ cardCode, desde: data.rango.desde, hasta: data.rango.hasta, max: 40 });
        if (facturas.length) attachments.push({ filename: facName, content: await buildFacturasPDF(facturas, empresa, lang) });
      } catch (e) { console.error('PDF de facturas falló (se envía solo el estado):', e.message); }
    }
    subject = tdict.subject(empresa.nombreCorto);
    html = emailHTML(data, empresa, lang);
  }

  // 4) CC: cobros + (si está activado) el vendedor de la última factura
  const ccList = [];
  if (empresa.cc) ccList.push(empresa.cc);
  if (ccVendedor && await ccVendedorActivado(empresa)) {
    let emails = await asignacionManualVendedor(empresa, cardCode, to);   // asignación manual por cliente
    if (!emails.length) emails = await resolverEmailsVendedor(empresa, data.vendedor, to);   // si no, automático por factura
    for (const e of emails) if (!ccList.includes(e)) ccList.push(e);
  }

  // 5) Enviar por Resend
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { data: sent, error: sendErr } = await resend.emails.send({
    from: empresa.from,
    to: [to],
    cc: ccList.length ? ccList : undefined,
    bcc: empresa.bcc ? [empresa.bcc] : undefined,
    subject,
    html,
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
