// netlify/functions/lib/cliente-reporte-pdf.js
// Reporte de historial de compras de un cliente (qué le hemos vendido) con imágenes.
// Lo usan el endpoint de descarga/correo y la asignación de dormidos (adjunto).
const PDFDocument = require('pdfkit');

const AZUL = '#009FE3', NAR = '#FF6B35';
const TXT = '#14181F', GRIS = '#8A93A0', VAL = '#333A45', CARD = '#F7F9FC', CARDBD = '#E6EAF0';

const fmtUSD = n => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
const fmtFecha = s => { try { return new Date(String(s).slice(0, 10) + 'T00:00:00').toLocaleDateString('es-PA', { day: '2-digit', month: 'short', year: 'numeric' }); } catch (e) { return String(s || '—'); } };

// data = salida de ventas_cliente_detalle ; imgs = { item_code: Buffer|null }
function buildClienteReportePDF(empresa, data, vendedorNombre, imgs, fecha) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'letter', margin: 40, bufferPages: true });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      const left = 40, right = 572, W = 532, bottom = 706;
      const ensure = h => { if (doc.y + h > bottom) doc.addPage(); };
      const T = (s, x, y, o) => doc.text(s == null ? '' : String(s), x, y, Object.assign({ lineBreak: false }, o || {}));

      const docs = data.documentos || [];
      const allP = data.productos || [];
      const TOPN = 16;
      const prods = allP.slice(0, TOPN);
      const total = Number(data.total) || 0;
      const compras = docs.length;
      const ultima = docs[0] && docs[0].doc_date;
      const primera = docs.length ? docs[docs.length - 1].doc_date : null;
      let valorAno = total;
      if (primera && ultima) {
        const dias = Math.max(1, (new Date(ultima) - new Date(primera)) / 86400000);
        valorAno = total / Math.max(1, dias / 365);
      }

      // ── Encabezado ──
      doc.fillColor(TXT).font('Helvetica-Bold').fontSize(16); T(empresa.nombreLegal || empresa.nombreCorto || '', left, 42);
      doc.fillColor(GRIS).font('Helvetica').fontSize(8); T(empresa.subtitulo || '', left, 62, { width: W });
      doc.rect(left, 84, W, 2.5).fill(AZUL); doc.rect(left, 84, 46, 2.5).fill(NAR);
      doc.fillColor(AZUL).font('Helvetica-Bold').fontSize(20); T('Historial de compras', left, 96);
      doc.fillColor(TXT).font('Helvetica-Bold').fontSize(13); T(data.card_name || data.card_code || '', left, 124, { width: W - 10 });
      doc.fillColor(GRIS).font('Helvetica').fontSize(9);
      T(`${data.card_code || ''}${data.pais ? '  ·  ' + data.pais : ''}${vendedorNombre ? '  ·  Vendedor: ' + vendedorNombre : ''}  ·  ${fecha}`, left, 144);

      // ── KPIs ──
      const kx = [left, left + 135, left + 270, left + 405];
      const kpis = [['TOTAL COMPRADO', fmtUSD(total)], ['COMPRAS', String(compras)], ['ÚLTIMA COMPRA', ultima ? fmtFecha(ultima) : '—'], ['VALÍA / AÑO', fmtUSD(valorAno)]];
      let ky = 166;
      kpis.forEach((k, i) => {
        doc.fillColor(CARD); doc.roundedRect(kx[i], ky, 122, 50, 8).fill();
        doc.lineWidth(1).strokeColor(CARDBD); doc.roundedRect(kx[i], ky, 122, 50, 8).stroke();
        doc.rect(kx[i], ky, 122, 2.5).fill(i === 0 ? NAR : AZUL);
        doc.fillColor(GRIS).font('Helvetica-Bold').fontSize(7); T(k[0], kx[i] + 10, ky + 11, { width: 104 });
        doc.fillColor(TXT).font('Helvetica-Bold').fontSize(14); T(k[1], kx[i] + 10, ky + 24, { width: 104 });
      });
      doc.y = ky + 66;

      // ── Productos que compra (con imagen) ──
      ensure(28);
      doc.fillColor(TXT).font('Helvetica-Bold').fontSize(13); T('Lo que le hemos vendido', left, doc.y);
      doc.fillColor(GRIS).font('Helvetica').fontSize(8.5); T(`${allP.length} producto(s) · top ${prods.length} por monto`, left, doc.y + 1, { width: W, align: 'right' });
      doc.y += 22;

      const rowH = 54;
      prods.forEach(p => {
        ensure(rowH + 4);
        const y0 = doc.y;
        doc.fillColor(CARD); doc.roundedRect(left, y0, W, rowH, 8).fill();
        doc.lineWidth(1).strokeColor(CARDBD); doc.roundedRect(left, y0, W, rowH, 8).stroke();
        // imagen
        const buf = imgs && imgs[p.code];
        const ix = left + 7, iy = y0 + 6, isz = rowH - 12;
        doc.save(); doc.roundedRect(ix, iy, isz, isz, 6).clip();
        if (buf) { try { doc.image(buf, ix, iy, { fit: [isz, isz], align: 'center', valign: 'center' }); } catch (e) { doc.rect(ix, iy, isz, isz).fill('#EEF1F5'); } }
        else { doc.rect(ix, iy, isz, isz).fill('#EEF1F5'); doc.fillColor('#B9C0CC').font('Helvetica-Bold').fontSize(7); doc.text('SIN\nFOTO', ix, iy + isz / 2 - 8, { width: isz, align: 'center', lineBreak: true }); }
        doc.restore();
        // textos
        const tx = ix + isz + 12;
        doc.fillColor(TXT).font('Helvetica-Bold').fontSize(10); T(p.descripcion || p.code || '', tx, y0 + 9, { width: W - (tx - left) - 110 });
        doc.fillColor(GRIS).font('Helvetica').fontSize(8); T(`Cód: ${p.code || ''}   ·   ${Number(p.qty) || 0} und   ·   ${p.veces || 0} compra(s)`, tx, y0 + 26, { width: W - (tx - left) - 110 });
        doc.fillColor(AZUL).font('Helvetica-Bold').fontSize(12); T(fmtUSD(p.total), right - 100, y0 + 18, { width: 92, align: 'right' });
        doc.y = y0 + rowH + 4;
      });
      if (allP.length > TOPN) { ensure(20); doc.fillColor(GRIS).font('Helvetica-Oblique').fontSize(9); T(`+ ${allP.length - TOPN} producto(s) más en el histórico (mostrando el top ${TOPN} por monto)`, left, doc.y + 4); doc.y += 18; }
      if (!prods.length) { doc.fillColor(GRIS).font('Helvetica').fontSize(10); T('Sin historial de compras registrado.', left, doc.y + 6); }

      // ── Pie ──
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(i);
        doc.fillColor('#AAB1BC').font('Helvetica').fontSize(8);
        T(`${empresa.nombreCorto || ''} · Historial de cliente · ${fecha}`, left, 736, { width: W, align: 'left' });
        doc.fillColor(NAR).font('Helvetica').fontSize(8);
        T(`Página ${i + 1} de ${range.count}`, left, 736, { width: W, align: 'right' });
      }
      doc.end();
    } catch (e) { reject(e); }
  });
}

// Trae detalle (todo el histórico) + imágenes y arma el PDF. Reutilizable.
async function generarReporteCliente(empresa, sb, cardCode, vendedorNombre) {
  const hasta = new Date().toISOString().slice(0, 10);
  const { data, error } = await sb.rpc('ventas_cliente_detalle', { p_card: cardCode, desde: '2000-01-01', hasta, p_vendedores: null });
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Sin datos del cliente');

  const base = (empresa.supabaseUrl || process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const top = (data.productos || []).slice(0, 16);
  const imgs = {};
  await Promise.all(top.map(async p => {
    if (!p.code) return;
    const url = `${base}/storage/v1/object/public/productos-thumb/${encodeURIComponent(p.code)}.jpg`;
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch(url, { signal: ctrl.signal }); clearTimeout(t);
      if (r.ok) { const ab = await r.arrayBuffer(); if (ab.byteLength > 200) imgs[p.code] = Buffer.from(ab); }
    } catch (e) { /* sin imagen */ }
  }));

  const fecha = new Date().toLocaleDateString('es-PA', { day: '2-digit', month: 'long', year: 'numeric' });
  const pdf = await buildClienteReportePDF(empresa, data, vendedorNombre || data.vendedor || '', imgs, fecha);
  const safe = (data.card_name || cardCode || 'cliente').replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 40);
  return { pdf, filename: `Historial_${safe}.pdf`, nombre: data.card_name || cardCode };
}

module.exports = { buildClienteReportePDF, generarReporteCliente };
