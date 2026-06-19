// netlify/functions/lib/empresa-config.js
// Configuración por empresa (branding, correos e instrucciones bancarias).
// Se selecciona automáticamente según SAP_COMPANY_DB:
//   JFK        -> LAMPA2007
//   Big Dream  -> SBO_BIDRBRASA
// También se puede forzar con la variable de entorno COBRANZA_EMPRESA = 'JFK' | 'BDB'.
//
// ⚠️ COMPLETAR LAS INSTRUCCIONES BANCARIAS (marcadas con TODO) antes de usar en producción.
//    Se pueden dejar en este archivo o sobreescribir con variables de entorno (ver más abajo).

const EMPRESAS = {
  JFK: {
    id: 'JFK',
    nombreLegal: 'JFK INTERNATIONAL, S.A.',
    nombreCorto: 'JFK International',
    subtitulo: 'RUC 304748-1-410636 DV 71  ·  Zona Libre de Colón, Panamá  ·  Tel: 441-5267',
    supabaseUrl: 'https://gpighopguwafnxouejfb.supabase.co',
    // Color de acento (naranja JFK) usado en el PDF — mismo de la web.
    accent: [255, 107, 53],
    // Remitente del correo. El buzón debe existir en el dominio verificado en Resend.
    from: 'JFK International | Accounts <accounts@jfkintl.com>',
    // Copia (CC) a cobros para llevar el control. Override: env COBRANZA_CC
    cc: 'cobranzas@jfkintl.com',
    // Copia oculta (BCC) — Jonathan recibe copia de cada cobro enviado. Override: env COBRANZA_BCC
    bcc: 'jonathang@jfkintl.com',
    // Correo del administrador que recibe el resumen diario para aprobar. Override: env COBRANZA_ADMIN
    admin: 'jonathang@jfkintl.com',
    // Instrucciones bancarias (Banistmo) — se incluyen en el PDF y el correo.
    banco: [
      { label: 'Beneficiario',        value: 'JFK INTERNATIONAL, S.A.' },
      { label: 'Cuenta',              value: '0111263647' },
      { label: 'Dirección',           value: 'Calle 14 Ave. Sta. Isabel, Edificio Lamparama, frente a Regal Intl.' },
      { label: 'Banco',               value: 'BANISTMO, S.A.  ·  SWIFT MIDLPAPA  ·  Torre Banistmo, Calle 50' },
      { label: 'Banco intermediario', value: 'CITIBANK, N.A.  ·  SWIFT CITIUS33XXX  ·  111 Wall St., New York, NY 10043, USA' },
      { label: 'Referencia',          value: 'Indique el código de cliente en el detalle del pago.', value_en: 'Please indicate the customer code in the payment detail.' }
    ]
  },
  BDB: {
    id: 'BDB',
    nombreLegal: 'BIG DREAM BRANDS, S.A.',
    nombreCorto: 'Big Dream Brands',
    subtitulo: 'Zona Libre de Colón  ·  Calle 15 Ave. Santa Isabel, Panamá  ·  Tel: (507) 431-7400',
    supabaseUrl: 'https://birbtcnifhnviohkgyec.supabase.co',
    accent: [20, 110, 200],
    from: 'Big Dream Brands | Accounts <accounts@bigdreambrands.com>',
    cc: '',                              // Big Dream: sin CC a cobranzas (solo BCC + vendedor)
    bcc: 'jonathang@jfkintl.com',
    admin: 'jonathang@jfkintl.com',
    // Instrucciones bancarias (Banco General) — para recibir transferencias a Big Dream Brands.
    banco: [
      { label: 'Beneficiario',        value: 'BIG DREAM BRANDS (BDB), S.A.' },
      { label: 'Cuenta',              value: '03-27-01-132278-6' },
      { label: 'Dirección',           value: 'Calle 15 Ave. Santa Isabel, Zona Libre de Colón, Panamá' },
      { label: 'Banco',               value: 'BANCO GENERAL, S.A.  ·  SWIFT BAGEPAPA  ·  Torre Banco General, Quinta B Sur, Aquilino de la Guardia y Av., Panamá' },
      { label: 'Banco intermediario', value: 'CITIBANK, N.A., N.Y.  ·  SWIFT CITIUS33  ·  ABA 021000089  ·  111 Wall St., New York, NY 10043, USA' },
      { label: 'Referencia',          value: 'Indique el nombre del cliente y su código en el detalle del pago.', value_en: 'Please indicate the customer name and code in the payment detail.' }
    ]
  }
};

function getEmpresa() {
  const forced = (process.env.COBRANZA_EMPRESA || '').toUpperCase();
  let cfg;
  if (forced && EMPRESAS[forced]) cfg = EMPRESAS[forced];
  else {
    const db = process.env.SAP_COMPANY_DB || '';
    cfg = /BIDRBRASA|BIG.?DREAM/i.test(db) ? EMPRESAS.BDB : EMPRESAS.JFK;
  }
  // Permitir overrides puntuales por variable de entorno (sin tocar código).
  return {
    ...cfg,
    from: process.env.COBRANZA_FROM || cfg.from,
    cc: process.env.COBRANZA_CC || cfg.cc,
    bcc: process.env.COBRANZA_BCC || cfg.bcc,
    admin: process.env.COBRANZA_ADMIN || cfg.admin,
    supabaseUrl: process.env.SUPABASE_URL || cfg.supabaseUrl
  };
}

module.exports = { getEmpresa, EMPRESAS };
