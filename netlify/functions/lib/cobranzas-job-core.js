// netlify/functions/lib/cobranzas-job-core.js
// Núcleo del job diario de cobranzas (sin auto-envío: arma cola + avisa al administrador).
//
// Para cada cliente con cobranza_auto = true:
//   1) Calcula su estado de cuenta en SAP (vencido + días de atraso).
//   2) "En mora" si tiene saldo vencido (DocDueDate ya pasó, lo que respeta sus días de crédito).
//   3) Cadencia según el peor atraso:  1-30 días -> semanal,  > 30 días -> diario.
//   4) Si está en mora y "toca" enviar (según cobranza_last_sent y la cadencia) y no hay ya
//      un envío pendiente, lo encola en cobranza_envios con status 'pendiente'.
//   5) Envía un resumen al administrador para que apruebe los envíos desde el portal.
//
// NO envía nada al cliente: eso ocurre cuando el administrador aprueba (enviar-estado-cuenta).

const { Resend } = require('resend');
const { computeEstadoCuenta } = require('./sap-estado');
const { getEmpresa } = require('./empresa-config');
const { getSupabase } = require('./supabase');
const { fmt } = require('./estado-pdf');
const { enviarEstadoCuenta } = require('./enviar-core');

const DAY = 86400000;
const MAX_CLIENTS = parseInt(process.env.COBRANZA_MAX_CLIENTES || '120', 10);
// AUTO-ENVÍO: si está en 'true', el job ENVÍA los correos al cliente solo (sin aprobación).
// Si no, mantiene el comportamiento anterior (encola para aprobar en el portal).
const AUTO = (process.env.COBRANZA_AUTO_SEND || '').toLowerCase() === 'true';

function tocaEnviar(cadencia, lastSent, hoy) {
  if (!lastSent) return true;
  const diffDias = (hoy - new Date(lastSent)) / DAY;
  return cadencia === 'diario' ? diffDias >= 1 : diffDias >= 7;
}

async function runCobranzasJob(hoy = new Date()) {
  const empresa = getEmpresa();
  const sb = getSupabase(empresa);
  if (!sb) return { ok: false, error: 'Supabase no configurado (falta SUPABASE_SERVICE_KEY/URL)' };

  const desde = (hoy.getFullYear() - 1) + '-01-01';
  const hasta = hoy.toISOString().slice(0, 10);

  // 1) Clientes marcados para envío automático
  const { data: clientes, error: cErr } = await sb
    .from('customers')
    .select('sap_card_code, name, email, payment_terms, current_balance, cobranza_last_sent, cobranza_cadencia, active')
    .eq('cobranza_auto', true)
    .eq('active', true)
    .limit(MAX_CLIENTS);
  if (cErr) return { ok: false, error: 'Error leyendo customers: ' + cErr.message };
  if (!clientes || !clientes.length) return { ok: true, revisados: 0, encolados: 0, candidatos: [], mensaje: 'Sin clientes en lista automática' };

  // En AUTO: descartar los pendientes viejos de auto (ya no se aprueban, se envían solos).
  if (AUTO) {
    try { await sb.from('cobranza_envios').update({ status: 'descartado' }).eq('status', 'pendiente').eq('tipo', 'auto'); } catch (e) {}
  }

  // Pendientes existentes (para no duplicar — solo aplica al modo aprobación)
  const { data: pend } = await sb
    .from('cobranza_envios')
    .select('sap_card_code')
    .eq('status', 'pendiente');
  const yaPendiente = new Set((pend || []).map(p => p.sap_card_code));

  const candidatos = [];
  const errores = [];
  const enviadosList = [];
  let revisados = 0, enviados = 0, sinCorreo = 0;

  // 2-4) Revisar cada cliente (secuencial para no saturar SAP)
  for (const cli of clientes) {
    revisados++;
    try {
      const data = await computeEstadoCuenta({ cardCode: cli.sap_card_code, desde, hasta }, hoy);
      const vencido = data.vencido || 0;
      if (vencido <= 0.01) continue;                       // no está en mora
      const atraso = data.maxAtraso || 0;
      // Cadencia: la que eligió el administrador (manual); si no hay, según el atraso.
      const cadencia = cli.cobranza_cadencia || (atraso > 30 ? 'diario' : 'semanal');
      if (!tocaEnviar(cadencia, cli.cobranza_last_sent, hoy)) continue;  // aún no toca reenviar
      if (!AUTO && yaPendiente.has(cli.sap_card_code)) continue;    // ya hay uno esperando aprobación

      if (AUTO) {
        // ENVÍO AUTOMÁTICO: manda el estado de cuenta al cliente directo (sin aprobación).
        const r = await enviarEstadoCuenta({ cardCode: cli.sap_card_code, tipo: 'auto', cadencia });
        if (r.ok) { enviados++; enviadosList.push({ customer_name: data.cliente.nombre || cli.name, vencido, atraso_dias: atraso, cadencia }); }
        else if (r.sinCorreo) sinCorreo++;
        else errores.push({ cardCode: cli.sap_card_code, error: r.error });
      } else {
        candidatos.push({
          sap_card_code: cli.sap_card_code,
          customer_name: data.cliente.nombre || cli.name,
          email: (cli.email || data.cliente.email || '').trim() || null,
          empresa: empresa.id,
          saldo: data.cliente.saldoActual,
          vencido,
          atraso_dias: atraso,
          cadencia,
          tipo: 'auto',
          status: 'pendiente'
        });
      }
    } catch (e) {
      errores.push({ cardCode: cli.sap_card_code, error: e.message });
    }
  }

  // Encolar candidatos
  let encolados = 0;
  if (candidatos.length) {
    const { error: insErr } = await sb.from('cobranza_envios').insert(candidatos);
    if (insErr) return { ok: false, error: 'Error encolando: ' + insErr.message, candidatos };
    encolados = candidatos.length;
  }

  // 5) Avisar al administrador (best-effort)
  let avisoAdmin = false;
  if (encolados > 0 && process.env.RESEND_API_KEY && empresa.admin) {
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const siteUrl = (process.env.URL || '').replace(/\/$/, '');
      const link = siteUrl ? `${siteUrl}/vendedores` : 'el portal de vendedores';
      const rows = candidatos.map(c => `
        <tr>
          <td style="padding:6px 10px;border-bottom:1px solid #eee">${c.customer_name || c.sap_card_code}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #eee;color:#888">${c.email || '— sin correo —'}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;font-weight:600">${fmt(c.vencido)}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center">${c.atraso_dias} d (${c.cadencia})</td>
        </tr>`).join('');
      await resend.emails.send({
        from: empresa.from,
        to: [empresa.admin],
        subject: `Cobranzas ${empresa.nombreCorto} — ${encolados} cliente(s) en mora por aprobar`,
        html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:680px;margin:0 auto;color:#111">
          <h2 style="margin:0 0 6px">Resumen de cobranzas — ${hasta}</h2>
          <p style="color:#555;margin:0 0 16px">Hay <b>${encolados}</b> cliente(s) en mora esperando tu aprobación para enviarles su estado de cuenta.</p>
          <table style="border-collapse:collapse;width:100%;font-size:13px">
            <thead><tr style="background:#0E1016;color:#fff">
              <th style="padding:8px 10px;text-align:left">Cliente</th>
              <th style="padding:8px 10px;text-align:left">Correo</th>
              <th style="padding:8px 10px;text-align:right">Vencido</th>
              <th style="padding:8px 10px;text-align:center">Atraso</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <p style="margin:18px 0 0"><a href="${link}" style="background:rgb(${(empresa.accent || [255,107,53]).join(',')});color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:700">Revisar y aprobar en el portal</a></p>
          <p style="color:#999;font-size:12px;margin-top:14px">Aprueba o descarta cada envío en la sección <b>Cobranzas</b> del portal. Los correos a los clientes solo se envían tras tu aprobación.</p>
        </div>`
      });
      avisoAdmin = true;
    } catch (e) {
      console.error('Aviso al admin falló:', e.message);
    }
  }

  // Resumen al admin en modo AUTO (best-effort): qué se envió solo hoy.
  if (AUTO && (enviados > 0 || sinCorreo > 0) && process.env.RESEND_API_KEY && empresa.admin) {
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const rows = enviadosList.map(c => `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${c.customer_name}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;font-weight:600">${fmt(c.vencido)}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:center">${c.atraso_dias} d (${c.cadencia})</td></tr>`).join('');
      await resend.emails.send({
        from: empresa.from, to: [empresa.admin],
        subject: `Cobranzas ${empresa.nombreCorto} — ${enviados} estado(s) de cuenta enviados automáticamente`,
        html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:680px;margin:0 auto;color:#111">
          <h2 style="margin:0 0 6px">Cobranzas automáticas — ${hasta}</h2>
          <p style="color:#555;margin:0 0 16px">Se enviaron <b>${enviados}</b> estado(s) de cuenta a clientes en mora automáticamente.${sinCorreo ? ` <b>${sinCorreo}</b> no se enviaron por falta de correo.` : ''}</p>
          <table style="border-collapse:collapse;width:100%;font-size:13px"><thead><tr style="background:#0E1016;color:#fff"><th style="padding:8px 10px;text-align:left">Cliente</th><th style="padding:8px 10px;text-align:right">Vencido</th><th style="padding:8px 10px;text-align:center">Atraso</th></tr></thead><tbody>${rows}</tbody></table>
          <p style="color:#999;font-size:12px;margin-top:14px">Envío automático (sin aprobación). Para desactivarlo, quita la variable COBRANZA_AUTO_SEND.</p>
        </div>`
      });
      avisoAdmin = true;
    } catch (e) { console.error('Resumen auto al admin falló:', e.message); }
  }

  return { ok: true, empresa: empresa.id, modo: AUTO ? 'auto' : 'aprobacion', revisados, enviados, sin_correo: sinCorreo, encolados, avisoAdmin, errores };
}

module.exports = { runCobranzasJob };
