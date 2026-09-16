/* ════════════════════════════════════════════════════════════════
   VCONV · Módulo MLM — Red de referidos (5 niveles)
   Configuración dinámica en Firestore (config/mlm), interruptor
   maestro mlmEnabled, números de referido, selección de patrocinador
   y motor de cálculo de comisiones para el módulo financiero/ERP.
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var V = window.VCONV;
  if (!V) { console.error('VCONV core not loaded'); return; }

  var CONFIG_COLLECTION = 'config';
  var MLM_DOC = 'mlm';
  var MAX_NIVELES = 5;
  var PREFIJO_CODIGO = 'VC-';

  var DEFAULT_CONFIG = {
    mlmEnabled: true,
    // Red 5 niveles: 30% para el nivel 1 y 5% para los niveles 2–5.
    // Total de la bolsa de comisiones = 55%; el resto (45% por defecto)
    // se destina a la Caja Mayor / Fondo Estructura General.
    porcentajes: { 1: 30, 2: 5, 3: 5, 4: 5, 5: 5 }
  };

  var cfg = null;
  var cfgPromise = null;

  /* ─── CONFIG ───────────────────────────────────────────────── */
  function normalizePorcentajes(raw) {
    var out = {};
    for (var i = 1; i <= MAX_NIVELES; i++) {
      var v = raw && typeof raw[i] === 'number' && isFinite(raw[i]) ? raw[i] : DEFAULT_CONFIG.porcentajes[i];
      out[i] = Math.min(100, Math.max(0, Math.round(v)));
    }
    return out;
  }

  function loadConfig() {
    if (cfgPromise) return cfgPromise;
    cfgPromise = (V.db ? V.db.collection(CONFIG_COLLECTION).doc(MLM_DOC).get() : Promise.resolve(null))
      .then(function (doc) {
        var raw = doc && doc.exists ? doc.data() : {};
        cfg = {
          mlmEnabled: raw.mlmEnabled == null ? DEFAULT_CONFIG.mlmEnabled : !!raw.mlmEnabled,
          porcentajes: normalizePorcentajes(raw.porcentajes)
        };
        return cfg;
      })
      .catch(function () {
        cfg = {
          mlmEnabled: DEFAULT_CONFIG.mlmEnabled,
          porcentajes: normalizePorcentajes(DEFAULT_CONFIG.porcentajes)
        };
        return cfg;
      });
    return cfgPromise;
  }

  function getConfig() {
    return loadConfig().then(function () { return cfg; });
  }

  function isEnabled() {
    if (!cfg) return V.mlm && V.mlm._initialConfig && V.mlm._initialConfig.mlmEnabled;
    return !!cfg.mlmEnabled;
  }

  function porcentajeParaNivel(n) {
    if (!cfg) return DEFAULT_CONFIG.porcentajes[n] || 0;
    return cfg.porcentajes[n] || 0;
  }

  function guardarConfig(partial) {
    if (!V.db) return Promise.reject(new Error('Firestore no disponible.'));
    var next = {
      mlmEnabled: partial.mlmEnabled == null ? DEFAULT_CONFIG.mlmEnabled : !!partial.mlmEnabled,
      porcentajes: normalizePorcentajes(partial.porcentajes || cfg.porcentajes || DEFAULT_CONFIG.porcentajes)
    };
    return V.db.collection(CONFIG_COLLECTION).doc(MLM_DOC).set(next)
      .then(function () {
        cfg = next;
        cfgPromise = null;
        applyMlmUiState();
        renderMlmAdmin();
        return cfg;
      });
  }

  /* ─── ENLACE DE INVITACIÓN ─────────────────────────────────── */
  function enlaceInvitacion(code) {
    if (!code) return '';
    var base = (window.location.origin + window.location.pathname).split('?')[0];
    return base + '?ref=' + encodeURIComponent(code);
  }

  function copiarAlPortapapeles(texto) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(texto).catch(function () { copiarLegacy(texto); });
    }
    copiarLegacy(texto);
    return Promise.resolve();
  }

  function copiarLegacy(texto) {
    try {
      var ta = document.createElement('textarea');
      ta.value = texto;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) { /* noop */ }
  }

  /* ─── CÓDIGOS DE REFERIDO ──────────────────────────────────── */
  function generarCodigo() {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var out = '';
    for (var i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return PREFIJO_CODIGO + out;
  }

  function crearReferralCode() {
    function intentar(intentos) {
      var code = generarCodigo();
      return V.db.collection('referidos').doc(code).get()
        .then(function (doc) {
          if (doc.exists) {
            if (intentos >= 4) return code;
            return intentar(intentos + 1);
          }
          return code;
        })
        .catch(function () { return code; });
    }
    return intentar(0);
  }

  function guardarMapeoCodigo(uid, code) {
    if (!V.db || !code || !uid) return Promise.resolve();
    return V.db.collection('referidos').doc(code).set({ userId: uid }).catch(function () {});
  }

  // Asegura referralCode único y, de haberlo, asocia sponsorId solo
  // la primera vez (nunca sobreescribe una relación existente).
  // Solo escribe sobre documentos que ya existen; nunca crea perfiles.
  function aplicarPatrocinio(uid, sponsorId) {
    if (!V.db || !uid) return Promise.resolve('');
    var ref = V.db.collection(V.COL_USUARIOS).doc(uid);
    return ref.get().then(function (doc) {
      // Si el perfil aún no existe (registro no completado o sesión de
      // visitante sin formulario enviado), no se crea nada aquí.
      if (!doc.exists) return '';
      var data = doc.data();
      if (data.referralCode) {
        if (sponsorId && !data.sponsorId) {
          return ref.set({ sponsorId: sponsorId }, { merge: true }).then(function () { return data.referralCode; }).catch(function () { return data.referralCode; });
        }
        return Promise.resolve(data.referralCode);
      }
      return crearReferralCode().then(function (code) {
        var upd = { referralCode: code };
        if (sponsorId) upd.sponsorId = sponsorId;
        return ref.set(upd, { merge: true })
          .then(function () { return guardarMapeoCodigo(uid, code).then(function () { return code; }); })
          .catch(function () { return code; });
      });
    }).catch(function () {
      return '';
    });
  }

  // Valida que el código exista (doc referidos/{code}) y devuelve el UID del
  // patrocinador. Devuelve null si el MLM está desactivado o el código no existe.
  function resolverSponsor(codigo) {
    return loadConfig().then(function () {
      if (!cfg.mlmEnabled || !codigo || !V.db) return null;
      var code = codigo.trim().toUpperCase();
      return V.db.collection('referidos').doc(code).get()
        .then(function (doc) {
          if (!doc.exists) return null;
          var d = doc.data();
          return (d && d.userId) ? String(d.userId) : null;
        })
        .catch(function () { return null; });
    });
  }

  // Validación admin: acepta un código de referido (referidos/{code}) o un UID
  // directo (usuarios/{uid}); devuelve el UID resuelto o null si no existe.
  function validarPatrocinador(entrada) {
    if (!V.db || !entrada) return Promise.resolve(null);
    var code = entrada.trim().toUpperCase();
    return V.db.collection('referidos').doc(code).get()
      .then(function (doc) {
        if (doc.exists && doc.data() && doc.data().userId) {
          return String(doc.data().userId);
        }
        return V.db.collection(V.COL_USUARIOS).doc(entrada.trim())
          .get()
          .then(function (udoc) { return udoc.exists ? String(udoc.id) : null; })
          .catch(function () { return null; });
      })
      .catch(function () { return null; });
  }

  // Evita ciclos: true si subiendo por la cadena de sponsors se llega al
  // propio usuario que se está editando (máximo MAX_NIVELES generaciones).
  // BYPASS de superadmin: control absoluto — asigna patrocinadores sin
  // restricciones de parentesco ni de ciclos.
  function esCicloPotencial(sponsorUid, targetUid, nivel) {
    if (V.userRole === 'superadmin') return Promise.resolve(false);
    if (!sponsorUid) return Promise.resolve(false);
    if (sponsorUid === targetUid) return Promise.resolve(true);
    if ((nivel || 0) >= MAX_NIVELES) return Promise.resolve(false);
    return V.db.collection(V.COL_USUARIOS).doc(sponsorUid).get()
      .then(function (doc) {
        var sp = doc.exists ? doc.data().sponsorId : '';
        if (!sp) return false;
        return esCicloPotencial(String(sp), targetUid, (nivel || 0) + 1);
      })
      .catch(function () { return false; });
  }

  // Resuelve la identidad visible de un patrocinador (nombre/correo).
  function datosPatrocinador(uid) {
    if (!V.db || !uid) return Promise.resolve(null);
    return V.db.collection(V.COL_USUARIOS).doc(uid).get()
      .then(function (doc) {
        if (!doc.exists) return null;
        var d = doc.data();
        var nombre = ((d.nombre || '') + ' ' + (d.apellido || '')).trim();
        return { uid: uid, nombre: nombre, email: d.email || '' };
      })
      .catch(function () { return null; });
  }

  /* ─── MOTOR DE CÁLCULO DE RED (5 NIVELES) ────────────────────
     Recibe un evento ({ userId, monto, concepto?, fecha? }), asciende
     hasta 5 generaciones por sponsorId y devuelve el payload listo
     para el módulo financiero/ERP. Los porcentajes por nivel se leen
     DINÁMICAMENTE desde la configuración vigente: si el llamador
     entrega un mapa de porcentajes (pctsOverride) se usan esos valores
     (el módulo Finanzas pasa los suyos propios config/finanzas).      */
  function calcularPayloadCon(evento, pctsOverride) {
    return loadConfig().then(function () {
      var pcts = pctsOverride || cfg.porcentajes || DEFAULT_CONFIG.porcentajes;
      var monto = Number(evento && evento.monto) || 0;
      var userId = evento && evento.userId ? String(evento.userId) : '';
      var comisiones = [];
      var current = userId;
      var visitados = {};

      function paso(nivel) {
        if (nivel > MAX_NIVELES || !current) return Promise.resolve(comisiones);
        if (visitados[current]) return Promise.resolve(comisiones);
        visitados[current] = true;
        return V.db.collection(V.COL_USUARIOS).doc(current).get()
          .then(function (doc) {
            var data = doc.exists ? doc.data() : {};
            current = data.sponsorId ? String(data.sponsorId) : '';
            if (!current) return comisiones;
            var pct = (pcts && pcts[nivel]) || 0;
            comisiones.push({
              userId: current,
              nivel: nivel,
              porcentaje: pct,
              monto: +(monto * pct / 100).toFixed(2)
            });
            return paso(nivel + 1);
          })
          .catch(function () { return comisiones; });
      }

      return paso(1).then(function () {
        return {
          evento: {
            userId: userId,
            monto: monto,
            concepto: (evento && evento.concepto) || '',
            fecha: (evento && evento.fecha) || new Date().toISOString()
          },
          mlmEnabled: cfg.mlmEnabled,
          totalNiveles: comisiones.length,
          comisiones: comisiones
        };
      });
    });
  }

  function calcularPayload(evento) {
    return calcularPayloadCon(evento, null);
  }

  /* ─── RED DIRECTA (NIVEL 1) ─────────────────────────────────
     Consulta en Firestore los usuarios cuyo sponsorId coincide con el
     UID de la raíz (por defecto, el UID de la sesión): la red de
     referidos directos de ese perfil. El administrador general puede
     consultar la red de cualquier perfil pasando su UID como raíz,
     gracias a que las reglas le permiten leer usuarios. Como red de
     seguridad también acepta el referralCode propio (registros legacy
     que guardaron el código en lugar del UID). La consulta principal
     usa sponsorId == uidRaiz, exactamente el filtro que autoriza la
     regla de Firestore (esMiArbol): ningún usuario puede consultar
     redes ajenas. Cada resultado se revalida en el cliente antes de
     exponerse al llamador.                                      */
  function listarRedDirecta(rootUid) {
    if (!V.db) return Promise.resolve([]);
    var uid = String(rootUid || V.userId || '');
    if (!uid) return Promise.resolve([]);
    var refs = V.db.collection(V.COL_USUARIOS);
    return Promise.all([
      refs.doc(uid).get(),
      refs.where('sponsorId', '==', uid).get()
    ]).then(function (res) {
      var myData = res[0].exists ? (res[0].data() || {}) : {};
      var myCode = myData.referralCode ? String(myData.referralCode) : '';
      var seen = {};
      var rows = [];

      function esMia(sid) {
        if (String(sid) === uid) return true;
        return !!(myCode && myCode !== uid && String(sid) === myCode);
      }
      function addDoc(doc) {
        var d = doc.data() || {};
        if (!esMia(d.sponsorId)) return;
        if (seen[doc.id]) return;
        seen[doc.id] = true;
        rows.push({
          uid: doc.id,
          nombre: d.nombre || '',
          apellido: d.apellido || '',
          email: d.email || '',
          estado: d.estado || 'Activo',
          creado: d.creado || d.createdAt || '',
          rol: d.rol || 'estudiante',
          telefono: d.telefono || ''
        });
      }

      res[1].forEach(addDoc);
      if (myCode && myCode !== uid) {
        // Complemento best-effort por código propio: si las reglas rechazan
        // esta consulta (por diseño, para no exponer redes ajenas) se ignora
        // sin afectar el resultado principal filtrado por UID.
        return refs.where('sponsorId', '==', myCode).get()
          .then(function (extra) {
            extra.forEach(addDoc);
            return rows.sort(function (a, b) { return (b.creado || '').localeCompare(a.creado || ''); });
          })
          .catch(function () {
            return rows.sort(function (a, b) { return (b.creado || '').localeCompare(a.creado || ''); });
          });
      }
      return rows.sort(function (a, b) { return (b.creado || '').localeCompare(a.creado || ''); });
    }).catch(function () { return []; });
  }

  /* ─── RED COMPLETA (5 NIVELES) ────────────────────────────────
     Expande la red hacia abajo por patrocinio: el Nivel 1 se obtiene
     con listarRedDirecta() y cada nivel N se resuelve consultando los
     usuarios cuyo sponsorId pertenece al nivel N-1 (consulta 'in' en
     lotes de 10, el máximo que admite Firestore). La raíz del árbol es
     el UID de la sesión por defecto; el administrador general puede
     consultar el árbol genealógico de CUALQUIER perfil pasando su UID
     (redArbol(uid, 5)) gracias a sus reglas. Cada fila se revalida en
     el cliente: su sponsorId debe estar en el nivel anterior, así solo
     se exponen miembros de la propia red. Si un nivel es denegado por
     las reglas (red ajena o límite de acceso), se entrega lo ya
     recopilado marcando los niveles restantes como no disponibles.      */
  function redArbol(root, maxNivel) {
    var uid;
    var max;
    if (root == null || typeof root === 'number') {
      // Compatibilidad con la firma anterior redArbol(maxNivel).
      uid = String(V.userId || '');
      max = root == null ? MAX_NIVELES : Math.max(1, Math.min(MAX_NIVELES, Math.round(root)));
    } else {
      uid = String(root);
      max = maxNivel == null ? MAX_NIVELES : Math.max(1, Math.min(MAX_NIVELES, maxNivel));
    }
    if (!V.db || !uid) return Promise.resolve([]);
    var col = V.db.collection(V.COL_USUARIOS);

    function fetchNivelN(prevUids, nivel, visto) {
      if (!prevUids.length) return Promise.resolve([]);
      var batched = [];
      for (var i = 0; i < prevUids.length; i += 10) {
        batched.push(prevUids.slice(i, i + 10));
      }
      return Promise.all(batched.map(function (batch) {
        return col.where('sponsorId', 'in', batch).get();
      })).then(function (snapshots) {
        var rows = [];
        snapshots.forEach(function (snap) {
          snap.forEach(function (doc) {
            var d = doc.data() || {};
            var sid = String(d.sponsorId || '');
            if (prevUids.indexOf(sid) === -1) return;
            if (visto[doc.id]) return;
            visto[doc.id] = true;
            rows.push({
              uid: doc.id,
              nivel: nivel,
              nombre: d.nombre || '',
              apellido: d.apellido || '',
              email: d.email || '',
              estado: d.estado || 'Activo',
              creado: d.creado || d.createdAt || '',
              rol: d.rol || 'estudiante',
              telefono: d.telefono || ''
            });
          });
        });
        return rows;
      });
    }

    return listarRedDirecta(uid).then(function (nivel1) {
      var niveles = [];
      var visto = {};
      var i, n;
      for (i = 1; i <= max; i++) niveles.push({ nivel: i, miembros: [], denegado: false });
      niveles[0].miembros = nivel1;
      nivel1.forEach(function (m) { visto[m.uid] = true; });
      var prevUids = nivel1.map(function (m) { return m.uid; });
      var detenido = false;
      var paso = Promise.resolve();
      for (n = 1; n < max; n++) {
        (function (nivel) {
          paso = paso.then(function () {
            if (detenido) return;
            return fetchNivelN(prevUids, nivel, visto)
              .then(function (rows) {
                niveles[nivel - 1].miembros = rows;
                prevUids = rows.map(function (m) { return m.uid; });
              })
              .catch(function () {
                detenido = true;
                for (var k = nivel; k <= max; k++) niveles[k - 1].denegado = true;
              });
          });
        })(n + 1);
      }
      return paso.then(function () { return niveles; });
    });
  }

  /* ─── UI: FORMULARIO DE REGISTRO ───────────────────────────── */
  function leerRefDeUrl() {
    try {
      return new URLSearchParams(window.location.search).get('ref') || '';
    } catch (e) {
      var m = window.location.search.match(/[?&]ref=([^&]+)/);
      return m ? decodeURIComponent(m[1]) : '';
    }
  }

  function aplicarEstadoRegistro() {
    var wrap = V.$('regReferidoWrap');
    var input = V.$('regReferido');
    if (wrap) wrap.style.display = isEnabled() ? '' : 'none';
    if (input && input.value === '') input.value = leerRefDeUrl().trim().toUpperCase();
  }

  /* ─── UI: PANEL ADMIN (config) ─────────────────────────────── */
  function renderMlmAdmin() {
    var panel = V.$('adminMlmPanel');
    if (!panel) return;
    if (V.userRole !== 'superadmin' || !cfg) { panel.style.display = 'none'; return; }
    panel.style.display = '';

    var toggle = V.$('mlmEnabledToggle');
    if (toggle) toggle.checked = !!cfg.mlmEnabled;
    var label = V.$('mlmEnabledLabel');
    if (label) label.textContent = cfg.mlmEnabled ? 'MLM activado' : 'MLM desactivado';

    var list = V.$('mlmLevelsList');
    if (!list) return;
    list.innerHTML = '';
    for (var n = 1; n <= MAX_NIVELES; n++) {
      var row = V.el('div', 'mlm-level-row');
      row.appendChild(V.el('span', 'mlm-level-name', 'Nivel ' + n));
      var wrap = V.el('div', 'mlm-level-input');
      var inp = document.createElement('input');
      inp.type = 'number';
      inp.min = '0';
      inp.max = '100';
      inp.step = '1';
      inp.value = cfg.porcentajes[n] || 0;
      inp.dataset.nivel = String(n);
      wrap.appendChild(inp);
      wrap.appendChild(V.el('span', 'mlm-level-pct', '%'));
      row.appendChild(wrap);
      list.appendChild(row);
    }
  }

  function recogerConfigAdmin() {
    var mlmEnabled = !!(V.$('mlmEnabledToggle') && V.$('mlmEnabledToggle').checked);
    var porcentajes = {};
    var inputs = document.querySelectorAll('#mlmLevelsList input[type="number"]');
    Array.prototype.forEach.call(inputs, function (inp) {
      var nivel = parseInt(inp.dataset.nivel, 10);
      var v = parseFloat(inp.value);
      porcentajes[nivel] = isFinite(v) ? Math.min(100, Math.max(0, v)) : 0;
    });
    return { mlmEnabled: mlmEnabled, porcentajes: porcentajes };
  }

  function bindAdminEvents() {
    var toggle = V.$('mlmEnabledToggle');
    if (toggle) toggle.addEventListener('change', function () {
      var label = V.$('mlmEnabledLabel');
      if (label) label.textContent = this.checked ? 'MLM activado' : 'MLM desactivado';
    });
    var btn = V.$('mlmConfigSave');
    if (btn) btn.addEventListener('click', function () {
      var cfgBtn = V.$('mlmConfigSave');
      cfgBtn.disabled = true;
      cfgBtn.textContent = '⏳ Guardando…';
      guardarConfig(recogerConfigAdmin())
        .then(function () {
          V.toast('Configuración MLM guardada ✓');
        })
        .catch(function (e) {
          V.toast('Error al guardar: ' + (e && e.message ? e.message : e), true);
        })
        .then(function () {
          cfgBtn.disabled = false;
          cfgBtn.textContent = 'Guardar configuración';
        });
    });
  }

  /* ─── ESTADO GLOBAL DE LA UI ───────────────────────────────── */
  function applyMlmUiState() {
    var enabled = isEnabled();
    var regWrap = V.$('regReferidoWrap');
    if (regWrap) regWrap.style.display = enabled ? '' : 'none';
    var mlmPanel = V.$('dashMlmPanel');
    if (mlmPanel) mlmPanel.style.display = (enabled && !V.isAnon) ? '' : 'none';
    renderMlmAdmin();
  }

  /* ─── API ──────────────────────────────────────────────────── */
  V.mlm = {
    _initialConfig: null,
    loadConfig: loadConfig,
    getConfig: getConfig,
    isEnabled: isEnabled,
    porcentajeParaNivel: porcentajeParaNivel,
    guardarConfig: guardarConfig,
    enlaceInvitacion: enlaceInvitacion,
    copiarAlPortapapeles: copiarAlPortapapeles,
    aplicarPatrocinio: aplicarPatrocinio,
    listarRedDirecta: listarRedDirecta,
    redArbol: redArbol,
    resolverSponsor: resolverSponsor,
    validarPatrocinador: validarPatrocinador,
    esCicloPotencial: esCicloPotencial,
    datosPatrocinador: datosPatrocinador,
    crearReferralCode: crearReferralCode,
    calcularPayload: calcularPayload,
    calcularPayloadCon: calcularPayloadCon,
    applyMlmUiState: applyMlmUiState
  };

  /* ─── MODULE INTERFACE ─────────────────────────────────────── */
  var MlmModule = {
    onReady: function () {
      loadConfig().then(function (c) {
        V.mlm._initialConfig = c;
        applyMlmUiState();
      }).catch(function () {});
    }
  };
  V.registerModule(MlmModule);

  function init() {
    bindAdminEvents();
    loadConfig().then(function (c) {
      V.mlm._initialConfig = c;
      aplicarEstadoRegistro();
      applyMlmUiState();
    }).catch(function () {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();