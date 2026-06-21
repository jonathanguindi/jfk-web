// netlify/functions/cartera-pdf.js
// PDF de la cartera de clientes asignados a un vendedor (por país, con toda la info).
// POST { email, vendedor_email?, vendedor_nombre?, modo:'download'|'email' }
//  - admin: puede pedir la cartera de cualquier vendedor (vendedor_email).
//  - vendedor: solo la suya (se ignora vendedor_email).
//  - modo 'download' -> { ok, pdf:base64, filename }
//  - modo 'email'    -> manda el PDF al vendedor (BCC admin) y { ok, sent }
const { getEmpresa } = require('./lib/empresa-config');
const { getSupabase } = require('./lib/supabase');
const { buildCarteraPDF } = require('./lib/cartera-pdf');
let Resend; try { Resend = require('resend').Resend; } catch (e) {}

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (c, o) => ({ statusCode: c, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify(o) });
const ORD = { nuevo: 0, asignado: 1, contactando: 2, contactado: 3, cliente: 4, descartado: 5 };

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, { ok: true });
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Método no permitido' });
  let b = {}; try { b = JSON.parse(event.body || '{}'); } catch (_) {}

  const empresa = getEmpresa();
  const sb = getSupabase(empresa);
  if (!sb) return reply(500, { ok: false, error: 'Supabase no configurado' });

  const adminEmail = (process.env.VENTAS_ADMIN_EMAIL || empresa.admin || '').trim().toLowerCase();
  const email = (b.email || '').trim().toLowerCase();
  const esAdmin = !!email && email === adminEmail;
  if (!email) return reply(401, { ok: false, error: 'Sin sesión' });

  // Vendedor objetivo
  const target = (esAdmin && b.vendedor_email) ? String(b.vendedor_email).trim().toLowerCase() : email;
  let targetNombre = b.vendedor_nombre || '';

  try {
    // Países asignados a ese vendedor
    const { data: pv } = await sb.from('prospecto_pais_vendedor').select('pais,vendedor_nombre').eq('vendedor_email', target);
    const paises = (pv || []).map(x => x.pais);
    if (!targetNombre && pv && pv[0]) targetNombre = pv[0].vendedor_nombre || '';

    // Prospectos: asignados a él O en sus países
    let q = sb.from('prospectos').select('*');
    const ors = [`asignado_email.eq.${target.replace(/[^a-z0-9._%+\-@]/g, '')}`];
    if (paises.length) ors.push(`pais.in.(${paises.map(p => '"' + p.replace(/"/g, '') + '"').join(',')})`);
    q = q.or(ors.join(','));
    const { data: rows, error } = await q;
    if (error) return reply(200, { ok: false, error: error.message });

    const lista = rows || [];
    if (!targetNombre) targetNombre = (lista.find(x => x.asignado_nombre) || {}).asignado_nombre || target;
    if (!lista.length) return reply(200, { ok: false, error: 'Ese vendedor no tiene clientes asignados todavía.' });

    // Agrupar por país, ordenado
    const byPais = {};
    lista.forEach(c => { (byPais[c.pais || '—'] = byPais[c.pais || '—'] || []).push(c); });
    const grupos = Object.keys(byPais).sort().map(pais => ({
      pais,
      clientes: byPais[pais].sort((x, y) => (ORD[x.estado] ?? 9) - (ORD[y.estado] ?? 9) || (x.empresa || '').localeCompare(y.empresa || ''))
    }));

    const fecha = new Date().toLocaleDateString('es-PA', { day: '2-digit', month: 'long', year: 'numeric' });
    const pdf = await buildCarteraPDF(empresa, targetNombre, grupos, fecha, lista.length);
    const safeName = (targetNombre || 'vendedor').replace(/[^a-zA-Z0-9]+/g, '_');
    const filename = `Cartera_${safeName}.pdf`;

    if (b.modo === 'email') {
      if (!Resend || !process.env.RESEND_API_KEY) return reply(200, { ok: false, error: 'Correo no configurado (RESEND_API_KEY)' });
      if (!target || target.indexOf('@') < 0) return reply(200, { ok: false, error: 'El vendedor no tiene correo válido' });
      const r = new Resend(process.env.RESEND_API_KEY);
      const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#0E1016">
        <p>Hola ${targetNombre || ''},</p>
        <p>Adjunto tu <b>cartera de clientes asignados</b> (${lista.length} en ${grupos.length} país/es) para que les des seguimiento.</p>
        <p>Cada cliente trae su info de contacto y estado. Trabájalos y márcalos en el portal → <b>Expansión</b>. ¡Éxitos!</p>
        <p style="color:#888;font-size:12px">${empresa.nombreCorto || ''}</p></div>`;
      const adminBcc = (process.env.VENTAS_ADMIN_EMAIL || empresa.admin || '').trim();
      const { error: e2 } = await r.emails.send({
        from: empresa.from, to: [target], bcc: adminBcc ? [adminBcc] : undefined,
        subject: `Tu cartera de clientes — ${empresa.nombreCorto || ''}`,
        html, attachments: [{ filename, content: pdf }]
      });
      if (e2) return reply(200, { ok: false, error: (e2.message || JSON.stringify(e2)) });
      return reply(200, { ok: true, sent: true, to: target, clientes: lista.length });
    }

    return reply(200, { ok: true, pdf: pdf.toString('base64'), filename, clientes: lista.length });
  } catch (e) {
    return reply(500, { ok: false, error: e.message });
  }
};
