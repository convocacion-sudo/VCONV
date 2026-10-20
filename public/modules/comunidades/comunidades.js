/* ════════════════════════════════════════════════════════════════
   VCONV · Módulo Comunidades — Gestión de comunidades, miembros,
   control de asistencia y panel global de reportes.
   Colecciones:
     - comunidades            (id, nombre, tipo, coordinadorId, createdAt)
     - comunidad_categorias   (id, value, label) — opciones dinámicas de tipo
     - comunidad_miembros     (id, comunidadId, crmId, estado, fechaVinculacion)
     - reuniones              (id, comunidadId, titulo, descripcion, fecha, hora,
                               tipo: presencial|virtual, fechaReunion,
                               asistencias{crmId: pendiente|confirmado|asistio|falta},
                               asistencia{crmId:bool} — espejo legacy para reportes)
     - finanzas_transacciones (tipo 'grupo', comunidadId, monto, concepto, fecha) —
       ofrendas de grupo liquidadas desde esta sección (integración con Finanzas)
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var V = window.VCONV;
  if (!V) { console.error('VCONV core not loaded'); return; }

  /* ─── HELPERS ───────────────────────────────────────────────── */
  function $(id) { return V.$(id); }
  function el(tag, cls, text) { return V.el(tag, cls, text); }

  var DEFAULT_CATEGORIAS = [
    { value: 'precomunidad', label: 'Precomunidad' },
    { value: 'miembros', label: 'Miembros' },
    { value: 'misionera', label: 'Misionera' }
  ];
  var categorias = []; // opciones cargadas desde comunidad_categorias
  var ESTADOS = [
    { value: 'activo', label: 'Activo' },
    { value: 'inactivo', label: 'Inactivo' },
    { value: 'en_proceso', label: 'En proceso' }
  ];
  var COL_OFRS = 'finanzas_transacciones';
  var COL_REUNIONES = V.COL_REUNIONES || 'reuniones';

  var ESTADOS_ASISTENCIA = {
    pendiente: { label: 'Pendiente', icon: '⏳' },
    confirmado: { label: 'Confirmado', icon: '✅' },
    asistio: { label: 'Asistió', icon: '🟢' },
    falta: { label: 'Falta', icon: '❌' }
  };
  var TIPOS_REUNION = {
    presencial: { label: 'Presencial', icon: '🏠' },
    virtual: { label: 'Virtual', icon: '💻' }
  };

  function fmtMoneda(n) {
    var v = Number(n) || 0;
    return '$' + v.toLocaleString('es-CO');
  }
  function isSuperadmin() { return V.userRole === 'superadmin'; }

  function tipoLabel(t) {
    for (var i = 0; i < categorias.length; i++) if (categorias[i].value === t) return categorias[i].label;
    return t || '—';
  }
  function estadoLabel(e) {
    for (var i = 0; i < ESTADOS.length; i++) if (ESTADOS[i].value === e) return ESTADOS[i].label;
    return e || '—';
  }
  function userFullName(u) {
    return ((u && (u.nombre || '')) + ' ' + (u && (u.apellido || ''))).trim() || (u && u.email ? u.email : '—');
  }
  function comunidadById(id) {
    for (var i = 0; i < comunidades.length; i++) if (comunidades[i].id === id) return comunidades[i];
    return null;
  }
  function coordinadorDe(c) {
    if (!c || !c.coordinadorId) return null;
    for (var i = 0; i < usuarios.length; i++) if (usuarios[i].uid === c.coordinadorId) return usuarios[i];
    return null;
  }
  function miembrosDe(comunidadId) {
    return miembros.filter(function (m) { return m.comunidadId === comunidadId; });
  }
  function miembrosActivosDe(comunidadId) {
    return miembrosDe(comunidadId).filter(function (m) { return (m.estado || 'activo') === 'activo'; });
  }
  function isAdmin() {
    var r = (V.userRole || '').toLowerCase();
    return r === 'superadmin' || r === 'admin';
  }

  /* ─── HELPERS DE REUNIONES / ASISTENCIA ─────────────────────── */
  function tipoReunionLabel(t) {
    var x = TIPOS_REUNION[t] || TIPOS_REUNION.presencial;
    return x.label;
  }
  function tipoReunionIcon(t) {
    var x = TIPOS_REUNION[t] || TIPOS_REUNION.presencial;
    return x.icon;
  }
  function metaEstadoAsistencia(st) {
    return ESTADOS_ASISTENCIA[st] || ESTADOS_ASISTENCIA.pendiente;
  }

  // Fecha + hora reales de la reunión. Los documentos antiguos solo tienen
  // fechaReunion (ISO); se usan como respaldo para no romper el historial.
  function fechaHoraReunion(r) {
    if (!r) return null;
    var fecha = typeof r.fecha === 'string' && r.fecha ? r.fecha
      : (r.fechaReunion ? String(r.fechaReunion).slice(0, 10) : '');
    if (!fecha) return null;
    var hora = typeof r.hora === 'string' && r.hora ? r.hora : '00:00';
    var d = new Date(fecha + 'T' + hora + ':00');
    return isNaN(d.getTime()) ? null : d;
  }

  function fechaHoraTexto(r) {
    var d = fechaHoraReunion(r);
    if (!d) return 'Fecha por confirmar';
    var txt = d.toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
    return txt + (r && r.hora ? ' · ' + r.hora : '');
  }

  function ordenReunionesAsc(a, b) {
    var da = fechaHoraReunion(a);
    var db = fechaHoraReunion(b);
    return (da ? da.getTime() : 0) - (db ? db.getTime() : 0);
  }

  function estadoAsistencia(reu, crmId) {
    if (!reu || !crmId) return 'pendiente';
    var st = reu.asistencias && reu.asistencias[crmId];
    if (st && ESTADOS_ASISTENCIA[st]) return st;
    var legado = reu.asistencia && reu.asistencia[crmId];
    if (legado === true) return 'asistio';
    if (legado === false) return 'falta';
    return 'pendiente';
  }

  function proximaReunion(comId) {
    var ahora = Date.now();
    var lista = reuniones.filter(function (r) { return r.comunidadId === comId; })
      .sort(ordenReunionesAsc);
    for (var i = 0; i < lista.length; i++) {
      var d = fechaHoraReunion(lista[i]);
      // Se mantiene visible la reunión en curso hasta 2 horas después.
      if (d && d.getTime() >= ahora - 2 * 60 * 60 * 1000) return lista[i];
    }
    return null;
  }

  function conteoAsistencia(reu, comId) {
    var c = { total: 0, asistio: 0, falta: 0, confirmado: 0, pendiente: 0 };
    miembrosActivosDe(comId).forEach(function (m) {
      c.total++;
      var st = estadoAsistencia(reu, m.crmId);
      if (st === 'asistio') c.asistio++;
      else if (st === 'falta') c.falta++;
      else if (st === 'confirmado') c.confirmado++;
      else c.pendiente++;
    });
    return c;
  }

  function hoyISO() {
    var d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 10);
  }

  /* ─── STATE ─────────────────────────────────────────────────── */
  var comunidades = [];
  var miembros = [];
  var reuniones = [];
  var usuarios = [];
  var ofrendasCache = [];
  var ofrendasLoaded = false;
  var currComId = null;     // comunidad seleccionada en coordinador
  var currReunionId = null; // reunión seleccionada
  var tabActivo = 'grupo';  // pestaña activa del coordinador

  /* ─── DATA LOADERS ──────────────────────────────────────────── */
  function loadUsuarios() {
    if (!V.db) return Promise.resolve([]);
    if (usuarios.length) return Promise.resolve(usuarios);
    return V.db.collection(V.COL_USUARIOS).get()
      .then(function (snap) {
        usuarios = [];
        snap.forEach(function (doc) { var d = doc.data(); d.uid = doc.id; usuarios.push(d); });
        return usuarios;
      })
      .catch(function () { return []; });
  }
  function loadComunidades() {
    if (!V.db) return Promise.resolve([]);
    return V.db.collection(V.COL_COMUNIDADES).get()
      .then(function (snap) {
        comunidades = [];
        snap.forEach(function (doc) { var d = doc.data(); d.id = doc.id; comunidades.push(d); });
        return comunidades;
      })
      .catch(function () { return []; });
  }
  function loadMiembros() {
    if (!V.db) return Promise.resolve([]);
    return V.db.collection(V.COL_COMUNIDAD_MIEMBROS).get()
      .then(function (snap) {
        miembros = [];
        snap.forEach(function (doc) { var d = doc.data(); d.id = doc.id; miembros.push(d); });
        return miembros;
      })
      .catch(function () { return []; });
  }
  function loadCategorias() {
    if (!V.db) return Promise.resolve(categorias);
    return V.db.collection(V.COL_COMUNIDAD_CATEGORIAS).get()
      .then(function (snap) {
        categorias = [];
        snap.forEach(function (doc) {
          var d = doc.data() || {};
          categorias.push({ value: doc.id, label: d.label || doc.id });
        });
        categorias.sort(function (a, b) { return (a.label || '').localeCompare(b.label || ''); });
        if (!categorias.length) {
          // Primer arranque: sembrar las categorías por defecto. Si el usuario
          // no tiene permisos de escritura se ignora y se usa el fallback local.
          var ops = DEFAULT_CATEGORIAS.map(function (c) {
            return V.db.collection(V.COL_COMUNIDAD_CATEGORIAS).doc(c.value).set({
              value: c.value,
              label: c.label,
              createdAt: new Date().toISOString()
            });
          });
          return Promise.all(ops)
            .then(function () { categorias = DEFAULT_CATEGORIAS.slice(); return categorias; })
            .catch(function () { categorias = DEFAULT_CATEGORIAS.slice(); return categorias; });
        }
        return categorias;
      })
      .catch(function () {
        categorias = DEFAULT_CATEGORIAS.slice();
        return categorias;
      });
  }
  function loadReuniones() {
    if (!V.db) return Promise.resolve([]);
    return V.db.collection(V.COL_REUNIONES).get()
      .then(function (snap) {
        reuniones = [];
        snap.forEach(function (doc) { var d = doc.data(); d.id = doc.id; reuniones.push(d); });
        return reuniones;
      })
      .catch(function () { return []; });
  }

  // Ofrendas de grupo (finanzas_transacciones con tipo 'grupo'). El
  // superadmin consulta todas; el resto solo las propias (la regla de
  // Firestore exige userId == sesión o superadmin, así cualquier otra
  // consulta global sería rechazada). Dos igualdades sin orderBy: no
  // requiere índice compuesto.
  function loadOfrendas(forzar) {
    if (!V.db) return Promise.resolve([]);
    if (ofrendasLoaded && !forzar) return Promise.resolve(ofrendasCache);
    var col = V.db.collection(COL_OFRS);
    var q = isSuperadmin()
      ? col.where('tipo', '==', 'grupo')
      : col.where('tipo', '==', 'grupo').where('userId', '==', V.userId);
    return q.get()
      .then(function (snap) {
        ofrendasCache = [];
        snap.forEach(function (doc) { var d = doc.data() || {}; d.id = doc.id; ofrendasCache.push(d); });
        ofrendasCache.sort(function (a, b) { return (b.fecha || '').localeCompare(a.fecha || ''); });
        ofrendasLoaded = true;
        return ofrendasCache;
      })
      .catch(function () { return []; });
  }

  function loadAll() {
    return Promise.all([loadUsuarios(), loadComunidades(), loadMiembros(), loadReuniones(), loadCategorias(), loadOfrendas()]);
  }

  /* ─── MAIN RENDER DISPATCHER ────────────────────────────────── */
  function renderPanel() {
    var content = $('comunidadesContent');
    if (!content) return;
    var rol = V.userRole || 'estudiante';
    var esCoordinador = comunidadPorCoordinador(V.userId) ? true : false;
    var esAdmin = isAdmin();

    // Botón "+ Nueva Comunidad" del encabezado (visible para gestor, admin o coordinador)
    var btnNueva = $('btnNuevaComunidad');
    if (btnNueva) {
      btnNueva.style.display = (rol === 'gestor' || esAdmin || esCoordinador) ? '' : 'none';
    }

    if (esAdmin) {
      renderAdmin(content);
    } else if (rol === 'gestor' || esCoordinador) {
      renderCoordinador(content);
    } else {
      renderEstudiante(content);
    }
  }

  /* ─── MODAL CREAR COMUNIDAD ────────────────────────────────── */
  // Rellena el <select> de tipo con las categorías cargadas de
  // comunidad_categorias (getDocs). `curr` marca la opción seleccionada.
  function fillTipoSelect(select, curr, withPlaceholder) {
    select.innerHTML = '';
    if (withPlaceholder) {
      var optPh = document.createElement('option');
      optPh.value = ''; optPh.textContent = '— selecciona —';
      select.appendChild(optPh);
    }
    categorias.forEach(function (c) {
      var opt = document.createElement('option');
      opt.value = c.value; opt.textContent = c.label;
      opt.selected = c.value === curr;
      select.appendChild(opt);
    });
  }

  // getDocs fresco de comunidad_categorias al abrir el modal y repinta
  // el <select> conservando la selección actual (si aún existe).
  function refreshTipoSelect(select, curr) {
    loadCategorias().then(function () {
      if (!document.body.contains(select)) return;
      fillTipoSelect(select, curr, true);
    });
  }

  function coordinadoresDisponibles() {
    return usuarios;
  }

  function openNuevaComunidadModal() {
    var overlay = el('div', 'modal-overlay');
    overlay.id = 'comModalCrear';
    var card = el('div', 'modal-card');

    var h3 = el('h3', '', '➕ Nueva Comunidad');
    card.appendChild(h3);

    var fieldNombre = el('div', 'field');
    fieldNombre.appendChild(el('label', '', 'Nombre'));
    var inputNombre = document.createElement('input');
    inputNombre.type = 'text';
    inputNombre.className = 'input';
    inputNombre.placeholder = 'Ej: Comunidad El Retiro';
    fieldNombre.appendChild(inputNombre);
    card.appendChild(fieldNombre);

    var fieldTipo = el('div', 'field');
    fieldTipo.appendChild(el('label', '', 'Tipo'));
    var selectTipo = document.createElement('select');
    selectTipo.className = 'select';
    fillTipoSelect(selectTipo, '', true);
    fieldTipo.appendChild(selectTipo);
    card.appendChild(fieldTipo);
    refreshTipoSelect(selectTipo, '');

    var fieldCoord = el('div', 'field');
    fieldCoord.appendChild(el('label', '', 'Coordinador'));
    var selectCoord = document.createElement('select');
    selectCoord.className = 'select';
    var optCoord0 = document.createElement('option');
    optCoord0.value = ''; optCoord0.textContent = '— selecciona —';
    selectCoord.appendChild(optCoord0);
    coordinadoresDisponibles().forEach(function (u) {
      var opt = document.createElement('option');
      opt.value = u.uid;
      var label = userFullName(u) + (u.email ? ' · ' + u.email : '');
      opt.textContent = label;
      opt.selected = u.uid === V.userId;
      selectCoord.appendChild(opt);
    });
    fieldCoord.appendChild(selectCoord);
    card.appendChild(fieldCoord);

    var actions = el('div', 'form-actions');
    var btnSave = el('button', 'btn btn-primary', 'Guardar comunidad');
    btnSave.type = 'button';
    var btnCancel = el('button', 'btn btn-outline', 'Cancelar');
    btnCancel.type = 'button';
    actions.appendChild(btnSave);
    actions.appendChild(btnCancel);
    card.appendChild(actions);

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    overlay.classList.add('show');

    function closeModal() {
      overlay.classList.remove('show');
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    function validar() {
      var nombre = inputNombre.value.trim();
      var tipo = selectTipo.value;
      var coord = selectCoord.value;
      if (!nombre) { V.toast('Escribe el nombre de la comunidad.', true); return; }
      if (!tipo) { V.toast('Selecciona el tipo de comunidad.', true); return; }
      if (!coord) { V.toast('Selecciona el coordinador.', true); return; }
      return { nombre: nombre, tipo: tipo, coordinadorId: coord };
    }

    btnSave.addEventListener('click', function () {
      var data = validar();
      if (!data) return;
      btnSave.disabled = true;
      V.db.collection(V.COL_COMUNIDADES).add({
        nombre: data.nombre,
        tipo: data.tipo,
        coordinadorId: data.coordinadorId,
        createdAt: new Date().toISOString()
      }).then(function () {
        V.toast('Comunidad creada ✓');
        closeModal();
        return loadAll();
      }).then(function () { renderPanel(); })
        .catch(function (e) {
          V.toast('Error al crear la comunidad: ' + e.message, true);
          btnSave.disabled = false;
        });
    });
    btnCancel.addEventListener('click', closeModal);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });
  }

  // Mira de modal reutilizable que retorna { overlay, card, close }
  function abrirComModal(titulo) {
    var overlay = el('div', 'modal-overlay');
    var card = el('div', 'modal-card');
    card.appendChild(el('h3', '', titulo));
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    overlay.classList.add('show');
    function close() {
      overlay.classList.remove('show');
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    return { overlay: overlay, card: card, close: close };
  }

  function openAñadirMiembroModal(comId) {
    var com = comunidadById(comId);
    var m = abrirComModal('➕ Añadir Miembro — ' + (com ? com.nombre : ''));
    var card = m.card;
    card.appendChild(el('p', '', 'Busca en la base general del CRM y selecciona perfiles. Los ya vinculados no se muestran ni se duplican.'));

    var yaVinculados = {};
    miembrosDe(comId).forEach(function (mm) { yaVinculados[mm.crmId] = true; });

    var filtro = document.createElement('input');
    filtro.type = 'text';
    filtro.className = 'input com-filter-input';
    filtro.placeholder = 'Buscar por nombre o correo…';
    card.appendChild(filtro);

    var contactList = el('div', 'com-contact-list');
    card.appendChild(contactList);

    var selEstado = document.createElement('select');
    selEstado.className = 'select';
    ESTADOS.forEach(function (e2) {
      var opt = document.createElement('option');
      opt.value = e2.value; opt.textContent = e2.label;
      selEstado.appendChild(opt);
    });
    card.appendChild(selEstado);

    var actions = el('div', 'form-actions');
    var btnVincular = el('button', 'btn btn-primary', 'Vincular seleccionados');
    btnVincular.type = 'button';
    var btnCancel = el('button', 'btn btn-outline', 'Cancelar');
    btnCancel.type = 'button';
    actions.appendChild(btnVincular);
    actions.appendChild(btnCancel);
    card.appendChild(actions);

    function renderContactList(q) {
      q = (q || '').toLowerCase();
      var available = usuarios.filter(function (u) {
        if (yaVinculados[u.uid]) return false;
        if (u.uid === V.userId) return false;
        var haystack = (userFullName(u) + ' ' + (u.email || '')).toLowerCase();
        if (q && haystack.indexOf(q) === -1) return false;
        return true;
      });
      contactList.innerHTML = '';
      if (!available.length) {
        contactList.appendChild(el('div', 'com-empty', q ? 'Sin resultados.' : 'No hay contactos disponibles para vincular.'));
        return;
      }
      available.forEach(function (u) {
        var item = el('label', 'com-contact-item');
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = u.uid;
        cb.className = 'com-crm-cb';
        item.appendChild(cb);
        var wrap = el('div', '');
        wrap.appendChild(el('div', 'com-contact-name', userFullName(u)));
        wrap.appendChild(el('div', 'com-contact-meta', (u.email || '') + (u.ciudad ? ' · ' + u.ciudad : '')));
        item.appendChild(wrap);
        contactList.appendChild(item);
      });
    }

    filtro.addEventListener('input', function () { renderContactList(this.value); });
    renderContactList('');

    btnVincular.addEventListener('click', function () {
      var seleccionados = contactList.querySelectorAll('.com-crm-cb:checked');
      if (!seleccionados.length) { V.toast('Selecciona al menos un contacto.', true); return; }
      var estado = selEstado.value || 'activo';
      var fecha = new Date().toISOString();
      var promises = Array.prototype.map.call(seleccionados, function (cb) {
        return V.db.collection(V.COL_COMUNIDAD_MIEMBROS).add({
          comunidadId: comId,
          crmId: cb.value,
          estado: estado,
          fechaVinculacion: fecha
        });
      });
      Promise.all(promises)
        .then(function () {
          V.toast(seleccionados.length + ' contacto(s) vinculado(s) ✓');
          m.close();
          return loadAll();
        })
        .then(function () { renderPanel(); })
        .catch(function (e) { V.toast('Error al vincular: ' + e.message, true); });
    });
    btnCancel.addEventListener('click', m.close);
  }

  function openEditarComunidadModal(comId) {
    var com = comunidadById(comId);
    if (!com) { V.toast('Comunidad no encontrada.', true); return; }
    var m = abrirComModal('⚙️ Editar Comunidad / Cambiar Coordinador');
    var card = m.card;

    var fieldNombre = el('div', 'field');
    fieldNombre.appendChild(el('label', '', 'Nombre'));
    var inputNombre = document.createElement('input');
    inputNombre.type = 'text';
    inputNombre.className = 'input';
    inputNombre.value = com.nombre || '';
    fieldNombre.appendChild(inputNombre);
    card.appendChild(fieldNombre);

    var fieldTipo = el('div', 'field');
    fieldTipo.appendChild(el('label', '', 'Tipo'));
    var selectTipo = document.createElement('select');
    selectTipo.className = 'select';
    fillTipoSelect(selectTipo, com.tipo, false);
    fieldTipo.appendChild(selectTipo);
    card.appendChild(fieldTipo);
    refreshTipoSelect(selectTipo, com.tipo);

    var fieldCoord = el('div', 'field');
    fieldCoord.appendChild(el('label', '', 'Coordinador'));
    var selectCoord = document.createElement('select');
    selectCoord.className = 'select';
    coordinadoresDisponibles().forEach(function (u) {
      var opt = document.createElement('option');
      opt.value = u.uid;
      opt.textContent = userFullName(u) + (u.email ? ' · ' + u.email : '');
      opt.selected = u.uid === com.coordinadorId;
      selectCoord.appendChild(opt);
    });
    fieldCoord.appendChild(selectCoord);
    card.appendChild(fieldCoord);

    var actions = el('div', 'form-actions');
    var btnSave = el('button', 'btn btn-primary', 'Guardar cambios');
    btnSave.type = 'button';
    var btnCancel = el('button', 'btn btn-outline', 'Cancelar');
    btnCancel.type = 'button';
    actions.appendChild(btnSave);
    actions.appendChild(btnCancel);
    card.appendChild(actions);

    btnSave.addEventListener('click', function () {
      var nombre = inputNombre.value.trim();
      var tipo = selectTipo.value;
      var coord = selectCoord.value;
      if (!nombre) { V.toast('Escribe el nombre de la comunidad.', true); return; }
      if (!tipo) { V.toast('Selecciona el tipo de comunidad.', true); return; }
      if (!coord) { V.toast('Selecciona el coordinador.', true); return; }
      btnSave.disabled = true;
      V.db.collection(V.COL_COMUNIDADES).doc(comId).update({
        nombre: nombre,
        tipo: tipo,
        coordinadorId: coord
      }).then(function () {
        V.toast('Comunidad actualizada ✓');
        m.close();
        return loadAll();
      }).then(function () { renderPanel(); })
        .catch(function (e) {
          V.toast('Error al actualizar: ' + e.message, true);
          btnSave.disabled = false;
        });
    });
    btnCancel.addEventListener('click', m.close);
  }

  /* ─── GESTIÓN COMPLETA DE COMUNIDAD (acceso admin) ──────────── */
  function openGestionarComunidad(comId) {
    var com = comunidadById(comId);
    if (!com) { V.toast('Comunidad no encontrada.', true); return; }
    if (!isAdmin()) { V.toast('Solo el administrador puede gestionar esta comunidad.', true); return; }
    var m = abrirComModal('🛠️ Gestionar — ' + (com.nombre || ''));
    var card = m.card;
    card.appendChild(el('p', 'com-empty', 'Administración completa: miembros, coordinador y asistencia.'));

    // Gestión de miembros (añadir, vincular, estados, desvincular)
    card.appendChild(renderVinculacion(comId));
    // Control de asistencia
    card.appendChild(renderAsistenciaChecklist(comId, card));
    // Ofrendas de grupo (integración con Finanzas)
    card.appendChild(renderOfrendasSection(comId, card));

    var actions = el('div', 'form-actions');
    var btnCerrar = el('button', 'btn btn-outline', 'Cerrar');
    btnCerrar.type = 'button';
    btnCerrar.addEventListener('click', m.close);
    actions.appendChild(btnCerrar);
    card.appendChild(actions);
  }

  /* ─── ESTUDIANTE (Escritorio Personal) ──────────────────────── */
  function comunidadPorCoordinador(uid) {
    for (var i = 0; i < comunidades.length; i++) {
      if (comunidades[i].coordinadorId === uid) return comunidades[i];
    }
    return null;
  }

  // Doble validación de vinculación: el usuario puede estar registrado
  // como miembro (comunidad_miembros) o figurar como coordinadorId de
  // una comunidad (colección comunidades).
  function miVinculacion() {
    for (var i = 0; i < miembros.length; i++) {
      if (miembros[i].crmId === V.userId) {
        return { via: 'miembro', miembro: miembros[i], comunidad: comunidadById(miembros[i].comunidadId), crmId: V.userId };
      }
    }
    var com = comunidadPorCoordinador(V.userId);
    if (com) {
      return { via: 'coordinador', miembro: null, comunidad: com, crmId: V.userId };
    }
    return null;
  }

  function asistenciaResumen(comunidadId, crmId) {
    var reunionesCom = reuniones.filter(function (r) { return r.comunidadId === comunidadId; });
    var asistencias = 0;
    var faltas = 0;
    var confirmadas = 0;
    var total = 0; // reuniones con estado definitivo (asistió o falta)
    reunionesCom.forEach(function (r) {
      var st = estadoAsistencia(r, crmId);
      if (st === 'asistio') { asistencias++; total++; }
      else if (st === 'falta') { faltas++; total++; }
      else if (st === 'confirmado') confirmadas++;
    });
    return {
      total: total,
      programadas: reunionesCom.length,
      asistencias: asistencias,
      faltas: faltas,
      confirmadas: confirmadas
    };
  }

  // Tarjeta de "Próxima reunión" con confirmación para el miembro.
  function renderProximaReunion(reu, crmId) {
    var card = el('div', 'com-card com-next-meeting');
    var head = el('div', 'com-card-head');
    head.appendChild(el('h3', '', '📅 Próxima reunión'));
    head.appendChild(el('span', 'com-badge tipo-' + (reu.tipo || 'presencial'),
      tipoReunionIcon(reu.tipo) + ' ' + tipoReunionLabel(reu.tipo)));
    card.appendChild(head);

    card.appendChild(el('h4', 'com-next-title', reu.titulo || 'Reunión de la comunidad'));
    card.appendChild(el('p', 'com-next-meta', '🗓️ ' + fechaHoraTexto(reu)));

    var desc = typeof reu.descripcion === 'string' ? reu.descripcion.trim() : '';
    if (desc) card.appendChild(el('p', 'com-next-desc', desc));

    var estado = estadoAsistencia(reu, crmId);
    var meta = metaEstadoAsistencia(estado);
    var actions = el('div', 'com-next-actions');
    actions.appendChild(el('span', 'com-asistencia-pill st-' + estado, meta.icon + ' ' + meta.label));

    if (estado === 'confirmado') {
      var ok = el('button', 'btn btn-success', '✅ Asistencia confirmada');
      ok.type = 'button';
      ok.disabled = true;
      actions.appendChild(ok);
    } else if (estado === 'asistio') {
      var ok2 = el('button', 'btn btn-success', '🟢 Asistencia validada');
      ok2.type = 'button';
      ok2.disabled = true;
      actions.appendChild(ok2);
    } else {
      var btn = el('button', 'btn btn-primary', '✅ Confirmar asistencia');
      btn.type = 'button';
      btn.addEventListener('click', function () { confirmarAsistencia(reu, btn); });
      actions.appendChild(btn);
    }

    card.appendChild(actions);
    return card;
  }

  function confirmarAsistencia(reu, btn) {
    if (!V.db) { V.toast('La base de datos no está disponible.', true); return; }
    if (!reu || !reu.id) { V.toast('La reunión ya no está disponible.', true); return; }
    if (!V.userId) { V.toast('Inicia sesión para confirmar tu asistencia.', true); return; }

    var prev = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Confirmando…'; }
    var upd = {};
    upd['asistencias.' + V.userId] = 'confirmado';
    upd.actualizado = new Date().toISOString();

    return V.db.collection(COL_REUNIONES).doc(reu.id).update(upd)
      .then(function () {
        V.toast('Asistencia confirmada ✓');
        return loadReuniones();
      })
      .then(function () { renderPanel(); })
      .catch(function (e) {
        V.toast('No se pudo confirmar la asistencia: ' + e.message, true);
        if (btn) { btn.disabled = false; btn.textContent = prev; }
      });
  }

  function renderEstudiante(content) {
    content.innerHTML = '';
    $('comunidadesSub').textContent = 'Mi comunidad, coordinador y resumen de asistencia.';

    var vin = miVinculacion();
    if (!vin || !vin.comunidad) {
      content.appendChild(V.emptyState('🤝', 'Aún no estás vinculado a una comunidad', 'Cuando el coordinador te asigne a un grupo, la información aparecerá aquí.'));
      return;
    }
    var com = vin.comunidad;
    var coord = coordinadorDe(com);
    var asis = asistenciaResumen(com.id, vin.crmId);

    var card = el('div', 'com-card');
    var head = el('div', 'com-card-head');
    head.appendChild(el('h3', '', com.nombre || 'Mi comunidad'));
    head.appendChild(el('span', 'com-badge tipo-' + com.tipo, tipoLabel(com.tipo)));
    card.appendChild(head);

    // Stats
    var stats = el('div', 'com-stats');
    [
      { value: tipoLabel(com.tipo), label: 'Nivel' },
      { value: String(miembrosActivosDe(com.id).length), label: 'Miembros activos' },
      { value: asis.asistencias + ' / ' + asis.total, label: 'Reuniones asistidas' },
      { value: String(asis.faltas), label: 'Faltas', tone: 'faltas' },
      { value: asis.total ? Math.round((asis.asistencias / asis.total) * 100) + '%' : '—', label: 'Participación' }
    ].forEach(function (c) {
      var sc = el('div', 'com-stat-card' + (c.tone ? ' com-stat-' + c.tone : ''));
      sc.appendChild(el('div', 'com-stat-value', String(c.value)));
      sc.appendChild(el('div', 'com-stat-label', c.label));
      stats.appendChild(sc);
    });
    card.appendChild(stats);

    // Próxima reunión (si hay alguna programada)
    var prox = proximaReunion(com.id);
    if (prox) content.appendChild(renderProximaReunion(prox, vin.crmId));

    // Coordinador
    var coordCard = el('div', 'com-card');
    var coordHead = el('div', 'com-card-head');
    coordHead.appendChild(el('h3', '', '🧑‍🏫 Mi coordinador'));
    if (vin.via === 'coordinador') coordHead.appendChild(el('span', 'com-badge miembros', 'Tú coordinas esta comunidad'));
    coordCard.appendChild(coordHead);
    if (coord) {
      coordCard.appendChild(profileRow('Nombre', userFullName(coord)));
      coordCard.appendChild(profileRow('Correo', coord.email || '—'));
      coordCard.appendChild(profileRow('Teléfono', coord.telefono || '—'));
    } else {
      coordCard.appendChild(el('p', '', 'Sin coordinador asignado.'));
    }

    content.appendChild(card);
    content.appendChild(coordCard);
  }

  function profileRow(label, value) {
    var row = el('div', 'com-profile-row');
    row.appendChild(el('span', 'com-profile-label', label));
    row.appendChild(el('span', 'com-profile-value', value || '—'));
    return row;
  }

  /* ─── COORDINADOR (Gestión de Grupo) ────────────────────────── */
  function misComunidades() {
    return comunidades.filter(function (c) { return c.coordinadorId === V.userId; });
  }

  function renderCoordinador(content) {
    content.innerHTML = '';
    $('comunidadesSub').textContent = 'Gestiona tu grupo, vincula contactos existentes y controla la asistencia semanal.';

    var mine = misComunidades();

    // Tabs: Mi Comunidad / Asistencia / Ofrendas
    var tabs = el('div', 'com-tabs');
    var tGrupo = el('button', 'com-tab active', '👥 Mi Comunidad');
    tGrupo.type = 'button';
    tGrupo.dataset.tab = 'grupo';
    var tAsis = el('button', 'com-tab', '✅ Asistencia');
    tAsis.type = 'button';
    tAsis.dataset.tab = 'asistencia';
    var tOfr = el('button', 'com-tab', '💰 Ofrendas');
    tOfr.type = 'button';
    tOfr.dataset.tab = 'ofrendas';
    tabs.appendChild(tGrupo);
    tabs.appendChild(tAsis);
    tabs.appendChild(tOfr);
    content.appendChild(tabs);

    var panel = el('div', 'com-panel');
    panel.id = 'comPanel';
    content.appendChild(panel);

    function renderGrupo() {
      tGrupo.classList.add('active');
      tAsis.classList.remove('active');
      tOfr.classList.remove('active');
      panel.innerHTML = '';

      if (!mine.length) {
        var es = V.emptyState('🤝', 'Aún no tienes comunidades', 'Crea tu primera comunidad para comenzar.');
        var esBtn = el('button', 'btn btn-primary', '＋ Nueva Comunidad');
        esBtn.type = 'button';
        esBtn.addEventListener('click', openNuevaComunidadModal);
        es.appendChild(esBtn);
        panel.appendChild(es);
        return;
      }
      if (!currComId || !comunidadById(currComId)) currComId = mine[0].id;

      var list = el('div', 'com-toolbar');
      var sel = document.createElement('select');
      sel.className = 'select';
      mine.forEach(function (c) {
        var opt = document.createElement('option');
        opt.value = c.id; opt.textContent = c.nombre + ' (' + tipoLabel(c.tipo) + ')';
        opt.selected = c.id === currComId;
        sel.appendChild(opt);
      });
      sel.addEventListener('change', function () {
        currComId = this.value;
        renderGrupo();
      });
      list.appendChild(sel);
      var btnNew = el('button', 'btn btn-outline btn-sm', '+ Nueva comunidad');
      btnNew.type = 'button';
      btnNew.addEventListener('click', openNuevaComunidadModal);
      list.appendChild(btnNew);
      panel.appendChild(list);

      panel.appendChild(renderVinculacion(currComId));
    }

    function renderAsistencia() {
      tAsis.classList.add('active');
      tGrupo.classList.remove('active');
      tOfr.classList.remove('active');
      panel.innerHTML = '';

      if (!mine.length) {
        panel.appendChild(V.emptyState('✅', 'Sin comunidades', 'Crea una comunidad para registrar asistencia.'));
        return;
      }
      if (!currComId || !comunidadById(currComId)) currComId = mine[0].id;
      panel.appendChild(renderAsistenciaChecklist(currComId, panel));
    }

    function renderOfrendas() {
      tOfr.classList.add('active');
      tGrupo.classList.remove('active');
      tAsis.classList.remove('active');
      panel.innerHTML = '';

      if (!mine.length) {
        panel.appendChild(V.emptyState('💰', 'Sin comunidades', 'Crea una comunidad para cargar ofrendas de grupo.'));
        return;
      }
      if (!currComId || !comunidadById(currComId)) currComId = mine[0].id;

      var toolbar = el('div', 'com-toolbar');
      var sel = document.createElement('select');
      sel.className = 'select';
      mine.forEach(function (c) {
        var opt = document.createElement('option');
        opt.value = c.id; opt.textContent = c.nombre + ' (' + tipoLabel(c.tipo) + ')';
        opt.selected = c.id === currComId;
        sel.appendChild(opt);
      });
      sel.addEventListener('change', function () {
        currComId = this.value;
        renderOfrendas();
      });
      toolbar.appendChild(sel);
      panel.appendChild(toolbar);

      panel.appendChild(renderOfrendasSection(currComId, panel));
    }

    tGrupo.addEventListener('click', function () { tabActivo = 'grupo'; renderGrupo(); });
    tAsis.addEventListener('click', function () { tabActivo = 'asistencia'; renderAsistencia(); });
    tOfr.addEventListener('click', function () { tabActivo = 'ofrendas'; renderOfrendas(); });

    if (tabActivo === 'asistencia') renderAsistencia();
    else if (tabActivo === 'ofrendas') renderOfrendas();
    else renderGrupo();
  }

  function renderVinculacion(comId) {
    var com = comunidadById(comId);
    var base = el('div');

    var card = el('div', 'com-card');
    card.appendChild(el('h3', '', '👥 Miembros de "' + (com ? com.nombre : '') + '"'));
    var miembrosCom = miembrosDe(comId);
    if (!miembrosCom.length) {
      card.appendChild(el('p', 'com-empty', 'Aún no hay miembros vinculados. Usa el selector para añadir contactos del CRM.'));
    } else {
      var rows = el('div', '');
      miembrosCom.forEach(function (m) {
        var usr = usuarioDe(m.crmId);
        var row = el('div', 'com-member-row');
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = (m.estado || 'activo') === 'activo';
        cb.addEventListener('change', function () {
          var nuevo = cb.checked ? 'activo' : 'inactivo';
          V.db.collection(V.COL_COMUNIDAD_MIEMBROS).doc(m.id).update({ estado: nuevo })
            .then(function () { V.toast('Estado actualizado ✓'); return loadAll(); })
            .then(function () { renderPanel(); })
            .catch(function (e) { V.toast('Error: ' + e.message, true); });
        });
        row.appendChild(cb);
        var name = el('span', 'com-member-name', userFullName(usr));
        row.appendChild(name);
        var badge = el('span', 'com-member-badge estado-' + ((m.estado || 'activo').replace('_', '-')), estadoLabel(m.estado));
        row.appendChild(badge);
        var del = el('button', 'btn btn-danger btn-sm', '✕');
        del.type = 'button';
        del.addEventListener('click', function () {
          if (!confirm('¿Desvincular a ' + userFullName(usr) + ' de esta comunidad?')) return;
          V.db.collection(V.COL_COMUNIDAD_MIEMBROS).doc(m.id).delete()
            .then(function () { V.toast('Miembro desvinculado ✓'); return loadAll(); })
            .then(function () { renderPanel(); })
            .catch(function (e) { V.toast('Error: ' + e.message, true); });
        });
        row.appendChild(del);
        rows.appendChild(row);
      });
      card.appendChild(rows);
    }
    base.appendChild(card);

    // Panel de acciones de administración
    var acciones = el('div', 'com-actions');
    var btnAgregar = el('button', 'btn btn-primary', '➕ Añadir Miembro');
    btnAgregar.type = 'button';
    btnAgregar.addEventListener('click', function () { openAñadirMiembroModal(comId); });
    acciones.appendChild(btnAgregar);
    var btnEditar = el('button', 'btn btn-outline', '⚙️ Editar Comunidad / Cambiar Coordinador');
    btnEditar.type = 'button';
    btnEditar.addEventListener('click', function () { openEditarComunidadModal(comId); });
    acciones.appendChild(btnEditar);
    base.appendChild(acciones);

    return base;
  }

  function usuarioDe(crmId) {
    for (var i = 0; i < usuarios.length; i++) if (usuarios[i].uid === crmId) return usuarios[i];
    return null;
  }

  function renderAsistenciaChecklist(comId, parent) {
    var com = comunidadById(comId);
    var base = el('div');

    // 1) Programar nueva reunión (se refresca en sitio al guardar)
    base.appendChild(renderProgramarReunion(comId, function (id) {
      currReunionId = id;
      recargar();
      renderLista();
      renderDetalle();
    }));

    // 2) Listado de reuniones + panel de validación
    var card = el('div', 'com-card');
    card.appendChild(el('h3', '', '🗓️ Reuniones y asistencia — ' + (com ? com.nombre : '')));
    card.appendChild(el('p', 'com-meeting-help', 'Selecciona una reunión y marca a los asistentes. Quienes queden sin marcar se registran como falta.'));

    var listaWrap = el('div', 'com-meeting-list');
    var detalleWrap = el('div', 'com-meeting-detail');
    card.appendChild(listaWrap);
    card.appendChild(detalleWrap);
    base.appendChild(card);

    var reunionesCom = [];

    function recargar() {
      reunionesCom = reuniones.filter(function (r) { return r.comunidadId === comId; })
        .sort(function (a, b) { return ordenReunionesAsc(b, a); });
    }

    function buscarReunion(id) {
      for (var i = 0; i < reunionesCom.length; i++) if (reunionesCom[i].id === id) return reunionesCom[i];
      return null;
    }

    function renderLista() {
      listaWrap.innerHTML = '';
      if (!reunionesCom.length) {
        listaWrap.appendChild(V.emptyState('📅', 'Sin reuniones programadas', 'Usa el formulario de arriba para programar la primera reunión.'));
        return;
      }
      reunionesCom.forEach(function (r) {
        var c = conteoAsistencia(r, comId);
        var row = el('div', 'com-meeting-row' + (r.id === currReunionId ? ' active' : ''));
        var info = el('div', 'com-meeting-info');
        info.appendChild(el('div', 'com-meeting-title', r.titulo || 'Reunión de la comunidad'));
        info.appendChild(el('div', 'com-meeting-meta',
          tipoReunionIcon(r.tipo) + ' ' + tipoReunionLabel(r.tipo) + ' · ' + fechaHoraTexto(r)));
        info.appendChild(el('div', 'com-meeting-counts',
          '🟢 ' + c.asistio + ' asistieron · ❌ ' + c.falta + ' faltas · ✅ ' + c.confirmado + ' confirmados · ⏳ ' + c.pendiente + ' pendientes'));
        row.appendChild(info);
        var btn = el('button', 'btn btn-outline btn-sm', r.id === currReunionId ? 'Validando…' : 'Validar asistencia');
        btn.type = 'button';
        btn.addEventListener('click', function () {
          currReunionId = r.id;
          renderLista();
          renderDetalle();
        });
        row.appendChild(btn);
        listaWrap.appendChild(row);
      });
    }

    function renderDetalle() {
      detalleWrap.innerHTML = '';
      var reu = buscarReunion(currReunionId);
      if (!reu) {
        detalleWrap.appendChild(el('p', 'com-empty', 'Selecciona una reunión para validar la asistencia.'));
        return;
      }

      var box = el('div', 'com-meeting-validate');
      var head = el('div', 'com-card-head');
      head.appendChild(el('h4', '', reu.titulo || 'Reunión de la comunidad'));
      head.appendChild(el('span', 'com-badge tipo-' + (reu.tipo || 'presencial'),
        tipoReunionIcon(reu.tipo) + ' ' + tipoReunionLabel(reu.tipo)));
      box.appendChild(head);
      box.appendChild(el('p', 'com-meeting-meta', '🗓️ ' + fechaHoraTexto(reu)));

      var desc = typeof reu.descripcion === 'string' ? reu.descripcion.trim() : '';
      if (desc) box.appendChild(el('p', 'com-next-desc', desc));

      var actives = miembrosActivosDe(comId);
      if (!actives.length) {
        box.appendChild(V.emptyState('👥', 'Sin miembros activos', 'Víncula miembros activos para registrar asistencia.'));
        detalleWrap.appendChild(box);
        return;
      }

      var listaMiembros = el('div', 'com-asistencia-list');
      actives.forEach(function (m) {
        var usr = usuarioDe(m.crmId);
        var st = estadoAsistencia(reu, m.crmId);
        var meta = metaEstadoAsistencia(st);
        var row = el('label', 'com-member-row');
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = st === 'asistio';
        cb.dataset.crmId = m.crmId;
        row.appendChild(cb);
        row.appendChild(el('span', 'com-member-name', userFullName(usr)));
        row.appendChild(el('span', 'com-asistencia-pill st-' + st, meta.icon + ' ' + meta.label));
        listaMiembros.appendChild(row);
      });
      box.appendChild(listaMiembros);

      var actions = el('div', 'form-actions');
      var btnSave = el('button', 'btn btn-primary', '💾 Guardar asistencia y faltas');
      btnSave.type = 'button';
      actions.appendChild(btnSave);
      if (isAdmin()) {
        var btnDel = el('button', 'btn btn-danger', '🗑️ Eliminar reunión');
        btnDel.type = 'button';
        btnDel.addEventListener('click', function () {
          if (!confirm('¿Eliminar esta reunión y sus registros de asistencia?')) return;
          btnDel.disabled = true;
          V.db.collection(COL_REUNIONES).doc(reu.id).delete()
            .then(function () {
              V.toast('Reunión eliminada ✓');
              if (currReunionId === reu.id) currReunionId = null;
              return loadReuniones();
            })
            .then(function () {
              recargar();
              if (!currReunionId && reunionesCom.length) currReunionId = reunionesCom[0].id;
              renderLista();
              renderDetalle();
            })
            .catch(function (e) {
              V.toast('Error al eliminar la reunión: ' + e.message, true);
              btnDel.disabled = false;
            });
        });
        actions.appendChild(btnDel);
      }
      box.appendChild(actions);
      detalleWrap.appendChild(box);

      btnSave.addEventListener('click', function () {
        var asistencias = {};
        var asistencia = {};
        Object.keys(reu.asistencias || {}).forEach(function (k) { asistencias[k] = reu.asistencias[k]; });
        Object.keys(reu.asistencia || {}).forEach(function (k) { asistencia[k] = reu.asistencia[k]; });
        var checks = listaMiembros.querySelectorAll('input[type="checkbox"][data-crm-id]');
        for (var i = 0; i < checks.length; i++) {
          var uid = checks[i].dataset.crmId;
          var presente = !!checks[i].checked;
          asistencias[uid] = presente ? 'asistio' : 'falta';
          asistencia[uid] = presente;
        }
        btnSave.disabled = true;
        btnSave.textContent = '⏳ Guardando…';
        V.db.collection(COL_REUNIONES).doc(reu.id).set({
          asistencia: asistencia,
          asistencias: asistencias,
          actualizado: new Date().toISOString()
        }, { merge: true })
          .then(function () {
            V.toast('Asistencia y faltas guardadas ✓');
            return loadReuniones();
          })
          .then(function () {
            recargar();
            renderLista();
            renderDetalle();
          })
          .catch(function (e) {
            V.toast('Error al guardar la asistencia: ' + e.message, true);
            btnSave.disabled = false;
            btnSave.textContent = '💾 Guardar asistencia y faltas';
          });
      });
    }

    recargar();
    if (!currReunionId || !buscarReunion(currReunionId)) {
      var prox = proximaReunion(comId);
      var elegida = prox || reunionesCom[0] || null;
      currReunionId = elegida ? elegida.id : null;
    }
    renderLista();
    renderDetalle();

    return base;
  }

  // Formulario para programar una reunión (coordinador/admin).
  function renderProgramarReunion(comId, onSaved) {
    var card = el('div', 'com-card com-meeting-form-card');
    card.appendChild(el('h3', '', '➕ Programar nueva reunión'));

    var grid = el('div', 'com-form-grid two');

    function field(label, control, full) {
      var f = el('div', 'field' + (full ? ' com-form-full' : ''));
      var l = el('label', '', label);
      l.htmlFor = control.id;
      f.appendChild(l);
      f.appendChild(control);
      return f;
    }

    var inputTitulo = document.createElement('input');
    inputTitulo.type = 'text';
    inputTitulo.className = 'input';
    inputTitulo.id = 'comReuTitulo';
    inputTitulo.placeholder = 'Ej: Reunión semanal de la comunidad';
    grid.appendChild(field('Título de la reunión', inputTitulo, true));

    var inputFecha = document.createElement('input');
    inputFecha.type = 'date';
    inputFecha.className = 'input';
    inputFecha.id = 'comReuFecha';
    inputFecha.value = hoyISO();
    grid.appendChild(field('Fecha', inputFecha));

    var inputHora = document.createElement('input');
    inputHora.type = 'time';
    inputHora.className = 'input';
    inputHora.id = 'comReuHora';
    inputHora.value = '18:00';
    grid.appendChild(field('Hora', inputHora));

    var selectTipo = document.createElement('select');
    selectTipo.className = 'select';
    selectTipo.id = 'comReuTipo';
    Object.keys(TIPOS_REUNION).forEach(function (k) {
      var opt = document.createElement('option');
      opt.value = k;
      opt.textContent = TIPOS_REUNION[k].icon + ' ' + TIPOS_REUNION[k].label;
      selectTipo.appendChild(opt);
    });
    grid.appendChild(field('Tipo de reunión', selectTipo));

    var inputDesc = document.createElement('textarea');
    inputDesc.className = 'textarea';
    inputDesc.id = 'comReuDescripcion';
    inputDesc.rows = 3;
    inputDesc.placeholder = 'Tema, lugar o enlace de la reunión (opcional)…';
    grid.appendChild(field('Descripción (opcional)', inputDesc, true));

    card.appendChild(grid);

    var actions = el('div', 'form-actions');
    var btn = el('button', 'btn btn-primary', '📅 Programar reunión');
    btn.type = 'button';
    actions.appendChild(btn);
    card.appendChild(actions);

    btn.addEventListener('click', function () {
      if (!V.db) { V.toast('Firestore no está disponible.', true); return; }
      var titulo = (inputTitulo.value || '').trim();
      var fecha = inputFecha.value;
      var hora = inputHora.value;
      var tipo = selectTipo.value || 'presencial';
      if (!titulo) { V.toast('Escribe el título de la reunión.', true); return; }
      if (!fecha) { V.toast('Selecciona la fecha de la reunión.', true); return; }
      if (!hora) { V.toast('Selecciona la hora de la reunión.', true); return; }
      var d = new Date(fecha + 'T' + hora + ':00');
      if (isNaN(d.getTime())) { V.toast('La fecha u hora no es válida.', true); return; }

      var asistencias = {};
      miembrosActivosDe(comId).forEach(function (m) { asistencias[m.crmId] = 'pendiente'; });

      btn.disabled = true;
      btn.textContent = '⏳ Programando…';
      V.db.collection(COL_REUNIONES).add({
        comunidadId: comId,
        titulo: titulo,
        descripcion: (inputDesc.value || '').trim(),
        fecha: fecha,
        hora: hora,
        tipo: tipo,
        fechaReunion: d.toISOString(),
        asistencias: asistencias,
        asistencia: {},
        creado: new Date().toISOString(),
        actualizado: new Date().toISOString()
      }).then(function (ref) {
        V.toast('Reunión programada ✓');
        currReunionId = ref.id;
        btn.disabled = false;
        btn.textContent = '📅 Programar reunión';
        inputTitulo.value = '';
        inputDesc.value = '';
        return loadReuniones().then(function () {
          if (typeof onSaved === 'function') onSaved(ref.id);
          else renderPanel();
        });
      }).catch(function (e) {
        V.toast('Error al programar la reunión: ' + e.message, true);
        btn.disabled = false;
        btn.textContent = '📅 Programar reunión';
      });
    });

    return card;
  }

  /* ─── OFRENDAS DE GRUPO (coordinador / admin) ─────────────── */
  // Sección integrada junto al control de asistencia en la vista de
  // detalle de una comunidad. Reutiliza la API de Finanzas: la ofrenda
  // se registra como transacción tipo 'grupo' a nombre del coordinador
  // con su comisión de nivel 1 automática; aquí se muestra además el
  // desglose MLM (niveles 1–5) como vista informativa de la red.
  //
  // Tolerancia a fallos: el formulario y el listado se renderizan SIEMPRE.
  // Si config/finanzas no existe (documento sin inicializar) o la carga
  // falla (red, reglas), se usan valores por defecto: configuración activa
  // con la categoría 'ofrenda_grupo' y porcentaje del coordinador.
  var OFR_FALLBACK_CATS = [
    { id: 'ofrenda_grupo', nombre: 'Ofrenda de grupo', tipo: 'grupo', activa: true }
  ];
  var OFR_PCT_DEFAULT = 30;

  function categoriasGrupoSeguro() {
    var cats = [];
    try {
      if (V.finanzas && typeof V.finanzas.categoriasDeTipo === 'function') {
        cats = V.finanzas.categoriasDeTipo('grupo', true) || [];
      }
    } catch (e) {
      if (window.console && console.error) console.error('[comunidades] no se pudieron leer las categorías de grupo:', e);
      cats = [];
    }
    return (Array.isArray(cats) && cats.length) ? cats.slice() : OFR_FALLBACK_CATS.slice();
  }

  function pctCoordinadorSeguro() {
    try {
      if (V.finanzas && V.finanzas._initialConfig && V.finanzas._initialConfig.porcentajeCoordinador != null) {
        var n = Number(V.finanzas._initialConfig.porcentajeCoordinador);
        if (isFinite(n) && n > 0) return Math.min(100, n);
      }
    } catch (e) { /* noop */ }
    return OFR_PCT_DEFAULT;
  }

  function renderOfrendasSection(comId, parent) {
    var com = comunidadById(comId);
    var base = el('div');

    var card = el('div', 'com-card');
    card.appendChild(el('h3', '', '💰 Ofrendas de grupo — ' + (com ? com.nombre : 'Sin comunidad')));
    base.appendChild(card);

    var cell = el('div', '');
    card.appendChild(cell);
    var listBox = el('div', '');
    listBox.id = 'comOfrendaList';
    cell.appendChild(listBox);

    // Render inmediato y seguro: si la configuración real aún no está
    // disponible se usan categorías/ajustes por defecto.
    renderOfrendaForm(cell, com, listBox);
    renderOfrendaList(listBox, com);

    if (!V.db || !V.finanzas || typeof V.finanzas.loadConfig !== 'function') return base;

    // Carga real de config/finanzas: si existe y está desactivada se muestra
    // el aviso correspondiente; si existe y está activa se re-pinta con las
    // categorías y porcentaje reales. Si la carga falla (documento ausente,
    // red, reglas) se conserva el fallback seguro ya renderizado.
    V.finanzas.loadConfig().then(function () {
      if (!document.body.contains(card)) return;
      var enabled = true;
      try { enabled = !!V.finanzas.isEnabled(); } catch (e) { enabled = true; }
      if (!enabled) {
        cell.innerHTML = '';
        cell.appendChild(el('p', 'com-empty', 'El módulo de Finanzas está desactivado. El administrador puede activarlo desde su panel (💰 Finanzas).'));
        return;
      }
      if (com && !com.coordinadorId) {
        cell.innerHTML = '';
        cell.appendChild(el('p', 'com-empty', 'Esta comunidad no tiene coordinador asignado; asígnalo (' + (isAdmin() || isSuperadmin() ? 'Cambiar Coordinador' : 'ponte en contacto con el administrador') + ') para poder liquidar ofrendas.'));
        return;
      }
      // Re-render con la configuración real (categorías y % del coordinador).
      cell.innerHTML = '';
      cell.appendChild(listBox);
      renderOfrendaForm(cell, com, listBox);
      renderOfrendaList(listBox, com);
    }).catch(function (e) {
      if (window.console && console.error) console.error('[comunidades] configuración de Finanzas no disponible; se usan valores por defecto:', e);
    });

    return base;
  }

  function renderOfrendaForm(container, com, listBox) {
    var wrap = el('div', 'fin-form');
    container.appendChild(el('div', 'fin-subhead', 'Cargar ofrenda'));

    var cats = categoriasGrupoSeguro();
    var moduloOk = !!(V.finanzas && typeof V.finanzas.liquidarOfrendaGrupo === 'function' && V.db);

    var fCat = el('div', 'field');
    fCat.appendChild(el('label', '', 'Categoría'));
    var selCat = document.createElement('select');
    selCat.className = 'select';
    fCat.appendChild(selCat);
    wrap.appendChild(fCat);

    var fMonto = el('div', 'field');
    fMonto.appendChild(el('label', '', 'Monto'));
    var inputMonto = document.createElement('input');
    inputMonto.type = 'number';
    inputMonto.className = 'input';
    inputMonto.min = '1';
    inputMonto.step = '1';
    inputMonto.placeholder = 'Ej: 50000';
    fMonto.appendChild(inputMonto);
    wrap.appendChild(fMonto);

    var fCon = el('div', 'field');
    fCon.appendChild(el('label', '', 'Concepto (opcional)'));
    var inputCon = document.createElement('input');
    inputCon.type = 'text';
    inputCon.className = 'input';
    inputCon.placeholder = 'Ej: Ofrenda de la reunión del domingo';
    fCon.appendChild(inputCon);
    wrap.appendChild(fCon);

    var note = el('p', 'fin-form-note', '');
    wrap.appendChild(note);

    var acciones = el('div', 'fin-form-acciones');
    var btn = el('button', 'btn btn-primary', 'Cargar ofrenda');
    btn.type = 'button';
    acciones.appendChild(btn);
    wrap.appendChild(acciones);
    container.appendChild(wrap);

    cats.forEach(function (c) {
      var opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.nombre || c.id;
      selCat.appendChild(opt);
    });

    var coord = coordinadorDe(com);
    var pctCoord = pctCoordinadorSeguro();

    if (!moduloOk) {
      note.textContent = !V.finanzas
        ? 'El módulo de Finanzas no está disponible en esta sesión; contacta al administrador. Se muestran los valores por defecto.'
        : 'La base de datos no está disponible en esta sesión.';
      btn.disabled = true;
    } else if (!cats.length) {
      note.textContent = 'No hay categorías de ofrenda de grupo activas. El administrador puede agregarlas en 💰 Finanzas.';
      btn.disabled = true;
    } else {
      note.textContent = 'La ofrenda se registra a nombre del coordinador ' +
        ((com && (coord ? userFullName(coord) : (com.coordinadorId || '—'))) || '—') +
        ' y su comisión de nivel 1 (' + pctCoord + '%) se carga automáticamente.';
    }

    btn.addEventListener('click', function () {
      if (!moduloOk) { V.toast('El módulo de Finanzas no está disponible.', true); return; }
      if (!com || !com.id) { V.toast('Selecciona una comunidad válida.', true); return; }
      var catId = selCat.value;
      var monto = inputMonto.value;
      if (!catId) { V.toast('Selecciona la categoría de la ofrenda.', true); return; }
      if (!(Number(monto) > 0)) { V.toast('Escribe un monto válido mayor a cero.', true); return; }
      btn.disabled = true;
      btn.textContent = '⏳ Cargando…';
      V.finanzas.liquidarOfrendaGrupo({
        comunidadId: com.id,
        categoriaId: catId,
        monto: monto,
        concepto: inputCon.value
      }).then(function () {
        V.toast('Ofrenda de grupo cargada y comisión N1 del coordinador registrada ✓');
        inputMonto.value = '';
        inputCon.value = '';
        if (listBox) renderOfrendaList(listBox, com, true);
      }).catch(function (e) {
        V.toast(e && e.message ? e.message : 'Error al cargar la ofrenda.', true);
        btn.disabled = false;
        btn.textContent = 'Cargar ofrenda';
      });
    });
  }

  function renderOfrendaList(container, com, forzar) {
    var box = container;
    box.innerHTML = '';
    if (!com) {
      box.appendChild(el('p', 'fin-empty', 'Comunidad no encontrada.'));
      return;
    }
    box.appendChild(el('p', 'fin-loading', 'Cargando ofrendas…'));

    loadOfrendas(!!forzar).then(function (rows) {
      if (!document.body.contains(box)) return;
      var comId = com.id;
      var comOfr = (rows || []).filter(function (o) { return o.comunidadId === comId && String(o.tipo) === 'grupo'; })
        .sort(function (a, b) { return (b.fecha || '').localeCompare(a.fecha || ''); });
      box.innerHTML = '';

      var total = 0;
      comOfr.forEach(function (o) { total += Number(o.monto) || 0; });
      var stats = el('div', 'fin-stats');
      stats.appendChild(statMini('Ofrendas', String(comOfr.length)));
      stats.appendChild(statMini('Total ofrendado', fmtMoneda(total)));
      stats.appendChild(statMini('Última', comOfr.length && comOfr[0].fecha ? V.fmtDate(comOfr[0].fecha) : '—'));
      box.appendChild(stats);

      if (!comOfr.length) {
        box.appendChild(el('p', 'com-empty', 'Sin ofrendas de grupo registradas en esta comunidad.'));
        return;
      }
      comOfr.forEach(function (o) {
        var cat = (V.finanzas && typeof V.finanzas.categoriaById === 'function' && V.finanzas.categoriaById(o.categoriaId)) ||
          { nombre: o.categoriaId || '—' };
        var row = el('div', 'fin-fila');
        var info = el('div', 'fin-fila-info');
        info.appendChild(el('div', 'fin-fila-titulo', cat.nombre || '—'));
        var subTxt = '' + (o.concepto ? o.concepto + ' · ' : '') + (o.fecha ? V.fmtDate(o.fecha) : '') + ' · ' + (o.estado || 'liquidada');
        info.appendChild(el('div', 'fin-fila-sub', subTxt));
        row.appendChild(info);
        var right = el('div', 'fin-fila-info');
        right.appendChild(el('div', 'fin-fila-monto pos', fmtMoneda(o.monto)));
        right.appendChild(el('span', 'fin-pill oro', 'Grupo'));
        row.appendChild(right);
        box.appendChild(row);
        renderDesgloseMLM(box, o);
      });
    }).catch(function () {
      if (!document.body.contains(box)) return;
      box.innerHTML = '';
      box.appendChild(el('p', 'fin-empty', 'No se pudieron cargar las ofrendas de esta comunidad.'));
    });
  }

  function statMini(label, value) {
    var c = el('div', 'fin-stat');
    c.appendChild(el('div', 'fin-stat-label', label));
    c.appendChild(el('div', 'fin-stat-value', String(value)));
    return c;
  }

  // Desglose informativo del motor MLM (niveles 1–5) sobre el coordinador
  // de la ofrenda: muestra cómo se repartirían las comisiones de red por
  // sponsorId. No persiste niveles 2–5 (la contabilidad registrada es la
  // transacción + comisión N1 del coordinador).
  function renderDesgloseMLM(container, tx) {
    if (!V.mlm || typeof V.mlm.calcularPayload !== 'function') return;
    var d = document.createElement('details');
    d.className = 'fin-desglose';
    var s = document.createElement('summary');
    s.appendChild(el('span', '', '🌳 Desglose MLM (informativo) de esta ofrenda'));
    d.appendChild(s);
    var body = el('div', 'fin-desglose-body');
    body.appendChild(el('p', 'fin-loading', 'Calculando distribución…'));
    d.appendChild(body);
    container.appendChild(d);

    V.mlm.calcularPayload({ userId: tx.userId, monto: tx.monto, concepto: tx.concepto || tx.categoriaId, fecha: tx.fecha })
      .then(function (payload) {
        body.innerHTML = '';
        var comisiones = payload.comisiones || [];
        if (!payload.mlmEnabled) { body.appendChild(el('p', 'fin-empty', 'El módulo MLM (red de referidos) está desactivado.')); return; }
        if (!comisiones.length) { body.appendChild(el('p', 'fin-empty', 'Sin patrocinadores ascendentes: esta ofrenda no genera comisiones de red.')); return; }
        comisiones.forEach(function (c) {
          var row = el('div', 'fin-fila');
          var info = el('div', 'fin-fila-info');
          var u = usuarioDe(c.userId);
          info.appendChild(el('div', 'fin-fila-titulo', 'Nivel ' + c.nivel + ' · ' + c.porcentaje + '%'));
          info.appendChild(el('div', 'fin-fila-sub', 'Beneficiario: ' + (u ? userFullName(u) : String(c.userId))));
          row.appendChild(info);
          row.appendChild(el('div', 'fin-fila-monto pos', fmtMoneda(c.monto)));
          body.appendChild(row);
        });
      })
      .catch(function () {
        body.innerHTML = '';
        body.appendChild(el('p', 'fin-empty', 'No se pudo calcular el desglose en este momento.'));
      });
  }

  /* ─── GLOBAL PANEL (Admin) ──────────────────────────────────── */
  function renderAdmin(content) {
    content.innerHTML = '';
    $('comunidadesSub').textContent = 'Visualización general segmentada por jerarquía y reportes de participación.';

    // Estadísticas
    var totalCom = comunidades.length;
    var totalMiembros = miembros.length;
    var activos = miembros.filter(function (m) { return (m.estado || 'activo') === 'activo'; }).length;
    var totalReuniones = reuniones.length;

    var stats = el('div', 'com-stats');
    [
      { value: totalCom, label: 'Comunidades' },
      { value: totalMiembros, label: 'Vinculaciones' },
      { value: activos, label: 'Miembros activos' },
      { value: totalReuniones, label: 'Reuniones registradas' }
    ].forEach(function (c) {
      var sc = el('div', 'com-stat-card');
      sc.appendChild(el('div', 'com-stat-value', String(c.value)));
      sc.appendChild(el('div', 'com-stat-label', c.label));
      stats.appendChild(sc);
    });
    content.appendChild(stats);

    // Jerarquía por tipo
    var hier = el('div', 'com-hierarchy');
    categorias.forEach(function (t) {
      var col = el('div', 'com-hier-col');
      var icon = t.value === 'precomunidad' ? '🌱' : t.value === 'miembros' ? '👥' : t.value === 'misionera' ? '🚀' : '🏷️';
      var h4 = el('h4', '', icon + ' ' + t.label);
      col.appendChild(h4);
      var list = el('ul', '');
      var delTipo = comunidades.filter(function (c) { return c.tipo === t.value; });
      if (!delTipo.length) {
        var li = el('li', '', 'Sin comunidades.');
        list.appendChild(li);
      }
      delTipo.forEach(function (c) {
        var li = el('li', '');
        var wrap = el('div', '');
        wrap.appendChild(el('span', 'com-hier-name', c.nombre));
        var coord = coordinadorDe(c);
        wrap.appendChild(el('div', 'com-hier-meta', 'Coord: ' + userFullName(coord) + ' · ' + miembrosActivosDe(c.id).length + ' activos'));
        li.appendChild(wrap);
        var btnEdit = el('button', 'btn btn-outline btn-sm', '✏️');
        btnEdit.type = 'button';
        btnEdit.title = 'Editar comunidad';
        btnEdit.addEventListener('click', function () { openEditarComunidadModal(c.id); });
        li.appendChild(btnEdit);
        var btnGest = el('button', 'btn btn-primary btn-sm', '🛠️ Gestionar');
        btnGest.type = 'button';
        btnGest.title = 'Administrar miembros y asistencia';
        btnGest.addEventListener('click', function () { openGestionarComunidad(c.id); });
        li.appendChild(btnGest);
        list.appendChild(li);
      });
      col.appendChild(list);
      hier.appendChild(col);
    });
    content.appendChild(hier);

    // Reporte de participación
    var report = el('div', 'com-card');
    report.appendChild(el('h3', '', '📊 Reportes de participación'));
    var table = el('table', 'com-report-table');
    var thead = el('thead', '', '');
    var trHead = el('tr', '', '');
    ['Comunidad', 'Tipo', 'Miembros activos', 'Reuniones', 'Participación media', 'Ofrendas', 'Acciones'].forEach(function (h) {
      trHead.appendChild(el('th', '', h));
    });
    thead.appendChild(trHead);
    table.appendChild(thead);
    var tbody = el('tbody', '', '');
    comunidades.forEach(function (c) {
      var tr = el('tr', '');
      tr.appendChild(el('td', '', c.nombre));
      tr.appendChild(el('td', '', tipoLabel(c.tipo)));
      var activosC = miembrosActivosDe(c.id);
      tr.appendChild(el('td', '', String(activosC.length)));
      var reuC = reuniones.filter(function (r) { return r.comunidadId === c.id; });
      tr.appendChild(el('td', '', String(reuC.length)));
      // participación media
      var pct = participacionMedia(reuC, c.id);
      tr.appendChild(el('td', '', pct + '%'));
      // ofrendas de grupo
      var ofrC = ofrendasCache.filter(function (o) { return o.comunidadId === c.id && String(o.tipo) === 'grupo'; });
      var totalOfr = 0;
      ofrC.forEach(function (o) { totalOfr += Number(o.monto) || 0; });
      tr.appendChild(el('td', '', ofrC.length ? ofrC.length + ' · ' + fmtMoneda(totalOfr) : '—'));
      // Acciones
      var tdActions = el('td', '');
      var btnEdit = el('button', 'btn btn-outline btn-sm', '✏️');
      btnEdit.type = 'button';
      btnEdit.title = 'Editar comunidad';
      btnEdit.addEventListener('click', function () { openEditarComunidadModal(c.id); });
      tdActions.appendChild(btnEdit);
      var btnGest = el('button', 'btn btn-primary btn-sm', '🛠️');
      btnGest.type = 'button';
      btnGest.title = 'Gestionar comunidad';
      btnGest.addEventListener('click', function () { openGestionarComunidad(c.id); });
      tdActions.appendChild(btnGest);
      tr.appendChild(tdActions);
      tbody.appendChild(tr);
    });
    if (!comunidades.length) {
      var tr = el('tr', '');
      var td = el('td', '', 'Sin comunidades aún.');
      td.setAttribute('colspan', '7');
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    report.appendChild(table);
    content.appendChild(report);

    // Administración de categorías de comunidad (solo superadmin)
    content.appendChild(renderCategoriasAdmin());
  }

  /* ─── CRUD CATEGORÍAS DE COMUNIDAD (admin) ─────────────────── */
  function renderCategoriasAdmin() {
    var card = el('div', 'com-card');
    card.appendChild(el('h3', '', '🏷️ Categorías de comunidad'));
    card.appendChild(el('p', '', 'Opciones del campo "Tipo" en el formulario de comunidades. Se guardan en la colección comunidad_categorias y los selectores los cargan automáticamente con getDocs.'));

    var form = el('div', 'com-form-grid two');
    var fValue = el('div', 'field');
    fValue.appendChild(el('label', '', 'Valor (identificador único)'));
    var inputValue = document.createElement('input');
    inputValue.type = 'text';
    inputValue.className = 'input';
    inputValue.placeholder = 'Ej: precomunidad';
    inputValue.id = 'comCatValue';
    fValue.appendChild(inputValue);
    form.appendChild(fValue);

    var fLabel = el('div', 'field');
    fLabel.appendChild(el('label', '', 'Etiqueta (texto visible)'));
    var inputLabel = document.createElement('input');
    inputLabel.type = 'text';
    inputLabel.className = 'input';
    inputLabel.placeholder = 'Ej: Precomunidad';
    inputLabel.id = 'comCatLabel';
    fLabel.appendChild(inputLabel);
    form.appendChild(fLabel);
    card.appendChild(form);

    var actions = el('div', 'com-actions');
    var btnSave = el('button', 'btn btn-primary', '➕ Agregar categoría');
    btnSave.type = 'button';
    btnSave.id = 'comCatSave';
    actions.appendChild(btnSave);
    var btnCancelEdit = el('button', 'btn btn-outline', 'Cancelar edición');
    btnCancelEdit.type = 'button';
    btnCancelEdit.id = 'comCatCancelEdit';
    btnCancelEdit.style.display = 'none';
    actions.appendChild(btnCancelEdit);
    card.appendChild(actions);

    var list = el('div', '');
    list.id = 'comCatList';
    card.appendChild(list);

    var editingCat = null;

    function renderList() {
      list.innerHTML = '';
      if (!categorias.length) {
        list.appendChild(el('p', 'com-empty', 'No hay categorías. Agrega la primera con el formulario.'));
        return;
      }
      categorias.forEach(function (c) {
        var row = el('div', 'com-member-row');
        row.appendChild(el('span', 'com-member-name', c.label));
        row.appendChild(el('span', 'com-member-badge', c.value));
        var btnEdit = el('button', 'btn btn-outline btn-sm', '✏️');
        btnEdit.type = 'button';
        btnEdit.title = 'Editar categoría';
        btnEdit.addEventListener('click', function () {
          editingCat = c;
          inputValue.value = c.value;
          inputLabel.value = c.label;
          btnSave.textContent = '💾 Guardar cambios';
          btnCancelEdit.style.display = '';
        });
        row.appendChild(btnEdit);
        var btnDel = el('button', 'btn btn-danger btn-sm', '🗑️');
        btnDel.type = 'button';
        btnDel.title = 'Eliminar categoría';
        btnDel.addEventListener('click', function () {
          if (!confirm('¿Eliminar la categoría "' + c.label + '"? Las comunidades que la usen conservarán el valor pero se mostrará sin etiqueta.')) return;
          V.db.collection(V.COL_COMUNIDAD_CATEGORIAS).doc(c.value).delete()
            .then(function () { V.toast('Categoría eliminada ✓'); return loadCategorias(); })
            .then(function () { renderPanel(); })
            .catch(function (e) { V.toast('Error al eliminar: ' + e.message, true); });
        });
        row.appendChild(btnDel);
        list.appendChild(row);
      });
    }

    function resetForm() {
      editingCat = null;
      inputValue.value = '';
      inputLabel.value = '';
      btnSave.textContent = '➕ Agregar categoría';
      btnCancelEdit.style.display = 'none';
    }

    btnCancelEdit.addEventListener('click', resetForm);
    renderList();

    function slugify(s) {
      return (s || '').trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '').slice(0, 40);
    }

    btnSave.addEventListener('click', function () {
      var value = slugify(inputValue.value);
      var label = inputLabel.value.trim();
      if (!value) { V.toast('Escribe un valor para la categoría.', true); return; }
      if (!label) { V.toast('Escribe la etiqueta visible.', true); return; }
      btnSave.disabled = true;
      var ref = V.db.collection(V.COL_COMUNIDAD_CATEGORIAS);
      var op;
      if (editingCat) {
        var oldValue = editingCat.value;
        if (oldValue === value) {
          op = ref.doc(value).update({ value: value, label: label });
        } else {
          // El valor (id) cambió: crea el nuevo documento, migra las
          // comunidades que usaban el valor antiguo y borra el anterior.
          op = ref.doc(value).set({ value: value, label: label, createdAt: new Date().toISOString() })
            .then(function () {
              return V.db.collection(V.COL_COMUNIDADES).where('tipo', '==', oldValue).get()
                .then(function (snap) {
                  var ups = [];
                  snap.forEach(function (d) { ups.push(d.ref.update({ tipo: value })); });
                  return Promise.all(ups);
                })
                .catch(function () { return null; });
            })
            .then(function () { return ref.doc(oldValue).delete(); });
        }
      } else {
        op = ref.doc(value).set({ value: value, label: label, createdAt: new Date().toISOString() });
      }
      op.then(function () {
        V.toast(editingCat ? 'Categoría actualizada ✓' : 'Categoría creada ✓');
        return loadCategorias();
      }).then(function () {
        renderPanel();
      }).catch(function (e) {
        V.toast('Error al guardar la categoría: ' + e.message, true);
        btnSave.disabled = false;
      });
    });

    return card;
  }

  function participacionMedia(reuC, comId) {
    if (!reuC.length) return 0;
    var totalPts = 0;
    var base = 0;
    reuC.forEach(function (r) {
      var c = conteoAsistencia(r, comId);
      var registrados = c.asistio + c.falta;
      if (!registrados) return; // reunión aún sin validar
      totalPts += Math.round((c.asistio / registrados) * 100);
      base++;
    });
    return base ? Math.round(totalPts / base) : 0;
  }

  /* ─── SHOW HOOK ─────────────────────────────────────────────── */
  function showComunidades() {
    loadAll().then(function () {
      renderPanel();
    }).catch(function (e) {
      var content = $('comunidadesContent');
      if (content) content.appendChild(V.emptyState('⚠️', 'Error al cargar', (e && e.message) || 'No se pudieron cargar los datos.'));
    });
  }

  V.onComunidadesShow = showComunidades;

  /* ─── MODULE INTERFACE ──────────────────────────────────────── */
  var ComunidadesModule = {
    onReady: function () {
      var btnNueva = $('btnNuevaComunidad');
      if (btnNueva) {
        btnNueva.addEventListener('click', openNuevaComunidadModal);
        var rol = V.userRole || 'estudiante';
        btnNueva.style.display = (rol === 'gestor' || rol === 'superadmin') ? '' : 'none';
      }
    }
  };

  V.registerModule(ComunidadesModule);
})();
