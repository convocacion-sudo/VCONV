/* ════════════════════════════════════════════════════════════════
   VCONV · Módulo Escritorio (Dashboard) — Centro de control por rol
   y sección "Mi Perfil" con edición y guardado en Firestore.
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var V = window.VCONV;
  if (!V) { console.error('VCONV core not loaded'); return; }

  var profileDirty = false;

  function $(id) { return V.$(id); }
  function el(tag, cls, text) { return V.el(tag, cls, text); }

  var ROLES = {
    estudiante: { label: 'Estudiante', icon: '🎓' },
    gestor: { label: 'Gestor', icon: '🛠' },
    superadmin: { label: 'Superadmin', icon: '🔐' }
  };

  /* ─── LOAD BARRIOS (datalist from Firestore) ─────────────── */
  function loadBarriosFromDb() {
    var datalist = $('pfBarrioList');
    if (!datalist || !V.db) return Promise.resolve();
    var seen = {};
    var addOpt = function (value) {
      value = (value || '').trim();
      if (!value || value === 'Otro' || seen[value]) return;
      seen[value] = true;
      var opt = document.createElement('option');
      opt.value = value;
      datalist.appendChild(opt);
    };
    return V.db.collection(V.COL_USUARIOS).get().then(function (snap) {
      datalist.innerHTML = '';
      snap.forEach(function (doc) {
        var d = doc.data();
        if (d.barrio) addOpt(d.barrio);
        if (d.barrioCustom) addOpt(d.barrioCustom);
      });
      if ($('pfBarrio') && $('pfBarrio').value) addOpt($('pfBarrio').value);
    }).catch(function () {
      if ($('pfBarrio') && $('pfBarrio').value) addOpt($('pfBarrio').value);
    });
  }

  /* ─── ACCESS CARDS ───────────────────────────────────────── */
  function renderCards() {
    var container = $('dashCards');
    if (!container) return;
    container.innerHTML = '';
    var rol = V.userRole || 'estudiante';
    var cards = [];

    if (rol === 'gestor') {
      cards.push({ icon: '📚', title: 'Mis Cursos', desc: 'Administra y edita tus cursos.', action: function () { V.setMode('gestor'); } });
      cards.push({ icon: '➕', title: 'Nuevo Curso', desc: 'Crea un curso y añade lecciones.', action: function () { if (V.onNewCourse) V.onNewCourse(); } });
    } else if (rol === 'estudiante') {
      cards.push({ icon: '📖', title: 'Catálogo de Cursos', desc: 'Explora y comienza tus cursos.', action: function () { V.setMode('estudiante'); } });
    }

    if (rol === 'superadmin') {
      cards.push({ icon: '🔐', title: 'Gestión de Usuarios', desc: 'Administra perfiles, roles y estados.', action: function () { V.setMode('admin'); } });
    }

    cards.push({ icon: '🤝', title: 'Comunidades', desc: rol === 'gestor' ? 'Administra tu grupo, miembros y asistencia.' : 'Tu comunidad, coordinador y asistencia.', action: function () { V.showComunidades(); } });

    cards.forEach(function (c) {
      var card = el('button', 'dash-card');
      card.type = 'button';
      var h3 = el('h3', 'dash-card-title', c.icon + ' ' + c.title);
      card.appendChild(h3);
      card.appendChild(el('p', 'dash-card-desc', c.desc));
      card.addEventListener('click', c.action);
      container.appendChild(card);
    });
  }

  /* ─── PROFILE ────────────────────────────────────────────── */
  function runCascade() {
    var selCiudad = $('pfCiudad');
    var inpBarrio = $('pfBarrio');
    var wrapCiudadOtro = $('pfCiudadOtroWrap');

    selCiudad.innerHTML = '<option value="">—</option>';
    ['Medellín', 'Envigado', 'Itagüí', 'Sabaneta', 'Bello', 'La Estrella', 'Caldas', 'Copacabana', 'Girardota', 'Barbosa'].forEach(function (c) {
      var opt = document.createElement('option');
      opt.value = c; opt.textContent = c;
      selCiudad.appendChild(opt);
    });
    var optOtroC = document.createElement('option');
    optOtroC.value = 'Otro'; optOtroC.textContent = 'Otro';
    selCiudad.appendChild(optOtroC);

    selCiudad.onchange = function () {
      var isOtro = this.value === 'Otro';
      wrapCiudadOtro.style.display = isOtro ? '' : 'none';
      if (!isOtro) $('pfCiudadOtro').value = '';
      inpBarrio.value = '';
      markDirty();
    };
    ['pfNombre', 'pfApellido', 'pfDocumento', 'pfTelefono', 'pfCiudadOtro', 'pfBarrio', 'pfNotas'].forEach(function (id) {
      var input = $(id);
      if (input) input.addEventListener('input', markDirty);
    });
    var selRangoEdad = $('pfRangoEdad');
    if (selRangoEdad) selRangoEdad.addEventListener('change', markDirty);

    var selSexo = $('pfSexo');
    var wrapSexoOtro = $('pfSexoOtroWrap');
    if (selSexo) {
      selSexo.addEventListener('change', function () {
        var isOtro = this.value === 'Otro';
        wrapSexoOtro.style.display = isOtro ? '' : 'none';
        if (!isOtro) $('pfSexoOtro').value = '';
        markDirty();
      });
      $('pfSexoOtro').addEventListener('input', markDirty);
    }
  }

  function setCascade(user) {
    var ciudad = user.ciudad || '';
    if (ciudad === 'Otro') {
      $('pfCiudadOtroWrap').style.display = '';
      $('pfCiudadOtro').value = user.ciudadCustom || '';
    }
    if (ciudad) {
      $('pfCiudad').value = ciudad;
      if (user.barrio) {
        $('pfBarrio').value = user.barrio;
      } else if (user.barrioCustom) {
        $('pfBarrio').value = user.barrioCustom;
      }
    }
  }

  function markDirty() { profileDirty = true; }

  function getFechaSuscripcion(user) {
    return user.fechaSuscripcion || user.createdAt || user.creado || '';
  }

  function profileRow(label, value) {
    var row = el('div', 'dash-profile-row');
    row.appendChild(el('span', 'dash-profile-label', label));
    row.appendChild(el('span', 'dash-profile-value', value || '—'));
    return row;
  }

  function renderProfileView(user) {
    var container = $('dashProfileView');
    if (!container) return;
    container.innerHTML = '';
    var ubicacion = [(user.ciudad === 'Otro' ? (user.ciudadCustom || 'Otro') : user.ciudad), (user.barrio === 'Otro' ? (user.barrioCustom || 'Otro') : (user.barrio || user.barrioCustom))].filter(Boolean).join(', ');
    container.appendChild(profileRow('Nombre', ((user.nombre || '') + ' ' + (user.apellido || '')).trim()));
    container.appendChild(profileRow('Correo', user.email || ''));
    container.appendChild(profileRow('Documento', user.documento));
    container.appendChild(profileRow('Teléfono', user.telefono));
    container.appendChild(profileRow('Sexo', user.sexo === 'Otro' ? (user.sexoCustom || 'Otro') : user.sexo));
    container.appendChild(profileRow('Rol', ROLES[user.rol] ? (ROLES[user.rol].icon + ' ' + ROLES[user.rol].label) : (user.rol || '—')));
    container.appendChild(profileRow('Rango de edad', user.rangoEdad));
    container.appendChild(profileRow('Ubicación', ubicacion));
    container.appendChild(profileRow('Fecha de suscripción', V.fmtDate(getFechaSuscripcion(user))));
    container.appendChild(profileRow('Notas', user.notas));
    container.appendChild(profileRow('Registro', user.creado ? V.fmtDate(user.creado) : '—'));
  }

  function fillForm(user) {
    var el;
    if ((el = $('pfNombre'))) el.value = user.nombre || '';
    if ((el = $('pfApellido'))) el.value = user.apellido || '';
    if ((el = $('pfDocumento'))) el.value = user.documento || '';
    if ((el = $('pfTelefono'))) el.value = user.telefono || '';
    if ((el = $('pfSexo'))) el.value = user.sexo || '';
    if ((el = $('pfSexoOtroWrap'))) el.style.display = user.sexo === 'Otro' ? '' : 'none';
    if ((el = $('pfSexoOtro'))) el.value = user.sexo === 'Otro' ? (user.sexoCustom || '') : '';
    if ((el = $('pfFechaSuscripcion'))) el.value = getFechaSuscripcion(user) ? V.fmtDate(getFechaSuscripcion(user)) : '—';
    if ((el = $('pfRangoEdad'))) el.value = user.rangoEdad || '';
    if ((el = $('pfCiudad'))) el.value = '';
    if ((el = $('pfCiudadOtroWrap'))) el.style.display = 'none';
    if ((el = $('pfCiudadOtro'))) el.value = '';
    if ((el = $('pfBarrio'))) el.value = '';
    if ((el = $('pfNotas'))) el.value = user.notas || '';
    setCascade(user);
    loadBarriosFromDb();
    profileDirty = false;
  }

  function collectForm() {
    return {
      nombre: $('pfNombre').value.trim(),
      apellido: $('pfApellido').value.trim(),
      documento: $('pfDocumento').value.trim(),
      telefono: $('pfTelefono').value.trim(),
      sexo: $('pfSexo').value,
      sexoCustom: $('pfSexo').value === 'Otro' ? $('pfSexoOtro').value.trim() : '',
      rangoEdad: $('pfRangoEdad').value,
      ciudad: $('pfCiudad').value,
      ciudadCustom: $('pfCiudad').value === 'Otro' ? $('pfCiudadOtro').value.trim() : '',
      barrio: $('pfBarrio').value.trim(),
      notas: $('pfNotas').value.trim()
    };
  }

  function deleteEmptyFields(data) {
    Object.keys(data).forEach(function (k) {
      if (data[k] === '' || data[k] === null || data[k] === undefined) delete data[k];
    });
    return data;
  }

  function saveProfile() {
    if (!V.db || !V.userId) return;
    if (!profileDirty) { V.toast('No hay cambios que guardar.'); return; }
    var data = collectForm();
    var linked = { apellido: data.apellido, documento: data.documento, telefono: data.telefono, sexo: data.sexo, sexoCustom: data.sexoCustom, rangoEdad: data.rangoEdad, ciudad: data.ciudad, ciudadCustom: data.ciudadCustom, barrio: data.barrio, notas: data.notas };
    var current = V._lastUserDoc || {};
    if (!current.fechaSuscripcion && !current.createdAt) {
      linked.fechaSuscripcion = new Date().toISOString();
    }
    deleteEmptyFields(linked);
    if (data.nombre) linked.nombre = data.nombre;

    var btn = $('btnSaveProfile');
    btn.disabled = true;
    btn.textContent = '⏳ Guardando…';
    V.db.collection(V.COL_USUARIOS).doc(V.userId).set(linked, { merge: true })
      .then(function () {
        V.toast('Perfil actualizado ✓');
        goViewMode();
        V.onDashboardShow();
      })
      .catch(function (e) {
        V.toast('Error al guardar: ' + e.message, true);
        btn.disabled = false;
        btn.textContent = 'Guardar cambios';
      });
  }

  function goEditMode() {
    $('dashProfileView').style.display = 'none';
    $('dashProfileForm').style.display = 'block';
    $('dashEditProfile').style.display = 'none';
  }

  function goViewMode() {
    $('dashProfileView').style.display = 'block';
    $('dashProfileForm').style.display = 'none';
    $('dashEditProfile').style.display = '';
  }

  function bindProfileEvents() {
    $('dashEditProfile').addEventListener('click', goEditMode);
    $('dashProfileForm').addEventListener('submit', function (e) { e.preventDefault(); saveProfile(); });
    $('btnCancelEditProfile').addEventListener('click', function () {
      goViewMode();
      if (V._lastUserDoc) fillForm(V._lastUserDoc);
    });
  }

  /* ─── SHOW HOOK (called by core each time dashboard is shown) ── */
  function showDashboard() {
    renderCards();
    if (!V.db || !V.userId) return;
    V.db.collection(V.COL_USUARIOS).doc(V.userId).get().then(function (doc) {
      var user = doc.exists ? doc.data() : {};
      user.uid = V.userId;
      V._lastUserDoc = user;
      $('dashName').textContent = ((user.nombre || '') + ' ' + (user.apellido || '')).trim() || (V.currentUser && V.currentUser.email ? V.currentUser.email.split('@')[0] : 'Usuario');
      var rol = user.rol || V.userRole || 'estudiante';
      var rl = ROLES[rol];
      $('dashRoleBadge').textContent = (rl ? rl.icon + ' ' : '') + (rl ? rl.label : rol);
      $('dashRole').textContent = 'Bienvenido a tu centro de control como ' + (rl ? rl.label.toLowerCase() : rol) + '.';
      renderProfileView(user);
      fillForm(user);
      goViewMode();
    }).catch(function (e) {
      V.toast('No se pudo cargar tu perfil: ' + e.message, true);
    });
  }

  V.onDashboardShow = showDashboard;

  /* ─── MODULE INTERFACE ────────────────────────────────────── */
  var DashboardModule = {
    onReady: function () {
      runCascade();
      loadBarriosFromDb();
      bindProfileEvents();
    }
  };

  V.registerModule(DashboardModule);
})();
