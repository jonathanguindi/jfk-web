// netlify/functions/agenda-diaria.js
// Cada mañana manda a cada vendedor su AGENDA DEL DÍA por correo (le llega al celular).
// Programado en netlify.toml. Lista los clientes con fecha_visita = hoy + cuenta atrasados.
const { getEmpresa } = require('./lib/empresa-config');
const { getSupabase } = require('./lib/supabase');
let Resend; try { Resend = require('resend').Resend; } catch (e) {}

const PEND = ['nuevo', 'asignado', 'contactando', 'contactado'];
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

exports.handler = async () => {
  const empresa = getEmpresa();
  const sb = getSupabase(empresa);
  if (!sb || !Resend || !process.env.RESEND_API_KEY) return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'sin sb/resend' }) };
  const hoy = new Date().toISOString().slice(0, 10);

  // Visitas de hoy + atrasadas (pendientes), solo asignadas.
  const { data: rows } = await sb.from('prospectos')
    .select('empresa,ciudad,pais,estado,contacto,asignado_email,asignado_nombre,fecha_visita')
    .not('asignado_email', 'is', null)
    .lte('fecha_visita', hoy)
    .in('estado', PEND);

  const porVend = {};
  (rows || []).forEach(r => {
    const e = (r.asignado_email || '').trim().toLowerCase(); if (!e) return;
    (porVend[e] = porVend[e] || { nombre: r.asignado_nombre || e, hoy: [], atras: [] });
    if (r.fecha_visita === hoy) porVend[e].hoy.push(r); else porVend[e].atras.push(r);
  });

  const r = new Resend(process.env.RESEND_API_KEY);
  const fechaTxt = new Date().toLocaleDateString('es-PA', { weekday: 'long', day: '2-digit', month: 'long' });
  let enviados = 0;
  for (const email of Object.keys(porVend)) {
    const v = porVend[email];
    if (!v.hoy.length && !v.atras.length) continue;
    const li = c => `<li style="margin-bottom:6px"><b>${esc(c.empresa)}</b> <span style="color:#888">· ${esc(c.ciudad || c.pais || '')}${c.contacto ? ' · ' + esc(c.contacto) : ''}</span></li>`;
    const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#0E1016;max-width:560px">
      <h2 style="margin:0 0 2px">📅 Tu agenda de hoy</h2>
      <p style="color:#888;margin:0 0 14px;font-size:12px;text-transform:capitalize">${fechaTxt}</p>
      ${v.hoy.length ? `<p><b>${v.hoy.length} cliente(s) para visitar/contactar hoy:</b></p><ol>${v.hoy.map(li).join('')}</ol>` : '<p>No tienes visitas agendadas para hoy.</p>'}
      ${v.atras.length ? `<p style="background:#FDECEC;color:#D8413E;padding:10px 12px;border-radius:8px"><b>⚠️ ${v.atras.length} atrasado(s)</b> sin contactar — ponles nueva fecha.</p>` : ''}
      <p>Ábrelos en el portal → <b>Expansión → 📅 Mi Agenda</b>, y marca <b>✓ visité</b> cuando termines.</p>
      <p style="color:#aaa;font-size:11px">${empresa.nombreCorto || ''} · recordatorio automático</p></div>`;
    try {
      await r.emails.send({ from: empresa.from, to: [email], subject: `📅 Agenda de hoy: ${v.hoy.length} cliente(s)`, html });
      enviados++;
    } catch (e) { /* seguir con los demás */ }
  }
  return { statusCode: 200, body: JSON.stringify({ ok: true, vendedores: Object.keys(porVend).length, enviados }) };
};
