// netlify/functions/lib/cartera-pdf.js
// Genera un PDF elegante de la cartera de clientes asignados a un vendedor,
// agrupada por país, con toda la info de cada cliente. Lo usan descarga y correo.
const PDFDocument = require('pdfkit');

const hx = rgb => '#' + (rgb || [40, 40, 40]).map(n => Number(n).toString(16).padStart(2, '0')).join('');
const ESTLBL = { nuevo: 'NUEVO', asignado: 'ASIGNADO', contactando: 'CONTACTANDO', contactado: 'CONTACTADO', cliente: 'CLIENTE', descartado: 'DESCARTADO' };

function buildCarteraPDF(empresa, vendedorNombre, grupos, fecha, totalClientes) {
  return new Promise((resolve, reject) => {
    try {
      const A = hx(empresa.accent);
      const doc = new PDFDocument({ size: 'letter', margin: 40, bufferPages: true });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));

      const left = 40, right = 572, W = 532, bottom = 748;
      const ensure = h => { if (doc.y + h > bottom) doc.addPage(); };

      // ── Encabezado ──
      doc.fillColor('#111').font('Helvetica-Bold').fontSize(17).text(empresa.nombreLegal || empresa.nombreCorto || '', left, 42);
      doc.font('Helvetica').fontSize(8).fillColor('#888').text(empresa.subtitulo || '', left, 64, { width: W });
      doc.moveTo(left, 86).lineTo(right, 86).lineWidth(2.5).strokeColor(A).stroke();
      doc.fillColor(A).font('Helvetica-Bold').fontSize(21).text('Cartera de clientes', left, 98);
      doc.fillColor('#222').font('Helvetica-Bold').fontSize(12).text(vendedorNombre || '', left, 126);
      doc.fillColor('#888').font('Helvetica').fontSize(9).text(`${totalClientes} cliente(s) asignado(s)   ·   Generado ${fecha}`, left, 143);
      doc.y = 166;

      // ── Grupos por país ──
      grupos.forEach(g => {
        ensure(46);
        let yb = doc.y;
        doc.rect(left, yb, W, 24).fill(A);
        doc.fillColor('#fff').font('Helvetica-Bold').fontSize(12.5)
          .text(`${g.pais}`, left + 12, yb + 6);
        doc.font('Helvetica').fontSize(10).fillColor('#fff')
          .text(`${g.clientes.length} cliente(s)`, left, yb + 7, { width: W - 12, align: 'right' });
        doc.y = yb + 34;
        doc.fillColor('#000');

        g.clientes.forEach(c => {
          const rows = [];
          if (c.ciudad || c.direccion) rows.push(['Ubicación', [c.ciudad, c.direccion].filter(Boolean).join(' · ')]);
          if (c.contacto) rows.push(['Contacto', c.contacto]);
          if (c.email) rows.push(['Correo', c.email]);
          if (c.web) rows.push(['Web', c.web]);
          if (c.que_vende) rows.push(['Rubro', c.que_vende]);
          if (c.tipo) rows.push(['Tipo', c.tipo]);
          if (c.notas) rows.push(['Notas', c.notas]);

          // alto estimado (con wrap aproximado de notas largas)
          let bodyH = 0;
          rows.forEach(([, v]) => { bodyH += Math.max(12, Math.ceil(String(v).length / 78) * 12); });
          const h = 26 + bodyH + 10;
          ensure(h);
          const y0 = doc.y;
          doc.roundedRect(left, y0, W, h - 6, 6).fillAndStroke('#fafafa', '#e6e6e6');

          doc.fillColor('#111').font('Helvetica-Bold').fontSize(11.5).text(c.empresa || '(sin nombre)', left + 12, y0 + 8, { width: W - 130 });
          const est = ESTLBL[c.estado] || (c.estado || '').toUpperCase();
          if (est) doc.font('Helvetica-Bold').fontSize(8).fillColor(A).text(est, right - 122, y0 + 9, { width: 110, align: 'right' });

          let yy = y0 + 26;
          rows.forEach(([k, v]) => {
            doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#999').text(k, left + 12, yy, { width: 62 });
            doc.font('Helvetica').fontSize(9.5).fillColor('#333').text(String(v), left + 78, yy, { width: W - 90 });
            yy += Math.max(12, Math.ceil(String(v).length / 78) * 12);
          });
          doc.y = y0 + h;
        });
        doc.y += 8;
      });

      // ── Pie con numeración ──
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(i);
        doc.font('Helvetica').fontSize(8).fillColor('#aaa')
          .text(`${empresa.nombreCorto || ''} · Cartera de clientes · ${fecha}`, left, 766, { width: W, align: 'left' });
        doc.font('Helvetica').fontSize(8).fillColor('#aaa')
          .text(`Página ${i + 1} de ${range.count}`, left, 766, { width: W, align: 'right' });
      }
      doc.end();
    } catch (e) { reject(e); }
  });
}

module.exports = { buildCarteraPDF };
