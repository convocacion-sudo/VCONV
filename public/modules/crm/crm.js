/* ════════════════════════════════════════════════════════════════
   VCONV · Módulo CRM — Gestión de Usuarios (superadmin)
   Tabla en tiempo real, formulario extendido, filtros,
   perfiles dinámicos, ubicación en cascada.
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var V = window.VCONV;
  if (!V) { console.error('VCONV core not loaded'); return; }

  /* ─── STATE ───────────────────────────────────────────────── */
  var CONFIG_COLLECTION = 'config';
  var PROFILES_DOC = 'perfiles';
  var PROFESIONES_DOC = 'profesiones';
  var OFICIOS_DOC = 'oficios';
  var UBICACION_DOC = 'ubicacion';
  var DEFAULT_PROFESIONES = ['Abogado', 'Administrador', 'Docente', 'Líder religioso', 'Enfermero/a', 'Médico', 'Chef'];
  var DEFAULT_OFICIOS = ['Ama de casa', 'Carpintero', 'Conductor', 'Mecánico', 'Operario/a', 'Panadero', 'Vendedor/a'];
  var DEFAULT_UBICACION = {
    departamentos: ['Antioquia', 'Bogotá D.C.', 'Valle del Cauca'],
    ciudades: {
      'Antioquia': ['Medellín', 'Envigado', 'Bello', 'Sabaneta'],
      'Bogotá D.C.': ['Bogotá'],
      'Valle del Cauca': ['Cali', 'Palmira']
    },
    barrios: {
      'Medellín': ['El Poblado', 'Laureles', 'La Candelaria', 'Buenos Aires'],
      'Envigado': ['El Dorado', 'Santa Ana', 'La Magnolia'],
      'Bello': ['Centro', 'Naranjal', 'San José'],
      'Sabaneta': ['Centro', 'La Doctora', 'Ancón Sur'],
      'Bogotá': ['Chapinero', 'Usaquén', 'Suba'],
      'Cali': ['San Antonio', 'Granada', 'El Peñón'],
      'Palmira': ['Centro', 'La Carbonera']
    }
  };
  var usuariosUnsub = null;
  var usuariosCache = [];
  var perfilesCache = [];
  var perfilesUnsub = null;
  var profesionesCache = [];
  var profesionesUnsub = null;
  var oficiosCache = [];
  var oficiosUnsub = null;
  var ubicacionData = { departamentos: [], ciudades: {}, barrios: {} };
  var ubicacionUnsub = null;
  var editingUser = null;
  var editingProfileIndex = null;
  var editingProfesionIndex = null;
  var editingOficioIndex = null;
  var editingDeptoIndex = null;
  var editingCiudadDepto = null;
  var editingCiudadIndex = null;
  var editingBarrioCiudad = null;
  var editingBarrioIndex = null;
  var filters = { search: '', rol: '', estado: '', perfil: '', profesion: '', oficio: '', ciudad: '', barrio: '' };
  var selectedUids = new Set();

  /* ─── HELPERS ─────────────────────────────────────────────── */
  function $(id) { return V.$(id); }
  function el(tag, cls, text) { return V.el(tag, cls, text); }

  function toggleFilter(key, val) {
    filters[key] = filters[key] === val ? '' : val;
  }

  function clearAllFilters() {
    filters.search = ''; filters.rol = ''; filters.estado = '';
    filters.perfil = ''; filters.profesion = ''; filters.oficio = ''; filters.ciudad = ''; filters.barrio = '';
  }

  function syncFilterDropdowns() {
    var s = $('adminSearch'); if (s) s.value = filters.search;
    var r = $('adminFilterRol'); if (r) r.value = filters.rol;
    var e = $('adminFilterEstado'); if (e) e.value = filters.estado;
    var p = $('adminFilterPerfil'); if (p) p.value = filters.perfil;
    var pr = $('adminFilterProfesion'); if (pr) pr.value = filters.profesion;
    var of = $('adminFilterOficio'); if (of) of.value = filters.oficio;
  }

  function normFieldVal(field, val) {
    if (field === 'estado') return (!val || !val.trim()) ? 'Activo' : val.trim();
    return (!val || !val.trim()) ? '—' : val.trim();
  }

  function computeFieldCounts(field, limit) {
    var counts = {};
    usuariosCache.forEach(function (u) {
      var val = normFieldVal(field, u[field]);
      counts[val] = (counts[val] || 0) + 1;
    });
    return Object.keys(counts)
      .map(function (k) { return { value: k, count: counts[k] }; })
      .sort(function (a, b) { return b.count - a.count; })
      .slice(0, limit || 6);
  }

  function countUniqueValues(field) {
    var seen = {};
    usuariosCache.forEach(function (u) {
      seen[normFieldVal(field, u[field])] = true;
    });
    return Object.keys(seen).length;
  }

  function filterUpdate() {
    renderStats();
    renderAnalytics();
    renderActiveFiltersBar();
    renderTable();
  }

  /* ─── UBICACION (3 niveles: Departamento → Ciudad → Barrio) ─ */
  function normalizeUbicacion() {
    var ok = {};
    ok.departamentos = [];
    ok.ciudades = {};
    ok.barrios = {};
    if (ubicacionData && Array.isArray(ubicacionData.departamentos)) {
      ok.departamentos = ubicacionData.departamentos.filter(function (d) { return typeof d === 'string' && d.trim(); }).map(function (d) { return d.trim(); });
    }
    if (ubicacionData && ubicacionData.ciudades && typeof ubicacionData.ciudades === 'object') {
      Object.keys(ubicacionData.ciudades).forEach(function (depto) {
        var list = ubicacionData.ciudades[depto];
        if (Array.isArray(list)) {
          ok.ciudades[depto] = list.filter(function (c) { return typeof c === 'string' && c.trim(); }).map(function (c) { return c.trim(); });
        }
      });
    }
    if (ubicacionData && ubicacionData.barrios && typeof ubicacionData.barrios === 'object') {
      Object.keys(ubicacionData.barrios).forEach(function (ciudad) {
        var list = ubicacionData.barrios[ciudad];
        if (Array.isArray(list)) {
          ok.barrios[ciudad] = list.filter(function (b) { return typeof b === 'string' && b.trim(); }).map(function (b) { return b.trim(); });
        }
      });
    }
    return ok;
  }

  function applyUbicacion(data) {
    ubicacionData = data;
    return ubicacionData;
  }

  function defaultsUbicacionIfEmpty(data) {
    var norm = normalizeUbicacion();
    if (!norm.departamentos.length && !Object.keys(norm.ciudades).length && !Object.keys(norm.barrios).length) {
      var copy = JSON.parse(JSON.stringify(DEFAULT_UBICACION));
      applyUbicacion(copy);
      saveUbicacion();
      return ubicacionData;
    }
    applyUbicacion(norm);
    return ubicacionData;
  }

  function subscribeUbicacion() {
    if (!V.db) return;
    if (V.userRole !== 'superadmin') return;
    if (ubicacionUnsub) return;
    try {
      ubicacionUnsub = V.db.collection(CONFIG_COLLECTION).doc(UBICACION_DOC).onSnapshot(function (doc) {
        var raw = doc.exists ? doc.data() : {};
        defaultsUbicacionIfEmpty(raw);
        renderAll();
        var overlay = $('crmFormOverlay');
        if (overlay && overlay.classList.contains('show') && editingUser) {
          populateDeptoSelect(editingUser.departamento);
          populateCiudadSelect(editingUser.ciudad);
          populateBarrioSelect(editingUser.barrio);
        }
      }, function () {
        defaultsUbicacionIfEmpty({});
        renderAll();
      });
    } catch (e) {
      defaultsUbicacionIfEmpty({});
      renderAll();
    }
  }

  function saveUbicacion() {
    if (!V.db) return;
    V.db.collection(CONFIG_COLLECTION).doc(UBICACION_DOC).set({
      departamentos: ubicacionData.departamentos,
      ciudades: ubicacionData.ciudades,
      barrios: ubicacionData.barrios
    }, { merge: true })
      .then(function () { })
      .catch(function (e) {
        V.toast('Error al guardar ubicación: ' + e.message, true);
      });
  }

  function loadUbicacion() {
    if (!V.db) { return Promise.resolve(ubicacionData); }
    return V.db.collection(CONFIG_COLLECTION).doc(UBICACION_DOC).get()
      .then(function (doc) {
        var raw = doc.exists ? doc.data() : {};
        return defaultsUbicacionIfEmpty(raw);
      })
      .catch(function () {
        return defaultsUbicacionIfEmpty({});
      });
  }

  function addBarrioToList(ciudad, name) {
    if (!ciudad || !name) return false;
    var list = ubicacionData.barrios[ciudad] || (ubicacionData.barrios[ciudad] = []);
    if (list.indexOf(name) !== -1) return false;
    list.push(name);
    saveUbicacion();
    return true;
  }

  function clearUsersField(field, value) {
    if (!value) return;
    V.db.collection(V.COL_USUARIOS).where(field, '==', value).get()
      .then(function (snap) {
        var updates = [];
        var clearObj;
        snap.forEach(function (doc) {
          if (field === 'departamento') clearObj = { departamento: '', ciudad: '', barrio: '' };
          else if (field === 'ciudad') clearObj = { ciudad: '', barrio: '' };
          else clearObj = { barrio: '' };
          updates.push(doc.ref.update(clearObj));
        });
        return Promise.all(updates);
      })
      .catch(function () {});
  }

  function updateUsersField(field, oldValue, newValue) {
    if (!oldValue || !newValue) return;
    var upd = {};
    upd[field] = newValue;
    V.db.collection(V.COL_USUARIOS).where(field, '==', oldValue).get()
      .then(function (snap) {
        var updates = [];
        snap.forEach(function (doc) { updates.push(doc.ref.update(upd)); });
        return Promise.all(updates);
      })
      .catch(function () {});
  }

  /* ─── SUBSCRIBE USUARIOS ──────────────────────────────────── */
  function subscribeUsuarios() {
    if (!V.db || V.userRole !== 'superadmin') return;
    if (usuariosUnsub) return;
    try {
      usuariosUnsub = V.db.collection(V.COL_USUARIOS).onSnapshot(function (snap) {
        usuariosCache = [];
        snap.forEach(function (doc) { var d = doc.data(); d.uid = doc.id; usuariosCache.push(d); });
        pruneSelection();
        showUsuariosError(false);
        renderAll();
      }, function (e) {
        handleUsuariosError(e);
      });
    } catch (e) {
      handleUsuariosError(e);
    }
  }

  function handleUsuariosError(e) {
    if (!e) return;
    var msg = (e && e.message) || String(e);
    // Errores de permisos: aviso controlado y no bloqueante, sin spam de toasts.
    if (/permission|insufficient|Missing or insufficient permissions/i.test(msg)) {
      showUsuariosError(true, 'Sin permisos para cargar usuarios. Verifica tu rol en Firestore.');
      return;
    }
    showUsuariosError(true, 'Error al cargar usuarios: ' + msg);
  }

  function showUsuariosError(show, message) {
    var tbody = $('adminTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (!show) return;
    var tr = el('tr');
    var td = el('td', 'admin-empty');
    td.setAttribute('colspan', '11');
    td.textContent = message || 'No se pudieron cargar los usuarios.';
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  /* ─── SUBSCRIBE PERFILES ──────────────────────────────────── */
  function normalizePerfiles(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter(function (p) { return typeof p === 'string' && p.trim(); })
      .map(function (p) { return p.trim(); });
  }

  function applyPerfiles(next) {
    perfilesCache = next;
    return perfilesCache;
  }

  function subscribePerfiles() {
    if (!V.db) { return; }
    if (V.userRole !== 'superadmin') { return; }
    if (perfilesUnsub) return;
    try {
      perfilesUnsub = V.db.collection(CONFIG_COLLECTION).doc(PROFILES_DOC).onSnapshot(function (doc) {
        var raw = doc.exists ? (doc.data().categorias || doc.data().perfiles || []) : [];
        applyPerfiles(normalizePerfiles(raw));
        renderAll();
        var overlay = $('crmFormOverlay');
        if (overlay && overlay.classList.contains('show') && editingUser) populatePerfilSelect(editingUser.perfil);
      }, function () {
        applyPerfiles([]);
        renderAll();
      });
    } catch (e) {
      applyPerfiles([]);
      renderAll();
    }
  }

  function savePerfiles() {
    if (!V.db) return;
    V.db.collection(CONFIG_COLLECTION).doc(PROFILES_DOC).set({ categorias: perfilesCache }, { merge: true })
      .then(function () { })
      .catch(function (e) {
        V.toast('Error al guardar perfiles: ' + e.message, true);
      });
  }

  /* ─── SUBSCRIBE PROFESIONES ───────────────────────────────── */
  function normalizeProfesiones(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter(function (p) { return typeof p === 'string' && p.trim(); })
      .map(function (p) { return p.trim(); });
  }

  function applyProfesiones(next) {
    profesionesCache = next;
    return profesionesCache;
  }

  function defaultsProfesionesIfEmpty(next) {
    if (!next.length) {
      profesionesCache = DEFAULT_PROFESIONES.slice();
      saveProfesiones();
      return profesionesCache;
    }
    profesionesCache = next;
    return profesionesCache;
  }

  function subscribeProfesiones() {
    if (!V.db) { return; }
    if (V.userRole !== 'superadmin') { return; }
    if (profesionesUnsub) return;
    try {
      profesionesUnsub = V.db.collection(CONFIG_COLLECTION).doc(PROFESIONES_DOC).onSnapshot(function (doc) {
        var raw = doc.exists ? (doc.data().categorias || []) : [];
        defaultsProfesionesIfEmpty(normalizeProfesiones(raw));
        renderAll();
        var overlay = $('crmFormOverlay');
        if (overlay && overlay.classList.contains('show') && editingUser) populateProfesionSelect(editingUser.profesion);
      }, function () {
        defaultsProfesionesIfEmpty([]);
        renderAll();
      });
    } catch (e) {
      defaultsProfesionesIfEmpty([]);
      renderAll();
    }
  }

  function saveProfesiones() {
    if (!V.db) return;
    V.db.collection(CONFIG_COLLECTION).doc(PROFESIONES_DOC).set({ categorias: profesionesCache }, { merge: true })
      .then(function () { })
      .catch(function (e) {
        V.toast('Error al guardar profesiones: ' + e.message, true);
      });
  }

  function loadProfesionesFromDb() {
    if (!V.db) { return Promise.resolve(profesionesCache); }
    return V.db.collection(CONFIG_COLLECTION).doc(PROFESIONES_DOC).get()
      .then(function (doc) {
        var raw = doc.exists ? (doc.data().categorias || []) : [];
        return defaultsProfesionesIfEmpty(normalizeProfesiones(raw));
      })
      .catch(function () {
        return defaultsProfesionesIfEmpty([]);
      });
  }

  function addProfesionToList(name) {
    if (!name || profesionesCache.indexOf(name) !== -1) return false;
    profesionesCache.push(name);
    saveProfesiones();
    return true;
  }

  /* ─── SUBSCRIBE OFICIOS ──────────────────────────────────── */
  function normalizeOficios(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter(function (o) { return typeof o === 'string' && o.trim(); })
      .map(function (o) { return o.trim(); });
  }

  function applyOficios(next) {
    oficiosCache = next;
    return oficiosCache;
  }

  function defaultsOficiosIfEmpty(next) {
    if (!next.length) {
      oficiosCache = DEFAULT_OFICIOS.slice();
      saveOficios();
      return oficiosCache;
    }
    oficiosCache = next;
    return oficiosCache;
  }

  function subscribeOficios() {
    if (!V.db) { return; }
    if (V.userRole !== 'superadmin') { return; }
    if (oficiosUnsub) return;
    try {
      oficiosUnsub = V.db.collection(CONFIG_COLLECTION).doc(OFICIOS_DOC).onSnapshot(function (doc) {
        var raw = doc.exists ? (doc.data().categorias || []) : [];
        defaultsOficiosIfEmpty(normalizeOficios(raw));
        renderAll();
        var overlay = $('crmFormOverlay');
        if (overlay && overlay.classList.contains('show') && editingUser) populateOficioSelect(editingUser.oficio);
      }, function () {
        defaultsOficiosIfEmpty([]);
        renderAll();
      });
    } catch (e) {
      defaultsOficiosIfEmpty([]);
      renderAll();
    }
  }

  function saveOficios() {
    if (!V.db) return;
    V.db.collection(CONFIG_COLLECTION).doc(OFICIOS_DOC).set({ categorias: oficiosCache }, { merge: true })
      .then(function () { })
      .catch(function (e) {
        V.toast('Error al guardar oficios: ' + e.message, true);
      });
  }

  function loadOficiosFromDb() {
    if (!V.db) { return Promise.resolve(oficiosCache); }
    return V.db.collection(CONFIG_COLLECTION).doc(OFICIOS_DOC).get()
      .then(function (doc) {
        var raw = doc.exists ? (doc.data().categorias || []) : [];
        return defaultsOficiosIfEmpty(normalizeOficios(raw));
      })
      .catch(function () {
        return defaultsOficiosIfEmpty([]);
      });
  }

  function addOficioToList(name) {
    if (!name || oficiosCache.indexOf(name) !== -1) return false;
    oficiosCache.push(name);
    saveOficios();
    return true;
  }

  /* ─── RENDER ALL ──────────────────────────────────────────── */
  function renderAll() {
    renderStats();
    renderAnalytics();
    renderActiveFiltersBar();
    renderTable();
    renderProfiles();
    renderProfesiones();
    renderOficios();
    renderUbicacion();
  }

  /* ─── RECÁLCULO DE LAYOUT DE LA TABLA ────────────────────── */
  // La primera vez se entra al módulo, la tabla se pinta mientras
  // #viewAdmin está oculto (display:none). En ese estado el navegador
  // fija un grid de columnas comprimido/desalineado que no se corrige
  // al mostrar la vista; solo un refresh manual lo recompone. Al
  // volver visible la sección (o tras cargar los datos), se reinserta
  // la tabla dentro de su contenedor usando requestAnimationFrame +
  // setTimeout para forzar una nueva medición de los anchos de columna.
  var _adminRelayoutScheduled = false;

  function isAdminViewVisible() {
    var view = $('viewAdmin');
    return !!(view && view.classList.contains('active') && view.offsetParent !== null);
  }

  function forceAdminTableRelayout() {
    _adminRelayoutScheduled = false;
    if (!isAdminViewVisible()) return;
    var wrap = document.querySelector('#viewAdmin .admin-table-wrap');
    var table = document.querySelector('#viewAdmin .admin-table');
    if (!wrap || !table || table.parentNode !== wrap) return;
    var next = table.nextSibling;
    wrap.removeChild(table);
    if (next && next.parentNode === wrap) wrap.insertBefore(table, next);
    else wrap.appendChild(table);
  }

  function scheduleAdminTableRelayout() {
    if (_adminRelayoutScheduled) return;
    _adminRelayoutScheduled = true;
    requestAnimationFrame(function () {
      setTimeout(forceAdminTableRelayout, 0);
    });
  }

  // Cada vez que el view pasa a mostrarse se re-mide la tabla para
  // que las columnas ajusten su ancho sin necesidad de refrescar.
  function watchAdminSectionLayout() {
    var view = $('viewAdmin');
    if (!view || typeof MutationObserver === 'undefined') return;
    var observer = new MutationObserver(function () {
      if (view.classList.contains('active')) scheduleAdminTableRelayout();
    });
    observer.observe(view, { attributes: true, attributeFilter: ['class'] });
    if (isAdminViewVisible()) scheduleAdminTableRelayout();
  }

  /* ─── STATS (row 1: summary — clickable to filter) ───────── */
  function renderStats() {
    var stats = $('adminSummaryStats');
    if (!stats) return;
    var total = usuariosCache.length;
    var activos = usuariosCache.filter(function (u) { return (u.estado || 'Activo') === 'Activo'; }).length;
    var estudiantes = usuariosCache.filter(function (u) { return u.rol === 'estudiante'; }).length;
    var gestores = usuariosCache.filter(function (u) { return u.rol === 'gestor'; }).length;
    var admins = usuariosCache.filter(function (u) { return u.rol === 'superadmin'; }).length;

    stats.innerHTML = '';
    [
      { value: total, label: 'Total', filterKey: null },
      { value: activos, label: 'Activos', filterKey: 'estado', filterVal: 'Activo' },
      { value: estudiantes, label: 'Estudiantes', filterKey: 'rol', filterVal: 'estudiante' },
      { value: gestores, label: 'Gestores', filterKey: 'rol', filterVal: 'gestor' },
      { value: admins, label: 'Admins', filterKey: 'rol', filterVal: 'superadmin' }
    ].forEach(function (c) {
      var card = el('div', 'admin-stat-card');
      var isActive = c.filterKey && filters[c.filterKey] === c.filterVal;
      if (isActive) card.classList.add('active');
      card.appendChild(el('div', 'stat-value', String(c.value)));
      card.appendChild(el('div', 'stat-label', c.label));
      card.style.cursor = 'pointer';
      card.addEventListener('click', function () {
        if (c.filterKey) { toggleFilter(c.filterKey, c.filterVal); }
        else { clearAllFilters(); }
        syncFilterDropdowns();
        filterUpdate();
      });
      stats.appendChild(card);
    });
  }

  /* ─── ANALYTICS (row 2: dimension breakdowns — pills to filter) ── */
  function renderAnalytics() {
    var container = $('adminAnalyticsStats');
    if (!container) return;
    container.innerHTML = '';
    [
      { key: 'perfil', label: 'Perfiles', filterKey: 'perfil' },
      { key: 'profesion', label: 'Profesiones', filterKey: 'profesion' },
      { key: 'oficio', label: 'Oficios', filterKey: 'oficio' },
      { key: 'estado', label: 'Estados', filterKey: 'estado' },
      { key: 'ciudad', label: 'Ciudades', filterKey: 'ciudad' },
      { key: 'barrio', label: 'Barrios', filterKey: 'barrio' }
    ].forEach(function (cat) {
      var counts = computeFieldCounts(cat.key, 5);
      var card = el('div', 'admin-analytics-card');
      var hdr = el('div', 'analytics-header');
      hdr.appendChild(el('span', 'analytics-title', cat.label));
      hdr.appendChild(el('span', 'analytics-count', String(countUniqueValues(cat.key))));
      card.appendChild(hdr);
      var pills = el('div', 'analytics-pills');
      counts.forEach(function (item) {
        var pill = el('span', 'analytics-pill');
        if (filters[cat.filterKey] === item.value) pill.classList.add('active');
        pill.appendChild(document.createTextNode(item.value === '—' ? 'Sin asignar' : item.value));
        var badge = el('span', 'pill-count', String(item.count));
        pill.appendChild(badge);
        pill.addEventListener('click', function (e) {
          e.stopPropagation();
          toggleFilter(cat.filterKey, item.value);
          syncFilterDropdowns();
          filterUpdate();
        });
        pills.appendChild(pill);
      });
      card.appendChild(pills);
      container.appendChild(card);
    });
  }

  /* ─── ACTIVE FILTERS BAR ───────────────────────────────────── */
  function renderActiveFiltersBar() {
    var bar = $('adminActiveFilters');
    if (!bar) return;
    var active = [];
    function labelOf(key, val) { return val === '—' ? 'Sin asignar' : val; }
    if (filters.rol) active.push({ label: 'Rol: ' + labelOf('rol', filters.rol), key: 'rol' });
    if (filters.estado) active.push({ label: 'Estado: ' + labelOf('estado', filters.estado), key: 'estado' });
    if (filters.perfil) active.push({ label: 'Perfil: ' + labelOf('perfil', filters.perfil), key: 'perfil' });
    if (filters.profesion) active.push({ label: 'Profesión: ' + labelOf('profesion', filters.profesion), key: 'profesion' });
    if (filters.oficio) active.push({ label: 'Oficio: ' + labelOf('oficio', filters.oficio), key: 'oficio' });
    if (filters.ciudad) active.push({ label: 'Ciudad: ' + labelOf('ciudad', filters.ciudad), key: 'ciudad' });
    if (filters.barrio) active.push({ label: 'Barrio: ' + labelOf('barrio', filters.barrio), key: 'barrio' });
    if (filters.search) active.push({ label: 'Búsqueda: "' + filters.search + '"', key: 'search' });
    bar.style.display = active.length ? 'flex' : 'none';
    bar.innerHTML = '';
    if (!active.length) return;
    bar.appendChild(el('span', 'active-filters-label', 'Filtros activos:'));
    active.forEach(function (a) {
      var pill = el('span', 'active-filter-pill', a.label + ' \u2715');
      pill.addEventListener('click', function () {
        if (a.key === 'search') { filters.search = ''; var si = $('adminSearch'); if (si) si.value = ''; }
        else { filters[a.key] = ''; syncFilterDropdowns(); }
        filterUpdate();
      });
      bar.appendChild(pill);
    });
    var clearBtn = el('button', 'btn-clear-filters', 'Limpiar todo');
    clearBtn.addEventListener('click', function () { clearAllFilters(); syncFilterDropdowns(); filterUpdate(); });
    bar.appendChild(clearBtn);
  }

  /* ─── FILTER ──────────────────────────────────────────────── */
  function applyFilters() {
    return usuariosCache.filter(function (u) {
      if (filters.search) {
        var q = filters.search.toLowerCase();
        var match = ((u.email || '') + ' ' + (u.nombre || '') + ' ' + (u.apellido || '') + ' ' + (u.documento || '') + ' ' + (u.telefono || '') + ' ' + (u.departamento || '') + ' ' + (u.ciudad || '') + ' ' + (u.barrio || '') + ' ' + (u.profesion || '') + ' ' + (u.oficio || '') + ' ' + (u.perfil || '')).toLowerCase();
        if (match.indexOf(q) === -1) return false;
      }
      if (filters.rol && u.rol !== filters.rol) return false;
      if (filters.estado && (u.estado || 'Activo') !== filters.estado) return false;
      if (filters.perfil && (u.perfil || '—') !== filters.perfil) return false;
      if (filters.profesion && (u.profesion || '—') !== filters.profesion) return false;
      if (filters.oficio && (u.oficio || '—') !== filters.oficio) return false;
      if (filters.ciudad && (u.ciudad || '—') !== filters.ciudad) return false;
      if (filters.barrio && (u.barrio || '—') !== filters.barrio) return false;
      return true;
    });
  }

  /* ─── TABLE ───────────────────────────────────────────────── */
  function renderTable() {
    var tbody = $('adminTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    var filtered = applyFilters();

    if (!filtered.length) {
      var tr = el('tr');
      var td = el('td', 'admin-empty', usuariosCache.length ? 'Sin resultados para los filtros aplicados.' : 'No hay usuarios registrados.');
td.setAttribute('colspan', '13');
      tr.appendChild(td);
      tbody.appendChild(tr);
      renderCheckAll();
      renderBulkBar();
      return;
    }

    filtered.forEach(function (u) {
      var tr = el('tr');
      tr.dataUid = String(u.uid);
      if (selectedUids.has(u.uid)) tr.className = 'admin-row-selected';

      // Celda de selección con checkbox (deshabilitada para el propio superadmin)
      var tdCheck = el('td', 'admin-check-cell');
      var check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'admin-check';
      check.checked = selectedUids.has(u.uid);
      if (u.uid === V.userId) check.disabled = true;
      check.addEventListener('change', function () { toggleSelection(u.uid, this.checked); });
      tdCheck.appendChild(check);
      tr.appendChild(tdCheck);

      tr.appendChild(el('td', 'wrap', u.email || '—'));
      // Nombre: clic = ficha completa
      var nameFull = ((u.nombre || '') + ' ' + (u.apellido || '')).trim() || '—';
      var tdName = el('td', 'wrap');
      var nameBtn = el('button', 'admin-name-link', nameFull);
      nameBtn.type = 'button';
      nameBtn.title = 'Ver ficha completa';
      nameBtn.addEventListener('click', function () { openView(u); });
      tdName.appendChild(nameBtn);
      tr.appendChild(tdName);

      // Código de referido: visible y copiable
      var tdRef = el('td', 'wrap');
      var refCode = u.referralCode || '';
      if (refCode) {
        var refWrap = document.createElement('div');
        refWrap.className = 'admin-ref';
        var refSpan = el('span', 'admin-ref-code', refCode);
        refSpan.title = refCode;
        var copyBtn = el('button', 'admin-copy-btn', '⧉');
        copyBtn.type = 'button';
        copyBtn.title = 'Copiar código de referido';
        copyBtn.addEventListener('click', function () {
          var btn = this;
          V.mlm.copiarAlPortapapeles(refCode).then(function () {
            var old = btn.textContent;
            btn.textContent = '✓';
            setTimeout(function () { btn.textContent = old; }, 1200);
          });
        });
        refWrap.appendChild(refSpan);
        refWrap.appendChild(copyBtn);
        tdRef.appendChild(refWrap);
      } else {
        tdRef.textContent = '--';
      }
      tr.appendChild(tdRef);
      tr.appendChild(el('td', 'wrap', u.documento || '—'));
      tr.appendChild(el('td', 'wrap', u.telefono || '—'));

      // Ubicación
      var ubicacion = [u.departamento, u.ciudad, u.barrio].filter(Boolean).join(', ');
      tr.appendChild(el('td', 'wrap', ubicacion || '—'));

      // Rol
      var tdRol = el('td');
      var selRol = document.createElement('select');
      selRol.className = 'admin-status-select';
      ['estudiante', 'gestor', 'superadmin'].forEach(function (r) {
        var opt = document.createElement('option');
        opt.value = r; opt.textContent = r === 'estudiante' ? 'Estudiante' : r === 'gestor' ? 'Gestor' : 'Superadmin';
        opt.selected = (u.rol || 'estudiante') === r;
        selRol.appendChild(opt);
      });
      if (u.uid === V.userId) selRol.disabled = true;
      selRol.addEventListener('change', function () { updateField(u.uid, 'rol', this.value); });
      tdRol.appendChild(selRol);
      tr.appendChild(tdRol);

      // Estado
      var tdEstado = el('td');
      var selEstado = document.createElement('select');
      selEstado.className = 'admin-status-select';
      ['Activo', 'Inactivo', 'Suspendido'].forEach(function (s) {
        var opt = document.createElement('option');
        opt.value = s; opt.textContent = s;
        opt.selected = (u.estado || 'Activo') === s;
        selEstado.appendChild(opt);
      });
      selEstado.addEventListener('change', function () { updateField(u.uid, 'estado', this.value); });
      tdEstado.appendChild(selEstado);
      tr.appendChild(tdEstado);

      // Perfil
      var tdPerfil = el('td');
      var selPerfil = document.createElement('select');
      selPerfil.className = 'admin-role-select';
      var optNone = document.createElement('option');
      optNone.value = ''; optNone.textContent = '—';
      selPerfil.appendChild(optNone);
      perfilesCache.forEach(function (p) {
        var opt = document.createElement('option');
        opt.value = p; opt.textContent = p;
        opt.selected = u.perfil === p;
        selPerfil.appendChild(opt);
      });
      selPerfil.addEventListener('change', function () { updateField(u.uid, 'perfil', this.value); });
      tdPerfil.appendChild(selPerfil);
      tr.appendChild(tdPerfil);

      // Profesión
      var tdProfesion = el('td');
      var selProfesion = document.createElement('select');
      selProfesion.className = 'admin-role-select';
      var optNoneProf = document.createElement('option');
      optNoneProf.value = ''; optNoneProf.textContent = '—';
      selProfesion.appendChild(optNoneProf);
      profesionesCache.forEach(function (p) {
        var opt = document.createElement('option');
        opt.value = p; opt.textContent = p;
        opt.selected = u.profesion === p;
        selProfesion.appendChild(opt);
      });
      selProfesion.addEventListener('change', function () { updateField(u.uid, 'profesion', this.value); });
      tdProfesion.appendChild(selProfesion);
      tr.appendChild(tdProfesion);

      // Oficio
      var tdOficio = el('td');
      var selOficio = document.createElement('select');
      selOficio.className = 'admin-role-select';
      var optNoneOfi = document.createElement('option');
      optNoneOfi.value = ''; optNoneOfi.textContent = '—';
      selOficio.appendChild(optNoneOfi);
      oficiosCache.forEach(function (p) {
        var opt = document.createElement('option');
        opt.value = p; opt.textContent = p;
        opt.selected = u.oficio === p;
        selOficio.appendChild(opt);
      });
      selOficio.addEventListener('change', function () { updateField(u.uid, 'oficio', this.value); });
      tdOficio.appendChild(selOficio);
      tr.appendChild(tdOficio);

      <!-- Acciones -->
      var tdActions = el('td', 'admin-actions');
      var viewBtn = el('button', 'admin-edit-btn', '👁');
      viewBtn.title = 'Ver ficha';
      viewBtn.addEventListener('click', function () { openView(u); });
      var editBtn = el('button', 'admin-edit-btn', '✏');
      editBtn.title = 'Editar perfil';
      editBtn.addEventListener('click', function () { openForm(u); });
      var delBtn = el('button', 'admin-delete-btn', '✕');
      delBtn.title = 'Eliminar usuario';
      delBtn.addEventListener('click', function () { deleteUser(u.uid, u.email); });
      tdActions.appendChild(viewBtn);
      tdActions.appendChild(editBtn);
      tdActions.appendChild(delBtn);
      tr.appendChild(tdActions);

      tbody.appendChild(tr);
    });

    renderCheckAll();
    renderBulkBar();
  }

  /* ─── SELECTION (bulk) ────────────────────────────────────── */
  function currentFilteredUids() {
    return applyFilters().map(function (u) { return u.uid; }).filter(function (uid) { return uid !== V.userId; });
  }

  function toggleSelection(uid, checked) {
    if (checked) { selectedUids.add(uid); }
    else { selectedUids.delete(uid); }
    renderBulkBar();
    var row = null;
    var tbody = $('adminTableBody');
    if (tbody) {
      Array.prototype.forEach.call(tbody.children, function (r) {
        if (r && r.dataUid === String(uid)) row = r;
      });
    }
    if (row) row.className = checked ? 'admin-row-selected' : '';
    renderCheckAll();
  }

  function renderCheckAll() {
    var checkAll = $('adminCheckAll');
    if (!checkAll) return;
    var filtered = currentFilteredUids();
    if (!filtered.length) { checkAll.checked = false; checkAll.indeterminate = false; return; }
    var allSelected = filtered.every(function (uid) { return selectedUids.has(uid); });
    var someSelected = filtered.some(function (uid) { return selectedUids.has(uid); });
    checkAll.checked = allSelected;
    checkAll.indeterminate = someSelected && !allSelected;
  }

  function renderBulkBar() {
    var bar = $('adminBulkBar');
    var count = $('adminBulkCount');
    var delBtn = $('adminBulkDelete');
    if (!bar) return;
    var n = selectedUids.size;
    if (n > 0) {
      bar.classList.add('show');
      if (count) count.textContent = n + (n === 1 ? ' usuario seleccionado' : ' usuarios seleccionados');
      if (delBtn) delBtn.textContent = 'Eliminar seleccionados (' + n + ')';
    } else {
      bar.classList.remove('show');
      if (delBtn) delBtn.textContent = 'Eliminar seleccionados';
    }
  }

  function pruneSelection() {
    var valid = new Set();
    usuariosCache.forEach(function (u) { valid.add(u.uid); });
    var before = selectedUids.size;
    selectedUids.forEach(function (uid) { if (!valid.has(uid)) selectedUids.delete(uid); });
    if (selectedUids.size !== before) renderBulkBar();
  }

  function clearSelection() {
    selectedUids.clear();
    renderBulkBar();
    var checkAll = $('adminCheckAll');
    if (checkAll) { checkAll.checked = false; checkAll.indeterminate = false; }
  }

  function toggleSelectAll() {
    var checkAll = $('adminCheckAll');
    if (!checkAll) return;
    var filtered = currentFilteredUids();
    var shouldSelect = !(filtered.length && filtered.every(function (uid) { return selectedUids.has(uid); }));
    if (shouldSelect) {
      filtered.forEach(function (uid) { selectedUids.add(uid); });
      checkAll.checked = true; checkAll.indeterminate = false;
    } else {
      filtered.forEach(function (uid) { selectedUids.delete(uid); });
      checkAll.checked = false; checkAll.indeterminate = false;
    }
    renderTable();
  }

  /* ─── BULK DELETE ─────────────────────────────────────────── */
  // La eliminación de raíz de cuentas requiere una Cloud Function de Firebase
  // (el SDK web no puede borrar la cuenta de Auth de otro usuario). El proyecto
  // opera en el plan Spark, sin Cloud Functions, así que la función no está
  // disponible: se informa al superadmin en lugar de dejar un fallo en red.
  var MSG_SIN_FUNCION = 'La eliminación de usuarios no está disponible: requiere Cloud Functions (plan Blaze), no habilitado en este proyecto.';

  function bulkDeleteUsers() {
    V.toast(MSG_SIN_FUNCION, true);
  }

  /* ─── FIELD UPDATE ────────────────────────────────────────── */
  function updateField(uid, field, value) {
    if (!V.db) return;
    if (uid === V.userId) { V.toast('No puedes cambiar tu propio ' + field + '.', true); renderAll(); return; }
    var update = {};
    update[field] = value;
    V.db.collection(V.COL_USUARIOS).doc(uid).update(update)
      .then(function () { V.toast(field.charAt(0).toUpperCase() + field.slice(1) + ' actualizado ✓'); })
      .catch(function (e) { V.toast('Error: ' + e.message, true); renderAll(); });
  }

  /* ─── DELETE USER ─────────────────────────────────────────── */
  function deleteUser(uid, email) {
    if (!confirm('¿Eliminar al usuario "' + (email || uid) + '"? Esta acción no se puede deshacer.')) return;
    if (uid === V.userId) { V.toast('No puedes eliminar tu propia cuenta.', true); return; }
    V.toast(MSG_SIN_FUNCION, true);
  }

  /* ─── VIEW USER (ficha de solo lectura) ───────────────────── */
  function rolLabel(r) {
    if (r === 'gestor') return 'Gestor';
    if (r === 'superadmin') return 'Superadmin';
    return 'Estudiante';
  }

  function viewBlock(icon, chipClass, title, rows, colorCls) {
    var block = el('div', 'form-block crm-view-block' + (colorCls ? ' ' + colorCls : ''));
    var head = el('div', 'form-block-head');
    head.appendChild(el('span', 'icon-chip sm' + (chipClass ? ' ' + chipClass : ''), icon));
    head.appendChild(el('h4', null, title));
    block.appendChild(head);
    rows.forEach(function (r) {
      var row = el('div', 'crm-view-row');
      row.appendChild(el('span', 'crm-view-label', r[0]));
      row.appendChild(el('span', 'crm-view-value', r[1] || '—'));
      block.appendChild(row);
    });
    return block;
  }

  function openView(user) {
    editingUser = user;
    var nombre = ((user.nombre || '') + ' ' + (user.apellido || '')).trim() || 'Usuario';
    $('crmViewTitle').textContent = nombre;
    $('crmViewSub').textContent = user.email || '';
    $('crmViewRol').textContent = 'Rol: ' + rolLabel(user.rol || 'estudiante');
    $('crmViewEstado').textContent = 'Estado: ' + (user.estado || 'Activo');

    var body = $('crmViewBody');
    body.innerHTML = '';

    var subDate = user.fechaSuscripcion || user.createdAt || user.creado;
    var sexo = user.sexo === 'Otro' ? (user.sexoCustom || 'Otro') : user.sexo;
    body.appendChild(viewBlock('👤', 'gold', 'Datos Personales', [
      ['Nombre completo', nombre],
      ['Correo electrónico', user.email],
      ['Documento de identidad', user.documento],
      ['Teléfono de contacto', user.telefono],
      ['Sexo', sexo],
      ['Rango de edad', user.rangoEdad],
      ['Estado civil', user.estadoCivil],
      ['Fecha de suscripción', subDate ? V.fmtDate(subDate) : '']
    ], 'prof-blue'));

    body.appendChild(viewBlock('📍', 'blue', 'Ubicación', [
      ['Departamento', user.departamento],
      ['Ciudad', user.ciudad],
      ['Barrio', user.barrio]
    ], 'prof-purple'));

    body.appendChild(viewBlock('📝', 'gold', 'Notas', [
      ['Notas o detalles adicionales', user.notas]
    ], 'prof-orange'));

    body.appendChild(viewBlock('🛡️', 'blue', 'Rol y Configuración', [
      ['Rol en la plataforma', rolLabel(user.rol || 'estudiante')],
      ['Estado de cuenta', user.estado || 'Activo'],
      ['Perfil organizacional', user.perfil],
      ['Profesión', user.profesion],
      ['Oficio', user.oficio]
    ], 'prof-magenta'));

    // Red de Referidos (MLM): se rellena el sponsor de forma asíncrona.
    var mlmBlock = viewBlock('🌐', 'gold', 'Red de Referidos (MLM)', [
      ['Código de referido', user.referralCode],
      ['Patrocinador asignado', user.sponsorId || '—']
    ], 'prof-green');
    body.appendChild(mlmBlock);
    var vals = mlmBlock.querySelectorAll('.crm-view-value');
    if (vals.length > 1) {
      if (user.sponsorId) {
        V.mlm.datosPatrocinador(user.sponsorId).then(function (sp) {
          if (!vals[1].isConnected) return;
          vals[1].textContent = (sp && (sp.nombre || sp.email))
            ? (sp.nombre || sp.email) + ' · ' + user.sponsorId
            : user.sponsorId;
        }).catch(function () {});
      } else {
        vals[1].textContent = '—';
      }
    }

    // Árbol multinivel (Nivel 1 a 5) del perfil consultado. Solo el
    // administrador general (isAdmin) tiene visibilidad sobre el árbol
    // genealógico de cualquier perfil, gracias a las reglas de Firestore.
    if (V.userRole === 'superadmin' && user.uid) {
      var crmRedWrap = el('div', 'crm-mlm-red');
      crmRedWrap.setAttribute('data-root', user.uid);
      mlmBlock.appendChild(crmRedWrap);
      cargarRedMlm(crmRedWrap, user.uid);
    }

    $('crmViewOverlay').classList.add('show');
  }

  /* ─── RED DE REFERIDOS (MLM): ÁRBOL MULTINIVEL ADMIN ────── */
  // Reutiliza el motor V.mlm.redArbol() con el UID del perfil consultado
  // como raíz: el administrador general ve la red descendente de hasta 5
  // generaciones de CUALQUIER usuario. Misma estructura de acordeones por
  // niveles que el Escritorio (clases dash-mlm-*): solo lectura, sin
  // acciones de edición sobre perfiles.
  function cargarRedMlm(container, uid) {
    container.innerHTML = '';
    if (!uid || !V.mlm || typeof V.mlm.redArbol !== 'function') {
      container.appendChild(el('p', 'crm-mlm-empty', 'No se pudo consultar la red en este momento.'));
      return;
    }
    container.appendChild(el('p', 'dash-mlm-loading', 'Consultando la red de referidos…'));
    V.mlm.redArbol(uid, 5)
      .then(function (niveles) { renderRedMlmNiveles(niveles, container); })
      .catch(function () {
        container.innerHTML = '';
        container.appendChild(el('p', 'crm-mlm-empty', 'No se pudo consultar la red en este momento.'));
      });
  }

  function renderRedMlmNiveles(niveles, container) {
    var total = 0;
    niveles.forEach(function (n) { total += n.miembros.length; });
    container.innerHTML = '';

    var head = el('div', 'crm-mlm-red-head');
    head.appendChild(el('span', 'crm-mlm-red-total', '🧬 ' + total + ' integrantes en la red de este perfil'));
    container.appendChild(head);

    if (!total) {
      container.appendChild(el('p', 'crm-mlm-empty', 'Este perfil aún no tiene referidos en su red.'));
      return;
    }

    niveles.forEach(function (n) {
      var det = document.createElement('details');
      det.className = 'dash-mlm-arbol-nivel dash-mlm-arbol-nivel-' + n.nivel;
      if (n.nivel === 1) det.open = true;

      var sum = document.createElement('summary');
      var label = n.denegado ? 'Nivel ' + n.nivel + ' (no disponible)' : 'Nivel ' + n.nivel;
      sum.appendChild(el('span', 'dash-mlm-arbol-nivel-titulo', label));
      var nCount = el('span', 'dash-mlm-red-count', String(n.miembros.length));
      sum.appendChild(nCount);
      det.appendChild(sum);

      var body = el('div', 'dash-mlm-arbol-nivel-body');
      if (n.denegado) {
        body.appendChild(el('p', 'crm-mlm-empty', 'No se pudieron cargar los niveles más profundos de esta red.'));
      } else if (!n.miembros.length) {
        body.appendChild(el('p', 'crm-mlm-empty', 'Sin referidos en este nivel.'));
      } else {
        n.miembros.forEach(function (m) { body.appendChild(crmRedTarjeta(m)); });
      }
      det.appendChild(body);
      container.appendChild(det);
    });

    var actions = el('div', 'dash-mlm-red-actions');
    var btnRefresh = el('button', 'btn btn-outline btn-sm', '↻ Actualizar red');
    btnRefresh.type = 'button';
    btnRefresh.addEventListener('click', function () {
      cargarRedMlm(container, container.getAttribute('data-root') || '');
    });
    actions.appendChild(btnRefresh);
    container.appendChild(actions);
  }

  // Fila de miembro con el mismo diseño responsivo del Escritorio
  // (dash-mlm-red-*): Nombre, Correo, Estado, Registro y "Ver detalle".
  // En CRM, "Ver" abre el perfil completo del integrante en el modal.
  function crmRedTarjeta(m) {
    var row = el('div', 'dash-mlm-red-row');
    row.appendChild(crmRedCelda('Nombre', crmRedNombreCompleto(m), 'dash-mlm-red-nombre'));
    row.appendChild(crmRedCelda('Correo', m.email || '—', 'dash-mlm-red-correo'));
    row.appendChild(crmRedCeldaEstado('Estado', m.estado || 'Activo'));
    row.appendChild(crmRedCelda('Registro', V.fmtDate(m.creado) || '—', 'dash-mlm-red-fecha'));

    var det = el('div', 'dash-mlm-red-detalle');
    det.setAttribute('data-label', 'Detalle');
    var btn = el('button', 'btn btn-outline btn-sm', 'Ver');
    btn.type = 'button';
    btn.addEventListener('click', function () { abrirPerfilDesdeRed(m); });
    det.appendChild(btn);
    row.appendChild(det);
    return row;
  }

  function crmRedCelda(label, value, extraCls) {
    var cell = el('span', 'dash-mlm-red-cell' + (extraCls ? ' ' + extraCls : ''), value);
    cell.setAttribute('data-label', label);
    return cell;
  }

  function crmRedCeldaEstado(label, value) {
    var cell = el('span', 'dash-mlm-red-cell', '');
    var key = String(value || 'activo').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    var pill = el('span', 'red-estado-pill red-estado-' + key, value || 'Activo');
    cell.appendChild(pill);
    cell.setAttribute('data-label', label);
    return cell;
  }

  function crmRedNombreCompleto(m) {
    return (((m.nombre || '') + ' ' + (m.apellido || '')).trim()) || (m.email || 'Usuario');
  }

  // Abre el perfil completo de un integrante de la red en el mismo modal
  // de detalles del CRM (carga su documento en Firestore para mostrarlo
  // actualizado y permitir el seguimiento de toda su red descendente).
  function abrirPerfilDesdeRed(m) {
    if (!V.db || !m || !m.uid) return;
    V.db.collection(V.COL_USUARIOS).doc(m.uid).get().then(function (doc) {
      if (!doc.exists) { V.toast('El perfil ya no existe.', true); return; }
      var data = doc.data();
      data.uid = doc.id;
      openView(data);
    }).catch(function () {
      V.toast('No se pudo abrir el perfil.', true);
    });
  }

  function closeView() {
    $('crmViewOverlay').classList.remove('show');
  }

  /* ─── EXTENDED FORM ───────────────────────────────────────── */
  function openForm(user) {
    editingUser = user;
    var overlay = $('crmFormOverlay');
    overlay.classList.add('show');

    var gef = function (v) { return v || ''; };
    $('crmFormSub').textContent = user.email || '';
    $('crmEmail').value = user.email || '';
    $('crmNombre').value = user.nombre || '';
    $('crmApellido').value = user.apellido || '';
    $('crmDocumento').value = user.documento || '';
    $('crmTelefono').value = user.telefono || '';
    $('crmSexo').value = user.sexo || '';
    var otWrap = $('crmSexoOtroWrap');
    if (otWrap) otWrap.style.display = user.sexo === 'Otro' ? '' : 'none';
    $('crmSexoOtro').value = user.sexo === 'Otro' ? gef(user.sexoCustom) : '';
    $('crmRangoEdad').value = user.rangoEdad || '';
    $('crmEstadoCivil').value = user.estadoCivil || '';
    var subDate = user.fechaSuscripcion || user.createdAt || user.creado;
    $('crmFechaSuscripcion').value = subDate ? V.fmtDate(subDate) : '—';
    $('crmNotas').value = user.notas || '';
    $('crmBanco').value = user.banco || '';
    $('crmNumeroCuenta').value = user.numeroCuenta || '';
    $('crmRegistradoPortal').checked = !!user.registradoPortal;
    $('crmRol').value = user.rol || 'estudiante';
    $('crmEstado').value = user.estado || 'Activo';

    // Perfil: carga en directo desde config/perfiles cada vez que se abre el modal.
    populatePerfilSelect(user.perfil);
    loadPerfilesFromDb().then(function () {
      populatePerfilSelect(user.perfil);
    });

    // Profesión: carga en directo desde config/profesiones.
    populateProfesionSelect(user.profesion);
    loadProfesionesFromDb().then(function () {
      populateProfesionSelect(user.profesion);
    });

    // Oficio: carga en directo desde config/oficios.
    populateOficioSelect(user.oficio);
    loadOficiosFromDb().then(function () {
      populateOficioSelect(user.oficio);
    });

    // Ubicación: carga en directo desde config/ubicacion (Departamento → Ciudad → Barrio).
    populateDeptoSelect(user.departamento);
    populateCiudadSelect(user.ciudad);
    populateBarrioSelect(user.barrio);
    loadUbicacion().then(function () {
      populateDeptoSelect(user.departamento);
      populateCiudadSelect(user.ciudad);
      populateBarrioSelect(user.barrio);
    });

    // Red de Referidos (MLM): solo los administradores pueden ver/editarla.
    var mlmBlock = $('crmMlmBlock');
    if (mlmBlock) mlmBlock.style.display = V.userRole === 'superadmin' ? '' : 'none';
    cargarSponsorActual(user);
  }

  // Muestra el patrocinador actual en el campo del formulario de edición.
  function cargarSponsorActual(user) {
    var info = $('crmSponsorInfo');
    var input = $('crmSponsor');
    if (!info || !input) return;
    input.value = '';
    var sid = user && user.sponsorId;
    if (!sid) { info.textContent = 'Sin patrocinador asignado.'; return; }
    V.db.collection(V.COL_USUARIOS).doc(sid).get().then(function (doc) {
      if (!doc.exists) {
        info.textContent = 'Patrocinador actual (ID): ' + sid;
        input.value = sid;
        return;
      }
      var d = doc.data();
      var nombre = ((d.nombre || '') + ' ' + (d.apellido || '')).trim();
      var code = d.referralCode || '';
      input.value = code || sid;
      info.textContent = nombre
        ? 'Patrocinador actual: ' + nombre + (code ? ' · ' + code : '')
        : 'Patrocinador actual: ' + (code || sid);
    }).catch(function () {
      info.textContent = 'Patrocinador actual (ID): ' + sid;
      input.value = sid;
    });
  }

  function populatePerfilSelect(selected) {
    var selPerfil = $('crmPerfil');
    if (!selPerfil) return;
    selPerfil.innerHTML = '<option value="">—</option>';
    if (!perfilesCache.length) {
      var hint = document.createElement('option');
      hint.value = ''; hint.disabled = true;
      hint.textContent = '(Sin perfiles configurados)';
      selPerfil.appendChild(hint);
    }
    perfilesCache.forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p; opt.textContent = p;
      opt.selected = String(selected || '') === p;
      selPerfil.appendChild(opt);
    });
  }

  function populateProfesionSelect(selected) {
    var sel = $('crmProfesion');
    if (!sel) return;
    sel.innerHTML = '<option value="">—</option>';
    if (!profesionesCache.length) {
      var hint = document.createElement('option');
      hint.value = ''; hint.disabled = true;
      hint.textContent = '(Sin profesiones configuradas)';
      sel.appendChild(hint);
    }
    profesionesCache.forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p; opt.textContent = p;
      opt.selected = String(selected || '') === p;
      sel.appendChild(opt);
    });
    var optOtro = document.createElement('option');
    optOtro.value = '__otro__'; optOtro.textContent = 'Otros...';
    sel.appendChild(optOtro);
    if (selected && profesionesCache.indexOf(selected) === -1 && selected !== '') {
      optOtro.selected = true;
    }
  }

  function handleProfesionOtro() {
    var sel = $('crmProfesion');
    if (!sel) return;
    if (sel.value !== '__otro__') return;
    var custom = prompt('Escribe la profesión:');
    if (custom === null || !custom.trim()) {
      populateProfesionSelect(editingUser ? editingUser.profesion : '');
      return;
    }
    var val = custom.trim();
    addProfesionToList(val);
    populateProfesionSelect(val);
    V.toast('Profesión "' + val + '" añadida ✓');
  }

  function populateOficioSelect(selected) {
    var sel = $('crmOficio');
    if (!sel) return;
    sel.innerHTML = '<option value="">—</option>';
    if (!oficiosCache.length) {
      var hint = document.createElement('option');
      hint.value = ''; hint.disabled = true;
      hint.textContent = '(Sin oficios configurados)';
      sel.appendChild(hint);
    }
    oficiosCache.forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o; opt.textContent = o;
      opt.selected = String(selected || '') === o;
      sel.appendChild(opt);
    });
    var optOtro = document.createElement('option');
    optOtro.value = '__otro__'; optOtro.textContent = 'Otros...';
    sel.appendChild(optOtro);
    if (selected && oficiosCache.indexOf(selected) === -1 && selected !== '') {
      optOtro.selected = true;
    }
  }

  function handleOficioOtro() {
    var sel = $('crmOficio');
    if (!sel) return;
    if (sel.value !== '__otro__') return;
    var custom = prompt('Escribe el oficio:');
    if (custom === null || !custom.trim()) {
      populateOficioSelect(editingUser ? editingUser.oficio : '');
      return;
    }
    var val = custom.trim();
    addOficioToList(val);
    populateOficioSelect(val);
    V.toast('Oficio "' + val + '" añadido ✓');
  }

  function loadPerfilesFromDb() {
    if (!V.db) { return Promise.resolve(perfilesCache); }
    return V.db.collection(CONFIG_COLLECTION).doc(PROFILES_DOC).get()
      .then(function (doc) {
        var raw = doc.exists ? (doc.data().categorias || doc.data().perfiles || []) : [];
        return applyPerfiles(normalizePerfiles(raw));
      })
      .catch(function () {
        return applyPerfiles([]);
      });
  }

  function closeForm() {
    $('crmFormOverlay').classList.remove('show');
    editingUser = null;
  }

  function populateDeptoSelect(selected) {
    var sel = $('crmDepartamento');
    if (!sel) return;
    sel.innerHTML = '<option value="">—</option>';
    ubicacionData.departamentos.forEach(function (d) {
      var opt = document.createElement('option');
      opt.value = d; opt.textContent = d;
      opt.selected = String(selected || '') === d;
      sel.appendChild(opt);
    });
  }

  function populateCiudadSelect(selected) {
    var sel = $('crmCiudad');
    if (!sel) return;
    var depto = $('crmDepartamento').value;
    sel.innerHTML = '<option value="">—</option>';
    var cities = ubicacionData.ciudades[depto] || [];
    cities.forEach(function (c) {
      var opt = document.createElement('option');
      opt.value = c; opt.textContent = c;
      opt.selected = String(selected || '') === c;
      sel.appendChild(opt);
    });
  }

  function populateBarrioSelect(selected) {
    var sel = $('crmBarrio');
    if (!sel) return;
    var ciudad = $('crmCiudad').value;
    sel.innerHTML = '<option value="">—</option>';
    var barrios = ubicacionData.barrios[ciudad] || [];
    barrios.forEach(function (b) {
      var opt = document.createElement('option');
      opt.value = b; opt.textContent = b;
      opt.selected = String(selected || '') === b;
      sel.appendChild(opt);
    });
    var optOtro = document.createElement('option');
    optOtro.value = '__otro__'; optOtro.textContent = 'Otros...';
    sel.appendChild(optOtro);
    if (selected && barrios.indexOf(selected) === -1 && selected !== '') {
      optOtro.selected = true;
    }
  }

  function handleBarrioOtro() {
    var sel = $('crmBarrio');
    if (!sel || sel.value !== '__otro__') return;
    var ciudad = $('crmCiudad').value;
    if (!ciudad) {
      V.toast('Selecciona una ciudad primero.', true);
      populateBarrioSelect('');
      return;
    }
    var custom = prompt('Escribe el barrio:');
    if (custom === null || !custom.trim()) {
      populateBarrioSelect(editingUser ? editingUser.barrio : '');
      return;
    }
    var val = custom.trim();
    addBarrioToList(ciudad, val);
    populateBarrioSelect(val);
    V.toast('Barrio "' + val + '" añadido ✓');
  }

  function saveForm() {
    if (!editingUser || !V.db) return;
    var profesionVal = $('crmProfesion').value;
    if (profesionVal === '__otro__') {
      var custom = prompt('Escribe la profesión:');
      if (custom && custom.trim()) {
        profesionVal = custom.trim();
        addProfesionToList(profesionVal);
      } else {
        profesionVal = '';
      }
    }
    var oficioVal = $('crmOficio').value;
    if (oficioVal === '__otro__') {
      var customOficio = prompt('Escribe el oficio:');
      if (customOficio && customOficio.trim()) {
        oficioVal = customOficio.trim();
        addOficioToList(oficioVal);
      } else {
        oficioVal = '';
      }
    }
    // Barrio: si quedó en "__otro__", pedir el valor y añadirlo a config.
    var barrioVal = $('crmBarrio').value;
    if (barrioVal === '__otro__') {
      var customBarrio = prompt('Escribe el barrio:');
      var ciudadSel = $('crmCiudad').value;
      if (customBarrio && customBarrio.trim() && ciudadSel) {
        barrioVal = customBarrio.trim();
        addBarrioToList(ciudadSel, barrioVal);
      } else {
        barrioVal = '';
      }
    }
    var sexoVal = $('crmSexo').value;
    var data = {
      apellido: $('crmApellido').value.trim(),
      documento: $('crmDocumento').value.trim(),
      telefono: $('crmTelefono').value.trim(),
      sexo: sexoVal,
      sexoCustom: sexoVal === 'Otro' ? $('crmSexoOtro').value.trim() : '',
      rangoEdad: $('crmRangoEdad').value,
      estadoCivil: $('crmEstadoCivil').value,
      departamento: $('crmDepartamento').value,
      ciudad: $('crmCiudad').value,
      barrio: barrioVal,
      rol: $('crmRol').value,
      estado: $('crmEstado').value,
      perfil: $('crmPerfil').value,
      profesion: profesionVal,
      oficio: oficioVal,
      nombre: $('crmNombre').value.trim(),
      notas: $('crmNotas').value.trim(),
      banco: $('crmBanco').value,
      numeroCuenta: $('crmNumeroCuenta').value.trim(),
      registradoPortal: !!$('crmRegistradoPortal').checked
    };

    if (!editingUser.fechaSuscripcion && !editingUser.createdAt) {
      data.fechaSuscripcion = new Date().toISOString();
    }

    if (editingUser.uid === V.userId && data.rol !== V.userRole) {
      // BYPASS de superadmin: puede cambiar su propio rol (control absoluto)
      // con confirmación para evitar un cierre accidental de su acceso.
      if (V.userRole === 'superadmin') {
        if (!confirm('⚠️ Estás a punto de cambiar TU PROPIO rol a "' + data.rol + '".\n¿Continuar?')) return;
      } else {
        V.toast('No puedes cambiar tu propio rol.', true);
        return;
      }
    }

    var btn = $('crmFormSave');
    btn.disabled = true;
    var original = btn.textContent;
    btn.textContent = '⏳ Guardando…';

    resolverNuevoSponsor().then(function (patrocinio) {
      if (patrocinio && patrocinio.error) {
        V.toast(patrocinio.error, true);
        return;
      }
      if (patrocinio && patrocinio.aplicar) data.sponsorId = patrocinio.sponsorId;
      return V.db.collection(V.COL_USUARIOS).doc(editingUser.uid).update(data)
        .then(function () { V.toast('Perfil actualizado ✓'); closeForm(); })
        .catch(function (e) { V.toast('Error: ' + e.message, true); });
    }).then(function () {
      btn.disabled = false;
      btn.textContent = original;
    });
  }

  // Valida el patrocinador ingresado por el admin antes de guardar el
  // sponsorId. Devuelve { aplicar:false } (sin cambio), { aplicar:true,
  // sponsorId } o { error }.
  function resolverNuevoSponsor() {
    var input = $('crmSponsor');
    var raw = input ? input.value.trim() : '';
    if (V.userRole !== 'superadmin') return Promise.resolve({ aplicar: false });
    if (!raw) return Promise.resolve({ aplicar: false });
    if (!V.mlm || !V.mlm.validarPatrocinador) {
      return Promise.resolve({ error: 'El módulo MLM no está disponible.' });
    }
    return V.mlm.validarPatrocinador(raw).then(function (uid) {
      if (!uid) {
        return { error: 'El código o ID de patrocinador ingresado no existe en la base de datos.' };
      }
      if (String(uid) === String(editingUser.sponsorId || '')) {
        return { aplicar: false };
      }
      // BYPASS de superadmin: control absoluto. Se omiten las validaciones
      // de parentesco (no auto-patrocinio) y de ciclos en la cadena; el
      // superadmin puede asignar el patrocinador que decida.
      if (V.userRole === 'superadmin') {
        return { aplicar: true, sponsorId: uid };
      }
      if (uid === editingUser.uid) {
        return { error: 'Un usuario no puede ser su propio patrocinador.' };
      }
      return V.mlm.esCicloPotencial(uid, editingUser.uid).then(function (ciclo) {
        if (ciclo) return { error: 'Ese patrocinador crearía un ciclo en la red.' };
        return { aplicar: true, sponsorId: uid };
      });
    }).catch(function () {
      return { error: 'No se pudo validar el patrocinador. Inténtalo de nuevo.' };
    });
  }

  /* ─── PROFILE MANAGEMENT ──────────────────────────────────── */
  function renderProfiles() {
    var list = $('adminProfilesList');
    if (!list) return;
    list.innerHTML = '';
    perfilesCache.forEach(function (p, i) {
      if (editingProfileIndex === i) {
        list.appendChild(renderProfileEditor(i, p));
        return;
      }
      var tag = el('span', 'profile-tag');
      tag.appendChild(document.createTextNode(p));
      var edit = el('button', 'profile-tag-edit', '✏');
      edit.title = 'Renombrar perfil';
      edit.addEventListener('click', function () { editingProfileIndex = i; renderProfiles(); });
      var del = el('button', 'profile-tag-delete', '✕');
      del.title = 'Eliminar perfil';
      del.addEventListener('click', function () { removeProfile(i); });
      tag.appendChild(edit);
      tag.appendChild(del);
      list.appendChild(tag);
    });
    populateFilterProfiles();
  }

  function renderProfileEditor(index, oldName) {
    var tag = el('span', 'profile-tag editing');
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'profile-tag-input';
    inp.value = oldName;
    inp.maxLength = 60;
    tag.appendChild(inp);

    var save = el('button', 'profile-tag-save', '✓');
    save.title = 'Guardar';
    save.addEventListener('click', function () { commitProfileRename(index, inp.value); });
    var cancel = el('button', 'profile-tag-delete', '✕');
    cancel.title = 'Cancelar';
    cancel.addEventListener('click', function () { editingProfileIndex = null; renderProfiles(); });
    tag.appendChild(save);
    tag.appendChild(cancel);

    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commitProfileRename(index, inp.value); }
      if (e.key === 'Escape') { editingProfileIndex = null; renderProfiles(); }
    });
    setTimeout(function () { inp.focus(); inp.select(); }, 0);
    return tag;
  }

  function commitProfileRename(index, rawValue) {
    var val = (rawValue || '').trim();
    var oldName = perfilesCache[index];
    if (!val || val === oldName) { editingProfileIndex = null; renderProfiles(); return; }
    if (perfilesCache.indexOf(val) !== -1) { V.toast('Ese perfil ya existe.', true); return; }
    perfilesCache[index] = val;
    savePerfiles();
    // Mantiene el nuevo nombre en los usuarios que tenían el anterior.
    if (oldName && V.db) {
      V.db.collection(V.COL_USUARIOS).where('perfil', '==', oldName).get()
        .then(function (snap) {
          var updates = [];
          snap.forEach(function (doc) { updates.push(doc.ref.update({ perfil: val })); });
          return Promise.all(updates);
        })
        .catch(function () {});
    }
    editingProfileIndex = null;
    V.toast('Perfil renombrado ✓');
    renderProfiles();
  }

  function addProfile() {
    var input = $('adminProfileInput');
    var val = input.value.trim();
    if (!val) return;
    if (perfilesCache.indexOf(val) !== -1) { V.toast('Ese perfil ya existe.', true); return; }
    perfilesCache.push(val);
    savePerfiles();
    input.value = '';
    renderProfiles();
    V.toast('Perfil "' + val + '" añadido ✓');
  }

  function removeProfile(index) {
    var name = perfilesCache[index];
    if (!confirm('¿Eliminar el perfil "' + name + '"? Los usuarios con este perfil quedarán sin perfil asignado.')) return;
    perfilesCache.splice(index, 1);
    savePerfiles();
    if (name && V.db) {
      V.db.collection(V.COL_USUARIOS).where('perfil', '==', name).get()
        .then(function (snap) {
          var updates = [];
          snap.forEach(function (doc) { updates.push(doc.ref.update({ perfil: '' })); });
          return Promise.all(updates);
        })
        .catch(function () {});
    }
    renderProfiles();
    V.toast('Perfil eliminado ✓');
  }

  /* ─── PROFESION MANAGEMENT ────────────────────────────────── */
  function renderProfesiones() {
    var list = $('adminProfesionesList');
    if (!list) return;
    list.innerHTML = '';
    profesionesCache.forEach(function (p, i) {
      if (editingProfesionIndex === i) {
        list.appendChild(renderProfesionEditor(i, p));
        return;
      }
      var tag = el('span', 'profile-tag');
      tag.appendChild(document.createTextNode(p));
      var edit = el('button', 'profile-tag-edit', '✏');
      edit.title = 'Renombrar profesión';
      edit.addEventListener('click', function () { editingProfesionIndex = i; renderProfesiones(); });
      var del = el('button', 'profile-tag-delete', '✕');
      del.title = 'Eliminar profesión';
      del.addEventListener('click', function () { removeProfesion(i); });
      tag.appendChild(edit);
      tag.appendChild(del);
      list.appendChild(tag);
    });
    populateFilterProfesiones();
  }

  function renderProfesionEditor(index, oldName) {
    var tag = el('span', 'profile-tag editing');
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'profile-tag-input';
    inp.value = oldName;
    inp.maxLength = 60;
    tag.appendChild(inp);

    var save = el('button', 'profile-tag-save', '✓');
    save.title = 'Guardar';
    save.addEventListener('click', function () { commitProfesionRename(index, inp.value); });
    var cancel = el('button', 'profile-tag-delete', '✕');
    cancel.title = 'Cancelar';
    cancel.addEventListener('click', function () { editingProfesionIndex = null; renderProfesiones(); });
    tag.appendChild(save);
    tag.appendChild(cancel);

    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commitProfesionRename(index, inp.value); }
      if (e.key === 'Escape') { editingProfesionIndex = null; renderProfesiones(); }
    });
    setTimeout(function () { inp.focus(); inp.select(); }, 0);
    return tag;
  }

  function commitProfesionRename(index, rawValue) {
    var val = (rawValue || '').trim();
    var oldName = profesionesCache[index];
    if (!val || val === oldName) { editingProfesionIndex = null; renderProfesiones(); return; }
    if (profesionesCache.indexOf(val) !== -1) { V.toast('Esa profesión ya existe.', true); return; }
    profesionesCache[index] = val;
    saveProfesiones();
    if (oldName && V.db) {
      V.db.collection(V.COL_USUARIOS).where('profesion', '==', oldName).get()
        .then(function (snap) {
          var updates = [];
          snap.forEach(function (doc) { updates.push(doc.ref.update({ profesion: val })); });
          return Promise.all(updates);
        })
        .catch(function () {});
    }
    editingProfesionIndex = null;
    V.toast('Profesión renombrada ✓');
    renderProfesiones();
  }

  function addProfesion() {
    var input = $('adminProfesionInput');
    var val = input.value.trim();
    if (!val) return;
    if (profesionesCache.indexOf(val) !== -1) { V.toast('Esa profesión ya existe.', true); return; }
    profesionesCache.push(val);
    saveProfesiones();
    input.value = '';
    renderProfesiones();
    V.toast('Profesión "' + val + '" añadida ✓');
  }

  function removeProfesion(index) {
    var name = profesionesCache[index];
    if (!confirm('¿Eliminar la profesión "' + name + '"? Los usuarios con esta profesión quedarán sin profesión asignada.')) return;
    profesionesCache.splice(index, 1);
    saveProfesiones();
    if (name && V.db) {
      V.db.collection(V.COL_USUARIOS).where('profesion', '==', name).get()
        .then(function (snap) {
          var updates = [];
          snap.forEach(function (doc) { updates.push(doc.ref.update({ profesion: '' })); });
          return Promise.all(updates);
        })
        .catch(function () {});
    }
    renderProfesiones();
    V.toast('Profesión eliminada ✓');
  }

  /* ─── OFICIO MANAGEMENT ───────────────────────────────────── */
  function renderOficios() {
    var list = $('adminOficiosList');
    if (!list) return;
    list.innerHTML = '';
    oficiosCache.forEach(function (o, i) {
      if (editingOficioIndex === i) {
        list.appendChild(renderOficioEditor(i, o));
        return;
      }
      var tag = el('span', 'profile-tag');
      tag.appendChild(document.createTextNode(o));
      var edit = el('button', 'profile-tag-edit', '✏');
      edit.title = 'Renombrar oficio';
      edit.addEventListener('click', function () { editingOficioIndex = i; renderOficios(); });
      var del = el('button', 'profile-tag-delete', '✕');
      del.title = 'Eliminar oficio';
      del.addEventListener('click', function () { removeOficio(i); });
      tag.appendChild(edit);
      tag.appendChild(del);
      list.appendChild(tag);
    });
    populateFilterOficios();
  }

  function renderOficioEditor(index, oldName) {
    var tag = el('span', 'profile-tag editing');
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'profile-tag-input';
    inp.value = oldName;
    inp.maxLength = 60;
    tag.appendChild(inp);

    var save = el('button', 'profile-tag-save', '✓');
    save.title = 'Guardar';
    save.addEventListener('click', function () { commitOficioRename(index, inp.value); });
    var cancel = el('button', 'profile-tag-delete', '✕');
    cancel.title = 'Cancelar';
    cancel.addEventListener('click', function () { editingOficioIndex = null; renderOficios(); });
    tag.appendChild(save);
    tag.appendChild(cancel);

    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commitOficioRename(index, inp.value); }
      if (e.key === 'Escape') { editingOficioIndex = null; renderOficios(); }
    });
    setTimeout(function () { inp.focus(); inp.select(); }, 0);
    return tag;
  }

  function commitOficioRename(index, rawValue) {
    var val = (rawValue || '').trim();
    var oldName = oficiosCache[index];
    if (!val || val === oldName) { editingOficioIndex = null; renderOficios(); return; }
    if (oficiosCache.indexOf(val) !== -1) { V.toast('Ese oficio ya existe.', true); return; }
    oficiosCache[index] = val;
    saveOficios();
    if (oldName && V.db) {
      V.db.collection(V.COL_USUARIOS).where('oficio', '==', oldName).get()
        .then(function (snap) {
          var updates = [];
          snap.forEach(function (doc) { updates.push(doc.ref.update({ oficio: val })); });
          return Promise.all(updates);
        })
        .catch(function () {});
    }
    editingOficioIndex = null;
    V.toast('Oficio renombrado ✓');
    renderOficios();
  }

  function addOficio() {
    var input = $('adminOficioInput');
    var val = input.value.trim();
    if (!val) return;
    if (oficiosCache.indexOf(val) !== -1) { V.toast('Ese oficio ya existe.', true); return; }
    oficiosCache.push(val);
    saveOficios();
    input.value = '';
    renderOficios();
    V.toast('Oficio "' + val + '" añadido ✓');
  }

  function removeOficio(index) {
    var name = oficiosCache[index];
    if (!confirm('¿Eliminar el oficio "' + name + '"? Los usuarios con este oficio quedarán sin oficio asignado.')) return;
    oficiosCache.splice(index, 1);
    saveOficios();
    if (name && V.db) {
      V.db.collection(V.COL_USUARIOS).where('oficio', '==', name).get()
        .then(function (snap) {
          var updates = [];
          snap.forEach(function (doc) { updates.push(doc.ref.update({ oficio: '' })); });
          return Promise.all(updates);
        })
        .catch(function () {});
    }
    renderOficios();
    V.toast('Oficio eliminado ✓');
  }

  /* ─── UBICACION MANAGEMENT (Departamento → Ciudad → Barrio) ─ */
  function renderUbicacion() {
    populateUbicacionSelects();
    renderDeptos();
    renderCiudades();
    renderBarrios();
  }

  function populateUbicacionSelects() {
    var selDeptos = $('adminCiudadesDepto');
    if (selDeptos) {
      var prev = selDeptos.value;
      selDeptos.innerHTML = '<option value="">—</option>';
      ubicacionData.departamentos.forEach(function (d) {
        var opt = document.createElement('option');
        opt.value = d; opt.textContent = d;
        if (prev === d) opt.selected = true;
        selDeptos.appendChild(opt);
      });
      if (!prev) selDeptos.value = ubicacionData.departamentos[0] || '';
    }
    var selCiudades = $('adminBarriosCiudad');
    if (selCiudades) {
      var depto = selDeptos ? selDeptos.value : '';
      var prevC = selCiudades.value;
      selCiudades.innerHTML = '<option value="">—</option>';
      (ubicacionData.ciudades[depto] || []).forEach(function (c) {
        var opt = document.createElement('option');
        opt.value = c; opt.textContent = c;
        if (prevC === c) opt.selected = true;
        selCiudades.appendChild(opt);
      });
      if (!prevC) selCiudades.value = (ubicacionData.ciudades[depto] || [])[0] || '';
    }
  }

  function renderDeptos() {
    var list = $('adminDeptosList');
    if (!list) return;
    list.innerHTML = '';
    ubicacionData.departamentos.forEach(function (d, i) {
      if (editingDeptoIndex === i) {
        list.appendChild(renderDeptoEditor(i, d));
        return;
      }
      var tag = el('span', 'profile-tag');
      tag.appendChild(document.createTextNode(d));
      var edit = el('button', 'profile-tag-edit', '✏');
      edit.title = 'Renombrar departamento';
      edit.addEventListener('click', function () { editingDeptoIndex = i; renderUbicacion(); });
      var del = el('button', 'profile-tag-delete', '✕');
      del.title = 'Eliminar departamento';
      del.addEventListener('click', function () { removeDepto(i); });
      tag.appendChild(edit);
      tag.appendChild(del);
      list.appendChild(tag);
    });
  }

  function renderDeptoEditor(index, oldName) {
    var tag = el('span', 'profile-tag editing');
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'profile-tag-input';
    inp.value = oldName;
    inp.maxLength = 60;
    tag.appendChild(inp);

    var save = el('button', 'profile-tag-save', '✓');
    save.title = 'Guardar';
    save.addEventListener('click', function () { commitDeptoRename(index, inp.value); });
    var cancel = el('button', 'profile-tag-delete', '✕');
    cancel.title = 'Cancelar';
    cancel.addEventListener('click', function () { editingDeptoIndex = null; renderUbicacion(); });
    tag.appendChild(save);
    tag.appendChild(cancel);

    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commitDeptoRename(index, inp.value); }
      if (e.key === 'Escape') { editingDeptoIndex = null; renderUbicacion(); }
    });
    setTimeout(function () { inp.focus(); inp.select(); }, 0);
    return tag;
  }

  function commitDeptoRename(index, rawValue) {
    var val = (rawValue || '').trim();
    var oldName = ubicacionData.departamentos[index];
    if (!val || val === oldName) { editingDeptoIndex = null; renderUbicacion(); return; }
    if (ubicacionData.departamentos.indexOf(val) !== -1) { V.toast('Ese departamento ya existe.', true); return; }
    // Actualiza claves de ciudades del departamento.
    if (ubicacionData.ciudades[oldName]) {
      ubicacionData.ciudades[val] = ubicacionData.ciudades[oldName];
      delete ubicacionData.ciudades[oldName];
    }
    ubicacionData.departamentos[index] = val;
    saveUbicacion();
    updateUsersField('departamento', oldName, val);
    editingDeptoIndex = null;
    V.toast('Departamento renombrado ✓');
    renderUbicacion();
  }

  function addDepto() {
    var input = $('adminDeptoInput');
    var val = input.value.trim();
    if (!val) return;
    if (ubicacionData.departamentos.indexOf(val) !== -1) { V.toast('Ese departamento ya existe.', true); return; }
    ubicacionData.departamentos.push(val);
    ubicacionData.ciudades[val] = ubicacionData.ciudades[val] || [];
    saveUbicacion();
    input.value = '';
    renderUbicacion();
    V.toast('Departamento "' + val + '" añadido ✓');
  }

  function removeDepto(index) {
    if (!confirm('¿Eliminar el departamento "' + ubicacionData.departamentos[index] + '"? Los usuarios quedarán sin ubicación.')) return;
    var name = ubicacionData.departamentos[index];
    // Borra las ciudades del departamento y sus barrios.
    (ubicacionData.ciudades[name] || []).forEach(function (c) { delete ubicacionData.barrios[c]; });
    delete ubicacionData.ciudades[name];
    ubicacionData.departamentos.splice(index, 1);
    saveUbicacion();
    clearUsersField('departamento', name);
    renderUbicacion();
    V.toast('Departamento eliminado ✓');
  }

  function renderCiudades() {
    var list = $('adminCiudadesList');
    if (!list) return;
    var selDepto = $('adminCiudadesDepto');
    if (!selDepto) return;
    var depto = selDepto.value;
    list.innerHTML = '';
    var cities = ubicacionData.ciudades[depto] || [];
    cities.forEach(function (c, i) {
      if (editingCiudadDepto === depto && editingCiudadIndex === i) {
        list.appendChild(renderCiudadEditor(depto, i, c));
        return;
      }
      var tag = el('span', 'profile-tag');
      tag.appendChild(document.createTextNode(c));
      var edit = el('button', 'profile-tag-edit', '✏');
      edit.title = 'Renombrar ciudad';
      edit.addEventListener('click', function () { editingCiudadDepto = depto; editingCiudadIndex = i; renderCiudades(); });
      var del = el('button', 'profile-tag-delete', '✕');
      del.title = 'Eliminar ciudad';
      del.addEventListener('click', function () { removeCiudad(depto, i); });
      tag.appendChild(edit);
      tag.appendChild(del);
      list.appendChild(tag);
    });
  }

  function renderCiudadEditor(depto, index, oldName) {
    var tag = el('span', 'profile-tag editing');
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'profile-tag-input';
    inp.value = oldName;
    inp.maxLength = 60;
    tag.appendChild(inp);

    var save = el('button', 'profile-tag-save', '✓');
    save.title = 'Guardar';
    save.addEventListener('click', function () { commitCiudadRename(depto, index, inp.value); });
    var cancel = el('button', 'profile-tag-delete', '✕');
    cancel.title = 'Cancelar';
    cancel.addEventListener('click', function () { editingCiudadDepto = null; renderCiudades(); });
    tag.appendChild(save);
    tag.appendChild(cancel);

    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commitCiudadRename(depto, index, inp.value); }
      if (e.key === 'Escape') { editingCiudadDepto = null; renderCiudades(); }
    });
    setTimeout(function () { inp.focus(); inp.select(); }, 0);
    return tag;
  }

  function commitCiudadRename(depto, index, rawValue) {
    var val = (rawValue || '').trim();
    var oldName = (ubicacionData.ciudades[depto] || [])[index];
    if (!val || val === oldName) { editingCiudadDepto = null; renderCiudades(); return; }
    if ((ubicacionData.ciudades[depto] || []).indexOf(val) !== -1) { V.toast('Esa ciudad ya existe.', true); return; }
    // Actualiza claves de barrios de la ciudad.
    if (ubicacionData.barrios[oldName]) {
      ubicacionData.barrios[val] = ubicacionData.barrios[oldName];
      delete ubicacionData.barrios[oldName];
    }
    ubicacionData.ciudades[depto][index] = val;
    saveUbicacion();
    updateUsersField('ciudad', oldName, val);
    editingCiudadDepto = null;
    V.toast('Ciudad renombrada ✓');
    renderCiudades();
  }

  function addCiudad() {
    var selDepto = $('adminCiudadesDepto');
    var input = $('adminCiudadInput');
    var depto = selDepto.value;
    if (!depto) { V.toast('Selecciona un departamento primero.', true); return; }
    var val = input.value.trim();
    if (!val) return;
    if ((ubicacionData.ciudades[depto] || []).indexOf(val) !== -1) { V.toast('Esa ciudad ya existe.', true); return; }
    ubicacionData.ciudades[depto] = ubicacionData.ciudades[depto] || [];
    ubicacionData.ciudades[depto].push(val);
    saveUbicacion();
    input.value = '';
    renderCiudades();
    V.toast('Ciudad "' + val + '" añadida ✓');
  }

  function removeCiudad(depto, index) {
    if (!confirm('¿Eliminar la ciudad "' + (ubicacionData.ciudades[depto] || [])[index] + '"? Los usuarios quedarán sin ciudad.')) return;
    var name = (ubicacionData.ciudades[depto] || [])[index];
    delete ubicacionData.barrios[name];
    ubicacionData.ciudades[depto].splice(index, 1);
    saveUbicacion();
    clearUsersField('ciudad', name);
    renderCiudades();
    V.toast('Ciudad eliminada ✓');
  }

  function renderBarrios() {
    var list = $('adminBarriosList');
    if (!list) return;
    var selCiudad = $('adminBarriosCiudad');
    if (!selCiudad) return;
    var ciudad = selCiudad.value;
    list.innerHTML = '';
    var barrios = ubicacionData.barrios[ciudad] || [];
    barrios.forEach(function (b, i) {
      if (editingBarrioCiudad === ciudad && editingBarrioIndex === i) {
        list.appendChild(renderBarrioEditor(ciudad, i, b));
        return;
      }
      var tag = el('span', 'profile-tag');
      tag.appendChild(document.createTextNode(b));
      var edit = el('button', 'profile-tag-edit', '✏');
      edit.title = 'Renombrar barrio';
      edit.addEventListener('click', function () { editingBarrioCiudad = ciudad; editingBarrioIndex = i; renderBarrios(); });
      var del = el('button', 'profile-tag-delete', '✕');
      del.title = 'Eliminar barrio';
      del.addEventListener('click', function () { removeBarrio(ciudad, i); });
      tag.appendChild(edit);
      tag.appendChild(del);
      list.appendChild(tag);
    });
  }

  function renderBarrioEditor(ciudad, index, oldName) {
    var tag = el('span', 'profile-tag editing');
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'profile-tag-input';
    inp.value = oldName;
    inp.maxLength = 60;
    tag.appendChild(inp);

    var save = el('button', 'profile-tag-save', '✓');
    save.title = 'Guardar';
    save.addEventListener('click', function () { commitBarrioRename(ciudad, index, inp.value); });
    var cancel = el('button', 'profile-tag-delete', '✕');
    cancel.title = 'Cancelar';
    cancel.addEventListener('click', function () { editingBarrioCiudad = null; renderBarrios(); });
    tag.appendChild(save);
    tag.appendChild(cancel);

    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); commitBarrioRename(ciudad, index, inp.value); }
      if (e.key === 'Escape') { editingBarrioCiudad = null; renderBarrios(); }
    });
    setTimeout(function () { inp.focus(); inp.select(); }, 0);
    return tag;
  }

  function commitBarrioRename(ciudad, index, rawValue) {
    var val = (rawValue || '').trim();
    var oldName = (ubicacionData.barrios[ciudad] || [])[index];
    if (!val || val === oldName) { editingBarrioCiudad = null; renderBarrios(); return; }
    if ((ubicacionData.barrios[ciudad] || []).indexOf(val) !== -1) { V.toast('Ese barrio ya existe.', true); return; }
    ubicacionData.barrios[ciudad][index] = val;
    saveUbicacion();
    updateUsersField('barrio', oldName, val);
    editingBarrioCiudad = null;
    V.toast('Barrio renombrado ✓');
    renderBarrios();
  }

  function addBarrio() {
    var selCiudad = $('adminBarriosCiudad');
    var input = $('adminBarrioInput');
    var ciudad = selCiudad.value;
    if (!ciudad) { V.toast('Selecciona una ciudad primero.', true); return; }
    var val = input.value.trim();
    if (!val) return;
    if ((ubicacionData.barrios[ciudad] || []).indexOf(val) !== -1) { V.toast('Ese barrio ya existe.', true); return; }
    ubicacionData.barrios[ciudad] = ubicacionData.barrios[ciudad] || [];
    ubicacionData.barrios[ciudad].push(val);
    saveUbicacion();
    input.value = '';
    renderBarrios();
    V.toast('Barrio "' + val + '" añadido ✓');
  }

  function removeBarrio(ciudad, index) {
    if (!confirm('¿Eliminar el barrio "' + (ubicacionData.barrios[ciudad] || [])[index] + '"? Los usuarios quedarán sin barrio.')) return;
    var name = (ubicacionData.barrios[ciudad] || [])[index];
    ubicacionData.barrios[ciudad].splice(index, 1);
    saveUbicacion();
    clearUsersField('barrio', name);
    renderBarrios();
    V.toast('Barrio eliminado ✓');
  }

  /* ─── FILTERS ─────────────────────────────────────────────── */
  function bindFilters() {
    var searchInput = $('adminSearch');
    var rolSelect = $('adminFilterRol');
    var estadoSelect = $('adminFilterEstado');
    var perfilSelect = $('adminFilterPerfil');
    var profesionSelect = $('adminFilterProfesion');
    var oficioSelect = $('adminFilterOficio');

    if (searchInput) {
      searchInput.addEventListener('input', function () {
        filters.search = this.value;
        renderTable();
        renderActiveFiltersBar();
      });
    }
    if (rolSelect) {
      rolSelect.addEventListener('change', function () {
        filters.rol = this.value;
        filterUpdate();
      });
    }
    if (estadoSelect) {
      estadoSelect.addEventListener('change', function () {
        filters.estado = this.value;
        filterUpdate();
      });
    }
    if (perfilSelect) {
      perfilSelect.addEventListener('change', function () {
        filters.perfil = this.value;
        filterUpdate();
      });
    }
    if (profesionSelect) {
      profesionSelect.addEventListener('change', function () {
        filters.profesion = this.value;
        filterUpdate();
      });
    }
    if (oficioSelect) {
      oficioSelect.addEventListener('change', function () {
        filters.oficio = this.value;
        filterUpdate();
      });
    }
  }

  function populateFilterProfiles() {
    var sel = $('adminFilterPerfil');
    if (!sel) return;
    while (sel.options.length > 1) sel.remove(1);
    perfilesCache.forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p; opt.textContent = p;
      sel.appendChild(opt);
    });
  }

  function populateFilterProfesiones() {
    var sel = $('adminFilterProfesion');
    if (!sel) return;
    while (sel.options.length > 1) sel.remove(1);
    profesionesCache.forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p; opt.textContent = p;
      sel.appendChild(opt);
    });
  }

  function populateFilterOficios() {
    var sel = $('adminFilterOficio');
    if (!sel) return;
    while (sel.options.length > 1) sel.remove(1);
    oficiosCache.forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o; opt.textContent = o;
      sel.appendChild(opt);
    });
  }

  /* ─── MODULE INTERFACE ────────────────────────────────────── */
  var CrmModule = {
    onReady: function () {
      if (V.userRole !== 'superadmin') return;

      // La gestión del patrocinador (MLM) es exclusiva de administradores.
      var mlmBlock = $('crmMlmBlock');
      if (mlmBlock) mlmBlock.style.display = '';

      subscribeUsuarios();
      subscribePerfiles();
      subscribeProfesiones();
      subscribeOficios();
      subscribeUbicacion();
      bindFilters();
      watchAdminSectionLayout();

      // Bulk actions
      var checkAll = $('adminCheckAll');
      if (checkAll) checkAll.addEventListener('change', toggleSelectAll);
      var bulkDelete = $('adminBulkDelete');
      if (bulkDelete) bulkDelete.addEventListener('click', bulkDeleteUsers);
      var bulkCancel = $('adminBulkCancel');
      if (bulkCancel) bulkCancel.addEventListener('click', clearSelection);

      // Form events
      $('crmFormSave').addEventListener('click', saveForm);
      $('crmFormCancel').addEventListener('click', closeForm);
      $('crmFormOverlay').addEventListener('click', function (e) {
        if (e.target === this) closeForm();
      });

      // Ficha (vista) events
      $('crmViewEdit').addEventListener('click', function () {
        if (editingUser) openForm(editingUser);
        closeView();
      });
      $('crmViewClose').addEventListener('click', closeView);
      $('crmViewOverlay').addEventListener('click', function (e) {
        if (e.target === this) closeView();
      });

      // Sexo "Otro" → descripción
      var crmSexo = $('crmSexo');
      if (crmSexo) crmSexo.addEventListener('change', function () {
        var wrap = $('crmSexoOtroWrap');
        if (wrap) wrap.style.display = this.value === 'Otro' ? '' : 'none';
      });

      // Ubicación: cascada del modal (Departamento → Ciudad → Barrio)
      var crmDepto = $('crmDepartamento');
      var crmCiudad = $('crmCiudad');
      var crmBarrio = $('crmBarrio');
      if (crmDepto) crmDepto.addEventListener('change', function () {
        populateCiudadSelect('');
        populateBarrioSelect('');
      });
      if (crmCiudad) crmCiudad.addEventListener('change', function () {
        populateBarrioSelect('');
      });
      if (crmBarrio) crmBarrio.addEventListener('change', handleBarrioOtro);

      // Profile management
      $('adminProfileAdd').addEventListener('click', addProfile);
      $('adminProfileInput').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); addProfile(); }
      });

      // Profesión management
      $('adminProfesionAdd').addEventListener('click', addProfesion);
      $('adminProfesionInput').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); addProfesion(); }
      });

      // Oficio management
      $('adminOficioAdd').addEventListener('click', addOficio);
      $('adminOficioInput').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); addOficio(); }
      });

      // Profesión "Otros..." handler in modal
      var crmProf = $('crmProfesion');
      if (crmProf) crmProf.addEventListener('change', handleProfesionOtro);

      // Oficio "Otros..." handler in modal
      var crmOfi = $('crmOficio');
      if (crmOfi) crmOfi.addEventListener('change', handleOficioOtro);

      // Ubicación management
      $('adminDeptoAdd').addEventListener('click', addDepto);
      $('adminDeptoInput').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); addDepto(); }
      });

      var adminCiudadesDepto = $('adminCiudadesDepto');
      if (adminCiudadesDepto) adminCiudadesDepto.addEventListener('change', function () {
        editingCiudadDepto = null;
        renderUbicacion();
      });
      $('adminCiudadAdd').addEventListener('click', addCiudad);
      $('adminCiudadInput').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); addCiudad(); }
      });

      var adminBarriosCiudad = $('adminBarriosCiudad');
      if (adminBarriosCiudad) adminBarriosCiudad.addEventListener('change', function () {
        editingBarrioCiudad = null;
        renderUbicacion();
      });
      $('adminBarrioAdd').addEventListener('click', addBarrio);
      $('adminBarrioInput').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); addBarrio(); }
      });
    }
  };

  V.registerModule(CrmModule);
})();
