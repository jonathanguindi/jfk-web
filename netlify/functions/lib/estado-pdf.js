// netlify/functions/lib/estado-pdf.js
// Genera el PDF formal del estado de cuenta con pdfkit y lo devuelve como Buffer.
// Mantiene el mismo look de la versión web (encabezado, tabla de movimientos, aging)
// y agrega las instrucciones bancarias al final.

const PDFDocument = require('pdfkit');

const fmt = (n) => '$' + (parseFloat(n || 0)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// data    = objeto devuelto por computeEstadoCuenta()
// empresa = objeto de getEmpresa()
function buildEstadoCuentaPDF(data, empresa) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'letter', margin: 40 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const accent = empresa.accent || [255, 107, 53];
      const A = `rgb(${accent[0]},${accent[1]},${accent[2]})`;
      const left = doc.page.margins.left;                 // 40
      const right = doc.page.width - doc.page.margins.right; // 572
      const contentW = right - left;                      // 532

      // ===== Encabezado =====
      doc.fillColor('#000').font('Helvetica-Bold').fontSize(16).text(empresa.nombreLegal, left, 40);
      doc.font('Helvetica').fontSize(8).fillColor('#777').text(empresa.subtitulo, left, 60, { width: contentW - 130 });
      doc.font('Helvetica-Bold').fontSize(15).fillColor(A).text('ESTADO DE CUENTA', left, 42, { width: contentW, align: 'right' });
      doc.fillColor('#000');

      // ===== Datos del cliente =====
      const c = data.cliente;
      let y = 92;
      doc.font('Helvetica-Bold').fontSize(11).text(c.nombre || '', left, y);
      doc.font('Helvetica').fontSize(9).fillColor('#333');
      y += 16;
      doc.text(`Código: ${c.codigo || '—'}    País: ${c.pais || '—'}    Tel: ${c.telefono || c.celular || '—'}`, left, y);
      y += 13;
      doc.text(`Email: ${c.email || '—'}`, left, y);
      y += 13;
      doc.text(`Período: ${data.rango.desde}  al  ${data.rango.hasta}`, left, y);
      // Saldo a la fecha (derecha, acento)
      doc.font('Helvetica-Bold').fontSize(11).fillColor(A)
        .text(`Saldo a la fecha: ${fmt(c.saldoActual)}`, left, 108, { width: contentW, align: 'right' });
      doc.fillColor('#000');

      // ===== Tabla de movimientos =====
      // Columnas: [x, ancho, alineación]
      const cols = [
        { key: 'fecha',  title: 'Fecha',     w: 58,  align: 'left'  },
        { key: 'doc',    title: 'Documento', w: 66,  align: 'left'  },
        { key: 'det',    title: 'Detalle',   w: 168, align: 'left'  },
        { key: 'deb',    title: 'Débito',    w: 76,  align: 'right' },
        { key: 'cre',    title: 'Crédito',   w: 76,  align: 'right' },
        { key: 'sal',    title: 'Saldo',     w: 88,  align: 'right' }
      ];
      // x absoluto de cada columna
      let cx = left;
      cols.forEach(col => { col.x = cx; cx += col.w; });

      const rowH = 16;
      const headFill = '#0E1016';
      const bottomLimit = doc.page.height - 70;

      const drawHeadRow = (yy) => {
        doc.rect(left, yy, contentW, rowH).fill(headFill);
        doc.fillColor('#fff').font('Helvetica-Bold').fontSize(8);
        cols.forEach(col => {
          doc.text(col.title, col.x + 4, yy + 5, { width: col.w - 8, align: col.align, lineBreak: false });
        });
        doc.fillColor('#000');
        return yy + rowH;
      };

      y = 150;
      y = drawHeadRow(y);

      doc.font('Helvetica').fontSize(8);
      let zebra = false;
      const drawCell = (col, text, yy, opts = {}) => {
        doc.text(text == null ? '' : String(text), col.x + 4, yy + 5, { width: col.w - 8, align: col.align, lineBreak: false, ...opts });
      };

      data.movimientos.forEach(m => {
        if (y + rowH > bottomLimit) {
          doc.addPage();
          y = 40;
          y = drawHeadRow(y);
          doc.font('Helvetica').fontSize(8);
          zebra = false;
        }
        if (zebra) { doc.rect(left, y, contentW, rowH).fill('#F4F4F6'); doc.fillColor('#000'); }
        zebra = !zebra;
        const det = (m.comentario || '').slice(0, 34);
        const docLabel = (m.tipo ? m.tipo + ' ' : '') + (m.doc || '');
        drawCell(cols[0], m.fecha, y);
        drawCell(cols[1], docLabel.trim(), y);
        drawCell(cols[2], det, y);
        drawCell(cols[3], m.debito > 0 ? fmt(m.debito) : '', y);
        drawCell(cols[4], m.credito > 0 ? fmt(m.credito) : '', y);
        doc.font('Helvetica-Bold');
        drawCell(cols[5], fmt(m.saldo), y);
        doc.font('Helvetica');
        y += rowH;
      });

      // Fila TOTALES
      if (y + rowH > bottomLimit) { doc.addPage(); y = 40; y = drawHeadRow(y); }
      doc.rect(left, y, contentW, rowH).fill('#E6E6EA'); doc.fillColor('#000').font('Helvetica-Bold').fontSize(8);
      drawCell(cols[2], 'TOTALES', y);
      drawCell(cols[3], fmt(data.totalDebito), y);
      drawCell(cols[4], fmt(data.totalCredito), y);
      drawCell(cols[5], fmt(data.saldoFinal), y);
      doc.font('Helvetica');
      y += rowH + 18;

      // ===== Antigüedad del saldo (aging) =====
      const aging = data.aging || {};
      const agingKeys = [
        ['0-30', '0-30'], ['31-60', '31-60'], ['61-90', '61-90'], ['91-120', '91-120'],
        ['121-150', '121-150'], ['151-180', '151-180'], ['181-210', '181-210'], ['211-240', '211-240'], ['mas240', '+240']
      ];
      const hayAging = agingKeys.some(([k]) => (aging[k] || 0) > 0);
      if (hayAging) {
        if (y + 50 > bottomLimit) { doc.addPage(); y = 40; }
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#000').text('Antigüedad del saldo pendiente', left, y);
        y += 14;
        const agW = contentW / agingKeys.length;
        // fila de etiquetas
        doc.rect(left, y, contentW, 15).fill(headFill);
        doc.fillColor('#fff').font('Helvetica-Bold').fontSize(7);
        agingKeys.forEach(([k, label], i) => doc.text(label, left + i * agW, y + 4, { width: agW, align: 'center', lineBreak: false }));
        y += 15;
        // fila de montos
        doc.rect(left, y, contentW, 15).fill('#F4F4F6');
        doc.fillColor('#000').font('Helvetica').fontSize(7);
        agingKeys.forEach(([k], i) => doc.text(fmt(aging[k] || 0), left + i * agW, y + 4, { width: agW, align: 'center', lineBreak: false }));
        // bordes verticales suaves
        y += 15 + 18;
      }

      // ===== Instrucciones bancarias =====
      const banco = empresa.banco || [];
      if (banco.length) {
        const boxH = 26 + banco.length * 14;
        if (y + boxH > bottomLimit) { doc.addPage(); y = 40; }
        doc.save();
        doc.roundedRect(left, y, contentW, boxH, 4).fillAndStroke('#FAFAFB', '#DADAE0');
        doc.restore();
        doc.fillColor(A).font('Helvetica-Bold').fontSize(10).text('Instrucciones de pago', left + 12, y + 9);
        doc.fillColor('#000').font('Helvetica').fontSize(9);
        let by = y + 26;
        banco.forEach(row => {
          doc.font('Helvetica-Bold').text(`${row.label}:`, left + 12, by, { width: 110, lineBreak: false });
          doc.font('Helvetica').text(row.value || '', left + 122, by, { width: contentW - 134, lineBreak: false });
          by += 14;
        });
        y += boxH + 10;
      }

      // ===== Pie =====
      doc.font('Helvetica').fontSize(7).fillColor('#999')
        .text(`${empresa.nombreCorto}  ·  Documento generado automáticamente`, left, doc.page.height - 48, { width: contentW, align: 'center' });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { buildEstadoCuentaPDF, fmt };
