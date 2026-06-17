// netlify/functions/lib/facturas-pdf.js
// Genera UN PDF con todas las facturas del período: por cada factura, su detalle
// de líneas (producto, cantidad, precio, total) con la FOTO de cada producto
// (de Supabase storage: productos-thumb/{code}.jpg, fallback productos/{code}.jpg).

const PDFDocument = require('pdfkit');
const { T } = require('./idioma');

const fmt = (n) => '$' + (parseFloat(n || 0)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Descarga la imagen de un producto (thumbnail, con fallback a la grande). Cachea por code.
async function fetchImg(empresa, code, cache) {
  if (cache.has(code)) return cache.get(code);
  const base = `${empresa.supabaseUrl}/storage/v1/object/public`;
  const urls = [
    `${base}/productos-thumb/${encodeURIComponent(code)}.jpg`,
    `${base}/productos/${encodeURIComponent(code)}.jpg`
  ];
  let buf = null;
  for (const u of urls) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 4000);
      const r = await fetch(u, { signal: ac.signal });
      clearTimeout(t);
      if (r.ok) { buf = Buffer.from(await r.arrayBuffer()); break; }
    } catch (_) { /* sin imagen */ }
  }
  cache.set(code, buf);
  return buf;
}

// Descarga con concurrencia limitada
async function prefetchImgs(empresa, codes, conc = 8) {
  const cache = new Map();
  let i = 0;
  const worker = async () => { while (i < codes.length) { const c = codes[i++]; await fetchImg(empresa, c, cache); } };
  await Promise.all(Array.from({ length: Math.min(conc, codes.length) }, worker));
  return cache;
}

const LBL = {
  es: { titulo: 'FACTURAS', factura: 'Factura', num: 'N° ', fecha: 'Fecha', producto: 'Producto', total: 'Total', cant: 'Cant', precio: 'Precio', subtotal: 'Total', sinFotos: 'sin foto', generado: 'Documento generado automáticamente' },
  en: { titulo: 'INVOICES', factura: 'Invoice', num: '#', fecha: 'Date', producto: 'Product', total: 'Total', cant: 'Qty', precio: 'Price', subtotal: 'Total', sinFotos: 'no photo', generado: 'Automatically generated document' }
};

// facturas = salida de fetchFacturasConLineas()
async function buildFacturasPDF(facturas, empresa, lang = 'es') {
  const L = LBL[lang] || LBL.es;
  const codes = [...new Set(facturas.flatMap(f => (f.lineas || []).map(l => l.code)).filter(Boolean))];
  const imgs = await prefetchImgs(empresa, codes);

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'letter', margin: 40 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const accent = empresa.accent || [255, 107, 53];
      const A = `rgb(${accent[0]},${accent[1]},${accent[2]})`;
      const left = doc.page.margins.left;
      const right = doc.page.width - doc.page.margins.right;
      const contentW = right - left;
      const bottom = doc.page.height - 60;

      // Encabezado
      doc.fillColor('#000').font('Helvetica-Bold').fontSize(16).text(empresa.nombreLegal, left, 40);
      doc.font('Helvetica').fontSize(8).fillColor('#777').text(empresa.subtitulo, left, 60, { width: contentW - 130 });
      doc.font('Helvetica-Bold').fontSize(15).fillColor(A).text(L.titulo, left, 42, { width: contentW, align: 'right' });
      doc.fillColor('#000');

      // Columnas de líneas
      const xImg = left, wImg = 34;
      const xDesc = left + 40, wDesc = 250;
      const xQty = left + 296, wQty = 44;
      const xPre = left + 344, wPre = 80;
      const xTot = left + 428, wTot = contentW - 428;

      let y = 92;

      const ensure = (h) => { if (y + h > bottom) { doc.addPage(); y = 40; } };

      facturas.forEach(f => {
        ensure(48);
        // Cabecera de la factura
        doc.rect(left, y, contentW, 22).fill('#0E1016');
        doc.fillColor('#fff').font('Helvetica-Bold').fontSize(10)
          .text(`${L.factura} ${L.num}${f.docNum}`, left + 8, y + 6, { lineBreak: false });
        doc.font('Helvetica').fontSize(9)
          .text(`${L.fecha}: ${f.fecha}`, left + 160, y + 6.5, { lineBreak: false });
        doc.font('Helvetica-Bold').fontSize(10)
          .text(`${fmt(f.total)}`, left, y + 6, { width: contentW - 8, align: 'right' });
        doc.fillColor('#000');
        y += 26;

        // Encabezado de columnas
        doc.font('Helvetica-Bold').fontSize(7).fillColor('#888');
        doc.text('', xImg, y, { width: wImg });
        doc.text(L.producto, xDesc, y, { width: wDesc, lineBreak: false });
        doc.text(L.cant, xQty, y, { width: wQty, align: 'right', lineBreak: false });
        doc.text(L.precio, xPre, y, { width: wPre, align: 'right', lineBreak: false });
        doc.text(L.subtotal, xTot, y, { width: wTot, align: 'right', lineBreak: false });
        doc.fillColor('#000');
        y += 12;
        doc.moveTo(left, y).lineTo(right, y).strokeColor('#E5E7EA').lineWidth(0.5).stroke();
        y += 4;

        (f.lineas || []).forEach(l => {
          const rowH = 30;
          ensure(rowH);
          const img = imgs.get(l.code);
          if (img) {
            try { doc.image(img, xImg, y, { fit: [wImg, 26] }); } catch (_) { }
          } else {
            doc.rect(xImg, y, 26, 26).fillAndStroke('#F4F5F7', '#E5E7EA'); doc.fillColor('#000');
          }
          doc.font('Helvetica').fontSize(8).fillColor('#111')
            .text((l.desc || '').slice(0, 46), xDesc, y + 2, { width: wDesc, lineBreak: false });
          doc.font('Helvetica').fontSize(7).fillColor('#999')
            .text(l.code || '', xDesc, y + 14, { width: wDesc, lineBreak: false });
          doc.fontSize(8).fillColor('#111');
          doc.text(String(l.qty != null ? l.qty : ''), xQty, y + 6, { width: wQty, align: 'right', lineBreak: false });
          doc.text(fmt(l.precio), xPre, y + 6, { width: wPre, align: 'right', lineBreak: false });
          doc.font('Helvetica-Bold').text(fmt(l.total), xTot, y + 6, { width: wTot, align: 'right', lineBreak: false });
          doc.font('Helvetica');
          y += rowH;
        });
        y += 12;
      });

      doc.font('Helvetica').fontSize(7).fillColor('#999')
        .text(`${empresa.nombreCorto}  ·  ${L.generado}`, left, doc.page.height - 48, { width: contentW, align: 'center' });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { buildFacturasPDF };
