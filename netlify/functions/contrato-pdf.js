// contrato-pdf.js · Genera el CONTRATO DE TRABAJO en PDF con los datos del empleado. SOLO ADMIN.
// Fiel a la plantilla de JFK (jornada L-V 8:30-5:30, pago 15 y 30, prueba 2 meses, término 6 meses).
const { getEmpresa } = require('./lib/empresa-config');
const { getSupabase } = require('./lib/supabase');
const PDFDocument = require('pdfkit');

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (c, o) => ({ statusCode: c, headers: { 'Content-Type': 'application/json', ...cors }, body: JSON.stringify(o) });

// Datos del EMPLEADOR por empresa (registro público y domicilio).
const EMPLEADOR = {
  JFK: { nombre: 'JFK INTERNATIONAL, S.A.', registro: 'inscrita en la ficha 410636, folio 304748, imagen 1, del Registro Público', domicilio: 'CALLE 15, AVE. SANTA ISABEL, ZONA LIBRE DE COLÓN' },
  BDB: { nombre: 'BIG DREAM BRANDS, S.A.', registro: 'inscrita en el Registro Público de Panamá', domicilio: 'CALLE 15 AVE. SANTA ISABEL, ZONA LIBRE DE COLÓN' }
};

// Número a letras en español (para el salario).
function numeroALetras(n) {
  n = Math.floor(Number(n) || 0);
  if (n === 0) return 'CERO';
  const U = ['', 'UNO', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE', 'DIEZ', 'ONCE', 'DOCE', 'TRECE', 'CATORCE', 'QUINCE', 'DIECISÉIS', 'DIECISIETE', 'DIECIOCHO', 'DIECINUEVE', 'VEINTE'];
  const D = ['', '', 'VEINTI', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA'];
  const C = ['', 'CIENTO', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS', 'SEISCIENTOS', 'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS'];
  function hasta999(x) {
    let r = '';
    const c = Math.floor(x / 100), d = Math.floor((x % 100) / 10), u = x % 10;
    if (x === 100) return 'CIEN';
    if (c) r += C[c] + ' ';
    const dd = x % 100;
    if (dd <= 20) r += U[dd];
    else if (dd < 30) r += 'VEINTI' + U[u];
    else { r += D[d]; if (u) r += ' Y ' + U[u]; }
    return r.trim();
  }
  let out = '';
  const millones = Math.floor(n / 1000000);
  const miles = Math.floor((n % 1000000) / 1000);
  const resto = n % 1000;
  if (millones) out += (millones === 1 ? 'UN MILLÓN ' : hasta999(millones) + ' MILLONES ');
  if (miles) out += (miles === 1 ? 'MIL ' : hasta999(miles) + ' MIL ');
  if (resto) out += hasta999(resto);
  return out.trim().replace(/\s+/g, ' ');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return reply(200, { ok: true });
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });
  try {
    const body = JSON.parse(event.body || '{}');
    const empresa = getEmpresa();
    const sb = getSupabase(empresa);
    if (!sb) return reply(500, { ok: false, error: 'Supabase no configurado' });
    const adminEmail = (process.env.VENTAS_ADMIN_EMAIL || empresa.admin || '').trim().toLowerCase();
    if ((body.email || '').trim().toLowerCase() !== adminEmail) return reply(403, { ok: false, error: 'Solo el administrador' });

    const { data: e, error } = await sb.from('empleados').select('*').eq('id', Number(body.id)).maybeSingle();
    if (error || !e) return reply(200, { ok: false, error: 'Empleado no encontrado' });

    const emp = EMPLEADOR[empresa.id] || EMPLEADOR.JFK;
    const salario = Number(e.salario) || 0;
    const ent = Math.floor(salario);
    const cent = Math.round((salario - ent) * 100);
    const salTxt = `B/. ${salario.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const salLetras = `${numeroALetras(ent)} BALBOAS CON ${String(cent).padStart(2, '0')}/100`;
    const blank = (v, n = 30) => v ? String(v) : '_'.repeat(n);
    const fFecha = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString('es-PA', { day: '2-digit', month: 'long', year: 'numeric' }) : '_'.repeat(22);

    const pdf = await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'letter', margins: { top: 56, bottom: 56, left: 64, right: 64 } });
      const chunks = []; doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
      const W = doc.page.width - 128;
      const P = (txt, opts) => doc.font('Helvetica').fontSize(10.5).fillColor('#000').text(txt, { align: 'justify', lineGap: 2, ...(opts || {}) });
      // Cláusula con etiqueta en negrita + texto normal en la misma línea.
      const CL = (label, txt) => {
        doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#000').text(label + ' ', { continued: true, align: 'justify', lineGap: 2 });
        doc.font('Helvetica').text(txt, { align: 'justify', lineGap: 2 });
        doc.moveDown(0.5);
      };

      doc.font('Helvetica-Bold').fontSize(15).text('CONTRATO DE TRABAJO', { align: 'center' });
      doc.moveDown(0.8);
      P('Entre los suscritos se ha convenido celebrar el presente CONTRATO DE TRABAJO, quienes para los efectos del mismo se llamarán el EMPLEADOR y el TRABAJADOR.');
      doc.moveDown(0.5);
      doc.font('Helvetica-Bold').fontSize(11).text('EL EMPLEADOR'); doc.moveDown(0.2);
      P(`Nombre ${emp.nombre}, ${emp.registro}, con domicilio en ${emp.domicilio}, representada para este acto por ${blank(e.representante, 28)}, quien es su Gerente General.`);
      doc.moveDown(0.4);
      doc.font('Helvetica-Bold').fontSize(11).text('EL TRABAJADOR'); doc.moveDown(0.2);
      P(`Nombre ${blank(e.nombre, 30)}, de nacionalidad ${e.nacionalidad || 'PANAMEÑA'}, con cédula de identidad personal No. ${blank(e.cedula, 18)}, con domicilio ${blank(e.domicilio, 34)}.`);
      P(`Fecha de nacimiento: ${e.fecha_nacimiento ? fFecha(e.fecha_nacimiento) : '_'.repeat(22)}.`);
      doc.moveDown(0.4);
      P('El presente contrato se regirá conforme a las siguientes cláusulas:'); doc.moveDown(0.5);

      const deps = (e.dependientes || '').split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
      CL('PRIMERO.', `Declara el TRABAJADOR que viven y dependen de él/ella las siguientes personas: ${deps.length ? deps.join(', ') : 'N/A'}.`);
      CL('SEGUNDO.', `La posición que ocupará EL TRABAJADOR en la empresa es de ${blank(e.cargo, 26)}.`);
      CL('TERCERO.', `Las funciones asignadas al TRABAJADOR: ${blank(e.funciones, 40)}.`);
      CL('CUARTO.', `Las funciones asignadas al TRABAJADOR se efectuarán en ${emp.nombre}; sin embargo, el TRABAJADOR podrá ser trasladado a otro lugar de trabajo bajo la dependencia y subordinación continua del EMPLEADOR, siempre y cuando ello no suponga desmejoramiento económico para el TRABAJADOR.`);
      CL('QUINTA.', `El término de este contrato es de seis (6) MESES. Y su causa es para realizar el puesto de ${blank(e.cargo, 24)}.`);
      CL('SEXTA.', 'La jornada ordinaria de trabajo convenida es de 8 horas diarias y 40 semanales, dividida de la siguiente manera: LUNES A VIERNES DESDE LAS 8:30 a.m. HASTA LAS 12:00 m.d. y de 1:00 p.m. A 5:30 p.m. Durante el periodo de descanso el TRABAJADOR no estará obligado a permanecer en el lugar donde trabaja, ni estará a disposición del EMPLEADOR. Las horas extraordinarias que labore el TRABAJADOR deberán ser previamente autorizadas por escrito por el EMPLEADOR o quien lo represente.');
      CL('SÉPTIMA.', 'Las partes contratantes, para los efectos de este contrato, quedan sujetas a los derechos y deberes consignados en el CÓDIGO DE TRABAJO y el REGLAMENTO INTERNO DE LA EMPRESA y de las demás regulaciones establecidas por el MINISTERIO DE TRABAJO.');
      CL('OCTAVA.', `El EMPLEADOR pagará al TRABAJADOR durante la vigencia de este contrato, en concepto de salario, la suma de ${salTxt} (${salLetras}) mensuales, la que se pagará en la forma y fecha que se señala a continuación: 15 Y 30 DE CADA MES. Al hacer el pago, el EMPLEADOR hará las deducciones que ordena la ley y deducirá también los anticipos que se hayan hecho al TRABAJADOR; los pagos se harán con cheque, ACH o dinero en efectivo, en la oficina del empleador antes señalada.`);
      CL('NOVENA.', 'El TRABAJADOR se obliga a acatar las instrucciones del EMPLEADOR, o de quien lo represente, y ejecutará sus labores con la intensidad, cuidado y eficiencia que sean compatibles con sus fuerzas, aptitudes, preparación y destreza.');
      CL('DÉCIMA.', 'Por exigirse cierta habilidad especial para la ejecución del servicio se fija un período probatorio de 2 meses. Durante dicho periodo las partes podrán dar por terminada la relación de trabajo sin responsabilidad alguna.');
      CL('UNDÉCIMA.', `Las partes convienen en que la fecha de inicio de la relación de trabajo es ${e.fecha_ingreso ? fFecha(e.fecha_ingreso) : '_'.repeat(22)}.`);
      doc.moveDown(0.4);
      P('LEÍDO EL PRESENTE CONTRATO INDIVIDUAL DE TRABAJO, EN DOS EJEMPLARES QUE SE ENTREGARÁN UNO AL TRABAJADOR Y EL OTRO AL EMPLEADOR, ambos los cuales se encuentran conformes, por lo cual los suscriben en la ciudad de Panamá a los ' + (e.fecha_firma ? fFecha(e.fecha_firma) : '_'.repeat(26)) + '.');
      doc.moveDown(2.2);
      const y = doc.y; const colW = W / 2;
      doc.font('Helvetica').fontSize(10).text('_______________________', 64, y, { width: colW, align: 'center' });
      doc.text('_______________________', 64 + colW, y, { width: colW, align: 'center' });
      doc.font('Helvetica-Bold').fontSize(9.5);
      doc.text('EL EMPLEADOR', 64, y + 16, { width: colW, align: 'center' });
      doc.text('EL TRABAJADOR', 64 + colW, y + 16, { width: colW, align: 'center' });
      doc.font('Helvetica').fontSize(9);
      doc.text(emp.nombre, 64, y + 30, { width: colW, align: 'center' });
      doc.text((e.nombre || 'NOMBRE: COLABORADOR'), 64 + colW, y + 30, { width: colW, align: 'center' });
      doc.text('Encargado', 64, y + 43, { width: colW, align: 'center' });
      doc.text('Cédula: ' + (e.cedula || 'X-XXX-XXX'), 64 + colW, y + 43, { width: colW, align: 'center' });

      doc.end();
    });

    const fname = `Contrato-${(e.nombre || 'empleado').replace(/[^A-Za-z0-9]+/g, '_')}.pdf`;
    return reply(200, { ok: true, pdf: pdf.toString('base64'), filename: fname });
  } catch (err) {
    return reply(200, { ok: false, error: err.message || String(err) });
  }
};
