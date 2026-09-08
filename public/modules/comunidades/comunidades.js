/* ════════════════════════════════════════════════════════════════
   VCONV · Módulo Comunidades — Gestión de comunidades, miembros,
   control de asistencia y panel global de reportes.
   Colecciones:
     - comunidades          (id, nombre, tipo, coordinadorId, createdAt)
     - comunidad_miembros   (id, comunidadId, crmId, estado, fechaVinculacion)
     - reuniones            (id, comunidadId, fechaReunion, asistencia{crmId:bool})
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var V = window.VCONV;
  if (!V) { console.error('VCONV core not loaded'); return; }

  /* ─── HELPERS ───────────────────────────────────────────────── */
  function $(id) { return V.$(id); }
  function el(tag, cls, text) { return V.el(tag, cls, text); }

  var TIPOS = [
    { value: 'precomunidad', label: 'Precomunidad' },
    { value: 'miembros', label: 'Miembros' },
    { value: 'misionera', label: 'Misionera' }
  ];
  var ESTADOS = [
    { value: 'activo', label: 'Activo' },
    { value: 'inactivo', label: 'Inactivo' },
    { value: 'en_proceso', label: 'En proceso' }
  ];

  function tipoLabel(t) {
    for (var i = 0; i < TIPOS.length; i++) if (TIPOS[i].value === t) return TIPOS[i].label;
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

  /* ─── STATE ─────────────────────────────────────────────────── */
  var comunidades = [];
  var miembros = [];
  var reuniones = [];
  var usuarios = [];
  var currComId = null;     // comunidad seleccionada en coordinador
  var currReunionId = null; // reunión seleccionada

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

  function loadAll() {
    return Promise.all([loadUsuarios(), loadComunidades(), loadMiembros(), loadReuniones()]);
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
    var optTipo0 = document.createElement('option');
    optTipo0.value = ''; optTipo0.textContent = '— selecciona —';
    selectTipo.appendChild(optTipo0);
    TIPOS.forEach(function (t) {
      var opt = document.createElement('option');
      opt.value = t.value; opt.textContent = t.label;
      selectTipo.appendChild(opt);
    });
    fieldTipo.appendChild(selectTipo);
    card.appendChild(fieldTipo);

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
    TIPOS.forEach(function (t) {
      var opt = document.createElement('option');
      opt.value = t.value; opt.textContent = t.label;
      opt.selected = t.value === com.tipo;
      selectTipo.appendChild(opt);
    });
    fieldTipo.appendChild(selectTipo);
    card.appendChild(fieldTipo);

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
    reunionesCom.forEach(function (r) {
      if (r.asistencia && r.asistencia[crmId] === true) asistencias++;
    });
    return { total: reunionesCom.length, asistencias: asistencias };
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
      { value: asis.asistencias + ' de ' + asis.total, label: 'Reuniones asistidas' },
      { value: asis.total ? Math.round((asis.asistencias / asis.total) * 100) + '%' : '—', label: 'Participación' }
    ].forEach(function (c) {
      var sc = el('div', 'com-stat-card');
      sc.appendChild(el('div', 'com-stat-value', String(c.value)));
      sc.appendChild(el('div', 'com-stat-label', c.label));
      stats.appendChild(sc);
    });
    card.appendChild(stats);

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

    // Tabs: Mi Comunidad / Asistencia
    var tabs = el('div', 'com-tabs');
    var tGrupo = el('button', 'com-tab active', '👥 Mi Comunidad');
    tGrupo.type = 'button';
    tGrupo.dataset.tab = 'grupo';
    var tAsis = el('button', 'com-tab', '✅ Asistencia');
    tAsis.type = 'button';
    tAsis.dataset.tab = 'asistencia';
    tabs.appendChild(tGrupo);
    tabs.appendChild(tAsis);
    content.appendChild(tabs);

    var panel = el('div', 'com-panel');
    panel.id = 'comPanel';
    content.appendChild(panel);

    function renderGrupo() {
      tGrupo.classList.add('active');
      tAsis.classList.remove('active');
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
      panel.innerHTML = '';

      if (!mine.length) {
        panel.appendChild(V.emptyState('✅', 'Sin comunidades', 'Crea una comunidad para registrar asistencia.'));
        return;
      }
      if (!currComId || !comunidadById(currComId)) currComId = mine[0].id;
      panel.appendChild(renderAsistenciaChecklist(currComId, panel));
    }

    tGrupo.addEventListener('click', renderGrupo);
    tAsis.addEventListener('click', renderAsistencia);
    renderGrupo();
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

    var card = el('div', 'com-card');
    card.appendChild(el('h3', '', '✅ Control de asistencia — ' + (com ? com.nombre : '')));

    // Selector de reunión (semanal)
    var reunionesCom = reuniones.filter(function (r) { return r.comunidadId === comId; })
      .sort(function (a, b) { return (a.fechaReunion || '').localeCompare(b.fechaReunion || ''); });

    var toolbar = el('div', 'com-toolbar');
    var selReu = document.createElement('select');
    selReu.className = 'select';
    selReu.id = 'comReunionSel';
    var optNueva = document.createElement('option');
    optNueva.value = '__new__'; optNueva.textContent = '+ Nueva reunión semanal';
    selReu.appendChild(optNueva);
    reunionesCom.forEach(function (r) {
      var opt = document.createElement('option');
      opt.value = r.id; opt.textContent = 'Reunión ' + V.fmtDate(r.fechaReunion);
      opt.selected = r.id === currReunionId;
      selReu.appendChild(opt);
    });
    toolbar.appendChild(selReu);

    var fechaInput = document.createElement('input');
    fechaInput.type = 'date';
    fechaInput.className = 'input';
    fechaInput.id = 'comFechaInput';
    fechaInput.style.maxWidth = '180px';
    toolbar.appendChild(fechaInput);

    var btnLoad = el('button', 'btn btn-outline btn-sm', 'Cargar');
    btnLoad.type = 'button';
    btnLoad.id = 'comBtnCargar';
    toolbar.appendChild(btnLoad);
    card.appendChild(toolbar);

    var listWrap = el('div', '');
    listWrap.id = 'comAsistenciaList';
    card.appendChild(listWrap);

    base.appendChild(card);

    function defaultFecha() {
      var d = new Date();
      d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
      return d.toISOString().slice(0, 10);
    }

    function loadReunion(reunionId) {
      var reu = null;
      for (var i = 0; i < reunionesCom.length; i++) if (reunionesCom[i].id === reunionId) reu = reunionesCom[i];
      listWrap.innerHTML = '';
      if (!reu) {
        listWrap.appendChild(V.emptyState('📅', 'Reunión nueva', 'Registra la asistencia de los miembros activos para la reunión.'));
        return;
      }
      currReunionId = reu.id;
      renderChecklist(reu);
    }

    function renderChecklist(reu) {
      listWrap.innerHTML = '';
      fechaInput.value = reu.fechaReunion ? reu.fechaReunion.slice(0, 10) : defaultFecha();
      var actives = miembrosActivosDe(comId);
      if (!actives.length) {
        listWrap.appendChild(V.emptyState('👥', 'Sin miembros activos', 'Víncula miembros activos para registrar asistencia.'));
        return;
      }
      var asist = reu.asistencia || {};
      actives.forEach(function (m) {
        var usr = usuarioDe(m.crmId);
        var row = el('label', 'com-member-row');
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = asist[m.crmId] === true;
        cb.dataset.crmId = m.crmId;
        row.appendChild(cb);
        row.appendChild(el('span', 'com-member-name', userFullName(usr)));
        var pres = asist[m.crmId] === true ? 'Presente' : 'Ausente';
        row.appendChild(el('span', 'com-member-badge', pres));
        listWrap.appendChild(row);
      });

      var actions = el('div', 'form-actions');
      var btnSave = el('button', 'btn btn-primary', 'Guardar asistencia');
      btnSave.type = 'button';
      btnSave.id = 'comBtnGuardarAsistencia';
      actions.appendChild(btnSave);
      listWrap.appendChild(actions);

      btnSave.addEventListener('click', function () {
        var nuevosAsist = {};
        var checks = listWrap.querySelectorAll('input[type="checkbox"][data-crm-id]');
        for (var ci = 0; ci < checks.length; ci++) {
          nuevosAsist[checks[ci].dataset.crmId] = checks[ci].checked;
        }
        var fechaStr = fechaInput.value || defaultFecha();
        var docId = (comId + '__' + fechaStr).replace(/[^a-zA-Z0-9_]/g, '_');
        V.db.collection(V.COL_REUNIONES).doc(docId).set({
          id: docId,
          comunidadId: comId,
          fechaReunion: new Date(fechaStr + 'T12:00:00').toISOString(),
          asistencia: nuevosAsist
        }, { merge: true })
          .then(function () { V.toast('Asistencia guardada ✓'); return loadReuniones(); })
          .then(function () { renderPanel(); })
          .catch(function (e) { V.toast('Error: ' + e.message, true); });
      });
    }

    selReu.addEventListener('change', function () {
      if (this.value === '__new__') {
        listWrap.innerHTML = '';
        fechaInput.value = defaultFecha();
        var reuTmp = { id: null, fechaReunion: new Date(fechaInput.value).toISOString() };
        renderChecklist(reuTmp);
      } else {
        loadReunion(this.value);
      }
    });
    btnLoad.addEventListener('click', function () {
      var value = selReu.value;
      if (value === '__new__') {
        var reuTmp = { id: null, fechaReunion: new Date(fechaInput.value).toISOString() };
        renderChecklist(reuTmp);
      } else {
        loadReunion(value);
      }
    });

    // Cargar la primera reunión o nueva
    if (currReunionId && reunionesCom.some(function (r) { return r.id === currReunionId; })) {
      selReu.value = currReunionId;
      loadReunion(currReunionId);
    } else {
      var reuTmp = { id: null, fechaReunion: new Date(defaultFecha()).toISOString() };
      renderChecklist(reuTmp);
    }

    return base;
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
    TIPOS.forEach(function (t) {
      var col = el('div', 'com-hier-col');
      var h4 = el('h4', '', (t.value === 'precomunidad' ? '🌱' : t.value === 'miembros' ? '👥' : '🚀') + ' ' + t.label);
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
    ['Comunidad', 'Tipo', 'Miembros activos', 'Reuniones', 'Participación media', 'Acciones'].forEach(function (h) {
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
      td.setAttribute('colspan', '6');
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    report.appendChild(table);
    content.appendChild(report);
  }

  function participacionMedia(reuC, comId) {
    if (!reuC.length) return 0;
    var actives = miembrosActivosDe(comId).length;
    if (!actives) return 0;
    var totalPts = 0;
    reuC.forEach(function (r) {
      var asis = r.asistencia || {};
      var presentes = Object.keys(asis).filter(function (k) { return asis[k] === true; }).length;
      totalPts += Math.min(100, Math.round((presentes / actives) * 100));
    });
    return Math.round(totalPts / reuC.length);
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
