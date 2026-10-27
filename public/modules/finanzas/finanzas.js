/* ════════════════════════════════════════════════════════════════
   VCONV · Módulo Finanzas — Aportes, Ofrendas, Comisiones MLM,
   CRUD centralizado y Reportes Financieros (Caja Mayor).

   Configuración dinámica en Firestore (config/finanzas):
     - finanzasEnabled            interruptor maestro
     - porcentajeCoordinador      comisión N1 del coordinador (legacy)
     - porcentajes               { nivel: % } para la red MLM N1–N5
                                (por defecto 30 / 5 / 5 / 5 / 5 = 55%)
     - porcentajeCaja             % de Caja Mayor / Fondo Estructura
                                General (por defecto 45% = lo restante)
     - categorias                 CRUD de categorías (personal/grupo/ofrenda/solidario)

   Colecciones:
     - finanzas_transacciones     (origen, origenId, etiqueta, userId,
                                   comunidadId, categoriaId, monto, tipo,
                                   concepto, fecha, estado, distribucion,
                                   creadoPor)
     - finanzas_comisiones        (userId, origenId, tipo, nivel,
                                   porcentaje, monto, fecha, comunidadId)

   Etiquetado obligatorio de origen (en BD y UI):
     - origen 'usuario'    →  etiqueta "Aporte de Usuario"
     - origen 'comunidad'  →  etiqueta "Ofrenda de Comunidad"

   Ofrendas directas / solidarias: el monto va 100% al destinatario. No se
   divide entre Bolsa de Comisiones y Caja Mayor ni genera comisiones MLM.
   El comprobante NO se sube desde el formulario: se envía por WhatsApp.

   BYPASS DE SUPERADMIN: el rol superadmin registra, edita y elimina
   transacciones de CUALQUIER usuario o comunidad sin restricciones de
   cadenas de patrocinio (las reglas de Firestore autorizan el bypass).

   El motor de comisiones lee los porcentajes dinámicamente desde
   config/finanzas.porcentajes (o el motor mlm como respaldo): ante una
   modificación de valores, el cálculo y los reportes se ajustan de
   forma automática.
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var V = window.VCONV;
  if (!V) { console.error('VCONV core not loaded'); return; }

  var CONFIG_DOC = 'finanzas';
  var COL_TRANS = 'finanzas_transacciones';
  var COL_COMIS = 'finanzas_comisiones';
  var COL_PAGOS = 'finanzas_pagos';
  // Catálogo de cuentas bancarias / billeteras. Solo el superadmin las
  // administra; superadmin y gestor pueden leerlas (firestore.rules). Cada
  // documento expone SOLO { banco, numero } como campos de negocio.
  var COL_CUENTAS = 'finanzas_cuentas';
  var TIPOS_VALIDOS = ['personal', 'grupo', 'ofrenda', 'solidario'];

  var ETIQUETA_USUARIO = 'Aporte de Usuario';
  var ETIQUETA_COMUNIDAD = 'Ofrenda de Comunidad';
  var ETIQUETA_DIRECTO = 'Ofrenda Directa / Solidaridad';
  var TIPO_DIRECTO = 'directo_solidaridad';
  var FONDO_CAJA_ID = 'fondo_caja_mayor';
  var FONDO_CAJA_NOMBRE = 'Caja Mayor / Fondo General';

  // Trazabilidad solidaria: todo movimiento nace "Registrado" y solo pasa a
  // "Asignado" cuando administración verifica el comprobante y confirma el
  // destino (beneficiario o red MLM). Los estados históricos se normalizan
  // al leerlos para no romper los documentos ya guardados.
  var ESTADO_REGISTRADO = 'registrado';
  var ESTADO_ASIGNADO = 'asignado';
  var ESTADOS_TRANSACCION = [
    { value: ESTADO_REGISTRADO, label: 'Registrado' },
    { value: ESTADO_ASIGNADO, label: 'Asignado' }
  ];

  var DEFAULT_CONFIG = {
    finanzasEnabled: true,
    porcentajeCoordinador: 30,
    // Porcentajes de la red MLM N1-N5. El valor inicial vive ÚNICAMENTE
    // en core/app.js (V.DEFAULT_MLM_PORCENTAJES), que lo comparte con el
    // motor MLM: antes cada módulo llevaba su propia copia y podían
    // divergir. Red de 5 niveles: 30% (N1) + 10% (N2) + 5% (N3–N5) =
    // 55% de bolsa; el 45% restante va a la Caja Mayor / Fondo General.
    porcentajes: V.DEFAULT_MLM_PORCENTAJES,
    porcentajeCaja: 45,
    categorias: [
      { id: 'diezmo', nombre: 'Diezmo', tipo: 'personal', activa: true },
      { id: 'ofrenda', nombre: 'Ofrenda', tipo: 'ofrenda', activa: true },
      { id: 'ofrenda_grupo', nombre: 'Ofrenda de grupo', tipo: 'grupo', activa: true },
      { id: 'misiones', nombre: 'Misiones', tipo: 'ofrenda', activa: true }
    ]
  };

  var cfg = null;
  var cfgPromise = null;
  var comunidadesCache = [];
  var usuariosCache = [];
  var cuentasCache = [];
  var _wrapped = false;

  // Estado de las vistas (filtros persistentes entre repintados).
  var _finState = { q: '', origen: '', categoriaId: '', estado: '', desde: '', hasta: '' };
  var _repState = { origen: '', categoriaId: '', estado: '', desde: '', hasta: '' };

  /* ─── HELPERS ───────────────────────────────────────────────── */
  function el(tag, cls, text) { return V.el(tag, cls, text); }
  function fmtMoneda(n) {
    var v = Number(n) || 0;
    return '$' + v.toLocaleString('es-CO');
  }
  // FASE A · multi-rol: los permisos del módulo se calculan sobre el
  // CONJUNTO efectivo de roles (rol principal + roles[]), no sobre un
  // único rol principal.
  function esSuper() { return typeof V.tieneRol === 'function' ? V.tieneRol('superadmin') : V.userRole === 'superadmin'; }
  function esContable() { return typeof V.tieneRol === 'function' ? V.tieneRol('contable') : false; }
  // El módulo de finanzas (CRUD completo de transacciones, cuentas,
  // comisiones y configuración) es territorio de 'contable' y 'superadmin'.
  // firestore.rules aplica el mismo criterio (esContable() || isAdmin()).
  function isAdminUser() { return esSuper() || esContable(); }
  // Lectura del catálogo de cuentas: SOLO quien administra finanzas
  // (superadmin y contable). Fase A: el módulo de finanzas es exclusivo de
  // esos dos roles, así que el gestor ya no lo entra y tampoco necesita el
  // catálogo de cuentas (la regla de firestore.rules tampoco se lo permite).
  function puedeLeerCuentas() { return isAdminUser(); }
  // Rol "avanzado": entra al módulo en modo SOLO LECTURA y limitado a su
  // propia red. Sus lecturas se resuelven contra esMiArbolFin() en
  // firestore.rules, así que el backend descarta cualquier documento ajeno
  // aunque el cliente lo solicite: el filtro del cliente es solo comodidad.
  function esAvanzadoUser() { return typeof V.tieneRol === 'function' ? V.tieneRol('avanzado') : V.userRole === 'avanzado'; }
  function nombreUsuario(u) {
    var n = ((u && (u.nombre || '')) + ' ' + (u && (u.apellido || ''))).trim();
    return n || (u && u.email ? u.email : '');
  }
  function diaISO(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toISOString().slice(0, 10);
  }
  function redondear(n) { return +(Math.round((Number(n) + 0.000001) * 100) / 100).toFixed(2); }

  /* ─── CONFIG ───────────────────────────────────────────────── */
  function normalizePorcentajes(raw) {
    var out = {};
    for (var i = 1; i <= 5; i++) {
      var v = raw && typeof raw[i] === 'number' && isFinite(raw[i]) ? raw[i] : DEFAULT_CONFIG.porcentajes[i];
      out[i] = Math.min(100, Math.max(0, Math.round(v)));
    }
    return out;
  }
  function normalizeCaja(v) {
    var n = Number(v);
    return (isFinite(n) && n >= 0) ? Math.min(100, Math.round(n)) : DEFAULT_CONFIG.porcentajeCaja;
  }
  function normalizeCategorias(raw) {
    var out = [];
    var arr = Array.isArray(raw) ? raw : (DEFAULT_CONFIG.categorias);
    arr.forEach(function (c) {
      var id = c && c.id ? String(c.id).trim() : '';
      var nombre = c && c.nombre ? String(c.nombre).trim() : '';
      if (!id || !nombre) return;
      var tipoRaw = String(c && c.tipo != null ? c.tipo : '').trim().toLowerCase();
      if (tipoRaw === TIPO_DIRECTO || tipoRaw === 'aporte_solidario' || tipoRaw === 'ofrenda_directa') {
        tipoRaw = 'solidario';
      }
      var tipo = TIPOS_VALIDOS.indexOf(tipoRaw) === -1 ? 'personal' : tipoRaw;
      out.push({ id: id, nombre: nombre, tipo: tipo, activa: c.activa !== false });
    });
    return out;
  }

  function loadConfig(force) {
    if (cfgPromise && !force) return cfgPromise;
    // Visitante sin sesión: config/* exige signedIn() en las reglas. Se
    // omiten la consulta y el cacheo (no se bloquea el reuso tras un login).
    if (V.isAnon) {
      cfg = {
        finanzasEnabled: DEFAULT_CONFIG.finanzasEnabled,
        porcentajeCoordinador: DEFAULT_CONFIG.porcentajeCoordinador,
        porcentajes: normalizePorcentajes(DEFAULT_CONFIG.porcentajes),
        porcentajeCaja: DEFAULT_CONFIG.porcentajeCaja,
        categorias: normalizeCategorias(DEFAULT_CONFIG.categorias)
      };
      return Promise.resolve(cfg);
    }
    cfgPromise = (V.db ? V.db.collection('config').doc(CONFIG_DOC).get() : Promise.resolve(null))
      .then(function (doc) {
        var raw = doc && doc.exists ? doc.data() : {};
        cfg = {
          finanzasEnabled: raw.finanzasEnabled == null ? DEFAULT_CONFIG.finanzasEnabled : !!raw.finanzasEnabled,
          porcentajeCoordinador: normalizePctCoord(raw.porcentajeCoordinador),
          porcentajes: normalizePorcentajes(raw.porcentajes),
          porcentajeCaja: normalizeCaja(raw.porcentajeCaja),
          categorias: normalizeCategorias(raw.categorias)
        };
        return cfg;
      })
      .catch(function () {
        cfg = {
          finanzasEnabled: DEFAULT_CONFIG.finanzasEnabled,
          porcentajeCoordinador: DEFAULT_CONFIG.porcentajeCoordinador,
          porcentajes: normalizePorcentajes(DEFAULT_CONFIG.porcentajes),
          porcentajeCaja: DEFAULT_CONFIG.porcentajeCaja,
          categorias: normalizeCategorias(DEFAULT_CONFIG.categorias)
        };
        return cfg;
      });
    return cfgPromise;
  }

  function normalizePctCoord(v) {
    var n = Number(v);
    return (isFinite(n) && n > 0) ? Math.min(100, Math.round(n)) : DEFAULT_CONFIG.porcentajeCoordinador;
  }

  function getConfig() {
    return loadConfig().then(function () { return cfg; });
  }

  function isEnabled() {
    if (!cfg) return V.finanzas && V.finanzas._initialConfig && V.finanzas._initialConfig.finanzasEnabled;
    return !!cfg.finanzasEnabled;
  }

  // Sincroniza de forma best-effort la configuración MLM con los
  // porcentajes vigentes del módulo Finanzas (config/finanzas.porcentajes
  // es la fuente de verdad; el motor de V.mlm también la refleja).
  function syncMlMConfig(porcentajes) {
    if (!V.mlm || typeof V.mlm.getConfig !== 'function' || typeof V.mlm.guardarConfig !== 'function') {
      return Promise.resolve();
    }
    return V.mlm.getConfig().then(function (mcfg) {
      var mlmEnabled = mcfg ? mcfg.mlmEnabled : true;
      return V.mlm.guardarConfig({ mlmEnabled: mlmEnabled, porcentajes: (porcentajes || cfg.porcentajes) })
        .catch(function () { /* best-effort */ });
    }).catch(function () { /* best-effort */ });
  }

  function guardarConfig(partial) {
    if (!V.db) return Promise.reject(new Error('Firestore no disponible.'));
    var next = {
      finanzasEnabled: partial.finanzasEnabled == null ? DEFAULT_CONFIG.finanzasEnabled : !!partial.finanzasEnabled,
      porcentajeCoordinador: normalizePctCoord(partial.porcentajeCoordinador),
      porcentajes: normalizePorcentajes(partial.porcentajes !== undefined ? partial.porcentajes : (cfg ? cfg.porcentajes : DEFAULT_CONFIG.porcentajes)),
      porcentajeCaja: normalizeCaja(partial.porcentajeCaja !== undefined ? partial.porcentajeCaja : (cfg ? cfg.porcentajeCaja : DEFAULT_CONFIG.porcentajeCaja)),
      categorias: normalizeCategorias(partial.categorias || (cfg ? cfg.categorias : DEFAULT_CONFIG.categorias))
    };
    return V.db.collection('config').doc(CONFIG_DOC).set(next)
      .then(function () {
        cfg = next;
        cfgPromise = null;
        applyFinanzasUiState();
        return syncMlMConfig(next.porcentajes).then(function () { return cfg; });
      });
  }

  function categoriasActivas() {
    return (cfg && cfg.categorias ? cfg.categorias : []).filter(function (c) { return c.activa; });
  }
  function categoriasDeTipo(tipo, soloActivas) {
    return (cfg && cfg.categorias ? cfg.categorias : []).filter(function (c) {
      if (soloActivas && !c.activa) return false;
      return c.tipo === tipo;
    });
  }
  function categoriaById(id) {
    var list = cfg && cfg.categorias ? cfg.categorias : [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function tipoLabel(t) {
    if (t === TIPO_DIRECTO || t === 'solidario') return ETIQUETA_DIRECTO;
    if (t === 'grupo') return 'Ofrenda de grupo';
    if (t === 'ofrenda') return 'Ofrenda';
    if (t === 'aporte') return 'Aporte (MLM)';
    if (t === 'manual') return 'Asignación manual';
    if (t === 'usuario') return ETIQUETA_USUARIO;
    if (t === 'comunidad') return ETIQUETA_COMUNIDAD;
    return 'Aporte personal';
  }
  // Una categoría es solidaria cuando su tipo se declaró como tal o cuando su
  // nombre identifica una ofrenda directa. En ambos casos el dinero NO se
  // reparte entre Bolsa MLM y Caja Mayor: va 100% al destinatario.
  function esCategoriaSolidaria(cat) {
    if (!cat) return false;
    if (String(cat.tipo) === 'solidario' || String(cat.tipo) === TIPO_DIRECTO) return true;
    var n = String(cat.nombre == null ? '' : cat.nombre).toLowerCase();
    return n.indexOf('solidar') !== -1
      || n.indexOf('ofrenda directa') !== -1
      || n.indexOf('aporte directo') !== -1;
  }
  function esTxDirecta(tx) {
    if (!tx) return false;
    if (String(tx.tipo) === TIPO_DIRECTO || String(tx.tipo) === 'solidario') return true;
    if (tx.beneficiarioId) return true;
    return esCategoriaSolidaria(categoriaById(tx.categoriaId));
  }
  function estadoNormalizado(e) {
    var s = String(e == null ? '' : e).trim().toLowerCase();
    // Compatibilidad con estados anteriores: "liquidada"/"pagado" eran el
    // equivalente operativo de "asignado"; "pendiente"/"registrada" de
    // "registrado". Los documentos nuevos usan SOLO los dos estados base.
    if (s === ESTADO_ASIGNADO || s === 'asignada' || s === 'liquidada' || s === 'liquidado'
      || s === 'aprobada' || s === 'aprobado' || s === 'pagado' || s === 'pagada') {
      return ESTADO_ASIGNADO;
    }
    if (s === 'anulada' || s === 'anulado' || s === 'cancelada' || s === 'cancelado') return 'anulada';
    return ESTADO_REGISTRADO;
  }
  function estadoLabel(e) {
    var n = estadoNormalizado(e);
    if (n === 'anulada') return 'Anulada';
    return n === ESTADO_ASIGNADO ? 'Asignado' : 'Registrado';
  }
  function estadoLabelTx(tx) {
    return estadoLabel(tx && tx.estado);
  }
  function estadoPillClsTx(tx) {
    return estadoPillCls(tx && tx.estado);
  }
  function opcionesEstado(incluirTodos) {
    var opts = incluirTodos ? [{ value: '', label: 'Todos los estados' }] : [];
    ESTADOS_TRANSACCION.forEach(function (e) { opts.push({ value: e.value, label: e.label }); });
    return opts;
  }
  function nombreBeneficiario(tx) {
    if (!tx) return '';
    var id = tx.beneficiarioId ? String(tx.beneficiarioId) : '';
    if (tx.beneficiarioNombre) return String(tx.beneficiarioNombre);
    if (id === FONDO_CAJA_ID) return FONDO_CAJA_NOMBRE;
    var u = id ? usuarioById(id) : null;
    return u ? nombreUsuario(u) : (id || '');
  }
  // Campos de verificación del beneficiado. Se aceptan los nombres nuevos
  // (beneficiario*) y los alias antiguos para que la trazabilidad siga
  // visible en documentos ya registrados.
  function telefonoBeneficiario(tx) {
    if (!tx) return '';
    return String(tx.beneficiarioTelefono || tx.telefonoBeneficiario || '').trim();
  }
  function notasVerificacionBeneficiario(tx) {
    if (!tx) return '';
    return String(tx.beneficiarioNotasVerificacion || tx.notasVerificacion
      || tx.notasBeneficiario || '').trim();
  }
  function detalleBeneficiario(tx) {
    var partes = [];
    var tel = telefonoBeneficiario(tx);
    var notas = notasVerificacionBeneficiario(tx);
    if (tel) partes.push('Tel: ' + tel);
    if (notas) partes.push('Verificación: ' + notas);
    return partes.join(' · ');
  }
  function nombreDonante(tx) {
    if (!tx) return '';
    if (tx.donanteNombre) return String(tx.donanteNombre);
    var id = tx.donanteId || tx.userId;
    var u = id ? usuarioById(id) : null;
    return u ? nombreUsuario(u) : (id || '');
  }

  /* ─── PARÁMETROS DE LA BOLSA DE COMISIONES Y CAJA MAYOR ────── */
  // Porcentajes vigentes de la red (lectura dinámica): se leen de la
  // configuración propia y, en ausencia, del motor MLM / valores por
  // defecto. Cualquier modificación del panel de ajustes se refleja
  // automáticamente en todos los cálculos y reportes.
  function pctsMlm() {
    if (cfg && cfg.porcentajes) return cfg.porcentajes;
    if (V.mlm && V.mlm._initialConfig && V.mlm._initialConfig.porcentajes) {
      return V.mlm._initialConfig.porcentajes;
    }
    return DEFAULT_CONFIG.porcentajes;
  }
  function bolsaTotalPct() {
    var p = pctsMlm();
    var sum = 0;
    for (var i = 1; i <= 5; i++) sum += Number(p[i]) || 0;
    return sum;
  }
  function cajaPctVigente() {
    return Math.max(0, 100 - bolsaTotalPct());
  }
  // Distribución de UNA transacción con los porcentajes vigentes.
  // Las ofrendas directas/solidarias no se fraccionan: el 100% es para el
  // destinatario y no alimenta la Bolsa de Comisiones ni la Caja Mayor.
  function distribucionTx(tx) {
    var monto = Number(tx && tx.monto) || 0;
    if (esTxDirecta(tx)) {
      return {
        directo: true,
        pctBolsa: 0,
        pctCaja: 0,
        pctDestinatario: 100,
        montoBolsa: 0,
        montoCaja: 0,
        montoDestinatario: redondear(monto),
        montoDirecto: redondear(monto)
      };
    }
    var bolsaPct = bolsaTotalPct();
    var cajaPct = Math.max(0, 100 - bolsaPct);
    return {
      directo: false,
      pctBolsa: bolsaPct,
      pctCaja: cajaPct,
      pctDestinatario: 0,
      montoBolsa: redondear(monto * bolsaPct / 100),
      montoCaja: redondear(monto * cajaPct / 100),
      montoDestinatario: 0,
      montoDirecto: 0
    };
  }

  /* ─── CACHE DE DATOS ───────────────────────────────────────── */
  function loadComunidades(forzar) {
    if (!V.db) return Promise.resolve([]);
    if (comunidadesCache.length && !forzar) return Promise.resolve(comunidadesCache);
    return V.db.collection(V.COL_COMUNIDADES).get()
      .then(function (snap) {
        comunidadesCache = [];
        snap.forEach(function (doc) {
          var d = doc.data() || {};
          d.id = doc.id;
          comunidadesCache.push(d);
        });
        comunidadesCache.sort(function (a, b) { return (a.nombre || '').localeCompare(b.nombre || ''); });
        return comunidadesCache;
      })
      .catch(function () { return []; });
  }
  function comunidadById(id) {
    for (var i = 0; i < comunidadesCache.length; i++) if (comunidadesCache[i].id === id) return comunidadesCache[i];
    return null;
  }
  function misComunidades(uid) {
    return comunidadesCache.filter(function (c) { return c.coordinadorId === uid; });
  }

  /* ─── COMUNIDADES SIN DUPLICADOS PARA LOS SELECTORES ─────────
     Firestore no impide que existan dos documentos con el mismo
     nombre (ids distintos) ni que una misma comunidad llegue dos
     veces al desplegable. Cada entrada repetida se pintaría como
     una fila idéntica e indistinguible en el menú, y el usuario no
     podría saber cuál está escogiendo. Este filtro deja UNA sola
     fila por comunidad: primero descarta las repeticiones por id y
     después fusiona las que comparten nombre normalizado (minúsculas,
     sin acentos y sin espacios redundantes).

     Ante un choque por nombre sobrevive, en este orden:
       1) el id recibido en `preferidoId` — la comunidad a la que ya
          apunta la transacción que se está editando, que de otro modo
          quedaría huérfana del desplegable. Este criterio es ABSOLUTO
          y no depende del orden de Firestore: se localiza su clave de
          nombre en una primera pasada y ninguna otra gemela de esa
          misma clave puede desplazarla.
       2) la que tiene coordinador asignado — la única con la que la
          liquidación de ofrendas puede operar,
       3) la primera encontrada. */
  var _ACENTOS_COM = {
    'á': 'a', 'à': 'a', 'ä': 'a', 'â': 'a', 'ã': 'a',
    'é': 'e', 'è': 'e', 'ë': 'e', 'ê': 'e',
    'í': 'i', 'ì': 'i', 'ï': 'i', 'î': 'i',
    'ó': 'o', 'ò': 'o', 'ö': 'o', 'ô': 'o', 'õ': 'o',
    'ú': 'u', 'ù': 'u', 'ü': 'u', 'û': 'u',
    'ñ': 'n', 'ç': 'c'
  };
  function claveNombreCom(nombre) {
    // El aplanado a minúsculas va ANTES de quitar los acentos: el mapa solo
    // tiene claves en minúscula, de modo que una vocal acentuada en
    // mayúscula no encontraría su equivalencia y las dos grafías ("Ñandú"
    // y "nandu") no se fundirían en la misma clave.
    var s = String(nombre == null ? '' : nombre).toLowerCase()
      .replace(/[\u00C0-\u017F]/g, function (ch) { return _ACENTOS_COM[ch] || ch; });
    return s.replace(/\s+/g, ' ').trim();
  }
  function comunidadesUnicas(lista, preferidoId) {
    var porId = {};   // evita repetir el mismo id aunque cambie la clave del objeto
    var porNombre = {};
    var out = [];
    var pref = (preferidoId == null || preferidoId === '') ? null : String(preferidoId);
    var clavePref = null;
    // Primera pasada: la clave de nombre de la comunidad preferida. Sin esto
    // la prioridad dependería del orden de Firestore y una gemela posterior
    // con coordinador la dejaría fuera del desplegable.
    (lista || []).forEach(function (c) {
      if (pref !== null && c && c.id != null && String(c.id) === pref) {
        var k = claveNombreCom(c.nombre);
        if (k) clavePref = k;
      }
    });
    (lista || []).forEach(function (c) {
      if (!c || c.id == null) return;
      var id = String(c.id);
      if (porId['id:' + id]) return;
      porId['id:' + id] = true;
      var clave = claveNombreCom(c.nombre);
      // Sin nombre no hay nada que comparar: la fila solo se deduplica por id.
      if (!clave) { out.push(c); return; }
      var previa = porNombre[clave];
      if (!previa) { porNombre[clave] = c; out.push(c); return; }
      if (clavePref !== null && clave === clavePref) {
        if (id === pref) { out[out.indexOf(previa)] = c; porNombre[clave] = c; }
        return;               // el resto de gemelas de esa clave se descartan
      }
      if (!previa.coordinadorId && c.coordinadorId) {
        out[out.indexOf(previa)] = c;   // gana la que tiene coordinador
        porNombre[clave] = c;
      }
    });
    out.sort(function (a, b) { return claveNombreCom(a.nombre).localeCompare(claveNombreCom(b.nombre)); });
    return out;
  }
  function loadUsuarios(force) {
    if (!V.db) return Promise.resolve([]);
    if (usuariosCache.length && !force) return Promise.resolve(usuariosCache);
    return V.db.collection(V.COL_USUARIOS).get()
      .then(function (snap) {
        usuariosCache = [];
        snap.forEach(function (doc) { var d = doc.data() || {}; d.uid = doc.id; usuariosCache.push(d); });
        return usuariosCache;
      })
      .catch(function () { return []; });
  }
  function usuarioById(uid) {
    for (var i = 0; i < usuariosCache.length; i++) if (usuariosCache[i].uid === uid) return usuariosCache[i];
    return null;
  }
  // La trazabilidad se apoya SIEMPRE en el uid de Firebase Auth. El nombre o
  // el correo son solo datos de presentación: nunca identifican al usuario
  // contable. Estas funciones centralizan la comparación para evitar que una
  // coincidencia de texto asigne dinero a la persona equivocada.
  function uidDe(raw) {
    return String(raw == null ? '' : raw).trim();
  }
  function mismoUid(a, b) {
    var ua = uidDe(a);
    return !!ua && ua === uidDe(b);
  }
  function usuarioPorUid(raw) {
    var uid = uidDe(raw);
    return uid ? usuarioById(uid) : null;
  }
  function uidValidoDeUsuario(raw, campo) {
    var uid = uidDe(raw);
    if (!uid) throw new Error('Selecciona ' + campo + ' desde la lista de usuarios.');
    if (!usuarioPorUid(uid)) {
      throw new Error('El uid seleccionado para ' + campo + ' no existe en la plataforma.');
    }
    return uid;
  }

  /* ─── CUENTAS BANCARIAS / BILLETERAS ─────────────────────────
     Catálogo de cuentas del proyecto. Cada cuenta tiene SOLO dos campos
     de negocio:
       banco  → texto descriptivo que incluye el tipo (ej. "Bancolombia
                Ahorros", "Nequi").
       numero → número de cuenta o de billetera.
      Seguridad (firestore.rules): lectura, creación, edición y borrado
      para 'contable' y 'superadmin' (los dos roles que administran
      finanzas). La UI de gestión se monta solo si isAdminUser(); el
      backend rechaza cualquier escritura de otro rol aunque se
      manipule el cliente. */
  function loadCuentas(forzar) {
    if (!V.db) return Promise.resolve([]);
    // El control de rol va ANTES de servir la caché: si no, una sesión que
    // heredara la caché de un superadmin (cambio de rol sin recargar) vería
    // el catálogo sin pasar por la regla de acceso. Solo superadmin y gestor
    // pueden leer la colección; para el resto se evita la consulta (daría
    // PERMISSION_DENIED) y se devuelve una lista vacía, que es lo que debe
    // ver su interfaz.
    if (!puedeLeerCuentas()) return Promise.resolve([]);
    if (cuentasCache.length && !forzar) return Promise.resolve(cuentasCache);
    return V.db.collection(COL_CUENTAS).get()
      .then(function (snap) {
        cuentasCache = [];
        snap.forEach(function (doc) {
          var d = doc.data() || {};
          cuentasCache.push({
            id: doc.id,
            banco: String(d.banco == null ? '' : d.banco),
            numero: String(d.numero == null ? '' : d.numero)
          });
        });
        cuentasCache.sort(function (a, b) {
          var c = a.banco.localeCompare(b.banco);
          return c !== 0 ? c : a.numero.localeCompare(b.numero);
        });
        return cuentasCache;
      })
      .catch(function () { return []; });
  }
  function cuentaById(id) {
    if (!id) return null;
    for (var i = 0; i < cuentasCache.length; i++) {
      if (cuentasCache[i].id === String(id)) return cuentasCache[i];
    }
    return null;
  }
  // Normaliza y valida los dos campos mínimos. Lanza Error con un mensaje
  // apto para mostrar en un toast cuando falta alguno.
  function normalizarCuenta(datos) {
    var banco = String(datos && datos.banco != null ? datos.banco : '').trim();
    var numero = String(datos && datos.numero != null ? datos.numero : '').trim();
    if (!banco) throw new Error('Escribe el banco o billetera (ej. Bancolombia Ahorros, Nequi).');
    if (!numero) throw new Error('Escribe el número de cuenta o de billetera.');
    return { banco: banco, numero: numero };
  }
  function crearCuentaBanco(datos) {
    if (!isAdminUser()) return Promise.reject(new Error('Solo el superadmin o el contable pueden crear cuentas.'));
    if (!V.db) return Promise.reject(new Error('Firestore no disponible.'));
    var cuenta;
    try { cuenta = normalizarCuenta(datos); } catch (e) { return Promise.reject(e); }
    cuenta.creadoPor = V.userId;
    cuenta.creadoEn = new Date().toISOString();
    return V.db.collection(COL_CUENTAS).add(cuenta).then(function (ref) {
      cuentasCache = [];
      return ref.id;
    });
  }
  function editarCuentaBanco(id, datos) {
    if (!isAdminUser()) return Promise.reject(new Error('Solo el superadmin o el contable pueden editar cuentas.'));
    if (!V.db || !id) return Promise.reject(new Error('Cuenta no válida.'));
    var cuenta;
    try { cuenta = normalizarCuenta(datos); } catch (e) { return Promise.reject(e); }
    return V.db.collection(COL_CUENTAS).doc(id).set({
      banco: cuenta.banco,
      numero: cuenta.numero,
      actualizadoPor: V.userId,
      actualizadoEn: new Date().toISOString()
    }, { merge: true }).then(function () {
      cuentasCache = [];
      return id;
    });
  }
  function eliminarCuentaBanco(id) {
    if (!isAdminUser()) return Promise.reject(new Error('Solo el superadmin o el contable pueden eliminar cuentas.'));
    if (!V.db || !id) return Promise.reject(new Error('Cuenta no válida.'));
    return V.db.collection(COL_CUENTAS).doc(id).delete().then(function () {
      cuentasCache = [];
    });
  }

  /* ─── MOTOR DE COMISIONES (lectura dinámica de porcentajes) ──
     Calcula la distribución exacta de la bolsa MLM para una
     transacción con LOS PORCENTAJES VIGENTES de config/finanzas:

       tipo 'aporte' (origen usuario): N1→patrocinador directo,
         N2→su patrocinador, etc. (cadena ascendente del aportante).
       tipo 'grupo' (origen comunidad): N1→coordinador de la
         comunidad (compensación), N2..N5→cadena ascendente del
         coordinador.

     Devuelve [{ userId, nivel, porcentaje, monto }].              */
  function calcularComisionesTx(tx) {
    // Ofrenda directa / solidaria: el 100% va al destinatario, sin comisiones.
    if (esTxDirecta(tx)) return Promise.resolve([]);
    if (!V.db || !tx || !tx.userId || !V.mlm || typeof V.mlm.calcularPayloadCon !== 'function') {
      return Promise.resolve([]);
    }
    var monto = Number(tx.monto) || 0;
    if (!(monto > 0)) return Promise.resolve([]);
    var esGrupo = String(tx.tipo) === 'grupo';
    var pcts = pctsMlm();
    var evento = {
      userId: String(tx.userId),
      monto: monto,
      concepto: tx.concepto || tx.categoriaId || '',
      fecha: tx.fecha || new Date().toISOString()
    };
    return V.mlm.calcularPayloadCon(evento, pcts).then(function (payload) {
      var out = [];
      if (esGrupo) {
        var l1 = Number(pcts[1]) || 0;
        if (l1 > 0) out.push({ userId: String(tx.userId), nivel: 1, porcentaje: l1, monto: redondear(monto * l1 / 100) });
        (payload.comisiones || []).forEach(function (c) {
          var nl = Number(c.nivel) + 1;
          var pct = Number(pcts[nl]) || 0;
          if (!(pct > 0)) return;
          out.push({ userId: String(c.userId), nivel: nl, porcentaje: pct, monto: redondear(monto * pct / 100) });
        });
        return out;
      }
      (payload.comisiones || []).forEach(function (c) {
        if (!(Number(c.monto) > 0)) return;
        out.push({ userId: String(c.userId), nivel: Number(c.nivel) || 0, porcentaje: Number(c.porcentaje) || 0, monto: redondear(c.monto) });
      });
      return out;
    }).catch(function () { return []; });
  }

  // Persiste en finanzas_comisiones la distribución calculada para una
  // transacción ya registrada (origenId = id de la transacción). Es
  // tolerante a fallos: si una escritura falla se entrega lo ya escrito.
  function liquidarComisionesTx(tx, txId) {
    if (!V.db || !txId) return Promise.resolve(null);
    return calcularComisionesTx(tx).then(function (comisiones) {
      if (!comisiones.length) return null;
      var fecha = tx.fecha || new Date().toISOString();
      var tipo = String(tx.tipo) === 'grupo' ? 'grupo' : 'aporte';
      return Promise.all(comisiones.map(function (c) {
        return V.db.collection(COL_COMIS).add({
          userId: c.userId,
          origenId: txId,
          tipo: tipo,
          nivel: Number(c.nivel) || 0,
          porcentaje: Number(c.porcentaje) || 0,
          monto: Number(c.monto) || 0,
          fecha: fecha,
          comunidadId: tx.comunidadId || '',
          creadoPor: V.userId
        })
          .then(function () { return true; })
          .catch(function () { return null; });
      }));
    }).catch(function () { return null; });
  }

  function eliminarComisionesDe(origenId) {
    if (!V.db || !origenId) return Promise.resolve();
    return V.db.collection(COL_COMIS).where('origenId', '==', origenId).get()
      .then(function (snap) {
        var ops = [];
        snap.forEach(function (doc) { ops.push(doc.ref.delete().catch(function () {})); });
        return Promise.all(ops);
      })
      .catch(function () { return null; });
  }

  // Compatibilidad con liquidación anterior de aportes personales.
  function liquidarComisionesAporte(tx, txId) {
    return liquidarComisionesTx(tx, txId);
  }

  /* ─── CONSTRUCCIÓN DE TRANSACCIONES ──────────────────────────
     prepararTransaccion(datos):
       origen 'usuario'   → etiqueta "Aporte de Usuario", tipo = cat.tipo
       origen 'comunidad' → etiqueta "Ofrenda de Comunidad", tipo 'grupo'
     Se exige la referencia correcta (userId o comunidadId) y se calcula
     la distribución de bolsa/caja con los porcentajes vigentes.       */
  function prepararTransaccion(datos) {
    var cat = categoriaById(datos.categoriaId);
    if (!cat) throw new Error('Selecciona una categoría válida.');
    var monto = redondear(Number(datos.monto) || 0);
    if (!(monto > 0)) throw new Error('Escribe un monto válido mayor a cero.');

      var esDirecto = datos.esDirecto === true
        || String(datos.tipo) === TIPO_DIRECTO
        || esCategoriaSolidaria(cat);
    var origen = datos.origen === 'comunidad' ? 'comunidad' : 'usuario';
    var comunidadId = (datos.comunidadId && String(datos.comunidadId)) || '';
    var userId = '';
    var beneficiarioId = '';
    var tipo = cat.tipo;

    if (esDirecto) {
      origen = 'usuario';
      comunidadId = '';
      userId = uidValidoDeUsuario(datos.donanteId || datos.userId, 'el usuario donante de la ofrenda directa');
      beneficiarioId = uidDe(datos.beneficiarioId);
      if (!beneficiarioId) throw new Error('Selecciona el usuario o fondo beneficiario de la ofrenda directa.');
      if (beneficiarioId !== FONDO_CAJA_ID) {
        beneficiarioId = uidValidoDeUsuario(beneficiarioId, 'el usuario beneficiario');
      }
      if (beneficiarioId === userId) throw new Error('El donante y el beneficiario deben ser diferentes.');
      tipo = TIPO_DIRECTO;
    } else if (origen === 'comunidad') {
      if (!comunidadId) throw new Error('Selecciona la comunidad de origen de la ofrenda.');
      var com = comunidadById(comunidadId);
      // El titular contable de la ofrenda es el coordinador (si existe);
      // el superadmin puede sobrescribir el userId de forma explícita
      // (bypass total, sin restricciones de cadenas de patrocinio).
      userId = uidDe(datos.userId) || uidDe(com && com.coordinadorId);
      if (!userId) throw new Error('La comunidad seleccionada no tiene un coordinador vinculado por uid.');
      tipo = 'grupo';
    } else {
      userId = uidValidoDeUsuario(datos.userId, 'el usuario de origen del aporte');
    }

    var fecha;
    if (datos.fecha) {
      var f = new Date(datos.fecha);
      fecha = isNaN(f.getTime()) ? new Date().toISOString() : f.toISOString();
    } else {
      fecha = new Date().toISOString();
    }

    var baseTx = {
      origen: origen,
      origenId: origen === 'comunidad' ? comunidadId : userId,
      etiqueta: esDirecto ? ETIQUETA_DIRECTO : (origen === 'comunidad' ? ETIQUETA_COMUNIDAD : ETIQUETA_USUARIO),
      userId: userId,
      comunidadId: comunidadId,
      categoriaId: cat.id,
      // Cuenta de destino (opcional): id de finanzas_cuentas. Cadena vacía
      // cuando el movimiento no se asocia a una cuenta concreta.
      cuentaId: (datos.cuentaId && String(datos.cuentaId)) || '',
      metodoPago: String(datos.metodoPago || '').trim(),
      referenciaPago: String(datos.referenciaPago || '').trim(),
      comprobanteUrl: urlSegura(datos.comprobanteUrl),
      monto: monto,
      tipo: tipo,
      concepto: (datos.concepto || '').trim(),
      fecha: fecha,
      estado: estadoNormalizado(datos.estado || ESTADO_REGISTRADO),
      creadoPor: V.userId
    };
    if (esDirecto) {
      var uDon = usuarioPorUid(userId);
      var uBen = beneficiarioId === FONDO_CAJA_ID ? null : usuarioPorUid(beneficiarioId);
      var nombreDon = (datos.donanteNombre && String(datos.donanteNombre)) || (uDon ? nombreUsuario(uDon) : '');
      var nombreBen = (datos.beneficiarioNombre && String(datos.beneficiarioNombre)) || '';
      if (!nombreBen) {
        nombreBen = beneficiarioId === FONDO_CAJA_ID
          ? FONDO_CAJA_NOMBRE
          : (uBen ? nombreUsuario(uBen) : '');
      }
      var telBen = String(datos.beneficiarioTelefono || datos.telefonoBeneficiario || '').trim();
      if (!telBen && uBen) telBen = String(uBen.telefono || '').trim();
      baseTx.donanteId = userId;
      baseTx.donanteNombre = nombreDon;
      baseTx.beneficiarioId = beneficiarioId;
      baseTx.beneficiarioNombre = nombreBen;
      baseTx.beneficiarioTelefono = telBen;
      baseTx.beneficiarioNotasVerificacion = String(
        datos.beneficiarioNotasVerificacion || datos.notasVerificacion || ''
      ).trim();
    }
    baseTx.distribucion = distribucionTx(baseTx);
    return baseTx;
  }

  /* ─── CRUD DE TRANSACCIONES ──────────────────────────────────
     BYPASS SUPERADMIN: crear/editar/eliminar cualquier transacción de
     cualquier usuario o comunidad sin restricciones de cadena MLM.   */
  function crearTransaccion(datos) {
    return loadConfig().then(function () {
      if (!isAdminUser()) throw new Error('Solo el superadmin puede registrar transacciones.');
      if (!V.db) throw new Error('Firestore no disponible.');
      var tx = prepararTransaccion(datos);
      return V.db.collection(COL_TRANS).add(tx).then(function (ref) {
        // Solo una transacción "Asignada" reparte la bolsa MLM. Una
        // "Registrada" queda a la espera de verificación administrativa y
        // una ofrenda directa nunca genera comisiones (100% destinatario).
        if (estadoNormalizado(tx.estado) !== ESTADO_ASIGNADO || esTxDirecta(tx)) return ref.id;
        return liquidarComisionesTx(tx, ref.id).then(function () { return ref.id; });
      });
    });
  }

  function editarTransaccion(id, datos) {
    return loadConfig().then(function () {
      if (!isAdminUser()) throw new Error('Solo el superadmin puede editar transacciones.');
      if (!V.db || !id) throw new Error('Transacción no válida.');
      var ref = V.db.collection(COL_TRANS).doc(id);
      return ref.get().then(function (doc) {
        if (!doc.exists) throw new Error('La transacción ya no existe.');
        var tx = prepararTransaccion(datos);
        return ref.set(tx).then(function () {
          // Al cambiar el monto/origen/estado se recalcula la bolsa MLM para
          // mantener la coherencia contable (bypass superadmin). Si vuelve a
          // "Registrado" se retiran las comisiones previamente liquidadas.
          return eliminarComisionesDe(id).then(function () {
            if (estadoNormalizado(tx.estado) !== ESTADO_ASIGNADO || esTxDirecta(tx)) return id;
            return liquidarComisionesTx(tx, id).then(function () { return id; });
          });
        });
      });
    });
  }

  function eliminarTransaccion(id) {
    if (!isAdminUser()) return Promise.reject(new Error('Solo el superadmin puede eliminar transacciones.'));
    if (!V.db || !id) return Promise.reject(new Error('Transacción no válida.'));
    return eliminarComisionesDe(id).then(function () {
      return V.db.collection(COL_TRANS).doc(id).delete();
    });
  }

  // Aporte personal/ofrenda registrado por el propio usuario (o asignado
  // por el superadmin). Al registrarse se liquidan las comisiones MLM de
  // su red con los porcentajes vigentes.
  function registrarAportePersonal(datos) {
    return loadConfig().then(function () {
      if (!isEnabled()) throw new Error('El módulo Finanzas está desactivado.');
      if (!V.db || V.isAnon) throw new Error('Debes tener una cuenta para registrar aportes.');
      var admin = isAdminUser();
      var cat = categoriaById(datos.categoriaId);
      if (!cat) throw new Error('Selecciona una categoría válida.');
      if (esCategoriaSolidaria(cat)) {
        throw new Error('Las ofrendas directas/solidarias se registran desde el formulario de Aporte / Donación para indicar el destinatario.');
      }
      if (cat.tipo === 'grupo' && !admin) throw new Error('Las ofrendas de grupo se liquidan desde "Ofrenda de grupo".');
      var monto = redondear(Number(datos.monto) || 0);
      if (!(monto > 0)) throw new Error('Escribe un monto válido mayor a cero.');

      var comunidadId = '';
      var tipo = cat.tipo;
      var origen = 'usuario';
      var userId = (admin && datos.userId) ? uidDe(datos.userId) : uidDe(V.userId);

      if (admin && (datos.comunidadId || cat.tipo === 'grupo')) {
        origen = 'comunidad';
        comunidadId = (datos.comunidadId && String(datos.comunidadId)) || '';
        if (cat.tipo === 'grupo' && !comunidadId) throw new Error('Selecciona la comunidad de la ofrenda de grupo.');
        var com = comunidadById(comunidadId);
        if (!com) throw new Error('Selecciona una comunidad válida.');
        userId = uidDe(datos.userId) || uidDe(com.coordinadorId);
        if (!userId) throw new Error('La comunidad seleccionada no tiene un coordinador vinculado por uid.');
        tipo = 'grupo';
      }
      if (!userId) throw new Error('Selecciona el usuario de origen del aporte.');

      var tx = {
        origen: origen,
        origenId: origen === 'comunidad' ? comunidadId : userId,
        etiqueta: origen === 'comunidad' ? ETIQUETA_COMUNIDAD : ETIQUETA_USUARIO,
        userId: userId,
        comunidadId: comunidadId,
        categoriaId: cat.id,
        cuentaId: (datos.cuentaId && String(datos.cuentaId)) || '',
        monto: monto,
        tipo: tipo,
        concepto: (datos.concepto || '').trim(),
        fecha: new Date().toISOString(),
        estado: estadoNormalizado((admin && datos.estado) ? datos.estado : ESTADO_REGISTRADO),
        creadoPor: V.userId
      };
      tx.distribucion = distribucionTx(tx);
      return V.db.collection(COL_TRANS).add(tx).then(function (ref) {
        if (estadoNormalizado(tx.estado) !== ESTADO_ASIGNADO || esTxDirecta(tx)) return ref.id;
        return liquidarComisionesTx(tx, ref.id).then(function () { return ref.id; });
      });
    });
  }

  // Reporte de aporte/donación con comprobante, por parte del propio
  // usuario. Admite aporte personal, ofrenda de comunidad y ofrenda directa
  // (donante → usuario/fondo beneficiario). Se crea la transacción en estado
  // 'Registrado' para que administración la verifique y la pase a 'Asignado'.
  // NO liquida comisiones todavía: la bolsa MLM se reparte al asignar.
  // El medio de pago, la cuenta, la referencia, la imagen del comprobante,
  // el teléfono y las notas de verificación del beneficiario se guardan en
  // el documento para conservar la trazabilidad solidaria.
  function reportarAportePendiente(datos) {
    return loadConfig().then(function () {
      if (!isEnabled()) throw new Error('El módulo Finanzas está desactivado.');
      if (!V.db || V.isAnon || !V.userId) throw new Error('Debes tener una cuenta para reportar un aporte.');
      var monto = redondear(Number(datos.monto) || 0);
      if (!(monto > 0)) throw new Error('Escribe un monto válido mayor a cero.');
      var metodo = String(datos.metodoPago || datos.metodo || '').trim();
      if (!metodo) throw new Error('Selecciona el medio de pago que usaste.');
      var referencia = String(datos.referencia || '').trim();
      if (!referencia) throw new Error('Escribe la referencia o número de comprobante.');
      var cat = categoriaById(datos.categoriaId) || categoriasActivas()[0];
      if (!cat) throw new Error('No hay categorías de aporte disponibles.');

    var esDirecto = datos.esDirecto === true
      || String(datos.tipo) === TIPO_DIRECTO
      || esCategoriaSolidaria(cat);
      var origen = datos.origen === 'comunidad' ? 'comunidad' : 'usuario';
      var comunidadId = '';
      var beneficiarioId = '';
      var tipo = 'personal';
      var etiqueta = ETIQUETA_USUARIO;
      if (esDirecto) {
        beneficiarioId = uidDe(datos.beneficiarioId);
        if (!beneficiarioId) throw new Error('Selecciona el usuario o fondo beneficiario.');
        if (beneficiarioId !== FONDO_CAJA_ID) {
          beneficiarioId = uidValidoDeUsuario(beneficiarioId, 'el usuario beneficiario');
        }
        if (mismoUid(beneficiarioId, V.userId)) throw new Error('El donante y el beneficiario deben ser diferentes.');
        tipo = TIPO_DIRECTO;
        etiqueta = ETIQUETA_DIRECTO;
      } else if (origen === 'comunidad') {
        comunidadId = String(datos.comunidadId || '');
        if (!comunidadId) throw new Error('Selecciona la comunidad de la ofrenda.');
        tipo = 'grupo';
        etiqueta = ETIQUETA_COMUNIDAD;
      }

      var tx = {
        origen: origen,
        origenId: origen === 'comunidad' ? comunidadId : V.userId,
        etiqueta: etiqueta,
        userId: V.userId,
        comunidadId: comunidadId,
        categoriaId: cat.id,
        cuentaId: (datos.cuentaId && String(datos.cuentaId)) || '',
        monto: monto,
        tipo: tipo,
        concepto: (datos.concepto || '').trim(),
        metodoPago: metodo,
        referenciaPago: referencia,
        comprobanteUrl: urlSegura(datos.comprobanteUrl),
        fecha: new Date().toISOString(),
        estado: ESTADO_REGISTRADO,
        creadoPor: V.userId
      };
      if (esDirecto) {
        var uBen = beneficiarioId === FONDO_CAJA_ID ? null : usuarioPorUid(beneficiarioId);
        var telBen = String(datos.beneficiarioTelefono || datos.telefonoBeneficiario || '').trim();
        if (!telBen && uBen) telBen = String(uBen.telefono || '').trim();
        tx.donanteId = uidDe(V.userId);
        tx.donanteNombre = nombreUsuario(V.currentUser) || uidDe(V.userId);
        tx.beneficiarioId = beneficiarioId;
        tx.beneficiarioNombre = beneficiarioId === FONDO_CAJA_ID
          ? FONDO_CAJA_NOMBRE
          : (uBen ? nombreUsuario(uBen) : (datos.beneficiarioNombre || ''));
        tx.beneficiarioTelefono = telBen;
        tx.beneficiarioNotasVerificacion = String(
          datos.beneficiarioNotasVerificacion || datos.notasVerificacion || ''
        ).trim();
      }
      tx.distribucion = distribucionTx(tx);
      return V.db.collection(COL_TRANS).add(tx).then(function (ref) { return ref.id; });
    });
  }

  // Solo http(s): el comprobante se muestra como enlace en el panel admin.
  function urlSegura(raw) {
    var u = String(raw || '').trim();
    if (!u) return '';
    if (/^https?:\/\//i.test(u)) return u;
    return '';
  }

  // Número de WhatsApp de soporte (config/whatsapp). El core lo mantiene en
  // vivo con una suscripción; aquí solo se consume al abrir el chat.
  function numeroWhatsApp() {
    var raw = typeof V.getWhatsAppNumero === 'function' ? V.getWhatsAppNumero() : '';
    return String(raw || '').replace(/\D/g, '');
  }
  function abrirWhatsApp(mensaje) {
    var numero = numeroWhatsApp();
    if (!numero) {
      V.toast('El WhatsApp de soporte aún no está configurado. Contacta a administración.', true);
      return false;
    }
    window.open('https://wa.me/' + numero + '?text=' + encodeURIComponent(mensaje || ''), '_blank', 'noopener');
    return true;
  }

  // Liquidación de una ofrenda de grupo desde Comunidades: transacción a
  // nombre del coordinador, con su comisión N1 + red N2–N5.
  function liquidarOfrendaGrupo(datos) {
    return loadConfig().then(function () {
      if (!isEnabled()) throw new Error('El módulo Finanzas está desactivado.');
      if (!V.db) throw new Error('Firestore no disponible.');
      var com = comunidadById(datos.comunidadId);
      if (!com) throw new Error('Selecciona una comunidad.');
      if (!com.coordinadorId) throw new Error('La comunidad seleccionada no tiene coordinador asignado.');
      var tx = prepararTransaccion({
        origen: 'comunidad',
        comunidadId: com.id,
        userId: com.coordinadorId,
        categoriaId: datos.categoriaId,
        monto: datos.monto,
        concepto: datos.concepto,
        fecha: datos.fecha || new Date().toISOString(),
        estado: ESTADO_ASIGNADO
      });
      return V.db.collection(COL_TRANS).add(tx)
        .then(function (ref) { return liquidarComisionesTx(tx, ref.id).then(function () { return ref.id; }); });
    });
  }

  /* ─── CONSULTAS ────────────────────────────────────────────── */
  function todasTransacciones() {
    if (!V.db) return Promise.resolve([]);
    var q = isAdminUser()
      ? V.db.collection(COL_TRANS).get()
      : V.db.collection(COL_TRANS).where('userId', '==', V.userId).get();
    return q.then(function (snap) {
      var rows = [];
      snap.forEach(function (doc) { var d = doc.data() || {}; d.id = doc.id; rows.push(d); });
      rows.sort(function (a, b) { return (b.fecha || '').localeCompare(a.fecha || ''); });
      return rows;
    }).catch(function () { return []; });
  }

  function misTransacciones() {
    return todasTransacciones();
  }

  function transaccionesRecibidasDirectas() {
    if (!V.db || !V.userId) return Promise.resolve([]);
    return V.db.collection(COL_TRANS).where('beneficiarioId', '==', V.userId).get()
      .then(function (snap) {
        var rows = [];
        snap.forEach(function (doc) { var d = doc.data() || {}; d.id = doc.id; rows.push(d); });
        rows.sort(function (a, b) { return (b.fecha || '').localeCompare(a.fecha || ''); });
        return rows;
      })
      .catch(function () { return []; });
  }

  function todasComisiones() {
    if (!V.db) return Promise.resolve([]);
    var q = isAdminUser()
      ? V.db.collection(COL_COMIS).get()
      : V.db.collection(COL_COMIS).where('userId', '==', V.userId).get();
    return q.then(function (snap) {
      var rows = [];
      snap.forEach(function (doc) { var d = doc.data() || {}; d.id = doc.id; rows.push(d); });
      rows.sort(function (a, b) { return (b.fecha || '').localeCompare(a.fecha || ''); });
      return rows;
    }).catch(function () { return []; });
  }

  function misComisiones() {
    return todasComisiones();
  }

  /* ─── DESEMBOLSOS / PAGOS A USUARIOS ──────────────────────────
     SEPARACIÓN CONTABLE ESTRICTA:
       · El pago se descuenta SOLO del saldo de comisiones del usuario
         (que es parte de la Bolsa de Comisiones): la bolsa generada es
         Σ finanzas_comisiones; lo pagado es Σ finanzas_pagos.
       · La Caja Mayor (reserva para el sostenimiento y operación del
         proyecto) NO se toca: cada pago registra origen 'bolsa' y nunca
         referencia la caja.
       · Cada egreso guarda constancia del banco y número de cuenta.   */
  function todosPagos() {
    if (!V.db) return Promise.resolve([]);
    var q = isAdminUser()
      ? V.db.collection(COL_PAGOS).get()
      : V.db.collection(COL_PAGOS).where('userId', '==', V.userId).get();
    return q.then(function (snap) {
      var rows = [];
      snap.forEach(function (doc) { var d = doc.data() || {}; d.id = doc.id; rows.push(d); });
      rows.sort(function (a, b) { return (b.fecha || '').localeCompare(a.fecha || ''); });
      return rows;
    }).catch(function () { return []; });
  }
  function misPagos() {
    return todosPagos();
  }

  /* ─── CONSULTAS DEL ROL AVANZADO (su propia red) ──────────────
     Las reglas (esMiArbolFin) ya restringen cada documento a la red del
     lector, así que aquí solo hay que pedir los uids de esa red. Se obtienen
     con loadUsuarios(), cuya consulta completa devuelve, para un usuario sin
     rol de gestión, únicamente los perfiles que las reglas permiten: él mismo,
     sus descendientes y su upline. Se resuelve UNA vez y se reutiliza para las
     tres colecciones: forzar la caché por colección multiplicaría las lecturas
     de usuarios sin aportar nada.

     El operador `in` admite como máximo 30 valores, por lo que una red de
     más de 30 personas se consulta en varios lotes y se fusiona el resultado
     (duplicados descartados por id). */
  var TROZO_IN = 30;

  function uidsDeMiRed() {
    if (!V.db || !V.userId) return Promise.resolve([]);
    return loadUsuarios(true).then(function (lista) {
      return lista.map(function (u) { return u.uid; }).filter(function (uid) { return !!uid; });
    });
  }

  function consultarPorUids(coleccion, uids) {
    if (!V.db) return Promise.resolve([]);
    if (!uids.length) return Promise.resolve([]);
    var lotes = [];
    for (var i = 0; i < uids.length; i += TROZO_IN) {
      lotes.push(V.db.collection(coleccion).where('userId', 'in', uids.slice(i, i + TROZO_IN)).get());
    }
    return Promise.all(lotes).then(function (snaps) {
      var porId = {};
      snaps.forEach(function (snap) {
        snap.forEach(function (doc) {
          if (porId[doc.id]) return;
          var d = doc.data() || {};
          d.id = doc.id;
          porId[doc.id] = d;
        });
      });
      var rows = Object.keys(porId).map(function (k) { return porId[k]; });
      rows.sort(function (a, b) { return (b.fecha || '').localeCompare(a.fecha || ''); });
      return rows;
    }).catch(function () { return []; });
  }
  function sumarMontos(lista) {
    var total = 0;
    (lista || []).forEach(function (d) { total += Number(d.monto) || 0; });
    return redondear(total);
  }
  // Saldo de comisiones disponible de un usuario: generado − pagado.
  function saldoComisionesDe(uid, comisiones, pagos) {
    var delUser = (comisiones || []).filter(function (c) { return String(c.userId) === String(uid); });
    var pagUser = (pagos || []).filter(function (p) { return String(p.userId) === String(uid); });
    return redondear(sumarMontos(delUser) - sumarMontos(pagUser));
  }
  // Bolsa de Comisiones disponible (global): generada − pagada.
  function bolsaComisionesDisponible(comisiones, pagos) {
    return redondear(sumarMontos(comisiones) - sumarMontos(pagos));
  }

  // Registra un Desembolso/Pago a usuario contra su saldo de comisiones
  // (Bolsa de Comisiones). Solo el superadmin. Valida banco/número de
  // cuenta, monto > 0 y que el saldo del usuario y la bolsa alcancen.
  function registrarDesembolso(datos) {
    if (!isAdminUser()) return Promise.reject(new Error('Solo el superadmin puede registrar desembolsos.'));
    if (!V.db) return Promise.reject(new Error('Firestore no disponible.'));
    var uid = datos && datos.userId ? String(datos.userId) : '';
    if (!uid) return Promise.reject(new Error('Selecciona el usuario destinatario del pago.'));
    var monto = redondear(Number(datos.monto) || 0);
    if (!(monto > 0)) return Promise.reject(new Error('Escribe un monto válido mayor a cero.'));

    function snapRows(snap) {
      var rows = [];
      snap.forEach(function (doc) { var d = doc.data() || {}; d.id = doc.id; rows.push(d); });
      return rows;
    }

    return Promise.all([V.db.collection(COL_COMIS).get(), V.db.collection(COL_PAGOS).get()])
      .then(function (res) {
        var comisionesTodas = snapRows(res[0]);
        var pagosTodas = snapRows(res[1]);
        return V.db.collection(V.COL_USUARIOS).doc(uid).get().then(function (doc) {
          var user = doc.exists ? doc.data() : {};
          var banco = (datos.banco || '').trim() || (user.banco || '');
          var numero = (datos.numeroCuenta || '').trim() || (user.numeroCuenta || '');
          if (!banco) return Promise.reject(new Error('El usuario no tiene banco asignado. Completa sus datos bancarios en el perfil o ingrésalos aquí.'));
          if (!numero) return Promise.reject(new Error('El usuario no tiene número de cuenta/celular. Completa sus datos bancarios o ingrésalos aquí.'));

          var saldo = saldoComisionesDe(uid, comisionesTodas, pagosTodas);
          if (monto > saldo) {
            return Promise.reject(new Error('El monto supera el saldo de comisiones de ' + (user.nombre || '') + '. Disponible: ' + fmtMoneda(saldo)));
          }
          var bolsa = bolsaComisionesDisponible(comisionesTodas, pagosTodas);
          if (monto > bolsa) {
            return Promise.reject(new Error('El monto supera la bolsa de comisiones disponible. Bolsa: ' + fmtMoneda(bolsa) + '. La Caja Mayor no se usa para pagos.'));
          }

          var fecha;
          if (datos.fecha) {
            var f = new Date(datos.fecha);
            fecha = isNaN(f.getTime()) ? new Date().toISOString() : f.toISOString();
          } else {
            fecha = new Date().toISOString();
          }
          var pago = {
            userId: uid,
            monto: monto,
            banco: banco,
            numeroCuenta: numero,
            concepto: (datos.concepto || '').trim(),
            tipo: 'comision',
            origen: 'bolsa',
            estado: 'pagado',
            fecha: fecha,
            creadoPor: V.userId
          };
          return V.db.collection(COL_PAGOS).add(pago).then(function (ref) { return ref.id; });
        });
      })
      .catch(function (error) {
        console.error('Error en desembolso:', error);
        var msg = error && error.message ? error.message : String(error);
        if (error && error.code) msg += ' [' + error.code + ']';
        mostrarErrorDesembolso(msg);
        throw error;
      });
  }

  // Alerta persistente de error para desembolsos: muestra el mensaje
  // completo (permisos de Firestore, campos faltantes o saldo) y deja
  // que el superadmin consulte la consola del navegador (F12).
  function mostrarErrorDesembolso(mensaje) {
    var overlay = el('div', 'modal-overlay');
    var card = el('div', 'modal-card fin-modal');
    card.appendChild(el('h3', '', '⚠️ Error al registrar el desembolso'));
    var body = el('div', 'fin-form');
    body.appendChild(el('p', 'fin-form-note', mensaje));
    body.appendChild(el('p', 'fin-form-note',
      'Causas más comunes: reglas de Firestore (finanzas_pagos) que deniegan el permiso, datos bancarios del usuario incompletos (banco/número de cuenta) o el monto superando el saldo de comisiones. Revisa la consola del navegador (F12 → Console) para más detalles.'));
    card.appendChild(body);
    var acc = el('div', 'fin-modal-acciones');
    var btnOk = el('button', 'btn btn-primary', 'Entendido');
    btnOk.type = 'button';
    acc.appendChild(btnOk);
    card.appendChild(acc);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    overlay.classList.add('show');
    function cerrar() {
      overlay.classList.remove('show');
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
    btnOk.addEventListener('click', cerrar);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) cerrar(); });
  }

  /* ─── FILTROS COMUNES ──────────────────────────────────────── */
  function coincideTx(tx, f) {
    if (f.origen && tx.origen !== f.origen) return false;
    if (f.categoriaId && tx.categoriaId !== f.categoriaId) return false;
    if (f.estado && estadoNormalizado(tx.estado) !== estadoNormalizado(f.estado)) return false;
    var d = diaISO(tx.fecha);
    if (f.desde && d < f.desde) return false;
    if (f.hasta && d > f.hasta) return false;
    return true;
  }
  function filtrarTxs(txs, f) {
    var out = txs.filter(function (tx) { return coincideTx(tx, f); });
    if (f.q) {
      var q = (f.q || '').toLowerCase();
      out = out.filter(function (tx) {
        var titular = titularDeTx(tx);
        var cat = categoriaById(tx.categoriaId);
        return (titular || '').toLowerCase().indexOf(q) !== -1
          || (tx.concepto || '').toLowerCase().indexOf(q) !== -1
          || (tx.etiqueta || '').toLowerCase().indexOf(q) !== -1
          || (cat && cat.nombre ? cat.nombre.toLowerCase().indexOf(q) !== -1 : false);
      });
    }
    return out;
  }
  function titularDeTx(tx) {
    if (!tx) return '';
    if (esTxDirecta(tx)) {
      var don = nombreDonante(tx) || 'Donante';
      var ben = nombreBeneficiario(tx);
      return ben ? don + ' → ' + ben : don;
    }
    if (tx.origen === 'comunidad' || String(tx.tipo) === 'grupo') {
      var c = tx.comunidadId ? comunidadById(tx.comunidadId) : null;
      return c && c.nombre ? c.nombre : (tx.comunidadId || 'Comunidad');
    }
    var u = tx.userId ? usuarioById(tx.userId) : null;
    return u ? nombreUsuario(u) : (tx.userId || 'Usuario');
  }
  function estadoPillCls(estado) {
    var e = estadoNormalizado(estado);
    if (e === ESTADO_ASIGNADO) return 'pos';
    if (e === 'anulada') return 'neg';
    if (e === ESTADO_REGISTRADO) return 'pend';
    return '';
  }

  /* ─── VISTA FINANZAS (superadmin · CRUD) ───────────────────── */
  function renderVistaFinanzas() {
    var cont = V.$('finanzasContent');
    if (!cont) return;
    var btnNuevo = V.$('btnNuevaTransaccion');
    var btnPago = V.$('btnNuevoDesembolso');
    if (esAvanzadoUser()) { hideBotonesEscritorio(btnNuevo, btnPago); renderVistaFinanzasAvanzado(cont); return; }
    if (!isAdminUser()) {
      // Usuario normal (estudiante/miembro/gestor): NO se bloquea la vista.
      // El CTA de aporte vive fuera de este contenedor y siempre se ve; aquí
      // se muestra además un resumen de sus propios movimientos.
      hideBotonesEscritorio(btnNuevo, btnPago);
      renderVistaFinanzasMiembro(cont);
      return;
    }
    if (btnNuevo) btnNuevo.style.display = '';
    if (btnPago) btnPago.style.display = '';

    cont.innerHTML = '';
    cont.appendChild(el('p', 'fin-loading', 'Cargando transacciones…'));

    Promise.all([todasTransacciones(), loadComunidades(true), loadUsuarios(true), loadConfig(), todosPagos()])
      .then(function (res) {
        if (!document.body.contains(cont)) return;
        var txs = filtrarTxs(res[0], _finState);
        cont.innerHTML = '';
        renderFichaSaldo(cont, res[0], res[4], {
          subtitulo: 'Balance global del módulo: ingresos, bolsa, caja y ofrendas directas.'
        });
        renderKpisFinanzas(cont, res[0], _finState);
        renderFiltrosFinanzas(cont);
        renderTablaTransacciones(cont, txs);
      })
      .catch(function () {
        cont.innerHTML = '';
        cont.appendChild(el('p', 'fin-empty', 'No se pudieron cargar las transacciones en este momento.'));
      });
  }

  function hideBotonesEscritorio(btnNuevo, btnPago) {
    if (btnNuevo) btnNuevo.style.display = 'none';
    if (btnPago) btnPago.style.display = 'none';
  }

  /* ─── VISTA FINANZAS · USUARIO NORMAL (miembro/estudiante) ────
     Muestra el resumen de sus propios aportes y comisiones. El CTA para
     realizar un aporte/donación vive fuera de este contenedor (HTML
     estático), por lo que siempre queda visible en la parte superior. */
  function renderVistaFinanzasMiembro(cont) {
    cont.innerHTML = '';
    cont.appendChild(el('p', 'fin-loading', 'Cargando tus finanzas…'));
    Promise.all([todasTransacciones(), todasComisiones(), misPagos(), transaccionesRecibidasDirectas(), loadConfig()])
      .then(function (res) {
        if (!document.body.contains(cont)) return;
        var transacciones = res[0] || [];
        var comisiones = res[1] || [];
        var pagos = res[2] || [];
        var recibidas = res[3] || [];
        cont.innerHTML = '';
        renderStats(cont, transacciones, comisiones, pagos, recibidas);
        if (transacciones.length || comisiones.length || pagos.length || recibidas.length) {
          renderHistorial(cont, transacciones);
          renderBendiciones(cont, recibidas);
          renderGanancias(cont, comisiones);
          renderMisPagos(cont, pagos);
        } else {
          cont.appendChild(el('p', 'fin-empty', 'Aún no tienes movimientos. Usa el botón "Realizar Aporte / Donación" para registrar tu primer aporte.'));
        }
      })
      .catch(function () {
        cont.innerHTML = '';
        cont.appendChild(el('p', 'fin-empty', 'No se pudieron cargar tus finanzas en este momento.'));
      });
  }

  /* ─── VISTA FINANZAS · ROL AVANZADO (solo lectura) ───────────
     Misma pantalla que el superadmin pero sin acciones: nada de
     "Nueva transacción" ni "Nuevo desembolso", y sin la última columna
     de editar/eliminar. Los datos salen de transacciones/comisiones/pagos
     de la red del usuario; las reglas descartan en el servidor cualquier
     documento fuera de ese árbol. Los porcentajes y el panel de Reportes
     Financieros NO se muestran aquí: siguen reservados al superadmin. */
  function renderVistaFinanzasAvanzado(cont) {
    cont.innerHTML = '';
    cont.appendChild(el('p', 'fin-loading', 'Cargando los movimientos de tu red…'));

    // Los uids de la red se resuelven una sola vez y se reutilizan en las tres
    // colecciones; loadUsuarios(true) queda así en la caché de usuariosCache y
    // los nombres del resolvedor (usuarioById) también están disponibles.
    uidsDeMiRed()
      .then(function (uids) {
        return Promise.all([
          consultarPorUids(COL_TRANS, uids),
          consultarPorUids(COL_COMIS, uids),
          consultarPorUids(COL_PAGOS, uids),
          loadComunidades(true),
          loadConfig()
        ]);
      })
      .then(function (res) {
        if (!document.body.contains(cont)) return;
        var txs = res[0];
        var comision = res[1];
        var pagos = res[2];
        cont.innerHTML = '';

        cont.appendChild(el('p', 'fin-nota',
          '👁 Vista de solo lectura: consultas tus movimientos y los de tu red (hasta 5 niveles). '
          + 'Registrar, editar o eliminar transacciones y desembolsos sigue siendo exclusivo del superadmin.'));

        renderFichaSaldo(cont, txs, pagos, {
          subtitulo: 'Balance y totales acumulados de tu red.'
        });
        renderKpisFinanzas(cont, txs, _finState);
        renderFiltrosFinanzas(cont);
        renderTablaTransacciones(cont, filtrarTxs(txs, _finState), true);
        renderResumenRed(cont, comision, pagos);
      })
      .catch(function () {
        cont.innerHTML = '';
        cont.appendChild(el('p', 'fin-empty', 'No se pudieron cargar los movimientos de tu red en este momento.'));
      });
  }

  // Comisiones y pagos de la red del usuario avanzado, en dos tablas
  // simplificadas de solo lectura (sin los importes consolidados de la bolsa
  // y de la caja, que son inherentes al superadmin).
  function renderResumenRed(container, comision, pagos) {
    var sec = document.createElement('details');
    sec.className = 'fin-seccion';
    var s = document.createElement('summary');
    s.appendChild(el('span', '', '🤝 Comisiones y pagos de mi red (solo lectura)'));
    sec.appendChild(s);
    var wrap = el('div', 'fin-seccion-body');
    sec.appendChild(wrap);
    container.appendChild(sec);

    if (!comision.length && !pagos.length) {
      wrap.appendChild(el('p', 'fin-empty', 'Tu red todavía no tiene comisiones ni pagos registrados.'));
      return;
    }

    if (comision.length) {
      wrap.appendChild(el('h4', '', 'Comisiones liquidadas (' + comision.length + ')'));
      var t1 = tablaSimple(
        ['Beneficiario', 'Nivel', 'Origen', 'Monto', 'Fecha'],
        comision.map(function (c) {
          return [
            c.userId === V.userId ? 'Yo' : (usuarioById(c.userId) ? nombreUsuario(usuarioById(c.userId)) : (c.userId || '—')),
            'N' + (c.nivel || '—'),
            c.etiqueta || c.tipo || '—',
            fmtMoneda(c.monto),
            (c.fecha || '').slice(0, 10)
          ];
        })
      );
      wrap.appendChild(t1);
    }

    if (pagos.length) {
      wrap.appendChild(el('h4', '', 'Pagos realizados (' + pagos.length + ')'));
      var t2 = tablaSimple(
        ['Beneficiario', 'Monto', 'Fecha'],
        pagos.map(function (p) {
          return [
            p.userId === V.userId ? 'Yo' : (usuarioById(p.userId) ? nombreUsuario(usuarioById(p.userId)) : (p.userId || '—')),
            fmtMoneda(p.monto),
            (p.fecha || '').slice(0, 10)
          ];
        })
      );
      wrap.appendChild(t2);
    }

    var saldo = saldoComisionesDe(V.userId, comision, pagos);
    if (saldo) wrap.appendChild(el('p', 'fin-nota', 'Tu saldo disponible de comisiones: ' + fmtMoneda(saldo) + '.'));
  }

  function tablaSimple(encabezados, filas) {
    var wrap = el('div', 'fin-table-wrap');
    var table = document.createElement('table');
    table.className = 'fin-table';
    var thead = document.createElement('thead');
    var hr = document.createElement('tr');
    encabezados.forEach(function (h) {
      var th = document.createElement('th');
      th.textContent = h;
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);
    var tbody = document.createElement('tbody');
    filas.forEach(function (fila) {
      var tr = document.createElement('tr');
      fila.forEach(function (valor, i) {
        tr.appendChild(celda(valor, encabezados[i] === 'Monto' ? 'fin-monto' : ''));
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  // Totales consolidados de un conjunto de movimientos. Las ofrendas
  // directas se contabilizan como ingreso, pero NUNCA como Bolsa ni Caja.
  function totalesFinancieros(txs, pagos) {
    var totalIngresos = 0, totalBolsa = 0, totalCaja = 0, totalDirecto = 0, directas = 0;
    (txs || []).forEach(function (tx) {
      var d = distribucionTx(tx);
      totalIngresos += Number(tx.monto) || 0;
      totalBolsa += d.montoBolsa;
      totalCaja += d.montoCaja;
      if (d.directo) {
        totalDirecto += Number(tx.monto) || 0;
        directas++;
      }
    });
    var totalPagado = sumarMontos(pagos || []);
    return {
      totalIngresos: redondear(totalIngresos),
      totalBolsa: redondear(totalBolsa),
      totalCaja: redondear(totalCaja),
      totalDirecto: redondear(totalDirecto),
      directas: directas,
      totalPagado: totalPagado,
      // Las ofrendas directas no forman parte del dinero retenido por la
      // organización: van 100% al destinatario. El balance solo considera
      // lo retenido en bolsa + caja menos los desembolsos.
      balance: redondear(totalBolsa + totalCaja - totalPagado)
    };
  }

  /* ─── FICHA DE SALDO (parte superior del módulo) ──────────────
     Resume el balance y los acumulados con los datos ya cargados. Se
     repinta cada vez que la vista se actualiza (al registrar, editar,
     eliminar o desembolsar), de modo que los totales reflejan el estado
     actual de Firestore sin recargar la página. */
  function renderFichaSaldo(container, txs, pagos, opts) {
    opts = opts || {};
    var t = totalesFinancieros(txs, pagos);
    var card = el('div', 'fin-saldo-card');
    var head = el('div', 'fin-saldo-head');
    var titles = el('div', '');
    titles.appendChild(el('h3', 'fin-saldo-title', '📊 Ficha de saldo'));
    titles.appendChild(el('p', 'fin-saldo-sub', opts.subtitulo || 'Balance acumulado y totales del módulo de finanzas.'));
    head.appendChild(titles);
    var stamp = el('div', 'fin-saldo-stamp', 'Actualizado ' + new Date().toLocaleTimeString('es-CO'));
    head.appendChild(stamp);
    card.appendChild(head);

    var body = el('div', 'fin-saldo-body');
    var main = el('div', 'fin-saldo-main');
    main.appendChild(el('div', 'fin-saldo-label', 'Balance disponible'));
    main.appendChild(el('div', 'fin-saldo-value', fmtMoneda(t.balance)));
    main.appendChild(el('div', 'fin-saldo-hint', 'Ingresos retenidos (bolsa + caja) − desembolsos'));
    body.appendChild(main);

    var grid = el('div', 'fin-saldo-grid');
    grid.appendChild(fichaItem('Ingresos acumulados', fmtMoneda(t.totalIngresos), 'gold'));
    grid.appendChild(fichaItem('Desembolsos', fmtMoneda(t.totalPagado), 'blue'));
    grid.appendChild(fichaItem('Bolsa de comisiones (' + bolsaTotalPct() + '%)', fmtMoneda(t.totalBolsa), 'green'));
    grid.appendChild(fichaItem('Caja Mayor (' + cajaPctVigente() + '%)', fmtMoneda(t.totalCaja), 'blue'));
    grid.appendChild(fichaItem('Ofrendas directas (100%)', fmtMoneda(t.totalDirecto), 'gold'));
    grid.appendChild(fichaItem('Movimientos', String((txs || []).length), ''));
    body.appendChild(grid);
    card.appendChild(body);
    container.appendChild(card);
  }

  function fichaItem(label, value, cls) {
    var item = el('div', 'fin-saldo-item');
    item.appendChild(el('div', 'fin-saldo-item-label', label));
    item.appendChild(el('div', 'fin-saldo-item-value' + (cls ? ' ' + cls : ''), value));
    return item;
  }

  function renderKpisFinanzas(container, txs, filtros) {
    var base = txs || [];
    var filtradas = filtrarTxs(base, filtros);
    var t = totalesFinancieros(filtradas, []);
    var stats = el('div', 'fin-stats fin-stats-kpi');
    stats.appendChild(statCard('Ingresos totales', fmtMoneda(t.totalIngresos), 'gold'));
    stats.appendChild(statCard('Transacciones', String(filtradas.length), ''));
    stats.appendChild(statCard('Bolsa de comisiones (' + bolsaTotalPct() + '%)', fmtMoneda(t.totalBolsa), 'green'));
    stats.appendChild(statCard('Caja Mayor (' + cajaPctVigente() + '%)', fmtMoneda(t.totalCaja), 'blue'));
    stats.appendChild(statCard('Ofrendas directas (100%)', fmtMoneda(t.totalDirecto), 'gold'));
    container.appendChild(stats);
  }

  function filtroField(label, id, cls) {
    var wrap = el('div', 'fin-filtro' + (cls ? ' ' + cls : ''));
    wrap.appendChild(el('label', '', label));
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'input';
    input.id = id;
    wrap.appendChild(input);
    return wrap;
  }

  function renderFiltrosFinanzas(container) {
    var bar = el('div', 'fin-toolbar');
    container.appendChild(bar);

    var fBus = el('div', 'fin-filtro fin-filtro-flex');
    fBus.appendChild(el('label', '', 'Buscar'));
    var inpQ = document.createElement('input');
    inpQ.type = 'text';
    inpQ.className = 'input';
    inpQ.placeholder = 'Nombre, concepto, categoría…';
    inpQ.value = _finState.q || '';
    fBus.appendChild(inpQ);
    bar.appendChild(fBus);

    var fOrigen = el('div', 'fin-filtro');
    fOrigen.appendChild(el('label', '', 'Origen'));
    var selOrigen = document.createElement('select');
    selOrigen.className = 'select';
    fillOrigenSelect(selOrigen, _finState.origen);
    fOrigen.appendChild(selOrigen);
    bar.appendChild(fOrigen);

    var fCat = el('div', 'fin-filtro');
    fCat.appendChild(el('label', '', 'Categoría'));
    var selCat = document.createElement('select');
    selCat.className = 'select';
    fillCategoriaSelect(selCat, _finState.categoriaId);
    fCat.appendChild(selCat);
    bar.appendChild(fCat);

    var fEst = el('div', 'fin-filtro');
    fEst.appendChild(el('label', '', 'Estado'));
    var selEst = document.createElement('select');
    selEst.className = 'select';
    fillSelectOpciones(selEst, opcionesEstado(true),
      _finState.estado ? estadoNormalizado(_finState.estado) : '');
    fEst.appendChild(selEst);
    bar.appendChild(fEst);

    var fDesde = el('div', 'fin-filtro');
    fDesde.appendChild(el('label', '', 'Desde'));
    var inpDesde = document.createElement('input');
    inpDesde.type = 'date';
    inpDesde.className = 'input';
    inpDesde.value = _finState.desde || '';
    fDesde.appendChild(inpDesde);
    bar.appendChild(fDesde);

    var fHasta = el('div', 'fin-filtro');
    fHasta.appendChild(el('label', '', 'Hasta'));
    var inpHasta = document.createElement('input');
    inpHasta.type = 'date';
    inpHasta.className = 'input';
    inpHasta.value = _finState.hasta || '';
    fHasta.appendChild(inpHasta);
    bar.appendChild(fHasta);

    var btnLimpiar = el('button', 'btn btn-outline btn-sm', 'Limpiar');
    btnLimpiar.type = 'button';
    bar.appendChild(btnLimpiar);

    function refresh() {
      _finState.q = inpQ.value.trim();
      _finState.origen = selOrigen.value;
      _finState.categoriaId = selCat.value;
      _finState.estado = selEst.value;
      _finState.desde = inpDesde.value;
      _finState.hasta = inpHasta.value;
      renderVistaFinanzas();
    }
    btnLimpiar.addEventListener('click', function () {
      _finState = { q: '', origen: '', categoriaId: '', estado: '', desde: '', hasta: '' };
      renderVistaFinanzas();
    });
    [inpQ, selOrigen, selCat, selEst, inpDesde, inpHasta].forEach(function (ctrl) {
      var ev = ctrl.tagName === 'INPUT' && ctrl.type !== 'text' && ctrl.type !== 'date' ? 'input' : (ctrl.tagName === 'INPUT' ? 'input' : 'change');
      ctrl.addEventListener(ev, refresh);
    });
  }

  function fillOrigenSelect(sel, selected) {
    fillSelectOpciones(sel, [
      { value: '', label: 'Todos los orígenes' },
      { value: 'usuario', label: ETIQUETA_USUARIO },
      { value: 'comunidad', label: ETIQUETA_COMUNIDAD }
    ], selected);
  }

  function fillCategoriaSelect(sel, selected, soloTipo) {
    var opts = [{ value: '', label: 'Todas las categorías' }];
    categoriasActivas().forEach(function (c) {
      if (soloTipo && c.tipo !== soloTipo) return;
      opts.push({ value: c.id, label: c.nombre + ' (' + tipoLabel(c.tipo) + ')' });
    });
    fillSelectOpciones(sel, opts, selected || '');
  }

  function fillSelectOpciones(sel, options, selected) {
    sel.innerHTML = '';
    options.forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      if (o.value === selected) opt.selected = true;
      sel.appendChild(opt);
    });
  }

  /* ─── AUTCOMPLETADO / BUSCADOR EN VIVO ───────────────────────
     Sustituye a los <select> nativos en el modal: el usuario digita
     parte del nombre o correo y ve la lista filtrada al instante;
     selecciona con un clic o Enter. Cada opción conserva su id/uid en
     dataset.id y getValue() solo devuelve un id VÁLIDO (nunca texto
     suelto), garantizando la persistencia correcta en la transacción. */
  function crearAutocompletar(input, onSelect) {
    var items = [];
    var wrap = document.createElement('div');
    wrap.className = 'fin-ac';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    var lista = el('div', 'fin-ac-list');
    wrap.appendChild(lista);
    var idxSel = 0;
    var abierto = false;

    function itemsFiltrados() {
      var q = (input.value || '').trim().toLowerCase();
      if (!q) return items.slice(0, 50);
      var out = [];
      items.forEach(function (it) {
        if ((it.label || '').toLowerCase().indexOf(q) !== -1
          || (it.sub || '').toLowerCase().indexOf(q) !== -1
          || String(it.id).toLowerCase().indexOf(q) !== -1) {
          out.push(it);
        }
      });
      return out.slice(0, 50);
    }

    function cerrar() { abierto = false; lista.style.display = 'none'; }

    // Solo mueve el realce (.active) sin reconstruir la lista: evita que
    // el elemento bajo el cursor se reemplace a mitad de un clic (lo que
    // impedía que mousedown/click seleccionaran la opción).
    function resaltar() {
      var opts = lista.querySelectorAll('.fin-ac-item');
      for (var i = 0; i < opts.length; i++) opts[i].classList.toggle('active', i === idxSel);
    }

    function render() {
      var list = itemsFiltrados();
      lista.innerHTML = '';
      if (!input.disabled && list.length && document.activeElement === input) {
        abierto = true;
        lista.style.display = 'block';
        idxSel = idxSel < list.length ? idxSel : 0;
        list.forEach(function (it, i) {
          var opt = el('div', 'fin-ac-item' + (i === idxSel ? ' active' : ''), '');
          opt.appendChild(el('div', 'fin-ac-label', it.label));
          if (it.sub) opt.appendChild(el('div', 'fin-ac-sub', it.sub));
          opt.setAttribute('data-id', String(it.id));
          opt.addEventListener('mousedown', function (ev) { ev.preventDefault(); seleccionar(it); });
          // Respaldo por click: si por algún motivo el mousedown no llegó a la
          // opción, este handler la selecciona. El guard evita doble disparo.
          opt.addEventListener('click', function (ev) {
            ev.preventDefault();
            if (String(input.dataset.id) !== String(it.id)) seleccionar(it);
          });
          opt.addEventListener('mouseenter', function () { idxSel = i; resaltar(); });
          lista.appendChild(opt);
        });
      } else {
        cerrar();
      }
    }

    function seleccionar(it) {
      input.value = it.label;
      input.dataset.id = String(it.id);
      cerrar();
      if (typeof onSelect === 'function') onSelect(it);
    }

    function getValue() {
      var raw = (input.value || '').trim();
      if (!raw) return '';
      // Vínculo ESTRICTO por uid: solo vale una opción seleccionada de la
      // lista o el uid escrito literalmente. Nunca se resuelve por nombre ni
      // correo, porque dos personas pueden compartir esos textos y el dinero
      // terminaría asignado a la cuenta equivocada.
      if (input.dataset.id) {
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          if (String(it.id) === String(input.dataset.id) && (it.label === raw || it.sub === raw)) {
            return it.id;
          }
        }
      }
      for (var j = 0; j < items.length; j++) {
        if (String(items[j].id) === raw) return items[j].id;
      }
      return '';
    }

    input.addEventListener('input', function () { idxSel = 0; render(); });
    input.addEventListener('focus', render);
    input.addEventListener('keydown', function (ev) {
      var list;
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        list = itemsFiltrados();
        if (!list.length) return;
        idxSel = Math.min(idxSel + 1, list.length - 1);
        if (abierto) resaltar(); else render();
      } else if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        idxSel = Math.max(idxSel - 1, 0);
        if (abierto) resaltar(); else render();
      } else if (ev.key === 'Enter') {
        if (abierto) {
          list = itemsFiltrados();
          var it = list[idxSel];
          if (it) { ev.preventDefault(); seleccionar(it); }
        } else {
          var raw = (input.value || '').trim();
          for (var k = 0; k < items.length; k++) {
            if (String(items[k].id) === raw) {
              seleccionar(items[k]);
              break;
            }
          }
        }
      } else if (ev.key === 'Escape') {
        cerrar();
      }
    });
    input.addEventListener('blur', function () {
      setTimeout(function () {
        if (document.activeElement === input) return;
        cerrar();
      }, 120);
    });

    return {
      // Última barrera contra filas repetidas: si la lista llega con el mismo
      // id dos veces (records repetidos en Firestore o una comunidad inyectada
      // a mano además de la que ya venía del servidor), se conserva la primera.
      setItems: function (arr) {
        var vistos = {};
        items = [];
        (arr || []).forEach(function (it) {
          if (!it || it.id == null) return;
          var id = String(it.id);
          if (vistos[id]) return;
          vistos[id] = true;
          items.push({ id: id, label: String(it.label || ''), sub: String(it.sub || '') });
        });
        render();
      },
      setValue: function (id) {
        for (var i = 0; i < items.length; i++) {
          if (String(items[i].id) === String(id)) {
            seleccionar(items[i]);
            return;
          }
        }
      },
      getValue: getValue,
      clear: function () { delete input.dataset.id; input.value = ''; cerrar(); }
    };
  }

  // `soloLectura` elimina la última columna (editar/eliminar). La usa el rol
  // avanzado, que consulta los movimientos de su red pero no puede escribir:
  // las reglas de Firestore rechazan el create/update/delete de igual modo.
  function renderTablaTransacciones(container, txs, soloLectura) {
    var wrap = el('div', 'fin-table-wrap');
    container.appendChild(wrap);
    if (!txs.length) {
      wrap.appendChild(el('p', 'fin-empty', soloLectura
        ? 'No hay transacciones de tu red con los filtros actuales.'
        : 'No hay transacciones con los filtros actuales. Usa "➕ Nueva transacción" para registrar la primera.'));
      return;
    }

    var encabezados = ['Fecha', 'Origen', 'Titular', 'Categoría', 'Monto', 'Bolsa', 'Caja', 'Estado'];
    if (!soloLectura) encabezados.push('');
    var table = document.createElement('table');
    table.className = 'fin-table';
    var thead = document.createElement('thead');
    var hr = document.createElement('tr');
    encabezados.forEach(function (h) {
      var th = document.createElement('th');
      th.textContent = h;
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    txs.forEach(function (tx) {
      var d = distribucionTx(tx);
      var tr = document.createElement('tr');
      tr.appendChild(celda(V.fmtDate(tx.fecha) || (tx.fecha || '')));
      var tdOri = celda('');
      var pill = el('span', 'fin-pill ' + (esTxDirecta(tx) || tx.origen === 'comunidad' ? 'oro' : 'azul'), tx.etiqueta || (tx.origen === 'comunidad' ? ETIQUETA_COMUNIDAD : ETIQUETA_USUARIO));
      tdOri.appendChild(pill);
      tr.appendChild(tdOri);
      var tdTitular = celda(titularDeTx(tx));
      var detBen = detalleBeneficiario(tx);
      if (detBen) tdTitular.appendChild(el('div', 'fin-fila-sub', detBen));
      tr.appendChild(tdTitular);
      var cat = categoriaById(tx.categoriaId);
      tr.appendChild(celda(cat ? cat.nombre : (tx.categoriaId || '—')));
      tr.appendChild(celda(fmtMoneda(tx.monto), 'fin-monto'));
      if (d.directo) {
        var tdSinBolsa = celda('—', 'fin-monto');
        tdSinBolsa.title = 'Ofrenda directa: el 100% va al destinatario, sin Bolsa ni Caja.';
        tr.appendChild(tdSinBolsa);
        var tdSinCaja = celda('—', 'fin-monto');
        tdSinCaja.title = 'Ofrenda directa: el 100% va al destinatario, sin Bolsa ni Caja.';
        tr.appendChild(tdSinCaja);
      } else {
        tr.appendChild(celda(fmtMoneda(d.montoBolsa), 'fin-monto pos'));
        tr.appendChild(celda(fmtMoneda(d.montoCaja), 'fin-monto blue'));
      }
      tr.appendChild(celda(estadoLabelTx(tx), estadoPillClsTx(tx) ? 'fin-monto ' + estadoPillClsTx(tx) : ''));

      var tdAcc = celda('');
      if (soloLectura) {
        tr.appendChild(tdAcc);
        tbody.appendChild(tr);
        return;
      }
      var acc = el('div', 'fin-acciones');
      var btnEdit = el('button', 'btn btn-outline btn-sm', '✏️');
      btnEdit.type = 'button';
      btnEdit.title = 'Editar transacción';
      btnEdit.addEventListener('click', function () { abrirModalTransaccion(tx); });
      acc.appendChild(btnEdit);
      var btnDel = el('button', 'btn btn-danger btn-sm', '🗑️');
      btnDel.type = 'button';
      btnDel.title = 'Eliminar transacción';
      btnDel.addEventListener('click', function () { eliminarConConfirmacion(tx); });
      acc.appendChild(btnDel);
      tdAcc.appendChild(acc);
      tr.appendChild(tdAcc);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
  }

  function celda(texto, cls) {
    var td = document.createElement('td');
    if (cls) td.className = cls;
    if (texto !== undefined && texto !== null) td.textContent = texto;
    return td;
  }

  function eliminarConConfirmacion(tx) {
    if (!confirm('¿Eliminar la transacción de ' + titularDeTx(tx) + ' por ' + fmtMoneda(tx.monto) + '?\n\nSe eliminarán también sus comisiones MLM registradas. Esta acción no se puede deshacer.')) return;
    eliminarTransaccion(tx.id).then(function () {
      V.toast('Transacción eliminada ✓');
      renderVistaFinanzas();
    }).catch(function (e) {
      V.toast(e && e.message ? e.message : 'Error al eliminar.', true);
    });
  }

  /* ─── MODAL ÚNICO DE TRANSACCIÓN / APORTE ─────────────────────
     Un solo formulario para "Realizar Aporte / Donación" y "Nueva
     transacción". Los campos contables (medio de pago, origen, monto,
     categoría, comprobante e imagen) son comunes; el rol y la edición
     deciden qué campos de gestión se muestran. */
  function abrirModalTransaccion(existing) {
    var admin = isAdminUser();
    var editando = !!existing;
    if (editando && !admin) { V.toast('Solo administración puede editar transacciones.', true); return; }
    if (!admin && (V.isAnon || !V.userId)) { V.toast('Inicia sesión para realizar un aporte.', true); return; }

    var overlay = el('div', 'modal-overlay');
    var card = el('div', 'modal-card fin-modal');
    var head = el('div', 'fin-modal-head');
    head.appendChild(el('h3', '', editando
      ? '✏️ Editar transacción'
      : (admin ? '💳 Nueva transacción / Aporte' : '💳 Realizar Aporte / Donación')));
    card.appendChild(head);

    var form = el('div', 'fin-form');

    /* a) Medio de pago / cuenta destino ─────────────────────── */
    form.appendChild(el('label', '', 'Medio de pago / cuenta destino'));
    var mediosWrap = el('div', 'fin-medios-pago');
    var medios = mediosPagoAporte();
    if (admin) {
      if (editando && existing.cuentaId) {
        var yaEsta = medios.some(function (m) { return String(m.cuentaId) === String(existing.cuentaId); });
        if (!yaEsta) {
          var ctaActual = cuentaById(existing.cuentaId);
          medios.push({
            id: 'cuenta_actual',
            label: 'Cuenta actual',
            icon: '🏦',
            banco: ctaActual ? ctaActual.banco : 'Cuenta asociada',
            numero: ctaActual ? ctaActual.numero : String(existing.cuentaId),
            cuentaId: String(existing.cuentaId),
            nota: 'Cuenta asociada a esta transacción.'
          });
        }
      }
      medios.push({
        id: 'sin_cuenta',
        label: 'Sin cuenta',
        icon: '➖',
        banco: 'Sin cuenta de destino',
        numero: '—',
        cuentaId: '',
        nota: 'El movimiento no se asociará a una cuenta bancaria.'
      });
    }
    var metodoSel = medios[0] ? medios[0].id : 'nequi';
    if (editando) {
      var porCuenta = existing.cuentaId
        ? medios.filter(function (m) { return String(m.cuentaId) === String(existing.cuentaId); })[0]
        : null;
      var porMetodo = existing.metodoPago
        ? medios.filter(function (m) { return m.id === String(existing.metodoPago); })[0]
        : null;
      if (porCuenta) metodoSel = porCuenta.id;
      else if (porMetodo) metodoSel = porMetodo.id;
    }

    medios.forEach(function (mp) {
      var opt = el('label', 'fin-medio-card');
      opt.setAttribute('data-medio', mp.id);
      var radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'finMedioPago';
      radio.value = mp.id;
      radio.checked = mp.id === metodoSel;
      opt.appendChild(radio);
      var body = el('div', 'fin-medio-body');
      body.appendChild(el('div', 'fin-medio-head', mp.icon + ' ' + mp.label));
      body.appendChild(el('div', 'fin-medio-dato', mp.banco));
      body.appendChild(el('div', 'fin-medio-num', mp.numero));
      body.appendChild(el('div', 'fin-medio-nota', mp.nota));
      opt.appendChild(body);
      radio.addEventListener('change', function () { if (radio.checked) metodoSel = mp.id; });
      mediosWrap.appendChild(opt);
    });
    form.appendChild(mediosWrap);

    function cuentaIdSeleccionada() {
      for (var i = 0; i < medios.length; i++) {
        if (medios[i].id === metodoSel) return medios[i].cuentaId || '';
      }
      return '';
    }

    /* b) Origen del movimiento ───────────────────────────────── */
    var fOrigen = el('div', 'field');
    fOrigen.appendChild(el('label', '', 'Origen del movimiento'));
    var radioWrap = el('div', 'fin-origen-radio');

    function radioOrigen(valor, texto) {
      var lbl = document.createElement('label');
      lbl.className = 'fin-radio';
      var inp = document.createElement('input');
      inp.type = 'radio';
      inp.name = 'finTxOrigen';
      inp.value = valor;
      lbl.appendChild(inp);
      lbl.appendChild(el('span', '', texto));
      radioWrap.appendChild(lbl);
      inp.addEventListener('change', actualizarOrigen);
      return inp;
    }
    var inUsu = radioOrigen('usuario', '👤 Aporte de Usuario');
    var inCom = radioOrigen('comunidad', '🤝 Ofrenda de Comunidad');
    var inDir = radioOrigen('directo', '🙏 Ofrenda Directa / Solidaridad');
    fOrigen.appendChild(radioWrap);
    form.appendChild(fOrigen);

    function origenSeleccionado() {
      if (inDir.checked) return 'directo';
      if (inCom.checked) return 'comunidad';
      return 'usuario';
    }

    /* c) Selectores condicionales por origen ─────────────────── */
    var acUsuario = null;
    var fUsr = null;
    if (admin) {
      fUsr = el('div', 'field');
      fUsr.appendChild(el('label', '', 'Usuario (Aporte)'));
      var inpUsuario = document.createElement('input');
      inpUsuario.type = 'text';
      inpUsuario.className = 'input';
      inpUsuario.placeholder = 'Escribe nombre o correo…';
      inpUsuario.autocomplete = 'off';
      fUsr.appendChild(inpUsuario);
      acUsuario = crearAutocompletar(inpUsuario);
      form.appendChild(fUsr);
    }

    var fDon = el('div', 'field');
    fDon.appendChild(el('label', '', 'Usuario donante (remitente)'));
    var inpDonante = document.createElement('input');
    inpDonante.type = 'text';
    inpDonante.className = 'input';
    inpDonante.placeholder = 'Escribe nombre o correo…';
    inpDonante.autocomplete = 'off';
    fDon.appendChild(inpDonante);
    var acDonante = crearAutocompletar(inpDonante);
    form.appendChild(fDon);

    var fBenef = el('div', 'field');
    fBenef.appendChild(el('label', '', 'Usuario / Fondo beneficiario'));
    var inpBenef = document.createElement('input');
    inpBenef.type = 'text';
    inpBenef.className = 'input';
    inpBenef.placeholder = 'Escribe nombre, correo o elige el fondo…';
    inpBenef.autocomplete = 'off';
    fBenef.appendChild(inpBenef);
    var acBenef = crearAutocompletar(inpBenef, function (it) {
      if (!it || it.id === FONDO_CAJA_ID) return;
      var u = usuarioPorUid(it.id);
      if (u && !inpBenefTel.value.trim()) inpBenefTel.value = String(u.telefono || '');
    });
    form.appendChild(fBenef);

    // Datos de verificación del beneficiado: quedan adjuntos al uid del
    // beneficiario y permiten auditar la entrega solidaria.
    var fBenefTel = el('div', 'field');
    fBenefTel.appendChild(el('label', '', 'Teléfono del beneficiario'));
    var inpBenefTel = document.createElement('input');
    inpBenefTel.type = 'text';
    inpBenefTel.className = 'input';
    inpBenefTel.placeholder = 'Ej: 300 123 4567';
    inpBenefTel.autocomplete = 'off';
    fBenefTel.appendChild(inpBenefTel);
    form.appendChild(fBenefTel);

    var fBenefNotas = el('div', 'field');
    fBenefNotas.appendChild(el('label', '', 'Notas de verificación del beneficiario'));
    var inpBenefNotas = document.createElement('textarea');
    inpBenefNotas.className = 'input';
    inpBenefNotas.rows = '2';
    inpBenefNotas.placeholder = 'Ej: verificado por teléfono el 20/10, recibe en su cuenta Nequi…';
    inpBenefNotas.autocomplete = 'off';
    fBenefNotas.appendChild(inpBenefNotas);
    form.appendChild(fBenefNotas);

    var fCom = el('div', 'field');
    fCom.appendChild(el('label', '', 'Comunidad (Ofrenda)'));
    var inpCom = document.createElement('input');
    inpCom.type = 'text';
    inpCom.className = 'input';
    inpCom.placeholder = 'Escribe el nombre de la comunidad…';
    inpCom.autocomplete = 'off';
    fCom.appendChild(inpCom);
    var acCom = crearAutocompletar(inpCom);
    form.appendChild(fCom);

    /* d) Datos contables ─────────────────────────────────────── */
    var fCat = el('div', 'field');
    fCat.appendChild(el('label', '', 'Categoría'));
    var selCat = document.createElement('select');
    selCat.className = 'select';
    fCat.appendChild(selCat);
    form.appendChild(fCat);

    var fMonto = el('div', 'field');
    fMonto.appendChild(el('label', '', 'Monto'));
    var inpMonto = document.createElement('input');
    inpMonto.type = 'number';
    inpMonto.className = 'input';
    inpMonto.min = '1';
    inpMonto.step = '1';
    inpMonto.placeholder = 'Ej: 50000';
    fMonto.appendChild(inpMonto);
    form.appendChild(fMonto);

    var fRef = el('div', 'field');
    fRef.appendChild(el('label', '', 'Número de comprobante o referencia' + (admin ? '' : ' *')));
    var inpRef = document.createElement('input');
    inpRef.type = 'text';
    inpRef.className = 'input';
    inpRef.placeholder = 'Ej: 1234567890 o la referencia de PSE';
    inpRef.autocomplete = 'off';
    fRef.appendChild(inpRef);
    form.appendChild(fRef);

    var fComp = el('div', 'field');
    fComp.appendChild(el('label', '', 'Comprobante de pago'));
    var waBox = el('div', 'fin-wa-notice');
    waBox.appendChild(el('div', 'fin-wa-title', '📲 Envía la foto del comprobante por WhatsApp'));
    waBox.appendChild(el('p', 'fin-wa-text',
      'Este formulario ya no carga imágenes. Después de guardar el movimiento, envía la foto o captura del comprobante directamente por WhatsApp para que administración valide el pago.'));
    var btnWa = el('button', 'btn btn-wa', '💬 Abrir WhatsApp y enviar comprobante');
    btnWa.type = 'button';
    btnWa.addEventListener('click', function () {
      var partes = ['Hola 👋, envío el comprobante de mi aporte.'];
      var monto = Number(inpMonto.value) || 0;
      if (monto > 0) partes.push('Monto: ' + fmtMoneda(monto));
      if (inpRef.value.trim()) partes.push('Referencia: ' + inpRef.value.trim());
      var catMsg = categoriaById(selCat.value);
      if (catMsg) partes.push('Categoría: ' + catMsg.nombre);
      abrirWhatsApp(partes.join(' '));
    });
    waBox.appendChild(btnWa);
    var waNumero = numeroWhatsApp();
    waBox.appendChild(el('p', 'fin-wa-num', waNumero
      ? 'Número de soporte: +' + waNumero
      : 'El número de WhatsApp de soporte aún no está configurado.'));
    if (editando && existing.comprobanteUrl) {
      var lnkComp = document.createElement('a');
      lnkComp.href = existing.comprobanteUrl;
      lnkComp.target = '_blank';
      lnkComp.rel = 'noopener';
      lnkComp.className = 'fin-link';
      lnkComp.textContent = 'Ver comprobante registrado anteriormente';
      waBox.appendChild(lnkComp);
    }
    fComp.appendChild(waBox);
    form.appendChild(fComp);

    var fCon = el('div', 'field');
    fCon.appendChild(el('label', '', 'Concepto (opcional)'));
    var inpCon = document.createElement('input');
    inpCon.type = 'text';
    inpCon.className = 'input';
    inpCon.placeholder = 'Ej: Diezmo de octubre';
    fCon.appendChild(inpCon);
    form.appendChild(fCon);

    var inpFecha = null;
    var selEstado = null;
    if (admin) {
      var fFecha = el('div', 'field');
      fFecha.appendChild(el('label', '', 'Fecha'));
      inpFecha = document.createElement('input');
      inpFecha.type = 'date';
      inpFecha.className = 'input';
      fFecha.appendChild(inpFecha);
      form.appendChild(fFecha);

      var fEst = el('div', 'field');
      fEst.appendChild(el('label', '', 'Estado'));
      selEstado = document.createElement('select');
      selEstado.className = 'select';
      fillSelectOpciones(selEstado, opcionesEstado(false), ESTADO_REGISTRADO);
      fEst.appendChild(selEstado);
      form.appendChild(fEst);
    }

    var resumen = el('p', 'fin-form-note', '');
    form.appendChild(resumen);
    if (!admin) {
      form.appendChild(el('p', 'fin-form-note', 'Tu aporte quedará en estado "Registrado" hasta que administración verifique el comprobante y lo marque como "Asignado".'));
    }

    var acciones = el('div', 'fin-modal-acciones');
    var btnSave = el('button', 'btn btn-primary', editando ? 'Guardar cambios' : (admin ? 'Registrar transacción' : 'Enviar solicitud'));
    btnSave.type = 'button';
    var btnCancel = el('button', 'btn btn-outline', 'Cancelar');
    btnCancel.type = 'button';
    acciones.appendChild(btnSave);
    acciones.appendChild(btnCancel);
    form.appendChild(acciones);
    card.appendChild(form);

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    overlay.classList.add('show');

    function cerrar() {
      overlay.classList.remove('show');
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
    btnCancel.addEventListener('click', cerrar);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) cerrar(); });

    var catEnEdicion = (editando && existing && existing.categoriaId) ? String(existing.categoriaId) : '';
    var esDirectoEd = !!(editando && existing && esTxDirecta(existing));

    function pintarCategorias(selected) {
      var cats = categoriasActivas();
      if (!admin) cats = cats.filter(function (c) { return c.tipo !== 'grupo'; });
      var opts = cats.map(function (c) {
        return { value: c.id, label: c.nombre + ' (' + tipoLabel(c.tipo) + ')' };
      });
      fillSelectOpciones(selCat, opts, selected || '');
    }
    pintarCategorias(catEnEdicion);

    function actualizarOrigen() {
      // Una categoría solidaria siempre se registra como ofrenda directa:
      // el 100% va al destinatario y se necesita elegir el beneficiario.
      if (esCategoriaSolidaria(categoriaById(selCat.value))) inDir.checked = true;
      var origen = origenSeleccionado();
      var directo = origen === 'directo';
      if (fUsr) fUsr.style.display = (!directo && origen === 'usuario') ? '' : 'none';
      fCom.style.display = (!directo && origen === 'comunidad') ? '' : 'none';
      fDon.style.display = directo ? '' : 'none';
      fBenef.style.display = directo ? '' : 'none';
      fBenefTel.style.display = directo ? '' : 'none';
      fBenefNotas.style.display = directo ? '' : 'none';
      actualizarResumen();
    }

    function actualizarResumen() {
      var monto = Number(inpMonto.value) || 0;
      var cat = categoriaById(selCat.value);
      var directo = origenSeleccionado() === 'directo' || esCategoriaSolidaria(cat);
      var d = distribucionTx({ monto: monto, tipo: directo ? TIPO_DIRECTO : '', categoriaId: selCat.value });
      var etiqueta = directo
        ? ETIQUETA_DIRECTO
        : (origenSeleccionado() === 'comunidad' ? ETIQUETA_COMUNIDAD : ETIQUETA_USUARIO);
      if (d.directo) {
        resumen.textContent = etiqueta + ' · 100% al destinatario → ' + fmtMoneda(d.montoDestinatario) +
          ' · Sin división entre Bolsa y Caja.';
      } else {
        resumen.textContent = etiqueta + ' · Bolsa MLM ' + d.pctBolsa + '% → ' + fmtMoneda(d.montoBolsa) +
          ' · Caja Mayor ' + d.pctCaja + '% → ' + fmtMoneda(d.montoCaja);
      }
    }
    inpMonto.addEventListener('input', actualizarResumen);
    selCat.addEventListener('change', function () {
      if (esCategoriaSolidaria(categoriaById(selCat.value))) inDir.checked = true;
      actualizarOrigen();
    });

    function itemUsuario(u) {
      return { id: u.uid, label: nombreUsuario(u), sub: u.email || u.uid };
    }
    function itemYo() {
      var yo = V.currentUser || {};
      return {
        id: V.userId,
        label: nombreUsuario(yo) || (yo.email || 'Yo'),
        sub: yo.email || V.userId
      };
    }

    function poblar() {
      loadUsuarios(true).then(function () {
        if (!document.body.contains(inpDonante)) return;
        var userItems = usuariosCache.map(itemUsuario);
        var yo = itemYo();
        if (!userItems.some(function (it) { return String(it.id) === String(yo.id); })) userItems.unshift(yo);
        if (editando && existing) {
          var uidOld = existing.donanteId || existing.userId || (existing.origen === 'usuario' ? existing.origenId : '');
          if (uidOld && !userItems.some(function (it) { return String(it.id) === String(uidOld); })) {
            userItems.push({ id: uidOld, label: existing.donanteNombre || uidOld, sub: 'Usuario actual' });
          }
        }
        if (admin && acUsuario) acUsuario.setItems(userItems);
        acDonante.setItems(admin ? userItems : [yo]);

        var benefItems = (admin ? userItems : []).filter(function (it) {
          return String(it.id) !== String(V.userId);
        });
        benefItems.unshift({ id: FONDO_CAJA_ID, label: FONDO_CAJA_NOMBRE, sub: 'Fondo de la plataforma' });
        if (editando && existing && existing.beneficiarioId) {
          var benId = String(existing.beneficiarioId);
          if (!benefItems.some(function (it) { return String(it.id) === benId; })) {
            benefItems.push({ id: benId, label: existing.beneficiarioNombre || benId, sub: 'Beneficiario actual' });
          }
        }
        acBenef.setItems(benefItems);

        if (editando && existing) {
          var uidSel = existing.donanteId || existing.userId || (existing.origen === 'usuario' ? existing.origenId : '');
          if (uidSel) {
            if (admin && acUsuario) acUsuario.setValue(uidSel);
            if (esDirectoEd) acDonante.setValue(uidSel);
          }
          if (esDirectoEd && existing.beneficiarioId) acBenef.setValue(existing.beneficiarioId);
        } else if (!admin) {
          acDonante.setValue(V.userId);
        }
      });
      loadComunidades(true).then(function () {
        if (!document.body.contains(inpCom)) return;
        var comOld = (editando && existing)
          ? (existing.comunidadId || (existing.origen === 'comunidad' ? existing.origenId : ''))
          : '';
        acCom.setItems(comunidadesUnicas(comunidadesCache, comOld).map(function (c) {
          return {
            id: c.id,
            label: c.nombre,
            sub: c.coordinadorId ? ('Coord: ' + nombreUsuario(usuarioById(c.coordinadorId))) : 'Sin coordinador'
          };
        }));
        if (comOld) acCom.setValue(comOld);
      });
      if (admin) {
        loadCuentas(true).then(function () {
          if (!document.body.contains(mediosWrap)) return;
          var reales = mediosPagoAporte();
          reales.forEach(function (real) {
            for (var i = 0; i < medios.length; i++) {
              if (medios[i].id === real.id) medios[i].cuentaId = real.cuentaId;
            }
            var cardReal = mediosWrap.querySelector('[data-medio="' + real.id + '"]');
            if (!cardReal) return;
            var dato = cardReal.querySelector('.fin-medio-dato');
            var num = cardReal.querySelector('.fin-medio-num');
            if (dato) dato.textContent = real.banco;
            if (num) num.textContent = real.numero;
          });
        });
      }
    }

    if (editando && existing) {
      var origenEd = existing.origen || (String(existing.tipo) === 'grupo' ? 'comunidad' : 'usuario');
      if (esDirectoEd) inDir.checked = true;
      else if (origenEd === 'comunidad') inCom.checked = true;
      else inUsu.checked = true;
      inpMonto.value = existing.monto;
      inpRef.value = existing.referenciaPago || '';
      inpCon.value = existing.concepto || '';
      inpBenefTel.value = telefonoBeneficiario(existing);
      inpBenefNotas.value = notasVerificacionBeneficiario(existing);
      if (inpFecha) inpFecha.value = diaISO(existing.fecha) || '';
      if (selEstado) {
        fillSelectOpciones(selEstado, opcionesEstado(false),
          estadoNormalizado(existing.estado || ESTADO_REGISTRADO));
      }
    } else {
      inUsu.checked = true;
      if (inpFecha) inpFecha.value = diaISO(new Date());
    }
    poblar();
    actualizarOrigen();
    actualizarResumen();

    btnSave.addEventListener('click', function () {
      var origen = origenSeleccionado();
      var directo = origen === 'directo' || esCategoriaSolidaria(categoriaById(selCat.value));
      var referencia = inpRef.value.trim();
      if (!selCat.value) { V.toast('Selecciona una categoría.', true); return; }
      if (!(Number(inpMonto.value) > 0)) { V.toast('Escribe un monto válido mayor a cero.', true); return; }
      if (!admin && !referencia) { V.toast('Escribe el número de comprobante o referencia.', true); return; }

      var datos = {
        origen: directo ? 'usuario' : origen,
        esDirecto: directo,
        userId: admin && acUsuario ? acUsuario.getValue() : V.userId,
        donanteId: directo ? (admin ? acDonante.getValue() : V.userId) : '',
        beneficiarioId: directo ? acBenef.getValue() : '',
        comunidadId: (!directo && origen === 'comunidad') ? acCom.getValue() : '',
        categoriaId: selCat.value,
        cuentaId: cuentaIdSeleccionada(),
        metodoPago: metodoSel,
        referenciaPago: referencia,
        monto: inpMonto.value,
        concepto: inpCon.value,
        beneficiarioTelefono: directo ? inpBenefTel.value : '',
        beneficiarioNotasVerificacion: directo ? inpBenefNotas.value : '',
        fecha: inpFecha ? (inpFecha.value || new Date().toISOString()) : new Date().toISOString(),
        estado: selEstado ? selEstado.value : ESTADO_REGISTRADO
      };
      if (editando && existing) {
        datos.comprobanteUrl = existing.comprobanteUrl || '';
        if (directo) {
          if (String(existing.donanteId || '') === String(datos.userId || '')) datos.donanteNombre = existing.donanteNombre || '';
          if (String(existing.beneficiarioId || '') === String(datos.beneficiarioId || '')) datos.beneficiarioNombre = existing.beneficiarioNombre || '';
        }
      }
      if (directo) {
        if (!(datos.donanteId || datos.userId)) { V.toast('Selecciona el usuario donante desde la lista (vínculo por uid).', true); return; }
        if (!datos.beneficiarioId) { V.toast('Selecciona el usuario o fondo beneficiario desde la lista (vínculo por uid).', true); return; }
        if (mismoUid(datos.donanteId || datos.userId, datos.beneficiarioId)) {
          V.toast('El donante y el beneficiario deben ser diferentes.', true); return;
        }
      } else if (origen === 'comunidad' && !datos.comunidadId) {
        V.toast('Selecciona la comunidad de la ofrenda.', true); return;
      } else if (origen === 'usuario' && admin && !datos.userId) {
        V.toast('Selecciona un usuario de la lista de autocompletado.', true); return;
      }
      if (!directo) { datos.donanteId = ''; datos.beneficiarioId = ''; }

      btnSave.disabled = true;
      btnSave.textContent = editando ? '⏳ Guardando…' : '⏳ Enviando…';
      var guardado = admin
        ? (editando ? editarTransaccion(existing.id, datos) : crearTransaccion(datos))
        : reportarAportePendiente(datos);
      guardado.then(function () {
        V.toast(editando
          ? 'Transacción actualizada ✓ Recuerda enviar el comprobante por WhatsApp.'
          : (admin
            ? (directo ? 'Ofrenda directa registrada ✓ El 100% va al destinatario.'
              : 'Transacción registrada y comisiones MLM liquidadas ✓')
            : 'Solicitud enviada ✓ Recuerda enviar la foto del comprobante por WhatsApp.'));
        cerrar();
        if (admin) renderVistaFinanzas(); else refreshPanel();
      }).catch(function (e) {
        V.toast(e && e.message ? e.message : 'Error al guardar.', true);
        btnSave.disabled = false;
        btnSave.textContent = editando ? 'Guardar cambios' : (admin ? 'Registrar transacción' : 'Enviar solicitud');
      });
    });
  }

  function abrirModalDesembolso() {
    if (!isAdminUser()) { V.toast('Solo el superadmin puede registrar desembolsos.', true); return; }
    var overlay = el('div', 'modal-overlay');
    var card = el('div', 'modal-card fin-modal');
    card.appendChild(el('h3', '', '💸 Desembolso / Pago a usuario'));
    var form = el('div', 'fin-form');

    // Usuario destinatario (autocompletado + saldo)
    var fUsr = el('div', 'field');
    fUsr.appendChild(el('label', '', 'Usuario destinatario'));
    var inpUsuario = document.createElement('input');
    inpUsuario.type = 'text';
    inpUsuario.className = 'input';
    inpUsuario.placeholder = 'Escribe nombre o correo…';
    inpUsuario.autocomplete = 'off';
    inpUsuario.id = 'dpUsuario';
    fUsr.appendChild(inpUsuario);
    var acDes = crearAutocompletar(inpUsuario, aplicarSeleccionUsuario);
    form.appendChild(fUsr);

    // Monto
    var fMonto = el('div', 'field');
    fMonto.appendChild(el('label', '', 'Monto a desembolsar'));
    var inpMonto = document.createElement('input');
    inpMonto.type = 'number';
    inpMonto.className = 'input';
    inpMonto.id = 'dpMonto';
    inpMonto.min = '1';
    inpMonto.step = '1';
    inpMonto.placeholder = 'Ej: 120000';
    fMonto.appendChild(inpMonto);
    var montoNota = el('p', 'fin-form-note', 'Saldo de comisiones del usuario: —');
    fMonto.appendChild(montoNota);
    form.appendChild(fMonto);

    // Banco / número (prellenado desde el perfil del usuario)
    var fBanco = el('div', 'field');
    fBanco.appendChild(el('label', '', 'Banco'));
    var selBanco = document.createElement('select');
    selBanco.className = 'select';
    selBanco.id = 'dpBanco';
    fillSelectOpciones(selBanco, [
      { value: '', label: '—' },
      { value: 'Bancolombia', label: 'Bancolombia' },
      { value: 'Nequi', label: 'Nequi' }
    ], '');
    fBanco.appendChild(selBanco);
    form.appendChild(fBanco);

    var fNum = el('div', 'field');
    fNum.appendChild(el('label', '', 'Número de cuenta / Celular Nequi'));
    var inpNum = document.createElement('input');
    inpNum.type = 'text';
    inpNum.className = 'input';
    inpNum.id = 'dpNumero';
    inpNum.placeholder = 'Ej: 3001234567 o 0123456789';
    inpNum.autocomplete = 'off';
    fNum.appendChild(inpNum);
    form.appendChild(fNum);

    var fCon = el('div', 'field');
    fCon.appendChild(el('label', '', 'Concepto / referencia (opcional)'));
    var inpCon = document.createElement('input');
    inpCon.type = 'text';
    inpCon.className = 'input';
    inpCon.id = 'dpConcepto';
    inpCon.placeholder = 'Ej: Pago mensual de comisiones';
    inpCon.autocomplete = 'off';
    fCon.appendChild(inpCon);
    form.appendChild(fCon);

    var bolsaNota = el('p', 'fin-form-note', 'Cargando saldos…');
    form.appendChild(bolsaNota);
    var cajaNota = el('p', 'fin-note', 'La Caja Mayor está reservada exclusivamente para el sostenimiento y operación del proyecto y NO se descuenta en pagos a usuarios.');
    form.appendChild(cajaNota);

    var acciones = el('div', 'fin-modal-acciones');
    var btnSave = el('button', 'btn btn-primary', 'Confirmar desembolso');
    btnSave.type = 'button';
    var btnCancel = el('button', 'btn btn-outline', 'Cancelar');
    btnCancel.type = 'button';
    acciones.appendChild(btnSave);
    acciones.appendChild(btnCancel);
    form.appendChild(acciones);
    card.appendChild(form);

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    overlay.classList.add('show');

    function cerrar() {
      overlay.classList.remove('show');
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
    btnCancel.addEventListener('click', cerrar);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) cerrar(); });

    var comisionesTodas = [];
    var pagosTodas = [];

    Promise.all([todasComisiones(), todosPagos(), loadUsuarios(true), loadConfig()])
      .then(function (res) {
        if (!document.body.contains(inpUsuario)) return;
        comisionesTodas = res[0];
        pagosTodas = res[1];
        acDes.setItems(usuariosCache.map(function (u) {
          return {
            id: u.uid,
            label: nombreUsuario(u),
            sub: (u.email || u.uid) + ' · Saldo comisiones: ' + fmtMoneda(saldoComisionesDe(u.uid, comisionesTodas, pagosTodas))
          };
        }));
        bolsaNota.textContent = 'Bolsa de Comisiones disponible: ' + fmtMoneda(bolsaComisionesDisponible(comisionesTodas, pagosTodas)) +
          ' · Total comisiones generadas: ' + fmtMoneda(sumarMontos(comisionesTodas)) +
          ' · Total pagado: ' + fmtMoneda(sumarMontos(pagosTodas));
      })
      .catch(function () {
        bolsaNota.textContent = 'No se pudieron cargar los saldos en este momento.';
      });

    // Al escribir solo se refresca la vista del saldo (aún sin uid válido).
    function sincronizarSaldo() {
      var uid = acDes.getValue();
      var saldo = uid ? saldoComisionesDe(uid, comisionesTodas, pagosTodas) : 0;
      montoNota.textContent = 'Saldo de comisiones del usuario: ' + fmtMoneda(saldo);
      inpMonto.max = String(saldo > 0 ? saldo : 0);
    }

    // Al seleccionar el usuario (clic/Enter) se precargan Banco y Número
    // desde su perfil y se fija su saldo como tope del monto.
    function aplicarSeleccionUsuario() {
      var uid = acDes.getValue();
      var u = usuarioById(uid);
      var saldo = uid ? saldoComisionesDe(uid, comisionesTodas, pagosTodas) : 0;
      montoNota.textContent = 'Saldo de comisiones del usuario: ' + fmtMoneda(saldo);
      inpMonto.max = String(saldo > 0 ? saldo : 0);
      if (u) {
        selBanco.value = u.banco || '';
        inpNum.value = u.numeroCuenta || '';
      }
    }
    inpUsuario.addEventListener('input', sincronizarSaldo);
    inpUsuario.addEventListener('blur', function () {
      if (acDes.getValue() && (!selBanco.value)) aplicarSeleccionUsuario();
    });

    btnSave.addEventListener('click', function () {
      var datos = {
        userId: acDes.getValue(),
        monto: inpMonto.value,
        banco: selBanco.value,
        numeroCuenta: inpNum.value,
        concepto: inpCon.value
      };
      if (!datos.userId) { V.toast('Selecciona un usuario de la lista de autocompletado.', true); return; }
      if (!(Number(datos.monto) > 0)) { V.toast('Escribe un monto válido mayor a cero.', true); return; }

      btnSave.disabled = true;
      btnSave.textContent = '⏳ Confirmando…';
      registrarDesembolso(datos).then(function () {
        V.toast('Desembolso registrado. Se descuenta de la bolsa de comisiones ✓');
        cerrar();
        renderVistaFinanzas();
        renderPerfil();
      }).catch(function (e) {
        V.toast(e && e.message ? e.message : 'Error al registrar el desembolso.', true);
        btnSave.disabled = false;
        btnSave.textContent = 'Confirmar desembolso';
      });
    });
  }

  /* ─── VISTA REPORTES FINANCIEROS ───────────────────────────── */
  function renderVistaReportes() {
    var cont = V.$('reportesContent');
    if (!cont) return;
    if (!isAdminUser()) {
      cont.innerHTML = '';
      cont.appendChild(V.emptyState('🔒', 'Solo superadmin', 'Los Reportes Financieros están disponibles exclusivamente para el rol superadmin.'));
      return;
    }

    cont.innerHTML = '';
    cont.appendChild(el('p', 'fin-loading', 'Cargando reportes…'));

    Promise.all([todasTransacciones(), todosPagos(), loadComunidades(true), loadUsuarios(true), loadConfig()])
      .then(function (res) {
        if (!document.body.contains(cont)) return;
        var txs = filtrarTxs(res[0], _repState);
        cont.innerHTML = '';
        renderFiltrosReportes(cont);
        renderKpisReportes(cont, txs);
        renderTabsReportes(cont, txs, res[1]);
      })
      .catch(function () {
        cont.innerHTML = '';
        cont.appendChild(el('p', 'fin-empty', 'No se pudieron cargar los reportes en este momento.'));
      });
  }

  function renderFiltrosReportes(container) {
    var bar = el('div', 'fin-toolbar');
    container.appendChild(bar);

    var fOrigen = el('div', 'fin-filtro');
    fOrigen.appendChild(el('label', '', 'Origen'));
    var selOrigen = document.createElement('select');
    selOrigen.className = 'select';
    fillOrigenSelect(selOrigen, _repState.origen);
    fOrigen.appendChild(selOrigen);
    bar.appendChild(fOrigen);

    var fCat = el('div', 'fin-filtro');
    fCat.appendChild(el('label', '', 'Categoría'));
    var selCat = document.createElement('select');
    selCat.className = 'select';
    fillCategoriaSelect(selCat, _repState.categoriaId);
    fCat.appendChild(selCat);
    bar.appendChild(fCat);

    var fEst = el('div', 'fin-filtro');
    fEst.appendChild(el('label', '', 'Estado'));
    var selEst = document.createElement('select');
    selEst.className = 'select';
    fillSelectOpciones(selEst, opcionesEstado(true),
      _repState.estado ? estadoNormalizado(_repState.estado) : '');
    fEst.appendChild(selEst);
    bar.appendChild(fEst);

    var fDesde = el('div', 'fin-filtro');
    fDesde.appendChild(el('label', '', 'Desde'));
    var inpDesde = document.createElement('input');
    inpDesde.type = 'date';
    inpDesde.className = 'input';
    inpDesde.value = _repState.desde || '';
    fDesde.appendChild(inpDesde);
    bar.appendChild(fDesde);

    var fHasta = el('div', 'fin-filtro');
    fHasta.appendChild(el('label', '', 'Hasta'));
    var inpHasta = document.createElement('input');
    inpHasta.type = 'date';
    inpHasta.className = 'input';
    inpHasta.value = _repState.hasta || '';
    fHasta.appendChild(inpHasta);
    bar.appendChild(fHasta);

    var btnGen = el('button', 'btn btn-primary btn-sm', 'Generar reporte');
    btnGen.type = 'button';
    btnGen.addEventListener('click', function () {
      _repState.origen = selOrigen.value;
      _repState.categoriaId = selCat.value;
      _repState.estado = selEst.value;
      _repState.desde = inpDesde.value;
      _repState.hasta = inpHasta.value;
      renderVistaReportes();
    });
    bar.appendChild(btnGen);
  }

  function renderKpisReportes(container, txs) {
    var t = totalesFinancieros(txs, []);
    var filtroDesc = '';
    if (_repState.desde || _repState.hasta) {
      filtroDesc = (diaISO(_repState.desde) || 'inicio') + ' → ' + (diaISO(_repState.hasta) || 'hoy');
    } else {
      filtroDesc = 'todo el histórico';
    }
    var stats = el('div', 'fin-stats fin-stats-kpi');
    stats.appendChild(statCard('Ingresos totales', fmtMoneda(t.totalIngresos), 'gold'));
    stats.appendChild(statCard('Bolsa de comisiones (' + bolsaTotalPct() + '%)', fmtMoneda(t.totalBolsa), 'green'));
    stats.appendChild(statCard('Caja Mayor (' + cajaPctVigente() + '%)', fmtMoneda(t.totalCaja), 'blue'));
    stats.appendChild(statCard('Ofrendas directas (100%)', fmtMoneda(t.totalDirecto), 'gold'));
    container.appendChild(stats);
    container.appendChild(el('p', 'fin-filtro-desc', 'Período: ' + filtroDesc + ' · Transacciones: ' + txs.length +
      ' · Porcentajes vigentes L1–L5: ' + nivelesPctTxt()));
  }

  function nivelesPctTxt() {
    var p = pctsMlm();
    var partes = [];
    for (var i = 1; i <= 5; i++) partes.push('N' + i + '=' + (Number(p[i]) || 0) + '%');
    return partes.join(' · ');
  }

  function renderTabsReportes(container, txs, pagos) {
    var tabs = el('div', 'fin-tabs');
    var tabIngresos = el('button', 'fin-tab active', '💰 Ingresos Totales');
    tabIngresos.type = 'button';
    var tabBolsa = el('button', 'fin-tab', '🌐 Bolsa de Comisiones (' + bolsaTotalPct() + '%)');
    tabBolsa.type = 'button';
    var tabCaja = el('button', 'fin-tab', '🏦 Caja Mayor / Fondo Estructura (' + cajaPctVigente() + '%)');
    tabCaja.type = 'button';
    var tabPagos = el('button', 'fin-tab', '💸 Desembolsos a Usuarios');
    tabPagos.type = 'button';
    tabs.appendChild(tabIngresos);
    tabs.appendChild(tabBolsa);
    tabs.appendChild(tabCaja);
    tabs.appendChild(tabPagos);
    container.appendChild(tabs);

    var panel = el('div', 'fin-tab-panel');
    container.appendChild(panel);

    if (bolsaTotalPct() > 100) {
      container.appendChild(el('p', 'fin-warn', '⚠️ Los porcentajes L1–L5 suman más de 100%. Revisa la configuración para evitar distribuciones incoherentes.'));
    }

    // Despliegue perezoso de cada pestaña.
    tabIngresos.addEventListener('click', function () {
      activarTab(tabs, tabIngresos);
      renderPanelIngresos(panel, txs);
    });
    tabBolsa.addEventListener('click', function () {
      activarTab(tabs, tabBolsa);
      renderPanelBolsa(panel, txs, pagos);
    });
    tabCaja.addEventListener('click', function () {
      activarTab(tabs, tabCaja);
      renderPanelCaja(panel, txs, pagos);
    });
    tabPagos.addEventListener('click', function () {
      activarTab(tabs, tabPagos);
      renderPanelPagos(panel, pagos);
    });

    renderPanelIngresos(panel, txs);
  }

  function activarTab(tabs, tab) {
    var btns = tabs.querySelectorAll('.fin-tab');
    Array.prototype.forEach.call(btns, function (b) { b.classList.remove('active'); });
    tab.classList.add('active');
  }

  /* ── PESTAÑA 1: INGRESOS TOTALES ─────────────────────────── */
  function renderPanelIngresos(panel, txs) {
    panel.innerHTML = '';
    panel.appendChild(el('h4', 'fin-panel-titulo', '💰 Detalle de ingresos por origen y categoría'));

    var porOrigen = { usuario: { count: 0, total: 0 }, comunidad: { count: 0, total: 0 } };
    var porCategoria = {};
    txs.forEach(function (tx) {
      var key = tx.origen === 'comunidad' ? 'comunidad' : 'usuario';
      porOrigen[key].count++;
      porOrigen[key].total += Number(tx.monto) || 0;
      var cat = categoriaById(tx.categoriaId);
      var ck = cat ? cat.nombre : (tx.categoriaId || '—');
      if (!porCategoria[ck]) porCategoria[ck] = { count: 0, total: 0 };
      porCategoria[ck].count++;
      porCategoria[ck].total += Number(tx.monto) || 0;
    });

    panel.appendChild(resumenTabla([
      { label: ETIQUETA_USUARIO + ' (' + ETIQUETA_USUARIO.replace(/ /g, '·') + ')', count: porOrigen.usuario.count, total: porOrigen.usuario.total, cls: 'azul' },
      { label: ETIQUETA_COMUNIDAD + ' (' + ETIQUETA_COMUNIDAD.replace(/ /g, '·') + ')', count: porOrigen.comunidad.count, total: porOrigen.comunidad.total, cls: 'oro' }
    ], 'Por origen'));

    var catRows = Object.keys(porCategoria).map(function (k) {
      return { label: k, count: porCategoria[k].count, total: porCategoria[k].total, cls: '' };
    }).sort(function (a, b) { return b.total - a.total; });
    panel.appendChild(resumenTabla(catRows, 'Por categoría'));

    // Listado detallado de las transacciones del filtro
    panel.appendChild(el('h4', 'fin-panel-titulo', 'Transacciones del período'));
    var wrap = el('div', 'fin-table-wrap');
    if (!txs.length) {
      wrap.appendChild(el('p', 'fin-empty', 'Sin transacciones en este período.'));
    } else {
      var table = document.createElement('table');
      table.className = 'fin-table';
      var thead = document.createElement('thead');
      var hr = document.createElement('tr');
      ['Fecha', 'Origen', 'Titular', 'Categoría', 'Monto', 'Estado'].forEach(function (h) {
        var th = document.createElement('th');
        th.textContent = h;
        hr.appendChild(th);
      });
      thead.appendChild(hr);
      table.appendChild(thead);
      var tbody = document.createElement('tbody');
      txs.forEach(function (tx) {
        var tr = document.createElement('tr');
        tr.appendChild(celda(V.fmtDate(tx.fecha) || ''));
        var tdOri = celda('');
        var pill = el('span', 'fin-pill ' + (tx.origen === 'comunidad' ? 'oro' : 'azul'), tx.etiqueta || (tx.origen === 'comunidad' ? ETIQUETA_COMUNIDAD : ETIQUETA_USUARIO));
        tdOri.appendChild(pill);
        tr.appendChild(tdOri);
        var tdTitular = celda(titularDeTx(tx));
        var detBen = detalleBeneficiario(tx);
        if (detBen) tdTitular.appendChild(el('div', 'fin-fila-sub', detBen));
        tr.appendChild(tdTitular);
        var cat = categoriaById(tx.categoriaId);
        tr.appendChild(celda(cat ? cat.nombre : (tx.categoriaId || '—')));
        tr.appendChild(celda(fmtMoneda(tx.monto), 'fin-monto'));
        var tdEst = celda('');
        tdEst.appendChild(el('span', 'fin-pill ' + (estadoPillCls(tx.estado) || 'gris'), estadoLabel(tx.estado)));
        if (tx.referenciaPago) tdEst.appendChild(el('div', 'fin-fila-sub', 'Ref: ' + tx.referenciaPago));
        if (tx.metodoPago) tdEst.appendChild(el('div', 'fin-fila-sub', 'Pago: ' + tx.metodoPago));
        tr.appendChild(tdEst);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
    }
    panel.appendChild(wrap);
  }

  function resumenTabla(rows, titulo) {
    var wrap = el('div', 'fin-group');
    wrap.appendChild(el('div', 'fin-subhead', titulo));
    var table = document.createElement('table');
    table.className = 'fin-table fin-table-sm';
    var thead = document.createElement('thead');
    var hr = document.createElement('tr');
    var th1 = document.createElement('th'); th1.textContent = 'Concepto';
    var th2 = document.createElement('th'); th2.textContent = 'Nº';
    var th3 = document.createElement('th'); th3.textContent = 'Total';
    hr.appendChild(th1); hr.appendChild(th2); hr.appendChild(th3);
    thead.appendChild(hr);
    table.appendChild(thead);
    var tbody = document.createElement('tbody');
    var total = 0, count = 0;
    rows.forEach(function (r) {
      total += r.total; count += r.count;
      var tr = document.createElement('tr');
      var tdC = celda('');
      var pill = el('span', 'fin-pill ' + (r.cls || 'gris'), r.label);
      tdC.appendChild(pill);
      tr.appendChild(tdC);
      tr.appendChild(celda(String(r.count)));
      tr.appendChild(celda(fmtMoneda(r.total), 'fin-monto'));
      tbody.appendChild(tr);
    });
    var trT = document.createElement('tr');
    trT.className = 'fin-total-row';
    trT.appendChild(celda('TOTAL'));
    trT.appendChild(celda(String(count)));
    trT.appendChild(celda(fmtMoneda(total), 'fin-monto pos'));
    tbody.appendChild(trT);
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  /* ── PESTAÑA 2: BOLSA DE COMISIONES (MLM) ────────────────── */
  // Recalcula la distribución EXACTA con los porcentajes vigentes para
  // cada transacción del filtro (motor dinámico) y la agrega por nivel
  // y por beneficiario. Ante cambios de configuración el reporte se
  // ajusta automáticamente.
  function renderPanelBolsa(panel, txs, pagos) {
    panel.innerHTML = '';
    panel.appendChild(el('p', 'fin-loading', 'Calculando distribución exacta de la bolsa MLM…'));

    Promise.all([
      Promise.all(txs.map(function (tx) {
        return calcularComisionesTx(tx).then(function (comisiones) {
          return { tx: tx, comisiones: comisiones || [] };
        });
      })),
      todasComisiones()
    ]).then(function (res) {
      var resol = res[0];
      var comisionesGlobal = res[1];
      panel.innerHTML = '';
      if (!txs.length) {
        panel.appendChild(el('p', 'fin-empty', 'Sin transacciones en el período.'));
        return;
      }

      var porNivel = {};
      var porUsuario = {};
      var totalBolsa = 0;
      resol.forEach(function (r) {
        r.comisiones.forEach(function (c) {
          var nivel = Number(c.nivel) || 0;
          if (!porNivel[nivel]) porNivel[nivel] = { count: 0, total: 0 };
          porNivel[nivel].count++;
          porNivel[nivel].total += Number(c.monto) || 0;
          if (!porUsuario[c.userId]) porUsuario[c.userId] = { count: 0, total: 0, niveles: {} };
          porUsuario[c.userId].count++;
          porUsuario[c.userId].total += Number(c.monto) || 0;
          if (!porUsuario[c.userId].niveles[nivel]) porUsuario[c.userId].niveles[nivel] = 0;
          porUsuario[c.userId].niveles[nivel] += Number(c.monto) || 0;
          totalBolsa += Number(c.monto) || 0;
        });
      });

      panel.appendChild(el('p', 'fin-note',
        'La bolsa de comisiones (' + bolsaTotalPct() + '%) se distribuye a la red MLM N1–N5 con los porcentajes vigentes: ' +
        nivelesPctTxt() + '. Los desembolsos a usuarios se descuentan de esta bolsa; la Caja Mayor no se toca.'));

      var totalPagado = sumarMontos(pagos || []);
      var bolsaGlobal = sumarMontos(comisionesGlobal || []);
      var saldoBolsa = redondear(bolsaGlobal - totalPagado);
      var statsGlobal = el('div', 'fin-stats');
      statsGlobal.appendChild(statCard('Bolsa global generada', fmtMoneda(bolsaGlobal), ''));
      statsGlobal.appendChild(statCard('Desembolsado a usuarios', fmtMoneda(totalPagado), 'blue'));
      statsGlobal.appendChild(statCard('Saldo disponible', fmtMoneda(saldoBolsa), 'green'));
      panel.appendChild(statsGlobal);

      panel.appendChild(el('div', 'fin-stats'));
      panel.querySelector('.fin-stats').appendChild(statCard('Bolsa del período', fmtMoneda(totalBolsa), 'green'));

      // Distribución por nivel
      panel.appendChild(el('h4', 'fin-panel-titulo', 'Distribución por nivel'));
      var rowsNivel = [];
      for (var n = 1; n <= 5; n++) {
        if (!porNivel[n]) continue;
        rowsNivel.push({
          label: 'Nivel ' + n + ' · ' + (Number(pctsMlm()[n]) || 0) + '%',
          count: porNivel[n].count,
          total: porNivel[n].total,
          cls: n === 1 ? 'oro' : ''
        });
      }
      if (!rowsNivel.length) {
        panel.appendChild(el('p', 'fin-empty', 'Las transacciones del período no generaron comisiones (sin red ascendente o MLM desactivado).'));
      } else {
        panel.appendChild(resumenTabla(rowsNivel, 'Pagado por nivel (MLM)'));
      }

      // Distribución por beneficiario
      panel.appendChild(el('h4', 'fin-panel-titulo', 'Pagos por beneficiario'));
      var rowsUsu = Object.keys(porUsuario).map(function (uid) {
        var u = usuarioById(uid);
        return {
          label: (u ? nombreUsuario(u) : uid) + (u && u.email ? ' · ' + u.email : ''),
          count: porUsuario[uid].count,
          total: porUsuario[uid].total,
          cls: ''
        };
      }).sort(function (a, b) { return b.total - a.total; });
      panel.appendChild(resumenTabla(rowsUsu, 'Comisiones recibidas'));
    }).catch(function (e) {
      panel.innerHTML = '';
      panel.appendChild(el('p', 'fin-empty', 'No se pudo calcular la bolsa de comisiones: ' + (e && e.message ? e.message : e)));
    });
  }

  /* ── PESTAÑA 3: CAJA MAYOR / FONDO ESTRUCTURA GENERAL ─────── */
  function renderPanelCaja(panel, txs) {
    panel.innerHTML = '';
    var totalBolsa = 0, totalCaja = 0;
    var filas = [];
    txs.forEach(function (tx) {
      var d = distribucionTx(tx);
      totalBolsa += d.montoBolsa;
      totalCaja += d.montoCaja;
      filas.push({ tx: tx, d: d });
    });
    filas.sort(function (a, b) { return (b.tx.fecha || '').localeCompare(a.tx.fecha || ''); });

    var cajaPct = cajaPctVigente();
    panel.appendChild(el('p', 'fin-note',
      'La Caja Mayor / Fondo Estructura General recibe el ' + cajaPct + '% restante de cada ingreso (100% − ' + bolsaTotalPct() + '% de bolsa MLM). ' +
      'Las ofrendas directas/solidarias quedan fuera: su monto va 100% al destinatario. ' +
      'Es el acumulado destinado a la caja central de la organización y NO se descuenta en pagos a usuarios.'));

    var stats = el('div', 'fin-stats');
    stats.appendChild(statCard('Acumulado Caja Mayor (' + cajaPct + '%)', fmtMoneda(totalCaja), 'blue'));
    stats.appendChild(statCard('Trasladado a bolsa MLM', fmtMoneda(totalBolsa), 'green'));
    stats.appendChild(statCard('Transacciones', String(filas.length), ''));
    panel.appendChild(stats);

    panel.appendChild(el('h4', 'fin-panel-titulo', 'Movimientos destinados a la Caja Mayor'));
    var wrap = el('div', 'fin-table-wrap');
    if (!filas.length) {
      wrap.appendChild(el('p', 'fin-empty', 'Sin transacciones en el período.'));
    } else {
      var table = document.createElement('table');
      table.className = 'fin-table';
      var thead = document.createElement('thead');
      var hr = document.createElement('tr');
      ['Fecha', 'Origen', 'Titular', 'Monto', 'Bolsa ' + bolsaTotalPct() + '%', 'Caja ' + cajaPct + '%'].forEach(function (h) {
        var th = document.createElement('th');
        th.textContent = h;
        hr.appendChild(th);
      });
      thead.appendChild(hr);
      table.appendChild(thead);
      var tbody = document.createElement('tbody');
      filas.forEach(function (f) {
        var tr = document.createElement('tr');
        tr.appendChild(celda(V.fmtDate(f.tx.fecha) || ''));
        var tdOri = celda('');
        var pill = el('span', 'fin-pill ' + (f.tx.origen === 'comunidad' ? 'oro' : 'azul'), f.tx.etiqueta || (f.tx.origen === 'comunidad' ? ETIQUETA_COMUNIDAD : ETIQUETA_USUARIO));
        tdOri.appendChild(pill);
        tr.appendChild(tdOri);
        tr.appendChild(celda(titularDeTx(f.tx)));
        tr.appendChild(celda(fmtMoneda(f.tx.monto), 'fin-monto'));
        if (f.d.directo) {
          var tdNB = celda('—', 'fin-monto');
          tdNB.title = 'Ofrenda directa: 100% al destinatario.';
          tr.appendChild(tdNB);
          var tdNC = celda('—', 'fin-monto');
          tdNC.title = 'Ofrenda directa: no alimenta la Caja Mayor.';
          tr.appendChild(tdNC);
        } else {
          tr.appendChild(celda(fmtMoneda(f.d.montoBolsa), 'fin-monto pos'));
          tr.appendChild(celda(fmtMoneda(f.d.montoCaja), 'fin-monto blue'));
        }
        tbody.appendChild(tr);
      });
      var trT = document.createElement('tr');
      trT.className = 'fin-total-row';
      trT.appendChild(celda('TOTAL'));
      trT.appendChild(celda(''));
      trT.appendChild(celda(''));
      trT.appendChild(celda(fmtMoneda(txs.reduce(function (s, tx2) { return s + (Number(tx2.monto) || 0); }, 0)), 'fin-monto'));
      trT.appendChild(celda(fmtMoneda(totalBolsa), 'fin-monto pos'));
      trT.appendChild(celda(fmtMoneda(totalCaja), 'fin-monto blue'));
      tbody.appendChild(trT);
      table.appendChild(tbody);
      wrap.appendChild(table);
    }
    panel.appendChild(wrap);
  }

  /* ── PESTAÑA 4: DESEMBOLSOS / PAGOS A USUARIOS ─────────────── */
  function renderPanelPagos(panel, pagos) {
    panel.innerHTML = '';
    var lista = (pagos || [].slice()).slice().sort(function (a, b) {
      return (b.fecha || '').localeCompare(a.fecha || '');
    });

    panel.appendChild(el('p', 'fin-note',
      'Registro de pagos/desembolsos hechos a usuarios desde la Bolsa de Comisiones. La Caja Mayor no se usa para estos egresos.'));

    var stats = el('div', 'fin-stats');
    stats.appendChild(statCard('Desembolsos realizados', String(lista.length), ''));
    stats.appendChild(statCard('Total desembolsado', fmtMoneda(sumarMontos(lista)), 'blue'));
    panel.appendChild(stats);

    var wrap = el('div', 'fin-table-wrap');
    if (!lista.length) {
      wrap.appendChild(el('p', 'fin-empty', 'Aún no se registran desembolsos a usuarios. Usa "Pago/Desembolso" desde la vista Finanzas.'));
    } else {
      var table = document.createElement('table');
      table.className = 'fin-table';
      var thead = document.createElement('thead');
      var hr = document.createElement('tr');
      ['Fecha', 'Usuario', 'Banco', 'N° cuenta', 'Concepto', 'Monto'].forEach(function (h) {
        var th = document.createElement('th');
        th.textContent = h;
        hr.appendChild(th);
      });
      thead.appendChild(hr);
      table.appendChild(thead);
      var tbody = document.createElement('tbody');
      lista.forEach(function (p) {
        var u = usuarioById(p.userId);
        var tr = document.createElement('tr');
        tr.appendChild(celda(V.fmtDate(p.fecha) || ''));
        tr.appendChild(celda((u ? nombreUsuario(u) : p.userId || '—') + (u && u.email ? ' · ' + u.email : '')));
        tr.appendChild(celda(p.banco || '—'));
        tr.appendChild(celda(p.numeroCuenta || '—'));
        tr.appendChild(celda(p.concepto || '—'));
        tr.appendChild(celda(fmtMoneda(p.monto), 'fin-monto neg'));
        tbody.appendChild(tr);
      });
      var trT = document.createElement('tr');
      trT.className = 'fin-total-row';
      trT.appendChild(celda('TOTAL'));
      trT.appendChild(celda(''));
      trT.appendChild(celda(''));
      trT.appendChild(celda(''));
      trT.appendChild(celda(''));
      trT.appendChild(celda(fmtMoneda(sumarMontos(lista)), 'fin-monto neg'));
      tbody.appendChild(trT);
      table.appendChild(tbody);
      wrap.appendChild(table);
    }
    panel.appendChild(wrap);
  }

  function statCard(label, value, cls) {
    var c = el('div', 'fin-stat');
    c.appendChild(el('div', 'fin-stat-label', label));
    var v = el('div', 'fin-stat-value' + (cls ? ' ' + cls : ''), value);
    c.appendChild(v);
    return c;
  }

  /* ─── DESGLOSE MLM (reutiliza el motor dinámico del módulo) ─ */
  function renderDesglose(container, tx) {
    if (esTxDirecta(tx)) {
      var directo = document.createElement('details');
      directo.className = 'fin-desglose';
      var dsum = document.createElement('summary');
      dsum.appendChild(el('span', '', '🙏 Ofrenda directa · 100% al destinatario'));
      directo.appendChild(dsum);
      var dbody = el('div', 'fin-desglose-body');
      dbody.appendChild(el('p', 'fin-nota',
        'El monto completo va a ' + (nombreBeneficiario(tx) || 'el destinatario')
        + '. No se divide entre Bolsa de Comisiones y Caja Mayor ni genera comisiones MLM.'));
      directo.appendChild(dbody);
      container.appendChild(directo);
      return;
    }
    if (!V.mlm || !V.mlm.calcularPayloadCon) return;
    var d = document.createElement('details');
    d.className = 'fin-desglose';
    var s = document.createElement('summary');
    s.appendChild(el('span', '', '🌳 Desglose MLM de este movimiento'));
    d.appendChild(s);
    var body = el('div', 'fin-desglose-body');
    body.appendChild(el('p', 'fin-loading', 'Calculando distribución…'));
    d.appendChild(body);
    container.appendChild(d);

    calcularComisionesTx(tx).then(function (comisiones) {
      body.innerHTML = '';
      if (!comisiones.length) {
        body.appendChild(el('p', 'fin-empty', 'Sin patrocinadores ascendentes: este movimiento no genera comisiones.'));
        return;
      }
      comisiones.forEach(function (c) {
        var row = el('div', 'fin-fila');
        var info = el('div', 'fin-fila-info');
        info.appendChild(el('div', 'fin-fila-titulo', 'Nivel ' + c.nivel + ' · ' + c.porcentaje + '%'));
        info.appendChild(el('div', 'fin-fila-sub', 'Beneficiario: ' + (usuarioById(c.userId) ? nombreUsuario(usuarioById(c.userId)) : String(c.userId))));
        row.appendChild(info);
        row.appendChild(el('div', 'fin-fila-monto pos', fmtMoneda(c.monto)));
        body.appendChild(row);
      });
    }).catch(function () {
      body.innerHTML = '';
      body.appendChild(el('p', 'fin-empty', 'No se pudo calcular el desglose en este momento.'));
    });
  }

  /* ─── UI: PANEL DEL PERFIL (Escritorio) ────────────────────── */
  // Carga los datos del perfil financiero (transacciones, comisiones,
  // pagos/desembolsos y referencias). Cada consulta nunca rechaza: si
  // Fallas, devuelve [] y la vista sigue mostrando estado vacío.
  function cargarDatosPerfil() {
    return Promise.all([
      misTransacciones(),
      misComisiones(),
      todosPagos(),
      transaccionesRecibidasDirectas(),
      loadComunidades(),
      (isAdminUser() ? loadUsuarios() : Promise.resolve([]))
    ]);
  }

  function renderPerfil() {
    var panel = V.$('finanzasPanel');
    var body = V.$('finanzasBody');
    if (!panel || !body) return;
    // CUALQUIER usuario autenticado ve el panel y el CTA (sin filtros de rol
    // ni de módulo). Solo se oculta si no hay sesión.
    if (V.isAnon || !V.userId) { panel.style.display = 'none'; return; }
    panel.style.display = '';
    bindAporteCta();
    body.innerHTML = '';
    var loader = el('p', 'fin-loading', 'Cargando tus finanzas…');
    body.appendChild(loader);

    var vuelto = false;
    var watchdog = null;

    function limpiarCarga() {
      if (loader && loader.parentNode) loader.parentNode.removeChild(loader);
      loader = null;
    }
    // Borra todo el cuerpo. El CTA vive fuera de este contenedor (HTML
    // estático), por lo que nunca se ve afectado por el repintado.
    function limpiarCuerpo() {
      body.innerHTML = '';
    }
    function fallo(mensaje) {
      vuelto = true;
      if (watchdog) { clearTimeout(watchdog); watchdog = null; }
      limpiarCarga();
      limpiarCuerpo();
      body.appendChild(el('p', 'fin-empty', mensaje));
    }
    // Red de seguridad anti-congelamiento: si la promesa nunca termina
    // (red colgada, reglas de Firestore, etc.), se limpia el "Cargando…"
    // y se muestra una vista vacía amigable en lugar de quedarse infinito.
    function armarWatchdog() {
      if (watchdog) return;
      watchdog = setTimeout(function () {
        if (!vuelto) fallo('No se pudieron cargar tus finanzas en este momento. Intenta de nuevo.');
      }, 20000);
    }

    try {
      armarWatchdog();

      cargarDatosPerfil()
        .then(function (res) {
          vuelto = true;
          if (watchdog) { clearTimeout(watchdog); watchdog = null; }
          var transacciones = res && res[0] ? res[0] : [];
          var comisiones = res && res[1] ? res[1] : [];
          var pagos = res && res[2] ? res[2] : [];
          var recibidas = res && res[3] ? res[3] : [];
          limpiarCarga();
          limpiarCuerpo();
          renderStats(body, transacciones, comisiones, pagos, recibidas);
          if (transacciones.length || comisiones.length || pagos.length || recibidas.length) {
            renderHistorial(body, transacciones);
            renderBendiciones(body, recibidas);
            renderGanancias(body, comisiones);
            renderMisPagos(body, pagos);
          } else {
            // Estado limpio: aún no hay movimientos registrados.
            body.appendChild(el('p', 'fin-empty', 'No hay movimientos registrados. Cuando registres un aporte o recibas comisiones, aparecerán aquí.'));
          }
        }, null)
        .then(null, function (e) {
          console.error('Error al cargar las finanzas del usuario:', e);
          fallo('No se pudieron cargar tus finanzas en este momento. Intenta de nuevo.');
        })
        .then(function () {
          // Equivalente a finally de la promesa: pase lo que pase, el
          // estado de carga se elimina de la interfaz.
          limpiarCarga();
        });
    } catch (e) {
      console.error('Error al inicializar las finanzas del usuario:', e);
      fallo('No se pudieron cargar tus finanzas en este momento. Intenta de nuevo.');
    } finally {
      // Garantía incondicional: el watchdog de limpieza del estado de
      // carga se arma en todos los casos (incluso si el try falló antes).
      armarWatchdog();
    }
  }

  // Enlaza el CTA estático (definido en index.html) para CUALQUIER usuario
  // autenticado. No depende de rol, permisos, config del módulo ni recargas
  // de datos: el markup vive fuera de finanzasBody y nunca se borra.
  function bindAporteCta() {
    var ids = ['btnAporteDonacion', 'btnAporteDonacionModulo'];
    ids.forEach(function (id) {
      var btn = V.$(id);
      if (!btn || btn._aporteBound) return;
      btn._aporteBound = true;
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        abrirModalAporte();
      });
    });
    var btnModuloCta = V.$('finanzasModuloCta');
    if (btnModuloCta) btnModuloCta.style.display = 'none';
  }

  // Medios de pago mostrados en el modal: dos opciones de transferencia
  // directa manual (Nequi y Bancolombia). Usan los datos de las cuentas del
  // catálogo si están disponibles.
  function mediosPagoAporte() {
    var cuentaPorBanco = function (needle) {
      for (var i = 0; i < cuentasCache.length; i++) {
        var c = cuentasCache[i];
        if (String(c.banco || '').toLowerCase().indexOf(needle) !== -1) return c;
      }
      return null;
    };
    var nequi = cuentaPorBanco('nequi');
    var banco = cuentaPorBanco('bancolombia');
    return [
      {
        id: 'nequi',
        label: 'Nequi',
        icon: '📱',
        banco: nequi ? nequi.banco : 'Nequi',
        numero: nequi ? nequi.numero : '300 000 0000',
        cuentaId: nequi ? nequi.id : '',
        nota: 'Envía el dinero desde tu app Nequi a este número y luego comparte el comprobante por WhatsApp.'
      },
      {
        id: 'bancolombia',
        label: 'Bancolombia',
        icon: '🏦',
        banco: banco ? banco.banco : 'Bancolombia Ahorros',
        numero: banco ? banco.numero : '000 0000 0000',
        cuentaId: banco ? banco.id : '',
        nota: 'Transferencia o consignación a la cuenta de ahorros. Adjunta el número de referencia.'
      }
    ];
  }

  function abrirModalAporte() {
    if (V.isAnon || !V.userId) { V.toast('Inicia sesión para realizar un aporte.', true); return; }
    abrirModalTransaccion(null);
  }

  function renderStats(container, transacciones, comisiones, pagos, recibidas) {
    var totalAportado = 0;
    transacciones.forEach(function (t) { totalAportado += Number(t.monto) || 0; });
    var totalRecibido = sumarMontos(recibidas || []);
    var totalComisiones = 0;
    comisiones.forEach(function (c) { totalComisiones += Number(c.monto) || 0; });
    var totalPagado = sumarMontos(pagos || []);
    var saldoDisponible = redondear(totalComisiones - totalPagado);

    var card = el('div', 'fin-saldo-card');
    var head = el('div', 'fin-saldo-head');
    var titles = el('div', '');
    titles.appendChild(el('h3', 'fin-saldo-title', '📊 Ficha de saldo'));
    titles.appendChild(el('p', 'fin-saldo-sub', 'Tus aportes, ofrendas recibidas, comisiones y saldo disponible.'));
    head.appendChild(titles);
    head.appendChild(el('div', 'fin-saldo-stamp', 'Actualizado ' + new Date().toLocaleTimeString('es-CO')));
    card.appendChild(head);

    var body = el('div', 'fin-saldo-body');
    var main = el('div', 'fin-saldo-main');
    main.appendChild(el('div', 'fin-saldo-label', 'Saldo disponible'));
    main.appendChild(el('div', 'fin-saldo-value', fmtMoneda(saldoDisponible)));
    main.appendChild(el('div', 'fin-saldo-hint', 'Comisiones recibidas − desembolsos realizados'));
    body.appendChild(main);

    var grid = el('div', 'fin-saldo-grid');
    grid.appendChild(fichaItem('Aportes realizados', fmtMoneda(totalAportado), 'gold'));
    grid.appendChild(fichaItem('Ofrendas recibidas', fmtMoneda(totalRecibido), 'green'));
    grid.appendChild(fichaItem('Comisiones recibidas', fmtMoneda(totalComisiones), 'green'));
    grid.appendChild(fichaItem('Desembolsos', fmtMoneda(totalPagado), 'blue'));
    grid.appendChild(fichaItem('Movimientos', String(transacciones.length), ''));
    body.appendChild(grid);
    card.appendChild(body);
    container.appendChild(card);
  }

  function selectOpcoes(select, options) {
    fillSelectOpciones(select, options, '');
  }

  function renderHistorial(container, transacciones) {
    var sec = document.createElement('details');
    sec.className = 'fin-seccion';
    var s = document.createElement('summary');
    s.appendChild(el('span', '', '📊 Mis Aportes · Historial de movimientos'));
    sec.appendChild(s);
    var wrap = el('div', 'fin-seccion-body');
    sec.appendChild(wrap);
    container.appendChild(sec);

    if (!transacciones.length) {
      wrap.appendChild(el('p', 'fin-empty', 'Aún no has registrado aportes.'));
      return;
    }

    transacciones.forEach(function (t) {
      var esDirecto = esTxDirecta(t);
      var cat = categoriaById(t.categoriaId) || { nombre: t.categoriaId || '—', tipo: t.tipo };
      var row = el('div', 'fin-fila');
      var info = el('div', 'fin-fila-info');
      info.appendChild(el('div', 'fin-fila-titulo', esDirecto ? ETIQUETA_DIRECTO : (cat.nombre || '—')));
      var partes = [];
      if (esDirecto) {
        partes.push('Ofrenda para: ' + (nombreBeneficiario(t) || 'Beneficiario'));
        var detHist = detalleBeneficiario(t);
        if (detHist) partes.push(detHist);
      }
      if (t.origen === 'comunidad' || t.tipo === 'grupo') {
        var comunidadTx = t.comunidadId ? comunidadById(t.comunidadId) : null;
        partes.push(comunidadTx ? 'Comunidad: ' + comunidadTx.nombre : 'Comunidad');
      }
      if (isAdminUser() && t.userId && t.userId !== V.userId) {
        partes.push('Usuario: ' + (usuarioById(t.userId) ? nombreUsuario(usuarioById(t.userId)) : t.userId));
      }
      if (t.metodoPago) partes.push('Pago: ' + t.metodoPago);
      if (t.referenciaPago) partes.push('Ref: ' + t.referenciaPago);
      if (t.fecha) partes.push(V.fmtDate(t.fecha));
      var subTxt = partes.join(' · ');
      info.appendChild(el('div', 'fin-fila-sub', subTxt));
      if (t.estado) {
        var estCls = estadoPillClsTx(t) || 'gris';
        info.appendChild(el('span', 'fin-pill ' + estCls, estadoLabelTx(t)));
      }
      row.appendChild(info);
      var right = el('div', 'fin-fila-info');
      right.appendChild(el('div', 'fin-fila-monto' + (esDirecto || t.tipo === 'grupo' ? ' pos' : ''), fmtMoneda(t.monto)));
      right.appendChild(el('span', 'fin-pill ' + (esDirecto || t.tipo === 'grupo' ? 'oro' : (t.origen === 'usuario' ? 'azul' : 'gris')), tipoLabel(t.tipo)));
      row.appendChild(right);
      wrap.appendChild(row);
      renderDesglose(wrap, t);
    });
  }

  function renderBendiciones(container, recibidas) {
    if (!recibidas || !recibidas.length) return;
    var sec = document.createElement('details');
    sec.className = 'fin-seccion';
    sec.open = true;
    var s = document.createElement('summary');
    s.appendChild(el('span', '', '🙏 Mis Bendiciones / Recursos Recibidos'));
    sec.appendChild(s);
    var wrap = el('div', 'fin-seccion-body');
    sec.appendChild(wrap);
    container.appendChild(sec);

    var total = 0;
    recibidas.forEach(function (t) {
      total += Number(t.monto) || 0;
      var origen = nombreDonante(t) || 'Donante';
      var row = el('div', 'fin-fila');
      var info = el('div', 'fin-fila-info');
      info.appendChild(el('div', 'fin-fila-titulo', 'Ofrenda recibida de ' + origen));
      var partes = ['Origen: ' + origen];
      if (t.concepto) partes.push(t.concepto);
      var detBen = detalleBeneficiario(t);
      if (detBen) partes.push(detBen);
      if (t.fecha) partes.push(V.fmtDate(t.fecha));
      info.appendChild(el('div', 'fin-fila-sub', partes.join(' · ')));
      if (t.estado) {
        var estCls = estadoPillClsTx(t) || 'gris';
        info.appendChild(el('span', 'fin-pill ' + estCls, estadoLabelTx(t)));
      }
      row.appendChild(info);
      var right = el('div', 'fin-fila-info');
      right.appendChild(el('div', 'fin-fila-monto pos', fmtMoneda(t.monto)));
      right.appendChild(el('span', 'fin-pill oro', tipoLabel(t.tipo)));
      row.appendChild(right);
      wrap.appendChild(row);
    });
    var totalRow = el('div', 'fin-fila');
    totalRow.appendChild(el('div', 'fin-fila-titulo', 'Total recibido'));
    totalRow.appendChild(el('div', 'fin-fila-monto pos', fmtMoneda(total)));
    wrap.appendChild(totalRow);
  }

  function renderGanancias(container, comisiones) {
    var sec = document.createElement('details');
    sec.className = 'fin-seccion';
    var s = document.createElement('summary');
    s.appendChild(el('span', '', '💰 Comisiones recibidas'));
    sec.appendChild(s);
    var wrap = el('div', 'fin-seccion-body');
    sec.appendChild(wrap);
    container.appendChild(sec);

    if (!comisiones.length) {
      wrap.appendChild(el('p', 'fin-empty', 'Sin comisiones aún. Como coordinador de una comunidad, recibirás el ' +
        (cfg ? cfg.porcentajeCoordinador : DEFAULT_CONFIG.porcentajeCoordinador) + '% de cada ofrenda de grupo liquidada.'));
      return;
    }
    var total = 0;
    comisiones.forEach(function (c) {
      total += Number(c.monto) || 0;
      var com = c.comunidadId ? comunidadById(c.comunidadId) : null;
      var row = el('div', 'fin-fila');
      var info = el('div', 'fin-fila-info');
      info.appendChild(el('div', 'fin-fila-titulo', (com ? com.nombre : 'Comunidad') + ' · ' + tipoLabel(c.tipo)));
      var sub = 'Nivel ' + (c.nivel || 1) + ' · ' + (c.porcentaje || 0) + '%' +
        (isAdminUser() && c.userId && c.userId !== V.userId ? ' · Beneficiario: ' + (usuarioById(c.userId) ? nombreUsuario(usuarioById(c.userId)) : c.userId) : '') +
        (c.fecha ? ' · ' + V.fmtDate(c.fecha) : '');
      info.appendChild(el('div', 'fin-fila-sub', sub));
      row.appendChild(info);
      row.appendChild(el('div', 'fin-fila-monto pos', fmtMoneda(c.monto)));
      wrap.appendChild(row);
    });
    var totalRow = el('div', 'fin-fila');
    totalRow.appendChild(el('div', 'fin-fila-titulo', 'Total en comisiones'));
    totalRow.appendChild(el('div', 'fin-fila-monto pos', fmtMoneda(total)));
    wrap.appendChild(totalRow);
  }

  function renderMisPagos(container, pagos) {
    var sec = document.createElement('details');
    sec.className = 'fin-seccion';
    var s = document.createElement('summary');
    s.appendChild(el('span', '', '💸 Desembolsos recibidos'));
    sec.appendChild(s);
    var wrap = el('div', 'fin-seccion-body');
    sec.appendChild(wrap);
    container.appendChild(sec);

    if (!pagos || !pagos.length) {
      wrap.appendChild(el('p', 'fin-empty', 'Aún no recibes desembolsos. El superadmin te paga desde la Bolsa de Comisiones cuando lo solicites.'));
      return;
    }
    var total = 0;
    pagos.forEach(function (p) {
      total += Number(p.monto) || 0;
      var row = el('div', 'fin-fila');
      var info = el('div', 'fin-fila-info');
      info.appendChild(el('div', 'fin-fila-titulo', 'Pago a ' + (p.banco ? p.banco : 'tu cuenta') + (p.numeroCuenta ? ' · ' + p.numeroCuenta : '')));
      var sub = (p.concepto || 'Desembolso de comisiones') + (p.fecha ? ' · ' + V.fmtDate(p.fecha) : '') + ' · ' + (p.estado || 'pagado');
      info.appendChild(el('div', 'fin-fila-sub', sub));
      row.appendChild(info);
      row.appendChild(el('div', 'fin-fila-monto neg', '-' + fmtMoneda(p.monto)));
      wrap.appendChild(row);
    });
    var totalRow = el('div', 'fin-fila');
    totalRow.appendChild(el('div', 'fin-fila-titulo', 'Total desembolsado'));
    totalRow.appendChild(el('div', 'fin-fila-monto neg', '-' + fmtMoneda(total)));
    wrap.appendChild(totalRow);
  }

  /* ─── UI: PANEL ADMIN (config y liquidación) ─────────────────
     Parámetros configurables: interruptor maestro, porcentajes de la
     red MLM (N1–N5, por defecto 30/5/5/5/5=55%) y % de Caja Mayor
     (por defecto 45%). El motor de cálculo y los reportes leen estos
     valores dinámicamente.                                          */
  function renderFinanzasAdmin() {
    var panel = V.$('finanzasConfigArea');
    if (!panel) return;
    if (!isAdminUser() || !cfg) { panel.style.display = 'none'; return; }
    panel.style.display = '';
    panel.innerHTML = '';

    // El CONTABLE no edita la configuración (interruptor maestro,
    // porcentajes de la red, Caja Mayor ni categorías): su ámbito son
    // los DATOS OPERATIVOS. El backend aplica la misma regla
    // (firestore.rules escribe config/finanzas solo con isAdmin()).
    if (!esSuper()) {
      panel.appendChild(el('h3', '', '💰 Datos operativos (cuentas y transacciones)'));
      panel.appendChild(el('p', 'field-hint', 'Administra las cuentas bancarias y las transacciones del módulo. Los interruptores y los porcentajes de la red los edita únicamente el superadmin, en Configuración → Finanzas y MLM.'));
      renderDatosOperativos(panel);
      return;
    }

    var h3 = el('h3', '', '💰 Finanzas (Aportes, Ofrendas y Comisiones MLM)');
    var hint = el('p', 'field-hint', 'Interruptor maestro, porcentajes de la red, Caja Mayor, categorías y liquidación de ofrendas de grupo.');
    panel.appendChild(h3);
    panel.appendChild(hint);

    var sw = el('label', 'mlm-switch');
    var toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.id = 'finanzasEnabledToggle';
    toggle.checked = !!cfg.finanzasEnabled;
    sw.appendChild(toggle);
    sw.appendChild(el('span', 'mlm-switch-slider', ''));
    var swLabel = el('span', 'mlm-switch-label', cfg.finanzasEnabled ? 'Finanzas activadas' : 'Finanzas desactivadas');
    sw.appendChild(swLabel);
    toggle.addEventListener('change', function () {
      swLabel.textContent = this.checked ? 'Finanzas activadas' : 'Finanzas desactivadas';
    });
    panel.appendChild(sw);

    // Parámetros: porcentajes MLM N1–N5 + Caja Mayor + coordinador.
    renderParametrosPorcentajes(panel);

    renderCategoriasAdmin(panel);

    // Datos operativos: catálogo de cuentas bancarias/billeteras,
    // liquidación de ofrendas de grupo y asignación de comisión.
    renderDatosOperativos(panel);
    panel.appendChild(el('p', 'fin-reg-note', 'Las ofrendas de grupo se registran a nombre del coordinador de la comunidad, que recibe el ' + cfg.porcentajes[1] + '% como comisión nivel 1; los niveles 2–5 se liquidan a su red ascendente. El superadmin puede registrar, editar o eliminar transacciones de cualquier usuario o comunidad (bypass total).'));

    var btnSave = el('button', 'btn btn-primary btn-sm', 'Guardar configuración');
    btnSave.type = 'button';
    btnSave.id = 'btnFinanzasConfigSave';
    btnSave.addEventListener('click', function () {
      btnSave.disabled = true;
      btnSave.textContent = '⏳ Guardando…';
      guardarConfig({
        finanzasEnabled: toggle.checked,
        porcentajeCoordinador: (document.getElementById('finPctCoordinador') || {}).value,
        porcentajes: leerPorcentajesInputs(),
        porcentajeCaja: (document.getElementById('finPctCaja') || {}).value,
        categorias: _catsWorking
      }).then(function () {
        V.toast('Configuración de Finanzas guardada ✓');
      }).catch(function (e) {
        V.toast('Error al guardar: ' + (e && e.message ? e.message : e), true);
      }).then(function () {
        if (!document.body.contains(btnSave)) return;
        btnSave.disabled = false;
        btnSave.textContent = 'Guardar configuración';
      });
    });
    panel.appendChild(btnSave);
  }

  /* Datos operativos del módulo de finanzas: catálogo de cuentas
     bancarias/billeteras, liquidación de ofrendas de grupo y
     asignación manual de comisión. Los administra el superadmin y el
     contable (las tres funciones ya exigen isAdminUser()). */
  function renderDatosOperativos(container) {
    renderCuentasAdmin(container);
    container.appendChild(renderLiquidacion(container));
    container.appendChild(renderAsignacionComision(container));
  }

  function leerPorcentajesInputs() {
    var out = {};
    var inputs = document.querySelectorAll('.fin-pct-nivel');
    Array.prototype.forEach.call(inputs, function (inp) {
      var nivel = parseInt(inp.dataset.nivel, 10);
      var v = parseFloat(inp.value);
      out[nivel] = isFinite(v) ? Math.min(100, Math.max(0, v)) : 0;
    });
    return out;
  }

  function renderParametrosPorcentajes(container) {
    container.appendChild(el('div', 'fin-subhead', 'Parámetros de distribución'));

    var grid = el('div', 'fin-pct-grid');
    for (var n = 1; n <= 5; n++) {
      var f = el('div', 'field');
      f.appendChild(el('label', '', 'Comisión Nivel ' + n + ' (%)'));
      var inp = document.createElement('input');
      inp.type = 'number';
      inp.className = 'input fin-pct-nivel';
      inp.dataset.nivel = String(n);
      inp.min = '0';
      inp.max = '100';
      inp.step = '1';
      inp.value = Number(cfg.porcentajes[n]) || 0;
      f.appendChild(inp);
      grid.appendChild(f);
    }
    var fCaja = el('div', 'field');
    fCaja.appendChild(el('label', '', 'Caja Mayor / Fondo Estructura (%)'));
    var inpCaja = document.createElement('input');
    inpCaja.type = 'number';
    inpCaja.className = 'input';
    inpCaja.id = 'finPctCaja';
    inpCaja.min = '0';
    inpCaja.max = '100';
    inpCaja.step = '1';
    inpCaja.value = cfg.porcentajeCaja;
    fCaja.appendChild(inpCaja);
    grid.appendChild(fCaja);

    var fCoord = el('div', 'field');
    fCoord.appendChild(el('label', '', 'Comisión coordinador (legacy, %)'));
    var inpCoord = document.createElement('input');
    inpCoord.type = 'number';
    inpCoord.className = 'input';
    inpCoord.id = 'finPctCoordinador';
    inpCoord.min = '0';
    inpCoord.max = '100';
    inpCoord.step = '1';
    inpCoord.value = cfg.porcentajeCoordinador;
    fCoord.appendChild(inpCoord);
    grid.appendChild(fCoord);

    container.appendChild(grid);

    var nota = el('p', 'fin-form-note', '');
    container.appendChild(nota);
    var cajaNota = el('p', 'fin-form-note', '');
    container.appendChild(cajaNota);

    function actualizarNotas() {
      var sum = leturaRapida(cajaNota);
    }
    function leturaRapida(parpadeo) {
      var total = 0;
      var inputs = container.querySelectorAll('.fin-pct-nivel');
      Array.prototype.forEach.call(inputs, function (inp) {
        var v = parseFloat(inp.value);
        if (isFinite(v)) total += v;
      });
      nota.textContent = 'Bolsa total de comisiones MLM: ' + total + '% → Caja Mayor automática: ' + Math.max(0, 100 - total) + '%.';
      if (total > 100) nota.className = 'fin-form-note fin-warn';
      else nota.className = 'fin-form-note';
    }
    var inputs = container.querySelectorAll('.fin-pct-nivel');
    Array.prototype.forEach.call(inputs, function (inp) { inp.addEventListener('input', leturaRapida); });
    leturaRapida();
  }

  var _catsWorking = [];
  var _editingCatId = null;

  function renderCategoriasAdmin(container) {
    _catsWorking = (cfg.categorias || []).map(function (c) { return { id: c.id, nombre: c.nombre, tipo: c.tipo, activa: c.activa }; });
    _editingCatId = null;

    container.appendChild(el('div', 'fin-subhead', 'Categorías'));

    var form = el('div', 'fin-form');
    var fNombre = el('div', 'field');
    fNombre.appendChild(el('label', '', 'Nombre'));
    var inputNombre = document.createElement('input');
    inputNombre.type = 'text';
    inputNombre.className = 'input';
    inputNombre.placeholder = 'Ej: Diezmo';
    inputNombre.id = 'finCatNombre';
    fNombre.appendChild(inputNombre);
    form.appendChild(fNombre);

    var fTipo = el('div', 'field');
    fTipo.appendChild(el('label', '', 'Tipo'));
    var selTipo = document.createElement('select');
    selTipo.className = 'select';
    selTipo.id = 'finCatTipo';
    TIPOS_VALIDOS.forEach(function (t) {
      var opt = document.createElement('option');
      opt.value = t;
      opt.textContent = tipoLabel(t);
      selTipo.appendChild(opt);
    });
    fTipo.appendChild(selTipo);
    form.appendChild(fTipo);

    var fActiva = el('label', 'fin-form-note');
    var cbActiva = document.createElement('input');
    cbActiva.type = 'checkbox';
    cbActiva.checked = true;
    fActiva.appendChild(cbActiva);
    fActiva.appendChild(document.createTextNode(' Activa'));
    form.appendChild(fActiva);

    var acciones = el('div', 'fin-form-acciones');
    var btnAgregar = el('button', 'btn btn-primary btn-sm', '➕ Agregar categoría');
    btnAgregar.type = 'button';
    var btnCancelar = el('button', 'btn btn-outline btn-sm', 'Cancelar edición');
    btnCancelar.type = 'button';
    btnCancelar.style.display = 'none';
    acciones.appendChild(btnAgregar);
    acciones.appendChild(btnCancelar);
    form.appendChild(acciones);
    container.appendChild(form);

    var list = el('div', '');
    container.appendChild(list);

    function renderList() {
      list.innerHTML = '';
      if (!_catsWorking.length) {
        list.appendChild(el('p', 'fin-empty', 'No hay categorías. Agrega la primera con el formulario.'));
        return;
      }
      _catsWorking.forEach(function (c) {
        var row = el('div', 'fin-cat-row');
        var nom = el('div', '');
        nom.appendChild(el('div', 'fin-cat-nombre', c.nombre));
        nom.appendChild(el('div', 'fin-cat-tipo', tipoLabel(c.tipo)));
        row.appendChild(nom);

        var act = el('label', 'fin-form-note');
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!c.activa;
        cb.addEventListener('change', function () { c.activa = cb.checked; });
        act.appendChild(cb);
        act.appendChild(document.createTextNode(' Activa'));
        row.appendChild(act);

        var acc = el('div', 'fin-cat-acciones');
        var btnEdit = el('button', 'btn btn-outline btn-sm', '✏️');
        btnEdit.type = 'button';
        btnEdit.title = 'Editar categoría';
        btnEdit.addEventListener('click', function () {
          _editingCatId = c.id;
          inputNombre.value = c.nombre;
          selTipo.value = c.tipo;
          cbActiva.checked = !!c.activa;
          btnAgregar.textContent = '💾 Guardar categoría';
          btnCancelar.style.display = '';
        });
        acc.appendChild(btnEdit);
        var btnDel = el('button', 'btn btn-danger btn-sm', '🗑️');
        btnDel.type = 'button';
        btnDel.title = 'Eliminar categoría';
        btnDel.addEventListener('click', function () {
          if (!confirm('¿Eliminar la categoría "' + c.nombre + '"?' +
            (_catsWorking.filter(function (x) { return x.tipo === c.tipo; }).length > 1
              ? ' Las transacciones existentes conservarán su valor.'
              : ' Es la única de su tipo; las transacciones existentes conservarán su valor.'))) return;
          _catsWorking = _catsWorking.filter(function (x) { return x.id !== c.id; });
          renderList();
        });
        acc.appendChild(btnDel);
        row.appendChild(acc);
        list.appendChild(row);
      });
    }

    function resetForm() {
      _editingCatId = null;
      inputNombre.value = '';
      selTipo.value = 'personal';
      cbActiva.checked = true;
      btnAgregar.textContent = '➕ Agregar categoría';
      btnCancelar.style.display = 'none';
    }

    btnCancelar.addEventListener('click', resetForm);

    function slugify(s) {
      return (s || '').trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '').slice(0, 40);
    }

    btnAgregar.addEventListener('click', function () {
      var nombre = inputNombre.value.trim();
      if (!nombre) { V.toast('Escribe el nombre de la categoría.', true); return; }
      if (_editingCatId) {
        for (var i = 0; i < _catsWorking.length; i++) {
          if (_catsWorking[i].id === _editingCatId) {
            _catsWorking[i].nombre = nombre;
            _catsWorking[i].tipo = selTipo.value;
            _catsWorking[i].activa = cbActiva.checked;
          }
        }
        V.toast('Categoría actualizada (pendiente de guardar) ✓');
      } else {
        var id = slugify(nombre) || ('cat_' + Date.now());
        var base = id;
        var n = 2;
        while (_catsWorking.some(function (x) { return x.id === id; })) { id = base + '_' + n; n++; }
        _catsWorking.push({ id: id, nombre: nombre, tipo: selTipo.value, activa: cbActiva.checked });
        V.toast('Categoría agregada (pendiente de guardar) ✓');
      }
      resetForm();
      renderList();
    });

    renderList();
  }

  /* ─── GESTIÓN DE CUENTAS BANCARIAS (superadmin) ──────────────
     Sección de administración del catálogo de cuentas del proyecto.
     Cada cuenta tiene SOLO dos campos: banco (con su tipo) y número.
     Solo se monta en el panel del superadmin; la lectura del gestor se
     resuelve por la API y las reglas, sin formulario de escritura.   */
  var _editingCuentaId = null;

  function renderCuentasAdmin(container) {
    container.appendChild(el('div', 'fin-subhead', 'Cuentas bancarias y billeteras'));
    container.appendChild(el('p', 'fin-form-note', 'Dos datos por cuenta: banco/billetera (con su tipo) y número. El rol gestor puede consultarlas para seleccionarlas como cuenta de destino; solo el superadmin puede crearlas, editarlas o eliminarlas.'));

    var form = el('div', 'fin-form');
    var fBanco = el('div', 'field');
    fBanco.appendChild(el('label', '', 'Banco / billetera'));
    var inpBanco = document.createElement('input');
    inpBanco.type = 'text';
    inpBanco.className = 'input';
    inpBanco.placeholder = 'Ej: Bancolombia Ahorros, Nequi';
    inpBanco.id = 'finCuentaBanco';
    inpBanco.autocomplete = 'off';
    fBanco.appendChild(inpBanco);
    form.appendChild(fBanco);

    var fNumero = el('div', 'field');
    fNumero.appendChild(el('label', '', 'Número de cuenta / billetera'));
    var inpNumero = document.createElement('input');
    inpNumero.type = 'text';
    inpNumero.className = 'input';
    inpNumero.placeholder = 'Ej: 01234567890 o 3001234567';
    inpNumero.id = 'finCuentaNumero';
    inpNumero.autocomplete = 'off';
    fNumero.appendChild(inpNumero);
    form.appendChild(fNumero);

    var acciones = el('div', 'fin-form-acciones');
    var btnAgregar = el('button', 'btn btn-primary btn-sm', '➕ Agregar cuenta');
    btnAgregar.type = 'button';
    var btnCancelar = el('button', 'btn btn-outline btn-sm', 'Cancelar edición');
    btnCancelar.type = 'button';
    btnCancelar.style.display = 'none';
    acciones.appendChild(btnAgregar);
    acciones.appendChild(btnCancelar);
    form.appendChild(acciones);
    container.appendChild(form);

    var list = el('div', '');
    container.appendChild(list);

    function resetForm() {
      _editingCuentaId = null;
      inpBanco.value = '';
      inpNumero.value = '';
      btnAgregar.textContent = '➕ Agregar cuenta';
      btnCancelar.style.display = 'none';
    }

    function renderList() {
      list.innerHTML = '';
      if (!cuentasCache.length) {
        list.appendChild(el('p', 'fin-empty', 'No hay cuentas registradas. Agrega la primera con el formulario.'));
        return;
      }
      cuentasCache.forEach(function (c) {
        var row = el('div', 'fin-cat-row');
        var info = el('div', '');
        info.appendChild(el('div', 'fin-cat-nombre', c.banco));
        info.appendChild(el('div', 'fin-cat-tipo', 'N.º ' + c.numero));
        row.appendChild(info);

        var acc = el('div', 'fin-cat-acciones');
        var btnEdit = el('button', 'btn btn-outline btn-sm', '✏️');
        btnEdit.type = 'button';
        btnEdit.title = 'Editar cuenta';
        btnEdit.addEventListener('click', function () {
          _editingCuentaId = c.id;
          inpBanco.value = c.banco;
          inpNumero.value = c.numero;
          btnAgregar.textContent = '💾 Guardar cuenta';
          btnCancelar.style.display = '';
        });
        acc.appendChild(btnEdit);
        var btnDel = el('button', 'btn btn-danger btn-sm', '🗑️');
        btnDel.type = 'button';
        btnDel.title = 'Eliminar cuenta';
        btnDel.addEventListener('click', function () {
          if (!confirm('¿Eliminar la cuenta "' + c.banco + '" (' + c.numero + ')? Las transacciones ya registradas conservarán su referencia.')) return;
          eliminarCuentaBanco(c.id).then(function () {
            V.toast('Cuenta eliminada ✓');
            return loadCuentas(true).then(renderList);
          }).catch(function (e) {
            V.toast(e && e.message ? e.message : 'Error al eliminar la cuenta.', true);
          });
        });
        acc.appendChild(btnDel);
        row.appendChild(acc);
        list.appendChild(row);
      });
    }

    btnCancelar.addEventListener('click', resetForm);

    btnAgregar.addEventListener('click', function () {
      var editando = !!_editingCuentaId;
      var datos = { banco: inpBanco.value, numero: inpNumero.value };
      btnAgregar.disabled = true;
      var op = _editingCuentaId
        ? editarCuentaBanco(_editingCuentaId, datos)
        : crearCuentaBanco(datos);
      op.then(function () {
        V.toast(editando ? 'Cuenta actualizada ✓' : 'Cuenta agregada ✓');
        resetForm();
        return loadCuentas(true).then(renderList);
      }).catch(function (e) {
        V.toast(e && e.message ? e.message : 'Error al guardar la cuenta.', true);
      }).then(function () {
        if (!document.body.contains(btnAgregar)) return;
        btnAgregar.disabled = false;
        btnAgregar.textContent = '➕ Agregar cuenta';
      });
    });

    list.appendChild(el('p', 'fin-loading', 'Cargando cuentas…'));
    loadCuentas(true).then(function () {
      if (!document.body.contains(list)) return;
      renderList();
    });
  }

  function renderLiquidacion(container) {
    var box = el('div', '');
    box.appendChild(el('div', 'fin-subhead', 'Liquidación de ofrendas de grupo'));

    var form = el('div', 'fin-form');
    var fCom = el('div', 'field');
    fCom.appendChild(el('label', '', 'Comunidad'));
    var selCom = document.createElement('select');
    selCom.className = 'select';
    fCom.appendChild(selCom);
    form.appendChild(fCom);

    var fCat = el('div', 'field');
    fCat.appendChild(el('label', '', 'Categoría'));
    var selCat = document.createElement('select');
    selCat.className = 'select';
    fCat.appendChild(selCat);
    form.appendChild(fCat);

    var fMonto = el('div', 'field');
    fMonto.appendChild(el('label', '', 'Monto'));
    var inputMonto = document.createElement('input');
    inputMonto.type = 'number';
    inputMonto.className = 'input';
    inputMonto.min = '1';
    inputMonto.step = '1';
    inputMonto.placeholder = 'Ej: 100000';
    fMonto.appendChild(inputMonto);
    form.appendChild(fMonto);

    var fCon = el('div', 'field');
    fCon.appendChild(el('label', '', 'Concepto (opcional)'));
    var inputCon = document.createElement('input');
    inputCon.type = 'text';
    inputCon.className = 'input';
    inputCon.placeholder = 'Ej: Ofrenda de la quincena';
    fCon.appendChild(inputCon);
    form.appendChild(fCon);

    var resumen = el('p', 'fin-form-note', '');
    form.appendChild(resumen);

    var acciones = el('div', 'fin-form-acciones');
    var btn = el('button', 'btn btn-primary', 'Liquidar ofrenda');
    btn.type = 'button';
    acciones.appendChild(btn);
    form.appendChild(acciones);
    box.appendChild(form);

    loadComunidades(true).then(function () {
      return loadUsuarios();
    }).then(function () {
      if (!document.body.contains(selCom)) return;
      var cats = categoriasDeTipo('grupo', true);
      selectOpcoes(selCom, comunidadesUnicas(comunidadesCache, selCom.value).map(function (c) {
        return { value: c.id, label: c.nombre + (c.coordinadorId ? ' · Coord: ' + nombreUsuario(usuarioById(c.coordinadorId)) : ' · Sin coordinador') };
      }));
      selectOpcoes(selCat, cats.map(function (c) { return { value: c.id, label: c.nombre }; }));
      selCom.addEventListener('change', actualizarResumen);
      selCat.addEventListener('change', actualizarResumen);
      actualizarResumen();
    });

    function actualizarResumen() {
      var com = comunidadById(selCom.value);
      if (com && com.coordinadorId && cfg) {
        var coord = usuarioById(com.coordinadorId);
        resumen.textContent = 'Coordinador: ' + (coord ? nombreUsuario(coord) : com.coordinadorId) +
          ' → comisión N1 (' + cfg.porcentajes[1] + '%) + red N2–N5 (' + ((Number(cfg.porcentajes[2]) || 0) + (Number(cfg.porcentajes[3]) || 0) + (Number(cfg.porcentajes[4]) || 0) + (Number(cfg.porcentajes[5]) || 0)) + '%).';
      } else {
        resumen.textContent = '';
      }
    }

    btn.addEventListener('click', function () {
      btn.disabled = true;
      btn.textContent = '⏳ Liquidando…';
      liquidarOfrendaGrupo({
        comunidadId: selCom.value,
        categoriaId: selCat.value,
        monto: inputMonto.value,
        concepto: inputCon.value
      }).then(function () {
        V.toast('Ofrenda liquidada y comisiones MLM cargadas ✓');
        inputMonto.value = '';
        inputCon.value = '';
        renderFinanzasAdmin();
        refreshPanel();
      }).catch(function (e) {
        V.toast(e && e.message ? e.message : 'Error al liquidar.', true);
        btn.disabled = false;
        btn.textContent = 'Liquidar ofrenda';
      });
    });

    return box;
  }

  /* ─── ASIGNACIÓN MANUAL DE COMISIONES (solo superadmin) ───── */
  function renderAsignacionComision(container) {
    if (!isAdminUser()) return el('div', '');
    var box = el('div', '');
    box.appendChild(el('div', 'fin-subhead', 'Asignación manual de comisiones'));

    var form = el('div', 'fin-form');
    var fBen = el('div', 'field');
    fBen.appendChild(el('label', '', 'Beneficiario'));
    var selBen = document.createElement('select');
    selBen.className = 'select';
    fBen.appendChild(selBen);
    form.appendChild(fBen);

    var fNiv = el('div', 'field');
    fNiv.appendChild(el('label', '', 'Nivel'));
    var selNiv = document.createElement('select');
    selNiv.className = 'select';
    for (var n = 1; n <= 5; n++) {
      var opt = document.createElement('option');
      opt.value = String(n);
      opt.textContent = 'Nivel ' + n + ' · ' + (Number(cfg.porcentajes[n]) || 0) + '%';
      selNiv.appendChild(opt);
    }
    fNiv.appendChild(selNiv);
    form.appendChild(fNiv);

    var fPct = el('div', 'field');
    fPct.appendChild(el('label', '', 'Porcentaje (%)'));
    var inpPct = document.createElement('input');
    inpPct.type = 'number';
    inpPct.className = 'input';
    inpPct.min = '0';
    inpPct.max = '100';
    inpPct.value = '10';
    fPct.appendChild(inpPct);
    form.appendChild(fPct);

    var fMon = el('div', 'field');
    fMon.appendChild(el('label', '', 'Monto'));
    var inpMon = document.createElement('input');
    inpMon.type = 'number';
    inpMon.className = 'input';
    inpMon.min = '1';
    inpMon.step = '1';
    inpMon.placeholder = 'Ej: 50000';
    fMon.appendChild(inpMon);
    form.appendChild(fMon);

    var fCon = el('div', 'field');
    fCon.appendChild(el('label', '', 'Concepto / origen (opcional)'));
    var inpCon = document.createElement('input');
    inpCon.type = 'text';
    inpCon.className = 'input';
    fCon.appendChild(inpCon);
    form.appendChild(fCon);

    var acciones = el('div', 'fin-form-acciones');
    var btn = el('button', 'btn btn-primary btn-sm', 'Asignar comisión');
    btn.type = 'button';
    acciones.appendChild(btn);
    form.appendChild(acciones);
    box.appendChild(form);

    loadUsuarios().then(function () {
      if (!document.body.contains(selBen)) return;
      selectOpcoes(selBen, usuariosCache.map(function (u) {
        return { value: u.uid, label: nombreUsuario(u) + ' · ' + (u.email || u.uid) };
      }));
    });

    btn.addEventListener('click', function () {
      var monto = redondear(Number(inpMon.value) || 0);
      if (!selBen.value) { V.toast('Selecciona un beneficiario.', true); return; }
      if (!(monto > 0)) { V.toast('Escribe un monto válido mayor a cero.', true); return; }
      btn.disabled = true;
      btn.textContent = '⏳ Asignando…';
      V.db.collection(COL_COMIS).add({
        userId: selBen.value,
        origenId: '',
        tipo: 'manual',
        nivel: Number(selNiv.value) || 0,
        porcentaje: Number(inpPct.value) || 0,
        monto: monto,
        fecha: new Date().toISOString(),
        comunidadId: '',
        concepto: inpCon.value.trim(),
        creadoPor: V.userId
      }).then(function () {
        V.toast('Comisión asignada ✓');
        refreshPanel();
      }).catch(function (e) {
        V.toast('Error al asignar: ' + (e && e.message ? e.message : e), true);
        btn.disabled = false;
        btn.textContent = 'Asignar comisión';
      });
    });

    return box;
  }

  /* ─── ESTADO GLOBAL DE LA UI ───────────────────────────────── */
  function refreshPanel() {
    renderFinanzasAdmin();
    renderPerfil();
  }

  function applyFinanzasUiState() {
    try {
      // El botón CTA de aporte/donación se enlaza siempre para cualquier
      // usuario autenticado (sin rol, permisos ni estado del módulo).
      if (V.$('btnAporteDonacion')) bindAporteCta();
      // El panel de Finanzas se muestra a CUALQUIER usuario con sesión.
      var panel = V.$('finanzasPanel');
      if (panel) panel.style.display = (!V.isAnon && V.userId) ? '' : 'none';
      if (!V.isAnon && V.userId) renderPerfil();
      renderFinanzasAdmin();
      if (V.$('finanzasContent')) renderVistaFinanzas();
      if (V.$('reportesContent')) renderVistaReportes();
    } catch (e) {
      if (window.console && console.error) console.error('[finanzas] error al aplicar el estado de la UI:', e);
    }
  }

  function wrapDashboardShow() {
    if (_wrapped || typeof V.onDashboardShow !== 'function') return;
    _wrapped = true;
    var original = V.onDashboardShow;
    V.onDashboardShow = function () {
      try { original.apply(null, arguments); } catch (e) { /* noop */ }
      applyFinanzasUiState();
    };
  }

  /* ─── HOOKS DE NAVEGACIÓN ──────────────────────────────────── */
  function onFinanzasShow() {
    // El CTA de aporte/donación debe quedar enlazado y visible al entrar a la
    // pestaña Finanzas para cualquier usuario con sesión. Se re-enlaza por si
    // el botón se recreó.
    bindAporteCta();
    renderVistaFinanzas();
    var btnNuevo = V.$('btnNuevaTransaccion');
    if (btnNuevo) {
      btnNuevo.onclick = function () { abrirModalTransaccion(null); };
    }
    var btnPago = V.$('btnNuevoDesembolso');
    if (btnPago) {
      btnPago.onclick = function () { abrirModalDesembolso(); };
    }
  }
  function onReportesShow() {
    renderVistaReportes();
  }

  /* ─── API ──────────────────────────────────────────────────── */
  V.finanzas = {
    _initialConfig: null,
    loadConfig: loadConfig,
    getConfig: getConfig,
    isEnabled: isEnabled,
    guardarConfig: guardarConfig,
    categoriaById: categoriaById,
    categoriasActivas: categoriasActivas,
    categoriasDeTipo: categoriasDeTipo,
    registrarAportePersonal: registrarAportePersonal,
    reportarAportePendiente: reportarAportePendiente,
    abrirModalAporte: abrirModalAporte,
    liquidarOfrendaGrupo: liquidarOfrendaGrupo,
    misTransacciones: misTransacciones,
    misComisiones: misComisiones,
    transaccionesRecibidasDirectas: transaccionesRecibidasDirectas,
    todasTransacciones: todasTransacciones,
    todasComisiones: todasComisiones,
    crearTransaccion: crearTransaccion,
    editarTransaccion: editarTransaccion,
    eliminarTransaccion: eliminarTransaccion,
    calcularComisionesTx: calcularComisionesTx,
    distribucionTx: distribucionTx,
    bolsaTotalPct: bolsaTotalPct,
    cajaPctVigente: cajaPctVigente,
    pctsMlm: pctsMlm,
    loadComunidades: loadComunidades,
    loadUsuarios: loadUsuarios,
    // Cuentas bancarias / billeteras: lectura para superadmin y gestor;
    // escritura exclusiva del superadmin (validada también en las reglas).
    loadCuentas: loadCuentas,
    cuentaById: cuentaById,
    crearCuenta: crearCuentaBanco,
    editarCuenta: editarCuentaBanco,
    eliminarCuenta: eliminarCuentaBanco,
    renderPerfil: renderPerfil,
    renderVistaFinanzas: renderVistaFinanzas,
    renderVistaReportes: renderVistaReportes,
    abrirModalTransaccion: abrirModalTransaccion,
    applyFinanzasUiState: applyFinanzasUiState
  };

  /* ─── MODULE INTERFACE ─────────────────────────────────────── */
  function logConfigError(e) {
    if (window.console && console.error) console.error('[finanzas] no se pudo cargar la configuración:', e);
  }

  var FinanzasModule = {
    onReady: function () {
      loadConfig().then(function (c) {
        V.finanzas._initialConfig = c;
        applyFinanzasUiState();
      }).catch(logConfigError);
    }
  };
  V.registerModule(FinanzasModule);

  // Publica los hooks de navegación que espera el Core (app.js).
  V.onFinanzasShow = onFinanzasShow;
  V.onReportesShow = onReportesShow;

  function init() {
    wrapDashboardShow();
    V.onFinanzasShow = onFinanzasShow;
    V.onReportesShow = onReportesShow;
    // En el arranque (DOMContentLoaded) aún no hay sesión resuelta; la carga
    // real de config/* (que exige signedIn()) ocurre en onReady tras
    // autenticar. Solo se consulta si ya existe una sesión activa.
    if (V.uidSesion()) {
      loadConfig().then(function (c) {
        V.finanzas._initialConfig = c;
        applyFinanzasUiState();
      }).catch(logConfigError);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
