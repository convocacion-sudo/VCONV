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
  var usuariosUnsub = null;
  var usuariosCache = [];
  var perfilesCache = ['Líder 1', 'Líder 2', 'Líder 3', 'Prospecto', 'Miembro'];
  var perfilesUnsub = null;
  var barriosData = null;
  var editingUser = null;
  var filters = { search: '', rol: '', estado: '', perfil: '' };
  var selectedUids = new Set();

  /* ─── HELPERS ─────────────────────────────────────────────── */
  function $(id) { return V.$(id); }
  function el(tag, cls, text) { return V.el(tag, cls, text); }

  /* ─── LOAD BARRIOS DATA ───────────────────────────────────── */
  function loadBarrios() {
    if (barriosData) return Promise.resolve(barriosData);
    return fetch('modules/crm/data/barrios.json')
      .then(function (r) { return r.json(); })
      .then(function (d) { barriosData = d; return d; })
      .catch(function () { barriosData = {}; return {}; });
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
    td.setAttribute('colspan', '10');
    td.textContent = message || 'No se pudieron cargar los usuarios.';
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  /* ─── SUBSCRIBE PERFILES ──────────────────────────────────── */
  function subscribePerfiles() {
    if (!V.db || V.userRole !== 'superadmin') return;
    if (perfilesUnsub) return;
    try {
      perfilesUnsub = V.db.collection('config').doc('perfiles').onSnapshot(function (doc) {
        if (doc.exists && doc.data().categorias) {
          perfilesCache = doc.data().categorias;
        }
        renderAll();
      }, function (e) {
        // Error no bloqueante: se mantienen los perfiles por defecto.
        renderAll();
      });
    } catch (e) {
      renderAll();
    }
  }

  function savePerfiles() {
    if (!V.db) return;
    V.db.collection('config').doc('perfiles').set({ categorias: perfilesCache }, { merge: true })
      .catch(function (e) { V.toast('Error al guardar perfiles: ' + e.message, true); });
  }

  /* ─── RENDER ALL ──────────────────────────────────────────── */
  function renderAll() {
    renderStats();
    renderTable();
    renderProfiles();
  }

  /* ─── STATS ───────────────────────────────────────────────── */
  function renderStats() {
    var stats = $('adminStats');
    if (!stats) return;
    var total = usuariosCache.length;
    var estudiantes = usuariosCache.filter(function (u) { return u.rol === 'estudiante'; }).length;
    var gestores = usuariosCache.filter(function (u) { return u.rol === 'gestor'; }).length;
    var admins = usuariosCache.filter(function (u) { return u.rol === 'superadmin'; }).length;
    var activos = usuariosCache.filter(function (u) { return (u.estado || 'Activo') === 'Activo'; }).length;
    stats.innerHTML = '';
    [
      { value: total, label: 'Total' },
      { value: activos, label: 'Activos' },
      { value: estudiantes, label: 'Estudiantes' },
      { value: gestores, label: 'Gestores' },
      { value: admins, label: 'Admins' }
    ].forEach(function (c) {
      var card = el('div', 'admin-stat-card');
      card.appendChild(el('div', 'stat-value', String(c.value)));
      card.appendChild(el('div', 'stat-label', c.label));
      stats.appendChild(card);
    });
  }

  /* ─── FILTER ──────────────────────────────────────────────── */
  function applyFilters() {
    return usuariosCache.filter(function (u) {
      if (filters.search) {
        var q = filters.search.toLowerCase();
        var match = ((u.email || '') + ' ' + (u.nombre || '') + ' ' + (u.apellido || '')).toLowerCase();
        if (match.indexOf(q) === -1) return false;
      }
      if (filters.rol && u.rol !== filters.rol) return false;
      if (filters.estado && (u.estado || 'Activo') !== filters.estado) return false;
      if (filters.perfil && u.perfil !== filters.perfil) return false;
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
      td.setAttribute('colspan', '10');
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
      tr.appendChild(el('td', 'wrap', ((u.nombre || '') + ' ' + (u.apellido || '')).trim() || '—'));
      tr.appendChild(el('td', 'wrap', u.documento || '—'));
      tr.appendChild(el('td', 'wrap', u.telefono || '—'));

      // Ubicación
      var ubicacion = [u.ciudad, u.municipio, u.barrio === 'Otro' ? (u.barrioCustom || 'Otro') : u.barrio].filter(Boolean).join(', ');
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

      // Acciones
      var tdActions = el('td', 'admin-actions');
      var editBtn = el('button', 'admin-edit-btn', '✏');
      editBtn.title = 'Editar perfil';
      editBtn.addEventListener('click', function () { openForm(u); });
      var delBtn = el('button', 'admin-delete-btn', '✕');
      delBtn.title = 'Eliminar usuario';
      delBtn.addEventListener('click', function () { deleteUser(u.uid, u.email); });
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
  function bulkDeleteUsers() {
    var ids = Array.from(selectedUids);
    if (!ids.length) return;
    if (ids.length > 500) {
      V.toast('Selecciona un máximo de 500 usuarios por lote.', true);
      return;
    }
    if (!confirm('¿Eliminar ' + ids.length + (ids.length === 1 ? ' usuario' : ' usuarios') + ' seleccionado' + (ids.length === 1 ? '' : 's') + '? Esta acción no se puede deshacer.')) return;

    var db = V.db;
    var batch = db.batch();
    ids.forEach(function (uid) { batch.delete(db.collection(V.COL_USUARIOS).doc(uid)); });

    batch.commit()
      .then(function () {
        V.toast(ids.length + (ids.length === 1 ? ' usuario' : ' usuarios') + ' eliminado' + (ids.length === 1 ? '' : 's') + ' ✓');
        clearSelection();
      })
      .catch(function (e) {
        V.toast('Error al eliminar: ' + e.message, true);
        renderTable();
      });
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
    V.db.collection(V.COL_USUARIOS).doc(uid).delete()
      .then(function () { V.toast('Usuario eliminado ✓'); })
      .catch(function (e) { V.toast('Error: ' + e.message, true); });
  }

  /* ─── EXTENDED FORM ───────────────────────────────────────── */
  function openForm(user) {
    editingUser = user;
    var overlay = $('crmFormOverlay');
    overlay.classList.add('show');

    $('crmEmail').value = user.email || '';
    $('crmNombre').value = user.nombre || '';
    $('crmApellido').value = user.apellido || '';
    $('crmDocumento').value = user.documento || '';
    $('crmTelefono').value = user.telefono || '';
    $('crmRol').value = user.rol || 'estudiante';
    $('crmEstado').value = user.estado || 'Activo';
    $('crmCreado').value = user.creado ? V.fmtDate(user.creado) : '—';

    // Perfil
    var selPerfil = $('crmPerfil');
    selPerfil.innerHTML = '<option value="">—</option>';
    perfilesCache.forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p; opt.textContent = p;
      opt.selected = user.perfil === p;
      selPerfil.appendChild(opt);
    });

    // Location cascade
    loadBarrios().then(function () { initLocationCascade(user); });
  }

  function closeForm() {
    $('crmFormOverlay').classList.remove('show');
    editingUser = null;
  }

  function initLocationCascade(user) {
    var selCiudad = $('crmCiudad');
    var selMunicipio = $('crmMunicipio');
    var selBarrio = $('crmBarrio');
    var txtBarrioWrap = $('crmBarrioCustomWrap');
    var txtBarrio = $('crmBarrioCustom');

    // Populate cities
    selCiudad.innerHTML = '<option value="">—</option>';
    Object.keys(barriosData).forEach(function (c) {
      var opt = document.createElement('option');
      opt.value = c; opt.textContent = c;
      selCiudad.appendChild(opt);
    });
    var optOtroC = document.createElement('option');
    optOtroC.value = 'Otro'; optOtroC.textContent = 'Otro';
    selCiudad.appendChild(optOtroC);

    selCiudad.onchange = function () {
      populateMunicipios(this.value);
      selBarrio.innerHTML = '<option value="">—</option>';
      txtBarrioWrap.style.display = 'none';
    };
    selMunicipio.onchange = function () {
      populateBarrios(selCiudad.value, this.value);
    };
    selBarrio.onchange = function () {
      txtBarrioWrap.style.display = this.value === 'Otro' ? '' : 'none';
    };

    // Set initial values
    if (user.ciudad) {
      selCiudad.value = user.ciudad;
      populateMunicipios(user.ciudad);
      if (user.municipio) {
        selMunicipio.value = user.municipio;
        populateBarrios(user.ciudad, user.municipio);
        if (user.barrio) {
          selBarrio.value = user.barrio;
          txtBarrioWrap.style.display = user.barrio === 'Otro' ? '' : 'none';
          txtBarrio.value = user.barrioCustom || '';
        }
      }
    }
  }

  function populateMunicipios(ciudad) {
    var sel = $('crmMunicipio');
    sel.innerHTML = '<option value="">—</option>';
    if (!ciudad || ciudad === 'Otro') return;
    var munis = barriosData[ciudad];
    if (!munis) return;
    if (Array.isArray(munis)) {
      munis.forEach(function (m) {
        var opt = document.createElement('option');
        opt.value = m; opt.textContent = m;
        sel.appendChild(opt);
      });
    } else {
      Object.keys(munis).forEach(function (m) {
        var opt = document.createElement('option');
        opt.value = m; opt.textContent = m;
        sel.appendChild(opt);
      });
    }
    var optOtro = document.createElement('option');
    optOtro.value = 'Otro'; optOtro.textContent = 'Otro';
    sel.appendChild(optOtro);
  }

  function populateBarrios(ciudad, municipio) {
    var sel = $('crmBarrio');
    sel.innerHTML = '<option value="">—</option>';
    if (!ciudad || !municipio || municipio === 'Otro') return;
    var munis = barriosData[ciudad];
    if (!munis || !munis[municipio] || !Array.isArray(munis[municipio])) return;
    munis[municipio].forEach(function (b) {
      var opt = document.createElement('option');
      opt.value = b; opt.textContent = b;
      sel.appendChild(opt);
    });
    var optOtro = document.createElement('option');
    optOtro.value = 'Otro'; optOtro.textContent = 'Otro';
    sel.appendChild(optOtro);
  }

  function saveForm() {
    if (!editingUser || !V.db) return;
    var data = {
      apellido: $('crmApellido').value.trim(),
      documento: $('crmDocumento').value.trim(),
      telefono: $('crmTelefono').value.trim(),
      ciudad: $('crmCiudad').value,
      municipio: $('crmMunicipio').value,
      barrio: $('crmBarrio').value,
      barrioCustom: $('crmBarrio').value === 'Otro' ? $('crmBarrioCustom').value.trim() : '',
      rol: $('crmRol').value,
      estado: $('crmEstado').value,
      perfil: $('crmPerfil').value,
      nombre: $('crmNombre').value.trim()
    };

    if (editingUser.uid === V.userId && data.rol !== V.userRole) {
      V.toast('No puedes cambiar tu propio rol.', true);
      return;
    }

    V.db.collection(V.COL_USUARIOS).doc(editingUser.uid).update(data)
      .then(function () { V.toast('Perfil actualizado ✓'); closeForm(); })
      .catch(function (e) { V.toast('Error: ' + e.message, true); });
  }

  /* ─── PROFILE MANAGEMENT ──────────────────────────────────── */
  function renderProfiles() {
    var list = $('adminProfilesList');
    if (!list) return;
    list.innerHTML = '';
    perfilesCache.forEach(function (p, i) {
      var tag = el('span', 'profile-tag');
      tag.appendChild(document.createTextNode(p));
      var del = el('button', 'profile-tag-delete', '✕');
      del.title = 'Eliminar perfil';
      del.addEventListener('click', function () { removeProfile(i); });
      tag.appendChild(del);
      list.appendChild(tag);
    });
    populateFilterProfiles();
  }

  function addProfile() {
    var input = $('adminProfileInput');
    var val = input.value.trim();
    if (!val) return;
    if (perfilesCache.indexOf(val) !== -1) { V.toast('Ese perfil ya existe.', true); return; }
    perfilesCache.push(val);
    savePerfiles();
    input.value = '';
    V.toast('Perfil "' + val + '" añadido ✓');
  }

  function removeProfile(index) {
    var name = perfilesCache[index];
    if (!confirm('¿Eliminar el perfil "' + name + '"?')) return;
    perfilesCache.splice(index, 1);
    savePerfiles();
    V.toast('Perfil eliminado ✓');
  }

  /* ─── FILTERS ─────────────────────────────────────────────── */
  function bindFilters() {
    var searchInput = $('adminSearch');
    var rolSelect = $('adminFilterRol');
    var estadoSelect = $('adminFilterEstado');
    var perfilSelect = $('adminFilterPerfil');

    if (searchInput) {
      searchInput.addEventListener('input', function () {
        filters.search = this.value;
        renderTable();
      });
    }
    if (rolSelect) {
      rolSelect.addEventListener('change', function () {
        filters.rol = this.value;
        renderTable();
      });
    }
    if (estadoSelect) {
      estadoSelect.addEventListener('change', function () {
        filters.estado = this.value;
        renderTable();
      });
    }
    if (perfilSelect) {
      perfilSelect.addEventListener('change', function () {
        filters.perfil = this.value;
        renderTable();
      });
    }
  }

  function populateFilterProfiles() {
    var sel = $('adminFilterPerfil');
    if (!sel) return;
    // Keep first option
    while (sel.options.length > 1) sel.remove(1);
    perfilesCache.forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p; opt.textContent = p;
      sel.appendChild(opt);
    });
  }

  /* ─── MODULE INTERFACE ────────────────────────────────────── */
  var CrmModule = {
    onReady: function () {
      if (V.userRole !== 'superadmin') return;

      subscribeUsuarios();
      subscribePerfiles();
      bindFilters();

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

      // Profile management
      $('adminProfileAdd').addEventListener('click', addProfile);
      $('adminProfileInput').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); addProfile(); }
      });
    }
  };

  V.registerModule(CrmModule);
})();
