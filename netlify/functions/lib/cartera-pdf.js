// netlify/functions/lib/cartera-pdf.js
// PDF elegante de la cartera de clientes asignados a un vendedor, por país.
// Paleta de marca: azul #009FE3 primario, naranja #FF6B35 en los detalles.
const PDFDocument = require('pdfkit');

const AZUL = '#009FE3', NAR = '#FF6B35';
const TXT = '#14181F', GRIS = '#8A93A0', VAL = '#333A45', CARD = '#F7F9FC', CARDBD = '#E6EAF0';
const ESTLBL = { nuevo: 'NUEVO', asignado: 'ASIGNADO', contactando: 'CONTACTANDO', contactado: 'CONTACTADO', cliente: 'CLIENTE', descartado: 'DESCARTADO' };

// Ajuste de líneas manual (sin auto-envoltura de pdfkit -> nunca crea páginas en blanco).
function wrapLines(s, max, maxLines) {
  const words = String(s == null ? '' : s).split(/\s+/).filter(Boolean);
  const lines = []; let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length <= max) cur = (cur + ' ' + w).trim();
    else { if (cur) lines.push(cur); cur = w.length > max ? w.slice(0, max - 1) + '…' : w; }
  }
  if (cur) lines.push(cur);
  if (!lines.length) lines.push('');
  if (maxLines && lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = lines[maxLines - 1].slice(0, max - 1) + '…'; }
  return lines;
}

function buildCarteraPDF(empresa, vendedorNombre, grupos, fecha, totalClientes) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'letter', margin: 40, bufferPages: true });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      const left = 40, right = 572, W = 532, bottom = 742;
      const ensure = h => { if (doc.y + h > bottom) doc.addPage(); };
      const T = (s, x, y, o) => doc.text(s == null ? '' : String(s), x, y, Object.assign({ lineBreak: false }, o || {}));

      // ── Encabezado ──
      doc.fillColor(TXT).font('Helvetica-Bold').fontSize(16); T(empresa.nombreLegal || empresa.nombreCorto || '', left, 42);
      doc.fillColor(GRIS).font('Helvetica').fontSize(8); T(empresa.subtitulo || '', left, 62, { width: W });
      doc.rect(left, 84, W, 2.5).fill(AZUL);          // regla azul
      doc.rect(left, 84, 46, 2.5).fill(NAR);          // detalle naranja
      doc.fillColor(AZUL).font('Helvetica-Bold').fontSize(20); T('Cartera de clientes', left, 96);
      doc.fillColor(TXT).font('Helvetica-Bold').fontSize(12); T(vendedorNombre || '', left, 124);
      doc.fillColor(GRIS).font('Helvetica').fontSize(9); T(`${totalClientes} cliente(s) asignado(s)   ·   Generado ${fecha}`, left, 141);
      doc.y = 164;

      grupos.forEach(g => {
        ensure(42);
        const yb = doc.y;
        doc.roundedRect(left, yb, W, 24, 5).fill(AZUL);
        doc.fillColor('#fff').font('Helvetica-Bold').fontSize(12.5); T(g.pais, left + 12, yb + 6);
        doc.fillColor('#fff').font('Helvetica').fontSize(9.5); T(`${g.clientes.length} cliente(s)`, left, yb + 7, { width: W - 12, align: 'right' });
        doc.y = yb + 32;

        g.clientes.forEach(c => {
          const rows = [];
          if (c.ciudad || c.direccion) rows.push(['Ubicación', [c.ciudad, c.direccion].filter(Boolean).join(' · ')]);
          if (c.contacto) rows.push(['Contacto', c.contacto]);
          if (c.email) rows.push(['Correo', c.email]);
          if (c.web) rows.push(['Web', c.web]);
          if (c.que_vende) rows.push(['Rubro', c.que_vende]);
          if (c.tipo) rows.push(['Tipo', c.tipo]);
          if (c.notas) rows.push(['Notas', c.notas]);

          // pre-calcular líneas envueltas (máx 3 por campo)
          const wrapped = rows.map(([k, v]) => [k, wrapLines(v, 80, 3)]);
          let bodyH = 0;
          wrapped.forEach(([, lines]) => { bodyH += lines.length * 12; });
          const h = 28 + bodyH + 8;
          ensure(h);
          const y0 = doc.y;
          doc.fillColor(CARD); doc.roundedRect(left, y0, W, h - 6, 8).fill();
          doc.lineWidth(1).strokeColor(CARDBD); doc.roundedRect(left, y0, W, h - 6, 8).stroke();

          doc.fillColor(TXT).font('Helvetica-Bold').fontSize(11.5); T(c.empresa || '(sin nombre)', left + 12, y0 + 9, { width: W - 130 });
          const est = ESTLBL[c.estado] || (c.estado || '').toUpperCase();
          if (est) { doc.fillColor(NAR).font('Helvetica-Bold').fontSize(8); T(est, right - 122, y0 + 10, { width: 110, align: 'right' }); }

          let yy = y0 + 27;
          wrapped.forEach(([k, lines]) => {
            doc.fillColor(GRIS).font('Helvetica-Bold').fontSize(8.5); T(k, left + 12, yy, { width: 62 });
            doc.fillColor(VAL).font('Helvetica').fontSize(9.5);
            lines.forEach((ln, idx) => { T(ln, left + 78, yy + idx * 12, { width: W - 92 }); });
            yy += lines.length * 12;
          });
          doc.y = y0 + h;
        });
        doc.y += 10;
      });

      // ── Pie (lineBreak:false evita páginas en blanco) ──
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(i);
        doc.fillColor('#AAB1BC').font('Helvetica').fontSize(8);
        T(`${empresa.nombreCorto || ''} · Cartera de clientes · ${fecha}`, left, 760, { width: W, align: 'left' });
        doc.fillColor(NAR).font('Helvetica').fontSize(8);
        T(`Página ${i + 1} de ${range.count}`, left, 760, { width: W, align: 'right' });
      }
      doc.end();
    } catch (e) { reject(e); }
  });
}

module.exports = { buildCarteraPDF };
