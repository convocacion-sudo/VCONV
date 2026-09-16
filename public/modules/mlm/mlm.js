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

  /* ─── TARJETA INTERACTIVA MLM (5 NIVELES) ──────────────────── */
  var LEVEL_META = {
    1: { label: 'Referidos Directos', accent: 'gold', commission: 10, icon: '⭐' },
    2: { label: 'Indirectos', accent: 'blue', commission: 5, icon: '🔵' },
    3: { label: 'Red Extendida', accent: 'purple', commission: 3, icon: '🟣' },
    4: { label: 'Profundidad Avanzada', accent: 'emerald', commission: 2, icon: '🟢' },
    5: { label: 'Red Global', accent: 'coral', commission: 1, icon: '🟠' }
  };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function renderMlmCard(container) {
    if (!container) return;
    container.innerHTML = '';
    var loading = el('p', 'mlm-level-empty', 'Consultando tu red…');
    container.appendChild(loading);

    if (V.isAnon || !V.userId || !V.mlm || typeof V.mlm.redArbol !== 'function') {
      loading.textContent = 'Inicia sesión para ver tu red de referidos.';
      return;
    }

    V.mlm.redArbol(5).then(function (niveles) {
      container.innerHTML = '';
      buildMlmCard(container, niveles);
    }).catch(function () {
      loading.textContent = 'No se pudo cargar tu red en este momento.';
    });
  }

  function buildMlmCard(container, niveles) {
    var totalMiembros = 0;
    var nivelesActivos = 0;
    var directos = 0;

    niveles.forEach(function (n) {
      totalMiembros += n.miembros.length;
      if (n.miembros.length > 0) nivelesActivos++;
      if (n.nivel === 1) directos = n.miembros.length;
    });

    var card = el('div', 'mlm-card');

    // ── Header ──
    var header = el('div', 'mlm-card-header');
    var iconChip = el('span', 'icon-chip sm gold', '🌐');
    header.appendChild(iconChip);
    header.appendChild(el('h4', '', 'Mi Red MLM'));
    card.appendChild(header);

    // ── Métricas ──
    var metrics = el('div', 'mlm-metrics');
    metrics.appendChild(buildMetric(totalMiembros, 'Miembros totales'));
    metrics.appendChild(buildMetric(nivelesActivos, 'Niveles activos'));
    metrics.appendChild(buildMetric(directos, 'Referidos directos'));
    card.appendChild(metrics);

    // ── Acordeón ──
    var accordion = el('div', 'mlm-accordion');
    for (var i = 0; i < niveles.length; i++) {
      accordion.appendChild(buildLevelAccordion(niveles[i]));
    }
    card.appendChild(accordion);

    // ── Refresh ──
    var refreshWrap = el('div', 'mlm-refresh');
    var btnRefresh = el('button', 'btn btn-outline btn-sm', '↻ Actualizar red');
    btnRefresh.type = 'button';
    btnRefresh.addEventListener('click', function () {
      renderMlmCard(container);
    });
    refreshWrap.appendChild(btnRefresh);
    card.appendChild(refreshWrap);

    container.appendChild(card);
  }

  function buildMetric(value, label) {
    var metric = el('div', 'mlm-metric');
    metric.appendChild(el('span', 'mlm-metric-value', String(value)));
    metric.appendChild(el('span', 'mlm-metric-label', label));
    return metric;
  }

  function buildLevelAccordion(nivel) {
    var n = nivel.nivel;
    var meta = LEVEL_META[n] || LEVEL_META[1];
    var count = nivel.miembros.length;

    var details = document.createElement('details');
    details.className = 'mlm-level mlm-level-' + n;
    if (n === 1) details.open = true;

    // ── Summary ──
    var summary = document.createElement('summary');
    summary.className = 'mlm-level-summary';

    summary.appendChild(el('span', 'mlm-level-badge', meta.icon + ' Nivel ' + n + ' · ' + meta.commission + '%'));
    summary.appendChild(el('span', '', meta.label));
    summary.appendChild(el('span', 'mlm-level-count', String(count)));
    summary.appendChild(el('span', 'mlm-level-chevron', '▾'));
    details.appendChild(summary);

    // ── Body ──
    var body = el('div', 'mlm-level-body');

    if (nivel.denegado) {
      body.appendChild(el('p', 'mlm-level-denied', 'No se pudieron cargar los niveles más profundos de tu red.'));
    } else if (count === 0) {
      body.appendChild(el('p', 'mlm-level-empty', 'Sin referidos en este nivel.'));
    } else if (n === 1) {
      buildLevel1Body(body, nivel.miembros);
    } else {
      buildLevelSummaryBody(body, nivel.miembros, n, meta);
    }

    details.appendChild(body);
    return details;
  }

  function buildLevel1Body(body, miembros) {
    miembros.forEach(function (m) {
      var row = el('div', 'mlm-member');
      row.appendChild(el('span', 'mlm-member-name', memberName(m)));
      row.appendChild(el('span', 'mlm-member-email', m.email || '—'));
      var statusKey = String(m.estado || 'activo').toLowerCase().replace(/[^a-záéíóúñ]+/g, '-');
      var statusCls = statusKey === 'activo' || statusKey === 'completo' ? 'activo'
        : statusKey === 'inactivo' || statusKey === 'suspendido' ? 'inactivo' : 'otro';
      row.appendChild(el('span', 'mlm-member-status ' + statusCls, m.estado || 'Activo'));
      var btn = el('button', 'mlm-member-view', 'Ver');
      btn.type = 'button';
      btn.addEventListener('click', function () { openMlmMemberModal(m); });
      row.appendChild(btn);
      body.appendChild(row);
    });
  }

  function buildLevelSummaryBody(body, miembros, n, meta) {
    var activos = 0;
    var inactivos = 0;
    miembros.forEach(function (m) {
      var st = String(m.estado || '').toLowerCase();
      if (st === 'activo' || st === 'completo') activos++;
      else inactivos++;
    });

    var grid = el('div', 'mlm-level-summary-grid');
    grid.appendChild(buildSummaryItem('Total miembros', String(miembros.length)));
    grid.appendChild(buildSummaryItem('Comisión', meta.commission + '%'));
    grid.appendChild(buildSummaryItem('Activos', String(activos)));
    grid.appendChild(buildSummaryItem('Inactivos', String(inactivos)));
    body.appendChild(grid);

    // Toggle para listar miembros
    var toggleId = 'mlm-toggle-' + n + '-' + Math.random().toString(36).slice(2, 6);
    var toggle = document.createElement('button');
    toggle.className = 'mlm-level-members-toggle';
    toggle.type = 'button';
    toggle.id = toggleId;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.innerHTML = '<i class="fas fa-chevron-right"></i> Ver miembros (' + miembros.length + ')';

    var membersList = el('div', 'mlm-level-members-list');
    membersList.style.display = 'none';

    miembros.forEach(function (m) {
      var row = el('div', 'mlm-member');
      row.appendChild(el('span', 'mlm-member-name', memberName(m)));
      row.appendChild(el('span', 'mlm-member-email', m.email || '—'));
      var statusKey = String(m.estado || 'activo').toLowerCase().replace(/[^a-záéíóúñ]+/g, '-');
      var statusCls = statusKey === 'activo' || statusKey === 'completo' ? 'activo'
        : statusKey === 'inactivo' || statusKey === 'suspendido' ? 'inactivo' : 'otro';
      row.appendChild(el('span', 'mlm-member-status ' + statusCls, m.estado || 'Activo'));
      var btn = el('button', 'mlm-member-view', 'Ver');
      btn.type = 'button';
      btn.addEventListener('click', function () { openMlmMemberModal(m); });
      row.appendChild(btn);
      membersList.appendChild(row);
    });

    toggle.addEventListener('click', function () {
      var expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
      membersList.style.display = expanded ? 'none' : '';
      toggle.innerHTML = (expanded ? '<i class="fas fa-chevron-right"></i> Ver miembros (' + miembros.length + ')' : '<i class="fas fa-chevron-down"></i> Ocultar miembros');
    });

    body.appendChild(toggle);
    body.appendChild(membersList);
  }

  function buildSummaryItem(label, value) {
    var item = el('div', 'mlm-level-summary-item');
    item.appendChild(el('span', 'mlm-level-summary-item-label', label));
    item.appendChild(el('span', 'mlm-level-summary-item-value', value));
    return item;
  }

  function memberName(m) {
    return (((m.nombre || '') + ' ' + (m.apellido || '')).trim()) || (m.email || 'Usuario');
  }

  function openMlmMemberModal(m) {
    var overlay = el('div', 'modal-overlay');
    var card = el('div', 'modal-card');
    var nivelLabel = m.nivel && m.nivel > 1 ? 'Referido nivel ' + m.nivel : 'Referido directo';
    card.appendChild(el('h3', '', '👤 ' + nivelLabel));

    var grid = el('div', 'dash-red-modal-grid');
    grid.appendChild(profileRowModal('Nombre', memberName(m)));
    grid.appendChild(profileRowModal('Correo', m.email));
    grid.appendChild(profileRowModal('Estado', m.estado || 'Activo'));
    grid.appendChild(profileRowModal('Rol', m.rol || '—'));
    grid.appendChild(profileRowModal('Fecha de registro', V.fmtDate(m.creado)));
    grid.appendChild(profileRowModal('Teléfono', m.telefono));
    card.appendChild(grid);

    card.appendChild(el('p', 'dash-red-modal-note', 'Solo ves perfiles de tu propia red de referidos. Las reglas de Firestore aíslan cada red.'));

    var actions = el('div', 'form-actions');
    if (m.email) {
      var btnMail = el('button', 'btn btn-primary', '✉️ Escribir');
      btnMail.type = 'button';
      btnMail.addEventListener('click', function () { window.location.href = 'mailto:' + encodeURIComponent(m.email); });
      actions.appendChild(btnMail);
    }
    var btnClose = el('button', 'btn btn-outline', 'Cerrar');
    btnClose.type = 'button';
    actions.appendChild(btnClose);
    card.appendChild(actions);

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    overlay.classList.add('show');

    function close() {
      overlay.classList.remove('show');
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
    btnClose.addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
  }

  function profileRowModal(label, value) {
    var row = el('div', 'dash-profile-row');
    row.appendChild(el('span', 'dash-profile-label', label));
    row.appendChild(el('span', 'dash-profile-value', value || '—'));
    return row;
  }

  /* ─── VISIÓN GLOBAL DE LA RED (solo superadmin) ────────────────
     Página independiente abierta desde la ficha de acceso del
     Escritorio. Consulta TODOS los perfiles (reglas: isAdmin()),
     construye el mapa de hijos por sponsorId, calcula la profundidad
     de cada miembro subiendo por su cadena de patrocinio y agrupa la
     red en niveles globales. El encabezado muestra los datos del
     multinivel (red) y el dinero (comisiones MLM desde Finanzas):
       · Red — usuarios totales, miembros vinculados, profundidad
         máxima y árboles/raíces.
       · Dinero — comisiones generadas (Σ finanzas_comisiones),
         desembolsado (Σ finanzas_pagos) y saldo disponible de la
         bolsa. La estructura se presenta en los 5 niveles de
         comisión con acordeones desplegables; los miembros más
         profundos (fuera de comisión) se resumen en una nota.         */
  function computarRedGlobal(users) {
    var byId = {};
    var i, u;
    for (i = 0; i < users.length; i++) {
      u = users[i];
      if (u && u.uid) byId[u.uid] = u;
    }
    var children = {};
    var roots = [];
    var conSponsor = 0;
    var sponsorValido = {};
    for (i = 0; i < users.length; i++) {
      u = users[i];
      var sid = u.sponsorId ? String(u.sponsorId) : '';
      if (sid && byId[sid]) {
        conSponsor++;
        sponsorValido[u.uid] = sid;
        (children[sid] = children[sid] || []).push(u);
      } else {
        roots.push(u);
      }
    }
    var depthById = {};
    var maxDepth = 0;
    for (i = 0; i < users.length; i++) {
      u = users[i];
      var seen = {};
      var cur = u;
      var d = 0;
      while (sponsorValido[cur.uid] && !seen[cur.uid] && d < 500) {
        seen[cur.uid] = true;
        cur = byId[sponsorValido[cur.uid]];
        if (!cur) break;
        d++;
      }
      if (d > maxDepth) maxDepth = d;
      depthById[u.uid] = d;
    }
    var niveles = [];
    for (i = 1; i <= MAX_NIVELES; i++) niveles[i] = { nivel: i, miembros: [] };
    var masProfundos = 0;
    for (i = 0; i < users.length; i++) {
      u = users[i];
      var d = depthById[u.uid];
      if (d > 0 && niveles[d]) {
        u._profundidad = d;
        var sid = sponsorValido[u.uid];
        u._sponsorNombre = byId[sid] ? memberName(byId[sid]) : '';
        niveles[d].miembros.push(u);
      } else if (d > MAX_NIVELES) {
        masProfundos++;
      }
    }
    var topReferrers = users.map(function (us) {
      return { uid: us.uid, nombre: memberName(us), directos: (children[us.uid] || []).length, email: us.email || '' };
    }).filter(function (r) { return r.directos > 0; })
      .sort(function (a, b) { return b.directos - a.directos; })
      .slice(0, 10);
    return {
      total: users.length,
      conSponsor: conSponsor,
      raices: roots.length,
      maxDepth: maxDepth,
      fueraDeComision: masProfundos,
      niveles: niveles.filter(Boolean),
      topReferrers: topReferrers,
      nombreDe: function (uid) { return byId[uid] ? memberName(byId[uid]) : (uid || '—'); },
      cadenaDe: function (uid) {
        var cadena = [];
        var cur = uid;
        var vistos = {};
        for (var g = 0; g < 500; g++) {
          if (!cur || byId[cur] === undefined) break;
          cadena.push({ uid: cur, nombre: memberName(byId[cur]) });
          if (vistos[cur]) break;
          vistos[cur] = true;
          cur = sponsorValido[cur] || '';
        }
        return cadena;
      }
    };
  }

  function renderMlmGlobalPanel(container) {
    if (!container) return;
    if (!V.esAdmin()) {
      container.innerHTML = '';
      container.appendChild(el('p', 'mlm-level-empty', 'Acceso restringido a administradores.'));
      return;
    }
    container.innerHTML = '';
    container.appendChild(el('p', 'mlm-level-empty', 'Analizando la red global…'));
    cargarRedGlobal(container);
  }

  function cargarRedGlobal(container) {
    if (!V.db) { return; }
    var usuariosP = V.db.collection(V.COL_USUARIOS).get().then(function (snap) {
      var users = [];
      snap.forEach(function (doc) {
        var d = doc.data() || {};
        d.uid = doc.id;
        users.push(d);
      });
      return users;
    }).catch(function () { return []; });

    var dineroDefault = { generadas: 0, pagado: 0, saldo: 0, ok: false };
    var dineroP = Promise.all([
      V.db.collection('finanzas_comisiones').get(),
      V.db.collection('finanzas_pagos').get()
    ]).then(function (res) {
      var generadas = 0, pagado = 0;
      res[0].forEach(function (doc) { generadas += Number((doc.data() || {}).monto) || 0; });
      res[1].forEach(function (doc) { pagado += Number((doc.data() || {}).monto) || 0; });
      return { generadas: generadas, pagado: pagado, saldo: +(generadas - pagado).toFixed(2), ok: true };
    }).catch(function () { return dineroDefault; });

    Promise.all([usuariosP, dineroP]).then(function (res) {
      var net = computarRedGlobal(res[0]);
      container.innerHTML = '';
      pintarRedGlobal(container, net, res[1]);
    }).catch(function () {
      container.innerHTML = '';
      container.appendChild(el('p', 'mlm-level-empty', 'No se pudo cargar la red global en este momento.'));
    });
  }

  function fmtMoneda(v) {
    try {
      var n = Number(v) || 0;
      return n.toLocaleString('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0, maximumFractionDigits: 0 });
    } catch (e) {
      return '$' + (Number(v) || 0).toLocaleString();
    }
  }

  function pintarRedGlobal(container, net, dinero) {
    var card = el('div', 'mlm-card mlm-card-global');

    var header = el('div', 'mlm-card-header');
    header.appendChild(el('span', 'icon-chip sm gold', '🌐'));
    header.appendChild(el('h4', '', 'Multinivel · Visión global'));
    header.appendChild(el('span', 'mlm-global-quick-badge', 'Admin'));
    card.appendChild(header);

    // ── Encabezado de datos: red + dinero ──
    var hero = el('div', 'mlm-global-hero');
    hero.appendChild(el('h5', 'mlm-global-hero-label', 'Red · Multinivel'));
    hero.appendChild(el('span', 'mlm-global-hero-sub', 'Toda la plataforma por patrocinio'));
    var heroRed = el('div', 'mlm-metrics mlm-metrics--4');
    heroRed.appendChild(buildMetric(net.total, 'Usuarios totales'));
    heroRed.appendChild(buildMetric(net.conSponsor, 'Miembros en red'));
    heroRed.appendChild(buildMetric(net.raices, 'Árboles / raíces'));
    heroRed.appendChild(buildMetric(net.maxDepth, 'Profundidad total'));
    hero.appendChild(heroRed);
    card.appendChild(hero);

    var heroDinero = el('div', 'mlm-global-hero mlm-global-money');
    heroDinero.appendChild(el('h5', 'mlm-global-hero-label', 'Dinero · Comisiones MLM'));
    heroDinero.appendChild(el('span', 'mlm-global-hero-sub', 'Distribución de la bolsa N1–N5 contra los desembolsos'));
    var moneyGrid = el('div', 'mlm-metrics');
    moneyGrid.appendChild(buildMetric(fmtMoneda(dinero.generadas), 'Comisiones generadas'));
    moneyGrid.appendChild(buildMetric(fmtMoneda(dinero.pagado), 'Desembolsado'));
    moneyGrid.appendChild(buildMetric(fmtMoneda(dinero.saldo), 'Saldo de bolsa'));
    heroDinero.appendChild(moneyGrid);
    card.appendChild(heroDinero);

    // ── Top patrocinadores ──
    if (net.topReferrers.length) {
      var topSection = el('div', 'mlm-global-top');
      topSection.appendChild(el('h5', 'mlm-global-top-title', '🏆 Top patrocinadores (referidos directos)'));
      var topList = el('div', 'mlm-global-top-list');
      net.topReferrers.forEach(function (r, idx) {
        var chip = el('span', 'mlm-global-top-chip');
        chip.appendChild(el('b', '', (idx + 1) + '. ' + r.nombre));
        chip.appendChild(el('span', '', ' · ' + r.directos + ' directo' + (r.directos === 1 ? '' : 's')));
        topList.appendChild(chip);
      });
      topSection.appendChild(topList);
      card.appendChild(topSection);
    }

    // ── Estructura completa de los 5 niveles ──
    card.appendChild(el('h5', 'mlm-global-section-title', 'Estructura de los 5 niveles'));
    card.appendChild(el('p', 'mlm-global-section-sub', 'Acordeones desplegables con la distribución completa de la red.'));
    if (!net.conSponsor && !net.niveles.some(function (n) { return n.miembros.length; })) {
      card.appendChild(el('p', 'mlm-level-empty', 'Aún no hay miembros vinculados a la red.'));
    } else {
      var accordion = el('div', 'mlm-accordion mlm-global-accordion');
      net.niveles.forEach(function (n) {
        accordion.appendChild(buildGlobalLevel(n, net));
      });
      card.appendChild(accordion);
      if (net.fueraDeComision > 0) {
        card.appendChild(el('p', 'mlm-global-note', '🔻 +' + net.fueraDeComision + ' miembros en niveles más profundos (fuera de la comisión N1–N5).'));
      }
    }

    card.appendChild(el('p', 'mlm-global-note', 'Administrador general · métricas de toda la plataforma. El dinero proviene de Finanzas (finanzas_comisiones y finanzas_pagos); la estructura, de los perfiles por sponsorId.'));

    container.appendChild(card);
  }

  function buildGlobalLevel(nivel, net) {
    var n = nivel.nivel;
    var accent = GLOBAL_ACCENTS[(n - 1) % GLOBAL_ACCENTS.length];
    var count = nivel.miembros.length;

    var details = document.createElement('details');
    details.className = 'mlm-level mlm-level-' + accent + ' mlm-level-global';
    if (n === 1) details.open = true;

    var summary = document.createElement('summary');
    summary.className = 'mlm-level-summary';
    summary.appendChild(el('span', 'mlm-level-badge', '📍 Nivel ' + n));
    summary.appendChild(el('span', '', count + ' miembro' + (count === 1 ? '' : 's')));
    summary.appendChild(el('span', 'mlm-level-count', String(count)));
    summary.appendChild(el('span', 'mlm-level-chevron', '▾'));
    details.appendChild(summary);

    var body = el('div', 'mlm-level-body');
    if (count === 0) {
      body.appendChild(el('p', 'mlm-level-empty', 'Sin miembros en este nivel.'));
    } else {
      nivel.miembros.slice().sort(function (a, b) { return (b.creado || '').localeCompare(a.creado || ''); }).forEach(function (m) {
        var row = el('div', 'mlm-member');
        row.appendChild(el('span', 'mlm-member-name', memberName(m)));
        row.appendChild(el('span', 'mlm-member-email', m.email || '—'));
        row.appendChild(el('span', 'mlm-global-sponsor', '⬆ ' + (m._sponsorNombre || net.nombreDe(m.sponsorId))));
        var statusKey = String(m.estado || 'activo').toLowerCase().replace(/[^a-záéíóúñ]+/g, '-');
        var statusCls = statusKey === 'activo' || statusKey === 'completo' ? 'activo'
          : statusKey === 'inactivo' || statusKey === 'suspendido' ? 'inactivo' : 'otro';
        row.appendChild(el('span', 'mlm-member-status ' + statusCls, m.estado || 'Activo'));
        var btn = el('button', 'mlm-member-view', 'Ver');
        btn.type = 'button';
        btn.addEventListener('click', (function (mem) {
          return function () { openGlobalMemberModal(mem, net); };
        })(m));
        row.appendChild(btn);
        body.appendChild(row);
      });
    }
    details.appendChild(body);
    return details;
  }

  function openGlobalMemberModal(m, net) {
    var overlay = el('div', 'modal-overlay');
    var card = el('div', 'modal-card');
    card.appendChild(el('h3', '', '👤 ' + memberName(m)));
    card.appendChild(el('p', 'mlm-modal-subtitle', m.email || 'Miembro de la red MLM'));

    var directos = 0;
    if (net && net.cadenaDe) {
      try {
        // El conteo de referidos directos se deduce de la cadena de la red.
        directos = net.topReferrers.filter(function (r) { return r.uid === m.uid; })[0];
        directos = directos ? directos.directos : 0;
      } catch (e) { directos = 0; }
    }

    var grid = el('div', 'dash-red-modal-grid');
    grid.appendChild(profileRowModal('Nombre', memberName(m)));
    grid.appendChild(profileRowModal('Nivel', m._profundidad ? 'Nivel ' + m._profundidad : 'Raíz'));
    grid.appendChild(profileRowModal('Estado', m.estado || 'Activo'));
    grid.appendChild(profileRowModal('Rol', m.rol || '—'));
    grid.appendChild(profileRowModal('Referidos directos', String(directos)));
    grid.appendChild(profileRowModal('Fecha de registro', V.fmtDate(m.creado)));
    grid.appendChild(profileRowModal('Teléfono', m.telefono));
    if (m.referralCode) grid.appendChild(profileRowModal('Código referido', m.referralCode));
    card.appendChild(grid);

    card.appendChild(el('h5', 'mlm-global-chain-title', '⬆ Cadena de patrocinio'));
    var chain = net.cadenaDe(m.uid);
    if (chain.length) {
      var chips = el('div', 'mlm-global-chain');
      chain.forEach(function (c, idx) {
        if (idx > 0) chips.appendChild(el('span', 'mlm-global-chain-arr', '→'));
        var cchip = el('span', 'mlm-global-chain-chip' + (c.uid === m.uid ? ' is-me' : ''), c.nombre);
        chips.appendChild(cchip);
      });
      card.appendChild(chips);
    } else {
      card.appendChild(el('p', 'mlm-level-empty', 'Sin patrocinador (raíz de su árbol).'));
    }

    card.appendChild(el('p', 'dash-red-modal-note', 'Vista de administrador general. Solo se muestran datos del perfil dentro de la red.'));

    var actions = el('div', 'form-actions');
    if (m.email) {
      var btnMail = el('button', 'btn btn-primary', '✉️ Escribir');
      btnMail.type = 'button';
      btnMail.addEventListener('click', function () { window.location.href = 'mailto:' + encodeURIComponent(m.email); });
      actions.appendChild(btnMail);
    }
    var btnClose = el('button', 'btn btn-outline', 'Cerrar');
    btnClose.type = 'button';
    actions.appendChild(btnClose);
    card.appendChild(actions);

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    overlay.classList.add('show');

    function close() {
      overlay.classList.remove('show');
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
    btnClose.addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
  }

  var GLOBAL_ACCENTS = ['1', '2', '3', '4', '5'];

  function bindGlobalEvents() {
    var btn = V.$('btnRedGlobalRefresh');
    if (btn) btn.addEventListener('click', function () {
      var content = V.$('redGlobalContent');
      if (content) renderMlmGlobalPanel(content);
      else if (typeof V.showRedGlobal === 'function') V.showRedGlobal();
    });
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
    applyMlmUiState: applyMlmUiState,
    renderMlmCard: renderMlmCard,
    computarRedGlobal: computarRedGlobal,
    renderMlmGlobalPanel: renderMlmGlobalPanel
  };

  V.onRedGlobalShow = function () {
    var content = V.$('redGlobalContent');
    if (!content) return;
    renderMlmGlobalPanel(content);
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
    bindGlobalEvents();
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