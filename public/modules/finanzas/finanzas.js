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
     - categorias                 CRUD de categorías (personal/grupo/ofrenda)

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
  var TIPOS_VALIDOS = ['personal', 'grupo', 'ofrenda'];

  var ETIQUETA_USUARIO = 'Aporte de Usuario';
  var ETIQUETA_COMUNIDAD = 'Ofrenda de Comunidad';

  var DEFAULT_CONFIG = {
    finanzasEnabled: true,
    porcentajeCoordinador: 30,
    // Red MLM 5 niveles: 30% (N1) + 10% (N2) + 5% (N3–N5) = 55% de bolsa;
    // el 45% restante se destina a la Caja Mayor / Fondo Estructura General.
    porcentajes: { 1: 30, 2: 10, 3: 5, 4: 5, 5: 5 },
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
  function isAdminUser() { return V.userRole === 'superadmin'; }
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
      var tipo = TIPOS_VALIDOS.indexOf(c.tipo) === -1 ? 'personal' : c.tipo;
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
    if (t === 'grupo') return 'Ofrenda de grupo';
    if (t === 'ofrenda') return 'Ofrenda';
    if (t === 'aporte') return 'Aporte (MLM)';
    if (t === 'manual') return 'Asignación manual';
    if (t === 'usuario') return ETIQUETA_USUARIO;
    if (t === 'comunidad') return ETIQUETA_COMUNIDAD;
    return 'Aporte personal';
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
  function distribucionTx(tx) {
    var monto = Number(tx && tx.monto) || 0;
    var bolsaPct = bolsaTotalPct();
    var cajaPct = Math.max(0, 100 - bolsaPct);
    return {
      pctBolsa: bolsaPct,
      pctCaja: cajaPct,
      montoBolsa: redondear(monto * bolsaPct / 100),
      montoCaja: redondear(monto * cajaPct / 100)
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

    var origen = datos.origen === 'comunidad' ? 'comunidad' : 'usuario';
    var comunidadId = (datos.comunidadId && String(datos.comunidadId)) || '';
    var userId = '';
    var tipo = cat.tipo;

    if (origen === 'comunidad') {
      if (!comunidadId) throw new Error('Selecciona la comunidad de origen de la ofrenda.');
      var com = comunidadById(comunidadId);
      // El titular contable de la ofrenda es el coordinador (si existe);
      // el superadmin puede sobrescribir el userId de forma explícita
      // (bypass total, sin restricciones de cadenas de patrocinio).
      userId = (datos.userId && String(datos.userId)) || (com && com.coordinadorId) || '';
      tipo = 'grupo';
    } else {
      if (!datos.userId) throw new Error('Selecciona el usuario de origen del aporte.');
      userId = String(datos.userId);
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
      etiqueta: origen === 'comunidad' ? ETIQUETA_COMUNIDAD : ETIQUETA_USUARIO,
      userId: userId,
      comunidadId: comunidadId,
      categoriaId: cat.id,
      monto: monto,
      tipo: tipo,
      concepto: (datos.concepto || '').trim(),
      fecha: fecha,
      estado: (datos.estado && String(datos.estado)) || 'registrada',
      creadoPor: V.userId
    };
    baseTx.distribucion = distribucionTx({ monto: monto });
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
          // Al cambiar el monto/origen se re-liquida la bolsa MLM para
          // mantener la coherencia contable (bypass superadmin).
          return eliminarComisionesDe(id).then(function () {
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
      if (cat.tipo === 'grupo' && !admin) throw new Error('Las ofrendas de grupo se liquidan desde "Ofrenda de grupo".');
      var monto = redondear(Number(datos.monto) || 0);
      if (!(monto > 0)) throw new Error('Escribe un monto válido mayor a cero.');

      var comunidadId = '';
      var tipo = cat.tipo;
      var origen = 'usuario';
      var userId = (admin && datos.userId) ? String(datos.userId) : V.userId;

      if (admin && (datos.comunidadId || cat.tipo === 'grupo')) {
        origen = 'comunidad';
        comunidadId = (datos.comunidadId && String(datos.comunidadId)) || '';
        if (cat.tipo === 'grupo' && !comunidadId) throw new Error('Selecciona la comunidad de la ofrenda de grupo.');
        var com = comunidadById(comunidadId);
        if (!com) throw new Error('Selecciona una comunidad válida.');
        userId = (datos.userId && String(datos.userId)) || com.coordinadorId || '';
        tipo = 'grupo';
      }

      var tx = {
        origen: origen,
        origenId: origen === 'comunidad' ? comunidadId : userId,
        etiqueta: origen === 'comunidad' ? ETIQUETA_COMUNIDAD : ETIQUETA_USUARIO,
        userId: userId,
        comunidadId: comunidadId,
        categoriaId: cat.id,
        monto: monto,
        tipo: tipo,
        concepto: (datos.concepto || '').trim(),
        fecha: new Date().toISOString(),
        estado: (admin && datos.estado) ? String(datos.estado) : 'registrada',
        creadoPor: V.userId
      };
      tx.distribucion = distribucionTx({ monto: monto });
      return V.db.collection(COL_TRANS).add(tx).then(function (ref) {
        return liquidarComisionesTx(tx, ref.id).then(function () { return ref.id; });
      });
    });
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
        estado: 'liquidada'
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
    if (f.estado && tx.estado !== f.estado) return false;
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
    if (tx.origen === 'comunidad' || String(tx.tipo) === 'grupo') {
      var c = tx.comunidadId ? comunidadById(tx.comunidadId) : null;
      return c && c.nombre ? c.nombre : (tx.comunidadId || 'Comunidad');
    }
    var u = tx.userId ? usuarioById(tx.userId) : null;
    return u ? nombreUsuario(u) : (tx.userId || 'Usuario');
  }
  function estadoPillCls(estado) {
    var e = String(estado || '').toLowerCase();
    if (e === 'liquidada') return 'pos';
    if (e === 'anulada') return 'neg';
    return '';
  }

  /* ─── VISTA FINANZAS (superadmin · CRUD) ───────────────────── */
  function renderVistaFinanzas() {
    var cont = V.$('finanzasContent');
    if (!cont) return;
    var btnNuevo = V.$('btnNuevaTransaccion');
    var btnPago = V.$('btnNuevoDesembolso');
    if (!isAdminUser()) {
      cont.innerHTML = '';
      cont.appendChild(V.emptyState('🔒', 'Solo superadmin', 'El módulo centralizado de Finanzas está disponible exclusivamente para el rol superadmin.'));
      if (btnNuevo) btnNuevo.style.display = 'none';
      if (btnPago) btnPago.style.display = 'none';
      return;
    }
    if (btnNuevo) btnNuevo.style.display = '';
    if (btnPago) btnPago.style.display = '';

    cont.innerHTML = '';
    cont.appendChild(el('p', 'fin-loading', 'Cargando transacciones…'));

    Promise.all([todasTransacciones(), loadComunidades(true), loadUsuarios(true), loadConfig()])
      .then(function (res) {
        if (!document.body.contains(cont)) return;
        var txs = filtrarTxs(res[0], _finState);
        cont.innerHTML = '';
        renderKpisFinanzas(cont, res[0], _finState);
        renderFiltrosFinanzas(cont);
        renderTablaTransacciones(cont, txs);
      })
      .catch(function () {
        cont.innerHTML = '';
        cont.appendChild(el('p', 'fin-empty', 'No se pudieron cargar las transacciones en este momento.'));
      });
  }

  function renderKpisFinanzas(container, txs, filtros) {
    var base = txs || [];
    var filtradas = filtrarTxs(base, filtros);
    var totalIngresos = 0, totalBolsa = 0, totalCaja = 0;
    filtradas.forEach(function (tx) {
      var d = distribucionTx(tx);
      totalIngresos += Number(tx.monto) || 0;
      totalBolsa += d.montoBolsa;
      totalCaja += d.montoCaja;
    });
    var stats = el('div', 'fin-stats fin-stats-kpi');
    stats.appendChild(statCard('Ingresos totales', fmtMoneda(totalIngresos), 'gold'));
    stats.appendChild(statCard('Transacciones', String(filtradas.length), ''));
    stats.appendChild(statCard('Bolsa de comisiones (' + bolsaTotalPct() + '%)', fmtMoneda(totalBolsa), 'green'));
    stats.appendChild(statCard('Caja Mayor (' + cajaPctVigente() + '%)', fmtMoneda(totalCaja), 'blue'));
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
    var estOptions = [
      { value: '', label: 'Todos los estados' },
      { value: 'registrada', label: 'Registrada' },
      { value: 'liquidada', label: 'Liquidada' },
      { value: 'anulada', label: 'Anulada' }
    ];
    fillSelectOpciones(selEst, estOptions, _finState.estado);
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
      if (input.dataset.id) {
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          if (String(it.id) === String(input.dataset.id)
            && (it.label === raw || it.sub === raw || String(it.id) === raw)) {
            return it.id;
          }
        }
      }
      for (var j = 0; j < items.length; j++) {
        var itj = items[j];
        if (String(itj.id) === raw
          || itj.label.toLowerCase() === raw.toLowerCase()
          || itj.sub.toLowerCase() === raw.toLowerCase()) {
          return itj.id;
        }
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
          var raw = (input.value || '').trim().toLowerCase();
          for (var k = 0; k < items.length; k++) {
            var itk = items[k];
            if (itk.label.toLowerCase() === raw
              || itk.sub.toLowerCase() === raw
              || String(itk.id).toLowerCase() === raw) {
              seleccionar(itk);
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
      setItems: function (arr) {
        items = (arr || []).map(function (it) {
          return { id: String(it.id), label: String(it.label || ''), sub: String(it.sub || '') };
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

  function renderTablaTransacciones(container, txs) {
    var wrap = el('div', 'fin-table-wrap');
    container.appendChild(wrap);
    if (!txs.length) {
      wrap.appendChild(el('p', 'fin-empty', 'No hay transacciones con los filtros actuales. Usa "➕ Nueva transacción" para registrar la primera.'));
      return;
    }

    var table = document.createElement('table');
    table.className = 'fin-table';
    var thead = document.createElement('thead');
    var hr = document.createElement('tr');
    ['Fecha', 'Origen', 'Titular', 'Categoría', 'Monto', 'Bolsa', 'Caja', 'Estado', ''].forEach(function (h) {
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
      var pill = el('span', 'fin-pill ' + (tx.origen === 'comunidad' ? 'oro' : 'azul'), tx.etiqueta || (tx.origen === 'comunidad' ? ETIQUETA_COMUNIDAD : ETIQUETA_USUARIO));
      tdOri.appendChild(pill);
      tr.appendChild(tdOri);
      tr.appendChild(celda(titularDeTx(tx)));
      var cat = categoriaById(tx.categoriaId);
      tr.appendChild(celda(cat ? cat.nombre : (tx.categoriaId || '—')));
      tr.appendChild(celda(fmtMoneda(tx.monto), 'fin-monto'));
      tr.appendChild(celda(fmtMoneda(d.montoBolsa), 'fin-monto pos'));
      tr.appendChild(celda(fmtMoneda(d.montoCaja), 'fin-monto blue'));
      tr.appendChild(celda((String(tx.estado) || '').charAt(0).toUpperCase() + String(tx.estado || '').slice(1), estadoPillCls(tx.estado) ? 'fin-monto ' + estadoPillCls(tx.estado) : ''));

      var tdAcc = celda('');
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

  /* ─── MODAL CREAR / EDITAR TRANSACCIÓN ─────────────────────── */
  function abrirModalTransaccion(existing) {
    if (!isAdminUser()) { V.toast('Solo el superadmin puede gestionar transacciones.', true); return; }
    var editando = !!existing;
    var overlay = el('div', 'modal-overlay');
    var card = el('div', 'modal-card fin-modal');
    var head = el('div', 'fin-modal-head');
    head.appendChild(el('h3', '', editando ? '✏️ Editar transacción' : '➕ Nueva transacción'));
    card.appendChild(head);

    var form = el('div', 'fin-form');

    // Origen (etiqueta comercial): Usuario / Comunidad
    var fOrigen = el('div', 'field');
    fOrigen.appendChild(el('label', '', 'Origen del movimiento'));
    var radioWrap = el('div', 'fin-origen-radio');
    var rUsu = document.createElement('label');
    rUsu.className = 'fin-radio';
    var inUsu = document.createElement('input');
    inUsu.type = 'radio';
    inUsu.name = 'finTxOrigen';
    inUsu.value = 'usuario';
    rUsu.appendChild(inUsu);
    rUsu.appendChild(el('span', '', '👤 Aporte de Usuario'));
    radioWrap.appendChild(rUsu);
    var rCom = document.createElement('label');
    rCom.className = 'fin-radio';
    var inCom = document.createElement('input');
    inCom.type = 'radio';
    inCom.name = 'finTxOrigen';
    inCom.value = 'comunidad';
    rCom.appendChild(inCom);
    rCom.appendChild(el('span', '', '🤝 Ofrenda de Comunidad'));
    radioWrap.appendChild(rCom);
    fOrigen.appendChild(radioWrap);
    form.appendChild(fOrigen);

    // Usuario destino — autocompletado en vivo (se guarda el UID).
    var fUsr = el('div', 'field');
    fUsr.appendChild(el('label', '', 'Usuario (Aporte)'));
    var inpUsuario = document.createElement('input');
    inpUsuario.type = 'text';
    inpUsuario.className = 'input';
    inpUsuario.placeholder = 'Escribe nombre o correo…';
    inpUsuario.autocomplete = 'off';
    inpUsuario.disabled = true;
    fUsr.appendChild(inpUsuario);
    var acUsuario = crearAutocompletar(inpUsuario);
    form.appendChild(fUsr);

    // Comunidad destino — autocompletado análogo (se guarda el id).
    var fCom = el('div', 'field');
    fCom.appendChild(el('label', '', 'Comunidad (Ofrenda)'));
    var inpCom = document.createElement('input');
    inpCom.type = 'text';
    inpCom.className = 'input';
    inpCom.placeholder = 'Escribe el nombre de la comunidad…';
    inpCom.autocomplete = 'off';
    inpCom.disabled = true;
    fCom.appendChild(inpCom);
    var acCom = crearAutocompletar(inpCom);
    form.appendChild(fCom);

    // Categoría (filtrada según origen)
    var fCat = el('div', 'field');
    fCat.appendChild(el('label', '', 'Categoría'));
    var selCat = document.createElement('select');
    selCat.className = 'select';
    fCat.appendChild(selCat);
    form.appendChild(fCat);

    // Monto / concepto / fecha / estado
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

    var fCon = el('div', 'field');
    fCon.appendChild(el('label', '', 'Concepto (opcional)'));
    var inpCon = document.createElement('input');
    inpCon.type = 'text';
    inpCon.className = 'input';
    inpCon.placeholder = 'Ej: Aporte de bienvenida';
    fCon.appendChild(inpCon);
    form.appendChild(fCon);

    var fFecha = el('div', 'field');
    fFecha.appendChild(el('label', '', 'Fecha'));
    var inpFecha = document.createElement('input');
    inpFecha.type = 'date';
    inpFecha.className = 'input';
    fFecha.appendChild(inpFecha);
    form.appendChild(fFecha);

    var fEst = el('div', 'field');
    fEst.appendChild(el('label', '', 'Estado'));
    var selEstado = document.createElement('select');
    selEstado.className = 'select';
    fillSelectOpciones(selEstado, [
      { value: 'registrada', label: 'Registrada' },
      { value: 'liquidada', label: 'Liquidada' },
      { value: 'anulada', label: 'Anulada' }
    ], 'registrada');
    fEst.appendChild(selEstado);
    form.appendChild(fEst);

    var resumen = el('p', 'fin-form-note', '');
    form.appendChild(resumen);

    var acciones = el('div', 'fin-modal-acciones');
    var btnSave = el('button', 'btn btn-primary', editando ? 'Guardar cambios' : 'Registrar transacción');
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

    function actualizarOrigen() {
      var origen = (inUsu.checked ? 'usuario' : (inCom.checked ? 'comunidad' : ''));
      inpUsuario.disabled = origen !== 'usuario';
      inpCom.disabled = origen !== 'comunidad';
      if (origen !== 'usuario' && acUsuario.getValue()) acUsuario.clear();
      if (origen !== 'comunidad' && acCom.getValue()) acCom.clear();
      var soloTipo = origen === 'comunidad' ? 'grupo' : '';
      var prevCat = selCat.value;
      fillCategoriaSelect(selCat, '', soloTipo);
      if (soloTipo && categoriasDeTipo('grupo', true).length) {
        selCat.value = categoriasDeTipo('grupo', true)[0].id;
      }
      if (!soloTipo) { if (prevCat) selCat.value = prevCat; }
      actualizarResumen();
    }
    inUsu.addEventListener('change', actualizarOrigen);
    inCom.addEventListener('change', actualizarOrigen);
    selMontoYConcepto(); // binds

    function selMontoYConcepto() {
      inpMonto.addEventListener('input', actualizarResumen);
      selCat.addEventListener('change', actualizarResumen);
    }

    function actualizarResumen() {
      var monto = Number(inpMonto.value) || 0;
      var d = distribucionTx({ monto: monto });
      var origen = inUsu.checked ? ETIQUETA_USUARIO : (inCom.checked ? ETIQUETA_COMUNIDAD : '—');
      resumen.textContent = origen + ' · Bolsa MLM ' + d.pctBolsa + '% → ' + fmtMoneda(d.montoBolsa) +
        ' · Caja Mayor ' + d.pctCaja + '% → ' + fmtMoneda(d.montoCaja);
    }

    function poblar() {
      loadUsuarios(true).then(function () {
        if (!document.body.contains(inpUsuario)) return;
        acUsuario.setItems(usuariosCache.map(function (u) {
          return { id: u.uid, label: nombreUsuario(u), sub: u.email || u.uid };
        }));
        if (editando && existing) {
          var uidOld = existing.userId || (existing.origen === 'usuario' ? existing.origenId : '');
          if (uidOld) acUsuario.setValue(uidOld);
        }
      });
      loadComunidades(true).then(function () {
        if (!document.body.contains(inpCom)) return;
        acCom.setItems(comunidadesCache.map(function (c) {
          return { id: c.id, label: c.nombre, sub: c.coordinadorId ? ('Coord: ' + nombreUsuario(usuarioById(c.coordinadorId))) : 'Sin coordinador' };
        }));
        if (editando && existing) {
          var comOld = existing.comunidadId || (existing.origen === 'comunidad' ? existing.origenId : '');
          if (comOld) acCom.setValue(comOld);
        }
      });
    }

    if (editando && existing) {
      var origenEd = existing.origen || (String(existing.tipo) === 'grupo' ? 'comunidad' : 'usuario');
      (origenEd === 'comunidad' ? inCom : inUsu).checked = true;
      inpMonto.value = existing.monto;
      inpCon.value = existing.concepto || '';
      if (inpFecha) inpFecha.value = diaISO(existing.fecha) || '';
      fillSelectOpciones(selEstado, [
        { value: 'registrada', label: 'Registrada' },
        { value: 'liquidada', label: 'Liquidada' },
        { value: 'anulada', label: 'Anulada' }
      ], existing.estado || 'registrada');
    } else {
      inUsu.checked = true;
      inpFecha.value = diaISO(new Date());
    }
    poblar();
    actualizarOrigen();
    actualizarResumen();

    btnSave.addEventListener('click', function () {
      var origen = inUsu.checked ? 'usuario' : 'comunidad';
      var datos = {
        origen: origen,
        userId: acUsuario.getValue(),
        comunidadId: acCom.getValue(),
        categoriaId: selCat.value,
        monto: inpMonto.value,
        concepto: inpCon.value,
        fecha: inpFecha.value || new Date().toISOString(),
        estado: selEstado.value
      };
      if (origen === 'comunidad' && !datos.comunidadId) { V.toast('Selecciona la comunidad de la ofrenda.', true); return; }
      if (origen === 'usuario' && !datos.userId) { V.toast('Selecciona un usuario de la lista de autocompletado.', true); return; }
      if (!selCat.value) { V.toast('Selecciona una categoría.', true); return; }
      if (!(Number(inpMonto.value) > 0)) { V.toast('Escribe un monto válido mayor a cero.', true); return; }

      btnSave.disabled = true;
      btnSave.textContent = editando ? '⏳ Guardando…' : '⏳ Registrando…';
      var op = editando
        ? editarTransaccion(existing.id, datos)
        : crearTransaccion(datos);
      op.then(function () {
        V.toast(editando ? 'Transacción actualizada ✓' : 'Transacción registrada y comisiones MLM liquidadas ✓');
        cerrar();
        renderVistaFinanzas();
      }).catch(function (e) {
        V.toast(e && e.message ? e.message : 'Error al guardar.', true);
        btnSave.disabled = false;
        btnSave.textContent = editando ? 'Guardar cambios' : 'Registrar transacción';
      });
    });
  }

  /* ─── MODAL DESEMBOLSO / PAGO A USUARIO ────────────────────── */
  // Egreso contable contra la Bolsa de Comisiones: descuenta el monto
  // del saldo de comisiones del usuario (y por tanto de la bolsa), sin
  // tocar la Caja Mayor. Guarda constancia de banco y número de cuenta.
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
    fillSelectOpciones(selEst, [
      { value: '', label: 'Todos los estados' },
      { value: 'registrada', label: 'Registrada' },
      { value: 'liquidada', label: 'Liquidada' },
      { value: 'anulada', label: 'Anulada' }
    ], _repState.estado);
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
    var totalIngresos = 0, totalBolsa = 0, totalCaja = 0;
    txs.forEach(function (tx) {
      var d = distribucionTx(tx);
      totalIngresos += Number(tx.monto) || 0;
      totalBolsa += d.montoBolsa;
      totalCaja += d.montoCaja;
    });
    var filtroDesc = '';
    if (_repState.desde || _repState.hasta) {
      filtroDesc = (diaISO(_repState.desde) || 'inicio') + ' → ' + (diaISO(_repState.hasta) || 'hoy');
    } else {
      filtroDesc = 'todo el histórico';
    }
    var stats = el('div', 'fin-stats fin-stats-kpi');
    stats.appendChild(statCard('Ingresos totales', fmtMoneda(totalIngresos), 'gold'));
    stats.appendChild(statCard('Bolsa de comisiones (' + bolsaTotalPct() + '%)', fmtMoneda(totalBolsa), 'green'));
    stats.appendChild(statCard('Caja Mayor (' + cajaPctVigente() + '%)', fmtMoneda(totalCaja), 'blue'));
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
        tr.appendChild(celda(titularDeTx(tx)));
        var cat = categoriaById(tx.categoriaId);
        tr.appendChild(celda(cat ? cat.nombre : (tx.categoriaId || '—')));
        tr.appendChild(celda(fmtMoneda(tx.monto), 'fin-monto'));
        tr.appendChild(celda(String(tx.estado || '')));
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
        tr.appendChild(celda(fmtMoneda(f.d.montoBolsa), 'fin-monto pos'));
        tr.appendChild(celda(fmtMoneda(f.d.montoCaja), 'fin-monto blue'));
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
      loadComunidades(),
      (isAdminUser() ? loadUsuarios() : Promise.resolve([]))
    ]);
  }

  function renderPerfil() {
    var panel = V.$('finanzasPanel');
    var body = V.$('finanzasBody');
    if (!panel || !body) return;
    var enabled = isEnabled();
    if (!enabled || V.isAnon || !V.userId) { panel.style.display = 'none'; return; }
    panel.style.display = '';
    body.innerHTML = '';
    body.appendChild(el('p', 'fin-loading', 'Cargando tus finanzas…'));

    var loader = body.lastChild;
    var vuelto = false;
    var watchdog = null;

    function limpiarCarga() {
      if (loader && loader.parentNode) loader.parentNode.removeChild(loader);
      loader = null;
    }
    function fallo(mensaje) {
      vuelto = true;
      if (watchdog) { clearTimeout(watchdog); watchdog = null; }
      limpiarCarga();
      body.innerHTML = '';
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
          body.innerHTML = '';
          renderStats(body, transacciones, comisiones, pagos);
          renderFormAporte(body);
          if (transacciones.length || comisiones.length || pagos.length) {
            renderHistorial(body, transacciones);
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

  function renderStats(container, transacciones, comisiones, pagos) {
    var totalAportado = 0;
    transacciones.forEach(function (t) { totalAportado += Number(t.monto) || 0; });
    var totalComisiones = 0;
    comisiones.forEach(function (c) { totalComisiones += Number(c.monto) || 0; });
    var totalPagado = sumarMontos(pagos || []);
    var saldoDisponible = redondear(totalComisiones - totalPagado);

    var stats = el('div', 'fin-stats');
    stats.appendChild(statCard('Mis movimientos', String(transacciones.length), ''));
    stats.appendChild(statCard('Total', fmtMoneda(totalAportado), ''));
    stats.appendChild(statCard('Comisiones recibidas', fmtMoneda(totalComisiones), 'green'));
    stats.appendChild(statCard('💸 Saldo disponible', fmtMoneda(saldoDisponible), saldoDisponible > 0 ? 'green' : ''));
    container.appendChild(stats);
  }

  function selectOpcoes(select, options) {
    fillSelectOpciones(select, options, '');
  }

  function renderFormAporte(container) {
    var sec = document.createElement('details');
    sec.className = 'fin-seccion';
    sec.open = true;
    var s = document.createElement('summary');
    s.appendChild(el('span', '', '💳 Registrar aporte'));
    sec.appendChild(s);
    var wrap = el('div', 'fin-seccion-body');
    sec.appendChild(wrap);

    var form = el('div', 'fin-form');

    var catRow = el('div', 'field');
    catRow.appendChild(el('label', '', 'Categoría'));
    var selCat = document.createElement('select');
    selCat.className = 'select';
    catRow.appendChild(selCat);
    form.appendChild(catRow);

    var montoRow = el('div', 'field');
    montoRow.appendChild(el('label', '', 'Monto'));
    var inputMonto = document.createElement('input');
    inputMonto.type = 'number';
    inputMonto.className = 'input';
    inputMonto.min = '1';
    inputMonto.step = '1';
    inputMonto.placeholder = 'Ej: 50000';
    montoRow.appendChild(inputMonto);
    form.appendChild(montoRow);

    var conRow = el('div', 'field');
    conRow.appendChild(el('label', '', 'Concepto (opcional)'));
    var inputCon = document.createElement('input');
    inputCon.type = 'text';
    inputCon.className = 'input';
    inputCon.placeholder = 'Ej: Aporte de bienvenida';
    conRow.appendChild(inputCon);
    form.appendChild(conRow);

    var selUsuario = null;
    var selCom = null;
    var selEstado = null;
    if (isAdminUser()) {
      var fUsr = el('div', 'field');
      fUsr.appendChild(el('label', '', 'Usuario destino (superadmin)'));
      selUsuario = document.createElement('select');
      selUsuario.className = 'select';
      fUsr.appendChild(selUsuario);
      form.appendChild(fUsr);

      var fCom = el('div', 'field');
      fCom.appendChild(el('label', '', 'Comunidad (superadmin, opcional)'));
      selCom = document.createElement('select');
      selCom.className = 'select';
      fCom.appendChild(selCom);
      form.appendChild(fCom);

      var fEst = el('div', 'field');
      fEst.appendChild(el('label', '', 'Estado (superadmin)'));
      selEstado = document.createElement('select');
      selEstado.className = 'select';
      fEst.appendChild(selEstado);
      form.appendChild(fEst);
    }

    var acciones = el('div', 'fin-form-acciones');
    var btn = el('button', 'btn btn-primary', 'Registrar');
    btn.type = 'button';
    acciones.appendChild(btn);
    form.appendChild(acciones);

    wrap.appendChild(form);
    container.appendChild(sec);

    var cats = categoriasActivas().filter(function (c) { return isAdminUser() || c.tipo !== 'grupo'; });
    selectOpcoes(selCat, cats.map(function (c) { return { value: c.id, label: c.nombre + ' (' + tipoLabel(c.tipo) + ')' }; }));

    if (isAdminUser() && selUsuario) {
      loadUsuarios().then(function () {
        if (!document.body.contains(selUsuario)) return;
        var me = (V.currentUser && V.currentUser.email) ? 'Yo · ' + V.currentUser.email : 'Yo';
        var opts = [{ value: V.userId, label: me, selected: true }];
        usuariosCache.filter(function (u) { return u.uid !== V.userId; })
          .forEach(function (u) {
            opts.push({ value: u.uid, label: nombreUsuario(u) + ' · ' + (u.email || u.uid) });
          });
        selectOpcoes(selUsuario, opts);
      });
    }
    if (isAdminUser() && selCom) {
      loadComunidades().then(function () {
        if (!document.body.contains(selCom)) return;
        var opts = [{ value: '', label: '(Sin comunidad)' }];
        comunidadesCache.forEach(function (c) { opts.push({ value: c.id, label: c.nombre + (c.coordinadorId ? ' · Coord: ' + nombreUsuario(usuarioById(c.coordinadorId)) : '') }); });
        selectOpcoes(selCom, opts);
      });
    }
    if (isAdminUser() && selEstado) {
      selectOpcoes(selEstado, [
        { value: 'registrada', label: 'Registrada', selected: true },
        { value: 'liquidada', label: 'Liquidada' }
      ]);
    }

    btn.addEventListener('click', function () {
      if (!selCat.value) { V.toast('Selecciona una categoría.', true); return; }
      if (!(Number(inputMonto.value) > 0)) { V.toast('Escribe un monto válido mayor a cero.', true); return; }
      var datosAporte = { categoriaId: selCat.value, monto: inputMonto.value, concepto: inputCon.value };
      if (isAdminUser()) {
        if (selUsuario && selUsuario.value) datosAporte.userId = selUsuario.value;
        if (selCom && selCom.value) datosAporte.comunidadId = selCom.value;
        if (selEstado) datosAporte.estado = selEstado.value;
      }
      btn.disabled = true;
      btn.textContent = '⏳ Registrando…';
      registrarAportePersonal(datosAporte).then(function () {
        V.toast('Aporte registrado ✓');
        inputMonto.value = '';
        inputCon.value = '';
        return refreshPanel();
      }).catch(function (e) {
        V.toast(e && e.message ? e.message : 'Error al registrar.', true);
        btn.disabled = false;
        btn.textContent = 'Registrar';
      });
    });
  }

  function renderHistorial(container, transacciones) {
    var sec = document.createElement('details');
    sec.className = 'fin-seccion';
    var s = document.createElement('summary');
    s.appendChild(el('span', '', '📊 Historial de mis movimientos'));
    sec.appendChild(s);
    var wrap = el('div', 'fin-seccion-body');
    sec.appendChild(wrap);
    container.appendChild(sec);

    if (!transacciones.length) {
      wrap.appendChild(el('p', 'fin-empty', 'Aún no has registrado aportes.'));
      return;
    }
    transacciones.forEach(function (t) {
      var cat = categoriaById(t.categoriaId) || { nombre: t.categoriaId || '—', tipo: t.tipo };
      var row = el('div', 'fin-fila');
      var info = el('div', 'fin-fila-info');
      info.appendChild(el('div', 'fin-fila-titulo', cat.nombre || '—'));
      var partes = [];
      if (t.origen === 'comunidad' || t.tipo === 'grupo') {
        var comunidadTx = t.comunidadId ? comunidadById(t.comunidadId) : null;
        partes.push(comunidadTx ? 'Comunidad: ' + comunidadTx.nombre : 'Comunidad');
      }
      if (isAdminUser() && t.userId && t.userId !== V.userId) {
        partes.push('Usuario: ' + (usuarioById(t.userId) ? nombreUsuario(usuarioById(t.userId)) : t.userId));
      }
      partes.push(t.estado || 'registrada');
      if (t.fecha) partes.push(V.fmtDate(t.fecha));
      var subTxt = partes.join(' · ');
      info.appendChild(el('div', 'fin-fila-sub', subTxt));
      row.appendChild(info);
      var right = el('div', 'fin-fila-info');
      right.appendChild(el('div', 'fin-fila-monto' + (t.tipo === 'grupo' ? ' pos' : ''), fmtMoneda(t.monto)));
      right.appendChild(el('span', 'fin-pill ' + (t.tipo === 'grupo' ? 'oro' : (t.origen === 'usuario' ? 'azul' : 'gris')), tipoLabel(t.tipo)));
      row.appendChild(right);
      wrap.appendChild(row);
      renderDesglose(wrap, t);
    });
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

    panel.appendChild(renderLiquidacion(panel));
    panel.appendChild(renderAsignacionComision(panel));
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
      selectOpcoes(selCom, comunidadesCache.map(function (c) {
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
      var enabled = isEnabled();
      var panel = V.$('finanzasPanel');
      if (panel) panel.style.display = (enabled && !V.isAnon && V.userId) ? '' : 'none';
      if (enabled && !V.isAnon && V.userId) renderPerfil();
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
    liquidarOfrendaGrupo: liquidarOfrendaGrupo,
    misTransacciones: misTransacciones,
    misComisiones: misComisiones,
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