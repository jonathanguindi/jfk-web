// netlify/functions/lib/idioma.js
// Decide el idioma del correo/PDF según el país del cliente.
// País hispanohablante -> 'es'.  Cualquier otro -> 'en'.  Sin país -> 'es' (default local).

const ES_PAISES = new Set([
  'PA', 'VE', 'CR', 'HN', 'DO', 'CO', 'NI', 'PY', 'EC', 'GT', 'BO', 'CL', 'PE',
  'MX', 'AR', 'CU', 'SV', 'UY', 'ES',
  'ZL'   // Zona Libre (Colón, Panamá)
]);

function idioma(pais) {
  if (!pais) return 'es';
  const c = String(pais).trim().toUpperCase();
  return ES_PAISES.has(c) ? 'es' : 'en';
}

// Traducción de las etiquetas de las instrucciones bancarias.
const BANCO_EN = {
  'Beneficiario': 'Beneficiary', 'Cuenta': 'Account', 'Dirección': 'Address',
  'Banco': 'Bank', 'Banco intermediario': 'Intermediary bank', 'Referencia': 'Reference',
  'Tipo': 'Type', 'SWIFT / ABA': 'SWIFT / ABA'
};
function bancoLabel(label, lang) {
  return lang === 'en' ? (BANCO_EN[label] || label) : label;
}

// Valor de una fila bancaria: usa value_en cuando el correo va en inglés (p.ej. la Referencia).
function bancoValue(row, lang) {
  return (lang === 'en' && row.value_en) ? row.value_en : row.value;
}

// Textos estructurales para el PDF y el correo.
const T = {
  es: {
    pdfTitulo: 'ESTADO DE CUENTA', saldoFecha: 'Saldo a la fecha', periodo: 'Período', al: 'al',
    codigo: 'Código', pais: 'País', tel: 'Tel', email: 'Email',
    th: ['Fecha', 'Documento', 'Detalle', 'Débito', 'Crédito', 'Saldo'], totales: 'TOTALES',
    aging: 'Antigüedad del saldo pendiente', instr: 'Instrucciones de pago',
    generado: 'Documento generado automáticamente', saldoAnterior: 'Saldo anterior'
  },
  en: {
    pdfTitulo: 'ACCOUNT STATEMENT', saldoFecha: 'Balance to date', periodo: 'Period', al: 'to',
    codigo: 'Code', pais: 'Country', tel: 'Phone', email: 'Email',
    th: ['Date', 'Document', 'Detail', 'Debit', 'Credit', 'Balance'], totales: 'TOTALS',
    aging: 'Aging of outstanding balance', instr: 'Payment instructions',
    generado: 'Automatically generated document', saldoAnterior: 'Previous balance'
  }
};

module.exports = { idioma, bancoLabel, bancoValue, T };
