// netlify/functions/prospectos.js
// CRM de clientes potenciales (Expansión). Acceso por rol vía service key.
// Acciones (POST JSON): list | vendors | assign | assignPais | update | add | misPendientes | seed
const { getSupabase } = require('./lib/supabase');
const { getEmpresa } = require('./lib/empresa-config');
let Resend; try { Resend = require('resend').Resend; } catch (e) {}
let reporteLib; try { reporteLib = require('./lib/cliente-reporte-pdf'); } catch (e) {}

const SEED = [{"empresa": "Decorglass", "pais": "Colombia", "ciudad": "", "tipo": "Importadora mayorista hogar", "que_vende": "Artículos hogar y decoración (1500+ distribuidores)", "encaja": "JFK", "web": "sitio.catalogodecorglass.com", "contacto": "", "fuente": "https://sitio.catalogodecorglass.com/", "ya_cliente": "no", "notas": "Importador mayorista con red nacional"}, {"empresa": "Distribuidora El Impacto", "pais": "Colombia", "ciudad": "", "tipo": "Importador/mayorista hogar", "que_vende": "4000+ productos hogar, importador directo + dropshipping", "encaja": "JFK", "web": "distribuidoraelimpacto.co", "contacto": "", "fuente": "https://distribuidoraelimpacto.co/collections/hogar", "ya_cliente": "no", "notas": "Importador directo, catálogo amplio"}, {"empresa": "Caroleste", "pais": "Colombia", "ciudad": "", "tipo": "Mayorista decoración", "que_vende": "Decoración hogar y eventos (29 años)", "encaja": "JFK", "web": "caroleste.com.co", "contacto": "", "fuente": "https://caroleste.com.co/pages/mayoristas", "ya_cliente": "no", "notas": "Mayorista decoración establecido"}, {"empresa": "Namo Home", "pais": "Colombia", "ciudad": "", "tipo": "Mayorista decoración", "que_vende": "Artículos de decoración al por mayor", "encaja": "JFK", "web": "namohome.co", "contacto": "", "fuente": "https://namohome.co/mayoristas-decoracion-namo-colombia/", "ya_cliente": "no", "notas": "Mayorista decoración"}, {"empresa": "Omega Importaciones", "pais": "Colombia", "ciudad": "", "tipo": "Importador mascotas", "que_vende": "Accesorios mascotas (abastece pet shops, veterinarias)", "encaja": "JFK", "web": "omegaimportaciones.com", "contacto": "", "fuente": "https://www.omegaimportaciones.com/", "ya_cliente": "no", "notas": "Importador directo accesorios mascotas"}, {"empresa": "Gioatope", "pais": "Colombia", "ciudad": "Bogotá", "tipo": "Distribuidor mascotas", "que_vende": "Camas, collares, pecheras, guacales, juguetes mascotas", "encaja": "JFK", "web": "gioatope.com", "contacto": "", "fuente": "https://gioatope.com/", "ya_cliente": "no", "notas": "Distribuye camas mascotas (encaja Pet Bed)"}, {"empresa": "Megapets Mayorista", "pais": "Colombia", "ciudad": "Bogotá", "tipo": "Mayorista mascotas", "que_vende": "Productos mascotas a tiendas pequeñas", "encaja": "JFK", "web": "megapetsmayorista.com.co", "contacto": "", "fuente": "https://megapetsmayorista.com.co/", "ya_cliente": "no", "notas": "Mayorista mascotas"}, {"empresa": "AM Mascotas", "pais": "Colombia", "ciudad": "Bogotá", "tipo": "Mayorista mascotas", "que_vende": "430+ productos perros y gatos (30 años)", "encaja": "JFK", "web": "ammascotas.com", "contacto": "", "fuente": "https://ammascotas.com/mayoristas/", "ya_cliente": "no", "notas": "Mayorista mascotas establecido"}, {"empresa": "Pet Outlet", "pais": "Colombia", "ciudad": "", "tipo": "Mayorista mascotas", "que_vende": "Artículos para mascotas al por mayor", "encaja": "JFK", "web": "petoutlet.com.co", "contacto": "", "fuente": "https://petoutlet.com.co/", "ya_cliente": "no", "notas": "Mayorista mascotas"}, {"empresa": "Multitextiles Ecuador", "pais": "Ecuador", "ciudad": "Guayaquil", "tipo": "Distribuidor textil hogar", "que_vende": "Sábanas, toallas, línea blanca a precio fábrica", "encaja": "Big Dream", "web": "facebook.com/MultitextilesEcuador", "contacto": "", "fuente": "https://www.facebook.com/MultitextilesEcuador/", "ya_cliente": "no", "notas": "Distribuidor textil hogar, envíos nacionales"}, {"empresa": "PRISMART", "pais": "Ecuador", "ciudad": "Quito", "tipo": "Importador/mayorista hogar", "que_vende": "Artículos hogar e industria al por mayor", "encaja": "Ambas", "web": "prismart-ecuador.com", "contacto": "", "fuente": "https://prismart-ecuador.com/nosotros/", "ya_cliente": "no", "notas": "Importador mayorista hogar"}, {"empresa": "Jonatex", "pais": "Ecuador", "ciudad": "Guayaquil", "tipo": "Mayorista textil hogar", "que_vende": "Edredones, sábanas, toallas, almohadas", "encaja": "Big Dream", "web": "tiktok.com/@jonatexfabricantes23", "contacto": "", "fuente": "https://www.tiktok.com/@jonatexfabricantes23", "ya_cliente": "no", "notas": "Mayorista textil hogar (verificar sitio formal)"}, {"empresa": "Pycca", "pais": "Ecuador", "ciudad": "Guayaquil", "tipo": "Cadena retail hogar", "que_vende": "Cadena de tiendas de artículos para el hogar", "encaja": "Ambas", "web": "pycca.com", "contacto": "", "fuente": "https://www.pycca.com/", "ya_cliente": "no", "notas": "Gran cadena retail hogar — comprador potencial fuerte"}, {"empresa": "Créditos Económicos (Almacenes Tía / Créditos Económicos)", "pais": "Ecuador", "ciudad": "Guayaquil", "tipo": "Cadena retail hogar/electro", "que_vende": "Cadena retail con sección hogar y textil", "encaja": "Ambas", "web": "creditoseconomicos.com", "contacto": "", "fuente": "https://www.creditoseconomicos.com/", "ya_cliente": "no", "notas": "Cadena retail amplia"}, {"empresa": "Corporación El Rosado (Mi Comisariato/Mi Juguetería)", "pais": "Ecuador", "ciudad": "Guayaquil", "tipo": "Cadena retail/hipermercado", "que_vende": "Hipermercados con sección hogar y textil", "encaja": "Ambas", "web": "elrosado.com", "contacto": "", "fuente": "https://www.elrosado.com/", "ya_cliente": "no", "notas": "Hipermercado — gran volumen"}, {"empresa": "PlusCalidad Importaciones", "pais": "Venezuela", "ciudad": "", "tipo": "Importador mayorista hogar", "que_vende": "Ropa de cama, utensilios, organizadores hogar", "encaja": "Ambas", "web": "pluscalidad.com", "contacto": "", "fuente": "https://pluscalidad.com/categoria/hogar/", "ya_cliente": "no", "notas": "Importador mayorista hogar + ropa de cama"}, {"empresa": "Cavegas C.A.", "pais": "Venezuela", "ciudad": "", "tipo": "Distribuidor mayorista", "que_vende": "Distribución mayorista (verificar líneas hogar)", "encaja": "Ambas", "web": "cavegas.com.ve", "contacto": "", "fuente": "https://cavegas.com.ve/distribuidores-mayorista/", "ya_cliente": "posible", "notas": "Verificar líneas de producto"}, {"empresa": "Corporación del Hogar, C.A.", "pais": "Venezuela", "ciudad": "Cagua (Aragua)", "tipo": "Distribuidor mayorista hogar", "que_vende": "Artículos para el hogar al por mayor", "encaja": "Ambas", "web": "", "contacto": "0244-3965613", "fuente": "https://vitrinavenezuela.com/compras-al-mayor/", "ya_cliente": "no", "notas": "Distribuidor mayorista hogar (contacto telefónico)"}, {"empresa": "Distribuidora Gama", "pais": "Guatemala", "ciudad": "Quetzaltenango", "tipo": "Distribuidor mayorista", "que_vende": "Abastece tiendas, abarroterías, super y mayoristas (occidente)", "encaja": "Ambas", "web": "distribuidoragama.com", "contacto": "", "fuente": "https://www.distribuidoragama.com/", "ya_cliente": "no", "notas": "Cobertura occidente/suroccidente GT"}, {"empresa": "Cemaco", "pais": "Guatemala", "ciudad": "Ciudad de Guatemala", "tipo": "Cadena retail hogar", "que_vende": "Cadena líder de artículos para el hogar", "encaja": "Ambas", "web": "cemaco.com", "contacto": "", "fuente": "https://www.cemaco.com/", "ya_cliente": "no", "notas": "Cadena hogar #1 de GT — comprador grande (verificar comprador)"}, {"empresa": "Almacenes El Machetazo / variedades", "pais": "Guatemala", "ciudad": "", "tipo": "Cadena variedades", "que_vende": "Variedades y hogar", "encaja": "Ambas", "web": "", "contacto": "", "fuente": "https://www.tecoloco.com.gt/empresas-comercio-mayorista-intermediac-dist", "ya_cliente": "posible", "notas": "Verificar (cadena variedades)"}, {"empresa": "Importaciones Mundo Ofertas", "pais": "Honduras", "ciudad": "San Pedro Sula", "tipo": "Importador hogar", "que_vende": "Amplia variedad artículos para el hogar", "encaja": "Ambas", "web": "facebook.com/impmundoofertas", "contacto": "", "fuente": "https://www.facebook.com/impmundoofertas/", "ya_cliente": "no", "notas": "Importador hogar SPS"}, {"empresa": "Diunsa", "pais": "Honduras", "ciudad": "San Pedro Sula", "tipo": "Cadena retail hogar/depto", "que_vende": "Tienda por departamento con hogar y textil", "encaja": "Ambas", "web": "diunsa.hn", "contacto": "", "fuente": "https://diunsa.hn/", "ya_cliente": "no", "notas": "Cadena depto líder HN — comprador grande (verificar)"}, {"empresa": "Oro Tex Mayoristas", "pais": "Honduras", "ciudad": "", "tipo": "Mayorista mercancía general", "que_vende": "Hogar y decoración entre sus líneas", "encaja": "JFK", "web": "orotexmayoristas.com", "contacto": "", "fuente": "https://orotexmayoristas.com/honduras/", "ya_cliente": "posible", "notas": "Liquidación/saldos — verificar líneas nuevas"}, {"empresa": "El Bodegón Mayorista", "pais": "Costa Rica", "ciudad": "", "tipo": "Importador mayorista", "que_vende": "Importa de Asia/América, hogar y souvenirs", "encaja": "Ambas", "web": "elbodegonmayorista.com", "contacto": "", "fuente": "https://elbodegonmayorista.com/", "ya_cliente": "no", "notas": "Importador mayorista hogar"}, {"empresa": "ATAI", "pais": "Costa Rica", "ciudad": "", "tipo": "Mayorista multirubro", "que_vende": "Mayoreo a bazares, librerías, super, tiendas", "encaja": "Ambas", "web": "ataicr.com", "contacto": "", "fuente": "https://ataicr.com/mayoreo/", "ya_cliente": "no", "notas": "Mayorista multirubro a retail"}, {"empresa": "DIELSA", "pais": "Costa Rica", "ciudad": "", "tipo": "Importador/distribuidor", "que_vende": "Importador y distribuidor para cadenas y mayoristas", "encaja": "Ambas", "web": "dielsacr.com", "contacto": "", "fuente": "https://dielsacr.com/", "ya_cliente": "no", "notas": "Provee cadenas y mayoristas"}, {"empresa": "Distribuidora Mía", "pais": "Costa Rica", "ciudad": "", "tipo": "Distribuidor hogar", "que_vende": "Todo para el hogar, mayoreo y detalle", "encaja": "Ambas", "web": "instagram.com/distribuidoramiacr", "contacto": "", "fuente": "https://www.instagram.com/distribuidoramiacr/", "ya_cliente": "no", "notas": "Distribuidor hogar"}, {"empresa": "Comersal", "pais": "El Salvador", "ciudad": "", "tipo": "Distribuidor marcas", "que_vende": "Distribución (60 años) de marcas mundiales", "encaja": "Ambas", "web": "comersal.com.sv", "contacto": "", "fuente": "https://comersal.com.sv/", "ya_cliente": "no", "notas": "Distribuidor establecido"}, {"empresa": "ACOSA", "pais": "El Salvador", "ciudad": "", "tipo": "Mayorista", "que_vende": "Venta mayorista multirubro", "encaja": "Ambas", "web": "acosa.com.sv", "contacto": "", "fuente": "https://acosa.com.sv/mayorista/", "ya_cliente": "no", "notas": "Mayorista"}, {"empresa": "DISNA", "pais": "El Salvador", "ciudad": "", "tipo": "Distribuidor", "que_vende": "Distribución multirubro", "encaja": "Ambas", "web": "disna.com.sv", "contacto": "", "fuente": "https://disna.com.sv/en/", "ya_cliente": "posible", "notas": "Verificar líneas hogar/textil"}, {"empresa": "Almacenes Simán", "pais": "El Salvador", "ciudad": "San Salvador", "tipo": "Cadena depto", "que_vende": "Tienda por departamento (hogar/textil)", "encaja": "Ambas", "web": "siman.com", "contacto": "", "fuente": "https://www.siman.com/", "ya_cliente": "no", "notas": "Cadena depto regional (verificar comprador)"}, {"empresa": "Variedades Aaron", "pais": "Nicaragua", "ciudad": "Managua", "tipo": "Mayorista variedades", "que_vende": "Mayorista (Mercado Oriental), envíos nacionales", "encaja": "Ambas", "web": "variedadesaaron.store", "contacto": "", "fuente": "https://www.variedadesaaron.store/", "ya_cliente": "no", "notas": "Mayorista variedades/hogar"}, {"empresa": "Grupo Yang Perú", "pais": "Perú", "ciudad": "Lima", "tipo": "Importador mayorista", "que_vende": "Importaciones por mayor hogar, cocina, tecnología", "encaja": "Ambas", "web": "grupoyang.pe", "contacto": "", "fuente": "https://grupoyang.pe/", "ya_cliente": "no", "notas": "Líder importaciones por mayor hogar"}, {"empresa": "Hans (DHans)", "pais": "Perú", "ciudad": "Lima", "tipo": "Importador hogar/cocina", "que_vende": "Vajillas, vasos, utensilios y hogar por mayor", "encaja": "JFK", "web": "dhans.pe", "contacto": "", "fuente": "https://dhans.pe/", "ya_cliente": "no", "notas": "Importa hogar por mayor"}, {"empresa": "Mayorista Peruano", "pais": "Perú", "ciudad": "Lima", "tipo": "Importador hogar", "que_vende": "Productos para el hogar por mayor y menor", "encaja": "Ambas", "web": "mayoristape.com", "contacto": "", "fuente": "https://mayoristape.com/", "ya_cliente": "no", "notas": "Importador hogar nacional"}, {"empresa": "Sharwinn", "pais": "Perú", "ciudad": "Lima", "tipo": "Importadora mayorista", "que_vende": "Importadora con envíos Lima/Trujillo/Chiclayo/Piura", "encaja": "Ambas", "web": "sharwinn.com", "contacto": "", "fuente": "https://sharwinn.com/tienda-importadora-por-mayor/", "ya_cliente": "no", "notas": "Importadora mayorista nacional"}, {"empresa": "Lima Mayoristas", "pais": "Perú", "ciudad": "Lima", "tipo": "Importador textil hogar", "que_vende": "Textil para el hogar (matriz en China)", "encaja": "Big Dream", "web": "limamayoristas.com", "contacto": "", "fuente": "https://limamayoristas.com/", "ya_cliente": "no", "notas": "Especialista textil hogar"}, {"empresa": "El Importador Perú", "pais": "Perú", "ciudad": "Lima", "tipo": "Distribuidor", "que_vende": "Distribuye a todo el Perú", "encaja": "Ambas", "web": "elimportadorperu.com", "contacto": "", "fuente": "https://elimportadorperu.com/", "ya_cliente": "no", "notas": "Distribuidor nacional"}, {"empresa": "Minoil S.A.", "pais": "Bolivia", "ciudad": "Santa Cruz", "tipo": "Distribuidor masivo", "que_vende": "Distribución masiva, 1000+ SKUs importados", "encaja": "Ambas", "web": "minoil.com.bo", "contacto": "", "fuente": "https://www.minoil.com.bo/", "ya_cliente": "no", "notas": "Distribuidor masivo nacional"}, {"empresa": "Cruzimex", "pais": "Bolivia", "ciudad": "Santa Cruz", "tipo": "Importador/distribuidor", "que_vende": "Consumo masivo, marcas mundiales y locales", "encaja": "Ambas", "web": "cruzimex.com", "contacto": "", "fuente": "https://cruzimex.com/", "ya_cliente": "no", "notas": "Importador/distribuidor consumo masivo"}, {"empresa": "Multicenter", "pais": "Bolivia", "ciudad": "La Paz / Santa Cruz", "tipo": "Cadena retail hogar", "que_vende": "Tienda por departamento de hogar", "encaja": "Ambas", "web": "multicenter.com.bo", "contacto": "", "fuente": "https://www.multicenter.com.bo/", "ya_cliente": "no", "notas": "Cadena hogar líder BO (verificar comprador)"}, {"empresa": "Doral Mayorista", "pais": "Chile", "ciudad": "Santiago", "tipo": "Mayorista hogar/textil", "que_vende": "Hogar, textil, menaje y electrohome", "encaja": "Ambas", "web": "doralmayorista.cl", "contacto": "", "fuente": "https://doralmayorista.cl/", "ya_cliente": "no", "notas": "Encaje fuerte (textil + hogar)"}, {"empresa": "Compras Aquí", "pais": "Chile", "ciudad": "Santiago", "tipo": "Mayorista hogar", "que_vende": "4277 productos: almacenamiento, baño, textil, deco", "encaja": "Ambas", "web": "comprasaqui.cl", "contacto": "", "fuente": "https://comprasaqui.cl/hogar", "ya_cliente": "no", "notas": "Catálogo hogar amplio incl. textil baño"}, {"empresa": "Chile Por Mayor SpA", "pais": "Chile", "ciudad": "Santiago", "tipo": "Importador mayorista", "que_vende": "Importaciones mayoristas (barrio Meiggs)", "encaja": "Ambas", "web": "chilepormayor.cl", "contacto": "", "fuente": "https://chilepormayor.cl/", "ya_cliente": "no", "notas": "Hub importador Meiggs"}, {"empresa": "Importadora Muli", "pais": "Chile", "ciudad": "Santiago", "tipo": "Importador menaje/hogar", "que_vende": "Regalos, menaje y hogar", "encaja": "JFK", "web": "muli.cl", "contacto": "", "fuente": "https://www.muli.cl/", "ya_cliente": "no", "notas": "Importador menaje/regalos"}, {"empresa": "FASTRAX S.A.", "pais": "Paraguay", "ciudad": "Asunción", "tipo": "Distribuidor mayorista", "que_vende": "Tecnología y productos de hogar, cobertura nacional", "encaja": "Ambas", "web": "fastrax.com.py", "contacto": "", "fuente": "https://www.fastrax.com.py/nosotros/", "ya_cliente": "no", "notas": "Distribuidor mayorista hogar"}, {"empresa": "Atlantic SAE", "pais": "Paraguay", "ciudad": "Asunción", "tipo": "Mayorista hogar/ferretería", "que_vende": "Hogar y construcción, marcas int. (Tramontina), 50 años", "encaja": "JFK", "web": "atlantic.com.py", "contacto": "", "fuente": "https://www.atlantic.com.py/", "ya_cliente": "no", "notas": "Mayorista hogar establecido"}, {"empresa": "Nueva Americana", "pais": "Paraguay", "ciudad": "Asunción", "tipo": "Cadena depto", "que_vende": "Tienda por departamento con hogar y textil", "encaja": "Ambas", "web": "nuevaamericana.com.py", "contacto": "", "fuente": "https://www.nuevaamericana.com.py/", "ya_cliente": "no", "notas": "Cadena depto (verificar comprador)"}, {"empresa": "RTR Distribuciones Diversas", "pais": "Republica Dominicana", "ciudad": "Santo Domingo", "tipo": "Importador/distribuidor hogar", "que_vende": "Muebles y adornos decorativos para el hogar", "encaja": "JFK", "web": "rtrdistribuciones.com", "contacto": "", "fuente": "https://www.rtrdistribuciones.com/", "ya_cliente": "no", "notas": "Importa muebles/adornos hogar"}, {"empresa": "Suplidores Diversos", "pais": "Republica Dominicana", "ciudad": "", "tipo": "Mayorista hogar", "que_vende": "Artículos esenciales y decorativos del hogar", "encaja": "Ambas", "web": "suplidoresdiversos.com", "contacto": "", "fuente": "https://www.suplidoresdiversos.com/", "ya_cliente": "no", "notas": "Líder mayoreo nacional"}, {"empresa": "Mega Depot", "pais": "Republica Dominicana", "ciudad": "", "tipo": "Importador/distribuidor", "que_vende": "Hogar, electrodomésticos y ferretería", "encaja": "Ambas", "web": "", "contacto": "", "fuente": "https://www.livio.com/directorio/negocios-y-economia/distribuidores/", "ya_cliente": "no", "notas": "Importador hogar (buscar contacto en Livio)"}, {"empresa": "Sanjo Market", "pais": "Republica Dominicana", "ciudad": "", "tipo": "Importador decoración", "que_vende": "Decoración del hogar (30 años)", "encaja": "JFK", "web": "", "contacto": "", "fuente": "https://www.livio.com/directorio/negocios-y-economia/distribuidores/", "ya_cliente": "no", "notas": "Importa decoración hogar"}, {"empresa": "DivemaRD", "pais": "Republica Dominicana", "ciudad": "", "tipo": "Distribuidor textil", "que_vende": "Textil/artesanía a resort, gift y supermercados", "encaja": "Big Dream", "web": "", "contacto": "", "fuente": "https://www.livio.com/directorio/negocios-y-economia/distribuidores/", "ya_cliente": "no", "notas": "Distribuidor textil (encaja Big Dream)"}, {"empresa": "Benigno Zapatero, SRL", "pais": "Republica Dominicana", "ciudad": "", "tipo": "Importador/distribuidor hogar", "que_vende": "Cubertería, cristalería, plásticos hogar", "encaja": "JFK", "web": "", "contacto": "", "fuente": "https://www.livio.com/directorio/negocios-y-economia/distribuidores/", "ya_cliente": "no", "notas": "Importador hogar/menaje"}, {"empresa": "Prince Trading Company", "pais": "Jamaica", "ciudad": "Kingston", "tipo": "Mayorista distribuidor", "que_vende": "Provee 300+ mayoristas y supermercados", "encaja": "Ambas", "web": "princetradingltd.com", "contacto": "", "fuente": "https://www.princetradingltd.com/", "ya_cliente": "no", "notas": "Amplia red mayorista/super"}, {"empresa": "DFL Importers & Distributors", "pais": "Jamaica", "ciudad": "Kingston", "tipo": "Importador/distribuidor FMCG", "que_vende": "FMCG a super, mayoristas, hoteles (desde 1976)", "encaja": "Ambas", "web": "dflimporters.com", "contacto": "", "fuente": "https://dflimporters.com/", "ya_cliente": "posible", "notas": "Verificar línea housewares"}, {"empresa": "Courts Jamaica (Unicomer)", "pais": "Jamaica", "ciudad": "Kingston", "tipo": "Cadena retail hogar", "que_vende": "Muebles, electro y hogar", "encaja": "Ambas", "web": "", "contacto": "", "fuente": "https://www.findyello.com/jamaica-kingston/distributors-wholesale/", "ya_cliente": "posible", "notas": "Cadena retail hogar (verificar comprador)"}, {"empresa": "A.S. Bryden & Sons (Brydens)", "pais": "Trinidad y Tobago", "ciudad": "Port of Spain", "tipo": "Distribuidor premier", "que_vende": "Cientos de marcas incl. Housewares", "encaja": "Ambas", "web": "brydenstt.com", "contacto": "", "fuente": "https://www.brydenstt.com/supply-my-business/", "ya_cliente": "no", "notas": "Distribuidor #1 con línea housewares"}, {"empresa": "Acado Distribution", "pais": "Trinidad y Tobago", "ciudad": "", "tipo": "Distribuidor", "que_vende": "Household, hygiene y housewares (30+ multinacionales)", "encaja": "Ambas", "web": "acadodistribution.com", "contacto": "", "fuente": "https://acadodistribution.com/company/", "ya_cliente": "no", "notas": "Fuerte en household/housewares"}, {"empresa": "Langston Roach Industries", "pais": "Trinidad y Tobago", "ciudad": "", "tipo": "Fabricante/distribuidor", "que_vende": "Household y personal care", "encaja": "JFK", "web": "", "contacto": "", "fuente": "https://www.findyello.com/trinidad/distributors-wholesale/", "ya_cliente": "posible", "notas": "Verificar interés en importado"}, {"empresa": "Kelly's House & Home", "pais": "Bahamas", "ciudad": "Nassau", "tipo": "Retail/mayorista hogar", "que_vende": "Housewares y artículos de cocina", "encaja": "Ambas", "web": "kellysbahamas.com", "contacto": "", "fuente": "https://www.kellysbahamas.com/c/general-housewares/2", "ya_cliente": "no", "notas": "Retailer hogar líder Nassau"}, {"empresa": "CBS Bahamas", "pais": "Bahamas", "ciudad": "Nassau", "tipo": "Retail hogar/mejoras", "que_vende": "Housewares, plomería, iluminación", "encaja": "JFK", "web": "cbsbahamas.com", "contacto": "", "fuente": "https://www.cbsbahamas.com/", "ya_cliente": "no", "notas": "Vende iluminación (encaja JFK)"}, {"empresa": "Quality Home Centre", "pais": "Bahamas", "ciudad": "Nassau", "tipo": "Retail housewares", "que_vende": "Artículos para el hogar", "encaja": "Ambas", "web": "", "contacto": "", "fuente": "https://www.findyello.com/bahamas/quality-home-centre/profile/", "ya_cliente": "no", "notas": "Retailer housewares"}, {"empresa": "M&C Home Depot (M&C Group)", "pais": "Santa Lucia", "ciudad": "Castries", "tipo": "Cadena retail hogar", "que_vende": "Hogar, muebles y electro", "encaja": "Ambas", "web": "", "contacto": "", "fuente": "https://www.dnb.com/business-directory/company-information.household_appliances_and_electrical_and_electronic_goods_merchant_wholesalers.lc.gros_islet.html", "ya_cliente": "posible", "notas": "Mayor grupo retail de St. Lucia (verificar dominio/comprador)"}, {"empresa": "Townhouse Megastore", "pais": "Antigua y Barbuda", "ciudad": "St. John's", "tipo": "Retail hogar/electro", "que_vende": "Hogar, muebles y electrodomésticos", "encaja": "Ambas", "web": "", "contacto": "", "fuente": "https://www.findyello.com/antigua/distributors-wholesale/", "ya_cliente": "posible", "notas": "Megastore de hogar (verificar contacto)"}, {"empresa": "Mangusa Hypermarket", "pais": "Curazao", "ciudad": "Willemstad", "tipo": "Hipermercado", "que_vende": "Hipermercado con sección hogar y textil", "encaja": "Ambas", "web": "", "contacto": "", "fuente": "https://www.findyello.com/", "ya_cliente": "posible", "notas": "Hipermercado (verificar dominio/comprador)"}];

const cors = { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'Content-Type', 'Access-Control-Allow-Methods':'POST, OPTIONS' };
const reply = (c,o)=>({ statusCode:c, headers:{'Content-Type':'application/json',...cors}, body:JSON.stringify(o) });
const now = ()=> new Date().toISOString();

async function emailVendor(empresa, to, nombre, pros, modo, attachments){
  try{
    if(!Resend) return {sent:false, error:'Paquete resend no instalado'};
    if(!process.env.RESEND_API_KEY) return {sent:false, error:'RESEND_API_KEY no configurado'};
    if(!to) return {sent:false, error:'El vendedor no tiene correo'};
    const r = new Resend(process.env.RESEND_API_KEY);
    const eh = s => String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    const esReact = modo==='reactivar';
    const webU = pros.web ? (String(pros.web).startsWith('http')?String(pros.web):'https://'+pros.web) : '';
    const intro = esReact
      ? `<p>Se te asignó un <b>cliente con historial en la empresa</b> para que le des seguimiento. Ya nos compraba y dejó de hacerlo — recuperarlo es venta casi segura.</p>`
      : `<p>Se te asignó un <b>cliente potencial</b> para contactar:</p>`;
    const filaReact = esReact ? `
        ${pros.valor_anual?`<tr><td style="padding:4px 10px;color:#888">Valía/año</td><td style="padding:4px 10px"><b>${eh(pros.valor_anual)}</b></td></tr>`:''}
        ${pros.ultima_compra?`<tr><td style="padding:4px 10px;color:#888">Última compra</td><td style="padding:4px 10px">${eh(pros.ultima_compra)}</td></tr>`:''}
        ${pros.contacto?`<tr><td style="padding:4px 10px;color:#888">Contacto</td><td style="padding:4px 10px">${eh(pros.contacto)}</td></tr>`:''}` : '';
    const cierre = esReact
      ? `<p>Es tu <b>oportunidad de demostrar que puedes y que quieres echar para adelante</b>. Escríbele o llámalo hoy, ofrécele lo que pedía y márcalo como <b>contactado</b> en el portal → <b>Expansión</b>. ¡Saludos!</p>`
      : `<p>Consigue su contacto, llámalo y márcalo como <b>contactado</b> en el portal → <b>Expansión</b>.</p>`;
    const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#0E1016">
      <p>Hola ${eh(nombre)},</p>
      ${intro}
      <table style="border-collapse:collapse;font-size:14px">
        <tr><td style="padding:4px 10px;color:#888">${esReact?'Cliente':'Empresa'}</td><td style="padding:4px 10px"><b>${eh(pros.empresa)}</b></td></tr>
        <tr><td style="padding:4px 10px;color:#888">País</td><td style="padding:4px 10px">${eh(pros.pais)}${pros.ciudad?(' · '+eh(pros.ciudad)):''}</td></tr>
        <tr><td style="padding:4px 10px;color:#888">${esReact?'Qué compraba':'Rubro'}</td><td style="padding:4px 10px">${eh(pros.que_vende||pros.tipo)}</td></tr>
        ${filaReact}
        ${webU?`<tr><td style="padding:4px 10px;color:#888">Web</td><td style="padding:4px 10px"><a href="${eh(webU)}">${eh(pros.web)}</a></td></tr>`:''}
      </table>
      ${cierre}
      <p style="color:#888;font-size:12px">${eh(empresa.nombreCorto)}</p></div>`;
    const subject = esReact ? `Cliente para reactivar: ${eh(pros.empresa)}` : `Nuevo cliente potencial para contactar: ${eh(pros.empresa)}`;
    const adminBcc = (process.env.VENTAS_ADMIN_EMAIL || empresa.admin || '').trim();
    const { data, error } = await r.emails.send({ from: empresa.from, to:[to], bcc: adminBcc?[adminBcc]:undefined, subject, html, attachments:(attachments&&attachments.length)?attachments:undefined });
    if(error) return {sent:false, error:(error.message||JSON.stringify(error))};
    return {sent:true, id:(data&&data.id)||null};
  }catch(e){ return {sent:false, error:e.message}; }
}

exports.handler = async (event) => {
  if (event.httpMethod==='OPTIONS') return reply(200,{ok:true});
  if (event.httpMethod!=='POST') return reply(405,{ok:false,error:'Método no permitido'});
  let b={}; try{ b=JSON.parse(event.body||'{}'); }catch(_){}
  const empresa = getEmpresa();
  const sb = getSupabase(empresa);
  if(!sb) return reply(500,{ok:false,error:'Supabase no configurado'});
  const adminEmail = (process.env.VENTAS_ADMIN_EMAIL || empresa.admin || '').trim().toLowerCase();
  const email = (b.email||'').trim().toLowerCase();
  const esAdmin = !!email && email===adminEmail;
  const label = (empresa.id==='JFK') ? 'JFK' : 'Big Dream';
  const relevante = (enc)=> enc===label || enc==='Ambas' || !enc;

  async function paisesDe(em){
    const { data } = await sb.from('prospecto_pais_vendedor').select('pais').eq('vendedor_email', em);
    return (data||[]).map(x=>x.pais);
  }
  async function getRow(id){ const {data}=await sb.from('prospectos').select('*').eq('id',id).single(); return data; }
  async function puedeEditar(row){
    if(esAdmin) return true;
    if(row.asignado_email && row.asignado_email.toLowerCase()===email) return true;
    const ps = await paisesDe(email); return ps.includes(row.pais);
  }
  const log = (row, accion)=> [...(row.historial||[]), {fecha:now(), quien:email, accion}];

  try{
    const action = b.action||'list';

    if(action==='list'){
      let paises=[];
      let q = sb.from('prospectos').select('*').order('pais').order('empresa');
      if(!esAdmin){
        paises = await paisesDe(email);
        const safeEmail = email.replace(/[^a-z0-9._%+\-@]/g,'');  // no romper el árbol .or() con comas/paréntesis
        const ors = [`asignado_email.eq.${safeEmail}`];
        if(paises.length) ors.push(`pais.in.(${paises.map(p=>'"'+p.replace(/"/g,'')+'"').join(',')})`);
        q = q.or(ors.join(','));
      }
      const { data, error } = await q;
      if(error) return reply(200,{ok:false,error:error.message});
      return reply(200,{ok:true, esAdmin, label, paisesAsignados:paises, prospectos:data||[]});
    }

    if(action==='vendors'){
      if(!esAdmin) return reply(403,{ok:false,error:'Solo admin'});
      const { data } = await sb.from('sellers').select('name,email,role').order('name');
      const asign = await sb.from('prospecto_pais_vendedor').select('*');
      return reply(200,{ok:true, vendedores:(data||[]), paisVendedor:(asign.data||[])});
    }

    // Ventas activas por país, últimos 12 meses (en vivo, mismo Supabase que el dashboard).
    // Alimenta la Meta/Análisis de Expansión. Reusa el RPC ventas_resumen; se refresca con el sync nocturno.
    if(action==='ventas12'){
      if(!esAdmin) return reply(403,{ok:false,error:'Solo admin'});
      const hasta = now().slice(0,10);
      const desde = new Date(Date.now()-365*86400000).toISOString().slice(0,10);
      const { data, error } = await sb.rpc('ventas_resumen', { desde, hasta, p_vendedores:null, p_pais:null });
      if(error) return reply(200,{ok:false,error:error.message});
      const ventas={}; ((data&&data.por_pais)||[]).forEach(r=>{ const n=r.name||r.code||'?'; ventas[n]=(ventas[n]||0)+Number(r.total||0); });
      const total=(data&&data.kpis&&data.kpis.ventas_total)||0;
      return reply(200,{ok:true, ventas, total, fecha:hasta});
    }

    if(action==='assign'){
      if(!esAdmin) return reply(403,{ok:false,error:'Solo admin'});
      const row = await getRow(b.id); if(!row) return reply(404,{ok:false,error:'No existe'});
      const upd = { asignado_email:(b.vendedor_email||'').toLowerCase(), asignado_nombre:b.vendedor_nombre||'',
        estado: (row.estado==='nuevo'||!row.estado)?'asignado':row.estado, updated_at:now(),
        historial: log(row, `Asignado a ${b.vendedor_nombre||b.vendedor_email}`) };
      const { error } = await sb.from('prospectos').update(upd).eq('id',b.id);
      if(error) return reply(200,{ok:false,error:error.message});
      const correo = await emailVendor(empresa, b.vendedor_email, b.vendedor_nombre, row);
      return reply(200,{ok:true, correo});
    }

    // Qué clientes dormidos ya están en el CRM (para no duplicar y mostrar a quién se asignaron).
    if(action==='reactivados'){
      if(!esAdmin) return reply(403,{ok:false,error:'Solo admin'});
      const { data } = await sb.from('prospectos').select('card_code,asignado_nombre,asignado_email,estado').not('card_code','is',null);
      return reply(200,{ok:true, reactivados:(data||[])});
    }

    // Clientes HUÉRFANOS: con ventas recientes cuyo vendedor SAP ya no tiene correo activo.
    if(action==='huerfanos'){
      if(!esAdmin) return reply(403,{ok:false,error:'Solo admin'});
      const hoy = now().slice(0,10);
      const d12 = new Date(Date.now()-365*86400000).toISOString().slice(0,10);
      const r12 = await sb.rpc('ventas_resumen',{desde:d12, hasta:hoy, p_vendedores:null, p_pais:null});
      const pv = (((r12.data||{}).por_vendedor)||[]).filter(v=>v.code!=null && (v.total||0)>0);
      const { data:cv } = await sb.from('cobranza_vendedores').select('sap_code,email,activo');
      const activos = new Set((cv||[]).filter(x=>x.activo!==false && (x.email||'').trim()).map(x=>x.sap_code));
      const NOISE = /sin\s*agente|trafico|shacalo|mostrador|varios|general|consumidor|^n\/?a$|^\s*-/i;
      const orf = pv.filter(v=>!activos.has(v.code) && !NOISE.test(v.name||''));
      const codes = orf.map(v=>v.code);
      const exNombre = {}; orf.forEach(v=>{ exNombre[v.code]=v.name; });
      let clientes=[];
      if(codes.length){
        const d24 = new Date(Date.now()-730*86400000).toISOString().slice(0,10);
        const rc = await sb.rpc('ventas_resumen',{desde:d24, hasta:hoy, p_vendedores:codes, p_pais:null});
        clientes = (((rc.data||{}).por_cliente)||[]).map(c=>({card_code:c.card_code, name:c.name, pais:c.pais, ex_vendedor:c.vendedor, total:c.total, ultima:c.ultima_compra}));
      }
      const { data:ya } = await sb.from('prospectos').select('card_code,asignado_nombre').not('card_code','is',null);
      const yaMap={}; (ya||[]).forEach(x=>{ if(x.card_code) yaMap[x.card_code]=x.asignado_nombre; });
      clientes.forEach(c=>{ c.ya = yaMap[c.card_code]||null; });
      const { data:vend } = await sb.from('sellers').select('name,email,role').order('name');
      return reply(200,{ok:true, clientes, vendedores:(vend||[]), exVendedores:orf.map(v=>({name:v.name,clientes:v.clientes,total:v.total})) });
    }

    // Mete un cliente DORMIDO al CRM como tarea de reactivación, asignado a un vendedor.
    if(action==='reactivar'){
      if(!esAdmin) return reply(403,{ok:false,error:'Solo admin'});
      const d = b.cliente||{};
      const nombreCli = d.empresa || d.name;  // el dormido trae el nombre en "name"
      if(!d.card_code || !nombreCli) return reply(400,{ok:false,error:'Falta cliente'});
      const vEmail=(b.vendedor_email||'').toLowerCase(), vNombre=b.vendedor_nombre||'';
      if(!vEmail) return reply(400,{ok:false,error:'Falta vendedor'});
      const contacto=[d.contact_person,d.telefono,d.email].filter(Boolean).join(' · ')||null;
      const notas=`♻️ Cliente dormido. Valía ~${d.valor_anual||'?'}/año · última compra ${d.ultima_compra||'?'} · ${d.n_compras||'?'} órdenes en ${d.meses_activos||'?'} meses. Escríbele y recupéralo.`;
      const fields={ pais:d.pais||'—', ciudad:d.city||null, empresa:nombreCli, tipo:'♻️ Reactivar dormido',
        que_vende:d.top_familia||null, encaja:label, web:null, contacto, email:d.email||null,
        direccion:null, fuente:'Cliente dormido', notas, card_code:d.card_code,
        asignado_email:vEmail, asignado_nombre:vNombre, estado:'asignado', creado_por:email,
        historial:[{fecha:now(),quien:email,accion:`Reactivación asignada a ${vNombre||vEmail}`}] };
      // ¿ya existe? -> reasignar; si no -> insertar
      const { data: ex } = await sb.from('prospectos').select('id,historial').eq('card_code',d.card_code).limit(1);
      let err;
      if(ex && ex.length){
        const upd={ asignado_email:vEmail, asignado_nombre:vNombre, estado:'asignado', updated_at:now(),
          historial:[...(ex[0].historial||[]),{fecha:now(),quien:email,accion:`Reasignado a ${vNombre||vEmail}`}] };
        ({ error: err } = await sb.from('prospectos').update(upd).eq('id',ex[0].id));
      } else {
        ({ error: err } = await sb.from('prospectos').insert(fields));
      }
      if(err){
        // Solo reintenta si el fallo es por columna inexistente (card_code/email). Otros errores
        // (timeout, constraint) se devuelven tal cual para NO insertar un duplicado a ciegas.
        if(/card_code|email|column|schema|does not exist/i.test(err.message||'')){
          const f2=Object.assign({},fields); delete f2.card_code; delete f2.email;
          const r2 = await sb.from('prospectos').insert(f2);
          if(r2.error) return reply(200,{ok:false,error:err.message});
        } else {
          return reply(200,{ok:false,error:err.message});
        }
      }
      const valorFmt = (d.valor_anual!=null && d.valor_anual!=='') ? '$'+Math.round(Number(d.valor_anual)).toLocaleString('en-US')+'/año' : null;
      let adj=[];
      try{ if(reporteLib){ const rep=await reporteLib.generarReporteCliente(empresa, sb, d.card_code, vNombre); if(rep&&rep.pdf) adj=[{filename:rep.filename, content:rep.pdf}]; } }catch(e){ /* sin reporte adjunto */ }
      const correo = await emailVendor(empresa, vEmail, vNombre,
        { empresa:nombreCli, pais:d.pais, ciudad:d.city, que_vende:d.top_familia, contacto, valor_anual:valorFmt, ultima_compra:d.ultima_compra }, 'reactivar', adj);
      return reply(200,{ok:true, correo});
    }

    // Registro de gestión: el vendedor anota qué pasó con el cliente (llamó, cotizó, cerró...).
    if(action==='gestion'){
      const row = await getRow(b.id); if(!row) return reply(404,{ok:false,error:'No existe'});
      if(!(await puedeEditar(row))) return reply(403,{ok:false,error:'Sin permiso'});
      const res = (b.resultado||'').trim();
      const nota = (b.nota||'').trim();
      if(!res) return reply(400,{ok:false,error:'Falta el resultado'});
      const mapEst = {'Contacté':'contactado','Coticé':'contactando','Cerró venta':'cliente','No contesta':'contactando','No interesado':'descartado','Volver a llamar':'contactando'};
      const nuevoEst = mapEst[res] || row.estado;
      const entry = {fecha:now(), quien:email, accion:'📝 '+res+(nota?(' — '+nota):'')};
      const upd = { estado:nuevoEst, updated_at:now(), historial:[...(row.historial||[]), entry] };
      const { error } = await sb.from('prospectos').update(upd).eq('id',b.id);
      if(error) return reply(200,{ok:false,error:error.message});
      return reply(200,{ok:true, estado:nuevoEst, entry});
    }

    if(action==='assignPais'){
      if(!esAdmin) return reply(403,{ok:false,error:'Solo admin'});
      const { error } = await sb.from('prospecto_pais_vendedor').upsert({
        pais:b.pais, vendedor_email:(b.vendedor_email||'').toLowerCase(), vendedor_nombre:b.vendedor_nombre||'', updated_at:now() });
      if(error) return reply(200,{ok:false,error:error.message});
      // correo resumen al vendedor
      const { count } = await sb.from('prospectos').select('*',{count:'exact',head:true}).eq('pais',b.pais);
      await emailVendor(empresa, b.vendedor_email, b.vendedor_nombre, {empresa:`${count||0} prospectos en ${b.pais}`, pais:b.pais, que_vende:'Revisa la lista en Expansión'});
      return reply(200,{ok:true});
    }

    if(action==='update'){
      const row = await getRow(b.id); if(!row) return reply(404,{ok:false,error:'No existe'});
      if(!(await puedeEditar(row))) return reply(403,{ok:false,error:'Sin permiso'});
      const f = b.fields||{};
      const allow = ['estado','contacto','email','ciudad','direccion','notas','web','empresa','tipo','que_vende'];
      const upd = { updated_at:now() };
      const cambios=[];
      allow.forEach(k=>{ if(f[k]!==undefined){ upd[k]=f[k]; cambios.push(k); } });
      upd.historial = log(row, 'Actualizó: '+(cambios.join(', ')||'—')+(f.estado?` (estado: ${f.estado})`:''));
      const { error } = await sb.from('prospectos').update(upd).eq('id',b.id);
      if(error) return reply(200,{ok:false,error:error.message});
      return reply(200,{ok:true});
    }

    if(action==='eliminar'){
      const row = await getRow(b.id); if(!row) return reply(404,{ok:false,error:'No existe'});
      const propio = (row.asignado_email && row.asignado_email.toLowerCase()===email) || (row.creado_por && String(row.creado_por).toLowerCase()===email);
      if(!esAdmin && !propio) return reply(403,{ok:false,error:'Solo admin o el dueño del prospecto puede eliminar'});
      const { error } = await sb.from('prospectos').delete().eq('id',b.id);
      if(error) return reply(200,{ok:false,error:error.message});
      return reply(200,{ok:true});
    }

    if(action==='add'){
      const f = b.fields||{};
      if(!f.empresa || !f.pais) return reply(400,{ok:false,error:'empresa y país obligatorios'});
      const ins = { pais:f.pais, ciudad:f.ciudad||null, empresa:f.empresa, tipo:f.tipo||null,
        que_vende:f.que_vende||null, encaja:f.encaja||label, web:f.web||null, contacto:f.contacto||null,
        direccion:f.direccion||null, notas:f.notas||null, fuente:f.fuente||null,
        estado: esAdmin?'nuevo':'contactando', creado_por:email,
        asignado_email: esAdmin?null:email, asignado_nombre: esAdmin?null:(b.nombre||email),
        historial:[{fecha:now(),quien:email,accion:'Creado'}] };
      const { error } = await sb.from('prospectos').insert(ins);
      if(error) return reply(200,{ok:false,error:error.message});
      return reply(200,{ok:true});
    }

    if(action==='misPendientes'){
      if(!email) return reply(200,{ok:true,count:0});
      const { count } = await sb.from('prospectos').select('*',{count:'exact',head:true})
        .eq('asignado_email',email).in('estado',['asignado','contactando']);
      return reply(200,{ok:true,count:count||0});
    }

    if(action==='seed'){
      if(!esAdmin) return reply(403,{ok:false,error:'Solo admin'});
      const { count } = await sb.from('prospectos').select('*',{count:'exact',head:true});
      if(count && count>0) return reply(200,{ok:true,inserted:0,note:'ya tenía datos'});
      const rows = SEED.filter(s=>relevante(s.encaja)).map(s=>({
        pais:s.pais, ciudad:s.ciudad||null, empresa:s.empresa, tipo:s.tipo||null, que_vende:s.que_vende||null,
        encaja:s.encaja||'Ambas', web:s.web||null, contacto:s.contacto||null, direccion:null,
        fuente:s.fuente||null, notas:s.notas||null, estado:'nuevo', creado_por:'sistema',
        historial:[{fecha:now(),quien:'sistema',accion:'Importado de investigación'}] }));
      const { error } = await sb.from('prospectos').insert(rows);
      if(error) return reply(200,{ok:false,error:error.message});
      return reply(200,{ok:true,inserted:rows.length});
    }

    return reply(400,{ok:false,error:'Acción desconocida'});
  }catch(e){ return reply(500,{ok:false,error:e.message}); }
};
