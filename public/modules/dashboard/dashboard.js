/* ════════════════════════════════════════════════════════════════
   VCONV · Módulo Escritorio (Dashboard) — Centro de control por rol
   y sección "Mi Perfil" con edición y guardado en Firestore.
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var V = window.VCONV;
  if (!V) { console.error('VCONV core not loaded'); return; }

  var profileDirty = false;
  var pfCustomBarrio = '';
  var ubicacionData = { departamentos: [], ciudades: {}, barrios: {} };

  function $(id) { return V.$(id); }
  function el(tag, cls, text) { return V.el(tag, cls, text); }

  var ROLES = {
    estudiante: { label: 'Estudiante', icon: '🎓' },
    gestor: { label: 'Gestor', icon: '🛠' },
    superadmin: { label: 'Superadmin', icon: '🔐' }
  };

  /* ─── CARGAR UBICACIÓN (config/ubicacion) ───────────────── */
  function applyUbicacion(data) {
    var d = data || {};
    ubicacionData = {
      departamentos: Array.isArray(d.departamentos) ? d.departamentos : [],
      ciudades: d.ciudades && typeof d.ciudades === 'object' ? d.ciudades : {},
      barrios: d.barrios && typeof d.barrios === 'object' ? d.barrios : {}
    };
    return ubicacionData;
  }

  function loadUbicacionFromConfig() {
    if (!V.db) return Promise.resolve(ubicacionData);
    return V.db.collection('config').doc('ubicacion').get()
      .then(function (doc) {
        return applyUbicacion(doc.exists ? doc.data() : {});
      })
      .catch(function () {
        return ubicacionData;
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
      cards.push({ icon: '📚', title: 'Mis Cursos', tag: 'Gestión', desc: 'Administra y edita tus cursos.', action: function () { V.setMode('gestor'); } });
      cards.push({ icon: '➕', title: 'Nuevo Curso', tag: 'Crear', desc: 'Crea un curso y añade lecciones.', action: function () { if (V.onNewCourse) V.onNewCourse(); } });
    } else if (rol === 'estudiante') {
      cards.push({ icon: '📖', title: 'Catálogo de Cursos', tag: 'Explorar', desc: 'Explora y comienza tus cursos.', action: function () { V.setMode('estudiante'); } });
    }

    if (rol === 'superadmin') {
      cards.push({ icon: '🔐', title: 'Gestión de Usuarios', tag: 'Admin', desc: 'Administra perfiles, roles y estados.', action: function () { V.setMode('admin'); } });
      cards.push({ icon: '💰', title: 'Finanzas', tag: 'Contable', desc: 'Registra aportes y ofrendas, configura porcentajes MLM.', action: function () { if (V.showFinanzas) V.showFinanzas(); } });
      cards.push({ icon: '📊', title: 'Reportes Financieros', tag: 'Contable', desc: 'Ingresos, bolsa de comisiones y Caja Mayor.', action: function () { if (V.showReportes) V.showReportes(); } });
      // Ficha MLM exclusiva del administrador: abre la página independiente
      // con el multinivel global (red + dinero) y la estructura de 5 niveles.
      cards.push({ icon: '🌐', title: 'Red MLM Global', tag: 'MLM', desc: 'Multinivel y comisiones de toda la red, estructura de 5 niveles.', action: function () { if (V.showRedGlobal) V.showRedGlobal(); } });
    }

    // Las comunidades requieren cuenta registrada.
    if (!V.isAnon) {
      cards.push({ icon: '🤝', title: 'Comunidades', tag: 'Mi red', desc: rol === 'gestor' ? 'Administra tu grupo, miembros y asistencia.' : 'Tu comunidad, coordinador y asistencia.', action: function () { V.showComunidades(); } });
    }

    cards.forEach(function (c) {
      var card = el('button', 'dash-card');
      card.type = 'button';
      var head = el('div', 'dash-card-head');
      head.appendChild(el('span', 'icon-chip gold', c.icon));
      head.appendChild(el('h3', 'dash-card-title', c.title));
      head.appendChild(el('span', 'status-pill gold', c.tag || 'Acceso'));
      card.appendChild(head);
      card.appendChild(el('p', 'dash-card-desc', c.desc));
      card.addEventListener('click', c.action);
      container.appendChild(card);
    });
  }

  /* ─── PROFILE ────────────────────────────────────────────── */
  function populateDeptos() {
    var sel = $('pfDepartamento');
    if (!sel) return;
    var prev = sel.value;
    sel.innerHTML = '<option value="">—</option>';
    ubicacionData.departamentos.forEach(function (d) {
      var opt = document.createElement('option');
      opt.value = d; opt.textContent = d;
      sel.appendChild(opt);
    });
    if (prev && ubicacionData.departamentos.indexOf(prev) !== -1) sel.value = prev;
  }

  function populateCiudades() {
    var sel = $('pfCiudad');
    if (!sel) return;
    var depto = $('pfDepartamento').value;
    var prev = sel.value;
    sel.innerHTML = '<option value="">—</option>';
    (ubicacionData.ciudades[depto] || []).forEach(function (c) {
      var opt = document.createElement('option');
      opt.value = c; opt.textContent = c;
      sel.appendChild(opt);
    });
    if (prev && (ubicacionData.ciudades[depto] || []).indexOf(prev) !== -1) sel.value = prev;
  }

  function populateBarrios() {
    var sel = $('pfBarrio');
    if (!sel) return;
    var ciudad = $('pfCiudad').value;
    var prev = sel.value;
    sel.innerHTML = '<option value="">—</option>';
    (ubicacionData.barrios[ciudad] || []).forEach(function (b) {
      var opt = document.createElement('option');
      opt.value = b; opt.textContent = b;
      sel.appendChild(opt);
    });
    var optOtro = document.createElement('option');
    optOtro.value = '__otro__'; optOtro.textContent = 'Otros...';
    sel.appendChild(optOtro);
    if (pfCustomBarrio) {
      var optC = document.createElement('option');
      optC.value = pfCustomBarrio; optC.textContent = pfCustomBarrio;
      optC.selected = true;
      sel.appendChild(optC);
    } else if (prev && prev !== '__otro__' && (ubicacionData.barrios[ciudad] || []).indexOf(prev) !== -1) {
      sel.value = prev;
    }
  }

  function runCascade() {
    var selDepto = $('pfDepartamento');
    var selCiudad = $('pfCiudad');
    var selBarrio = $('pfBarrio');

    selDepto.addEventListener('change', function () {
      pfCustomBarrio = '';
      selCiudad.value = '';
      selBarrio.value = '';
      populateCiudades();
      populateBarrios();
      markDirty();
    });
    selCiudad.addEventListener('change', function () {
      pfCustomBarrio = '';
      selBarrio.value = '';
      populateBarrios();
      markDirty();
    });
    selBarrio.addEventListener('change', function () {
      if (this.value !== '__otro__') { pfCustomBarrio = ''; markDirty(); return; }
      var custom = prompt('Escribe el barrio:');
      if (custom === null || !custom.trim()) {
        populateBarrios();
        return;
      }
      pfCustomBarrio = custom.trim();
      populateBarrios();
      markDirty();
    });
    ['pfNombre', 'pfApellido', 'pfDocumento', 'pfTelefono', 'pfNotas', 'pfBanco', 'pfNumeroCuenta'].forEach(function (id) {
      var input = $(id);
      if (input) input.addEventListener('input', markDirty);
    });
    var chkPortal = $('pfRegistradoPortal');
    if (chkPortal) chkPortal.addEventListener('change', markDirty);
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
    populateDeptos();
    var depto = user.departamento || '';
    if (depto && ubicacionData.departamentos.indexOf(depto) !== -1) $('pfDepartamento').value = depto;
    populateCiudades();
    var ciudad = user.ciudad || '';
    if (ciudad && (ubicacionData.ciudades[depto] || []).indexOf(ciudad) !== -1) $('pfCiudad').value = ciudad;
    pfCustomBarrio = '';
    populateBarrios();
    var barrio = user.barrio || '';
    if (barrio) {
      if ((ubicacionData.barrios[ciudad] || []).indexOf(barrio) !== -1) {
        $('pfBarrio').value = barrio;
      } else {
        pfCustomBarrio = barrio;
        populateBarrios();
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
    var ubicacion = [user.departamento, user.ciudad, user.barrio].filter(Boolean).join(', ');
    container.appendChild(profileRow('Nombre', ((user.nombre || '') + ' ' + (user.apellido || '')).trim()));
    container.appendChild(profileRow('Correo', user.email || ''));
    container.appendChild(profileRow('Documento', user.documento));
    container.appendChild(profileRow('Teléfono', user.telefono));
    container.appendChild(profileRow('Sexo', user.sexo === 'Otro' ? (user.sexoCustom || 'Otro') : user.sexo));
    container.appendChild(profileRow('Rol', ROLES[user.rol] ? (ROLES[user.rol].icon + ' ' + ROLES[user.rol].label) : (user.rol || '—')));
    container.appendChild(profileRow('Rango de edad', user.rangoEdad));
    container.appendChild(profileRow('Ubicación', ubicacion));
    var bancoNum = [user.banco, user.numeroCuenta].filter(Boolean).join(' · ');
    container.appendChild(profileRow('Banco', bancoNum || '—'));
    container.appendChild(profileRow('Estado en banco/portal', user.registradoPortal ? '✅ Registrado para pagos' : '—'));
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
    if ((el = $('pfDepartamento'))) el.value = '';
    if ((el = $('pfCiudad'))) el.value = '';
    if ((el = $('pfBarrio'))) el.value = '';
    if ((el = $('pfNotas'))) el.value = user.notas || '';
    if ((el = $('pfBanco'))) el.value = user.banco || '';
    if ((el = $('pfNumeroCuenta'))) el.value = user.numeroCuenta || '';
    if ((el = $('pfRegistradoPortal'))) el.checked = !!user.registradoPortal;
    pfCustomBarrio = '';
    profileDirty = false;
    return loadUbicacionFromConfig().then(function () {
      setCascade(user);
    });
  }

  function collectForm() {
    var barrioVal = $('pfBarrio').value;
    return {
      nombre: $('pfNombre').value.trim(),
      apellido: $('pfApellido').value.trim(),
      documento: $('pfDocumento').value.trim(),
      telefono: $('pfTelefono').value.trim(),
      sexo: $('pfSexo').value,
      sexoCustom: $('pfSexo').value === 'Otro' ? $('pfSexoOtro').value.trim() : '',
      rangoEdad: $('pfRangoEdad').value,
      departamento: $('pfDepartamento').value,
      ciudad: $('pfCiudad').value,
      barrio: barrioVal === '__otro__' ? (pfCustomBarrio || '') : barrioVal,
      notas: $('pfNotas').value.trim(),
      banco: $('pfBanco').value,
      numeroCuenta: $('pfNumeroCuenta').value.trim(),
      registradoPortal: !!$('pfRegistradoPortal').checked
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
    var linked = { apellido: data.apellido, documento: data.documento, telefono: data.telefono, sexo: data.sexo, sexoCustom: data.sexoCustom, rangoEdad: data.rangoEdad, departamento: data.departamento, ciudad: data.ciudad, barrio: data.barrio, notas: data.notas, banco: data.banco, numeroCuenta: data.numeroCuenta, registradoPortal: data.registradoPortal };
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

  function renderMlmPanel(user) {
    var panel = $('dashMlmPanel');
    var body = $('dashMlmBody');
    if (!panel || !body) return;
    if (!V.mlm || !V.mlm.isEnabled()) { panel.style.display = 'none'; return; }
    panel.style.display = '';
    body.innerHTML = '';

    function draw(theUser) {
      var code = theUser && theUser.referralCode ? theUser.referralCode : '';
      if (code) {
        var link = V.mlm.enlaceInvitacion(code);

        body.appendChild(profileRow('Tu código de referido', code));

        var linkRow = el('div', 'dash-mlm-link-row');
        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'input dash-mlm-link';
        input.value = link;
        input.readOnly = true;
        linkRow.appendChild(input);
        var copyBtn = el('button', 'btn btn-outline btn-sm', 'Copiar');
        copyBtn.type = 'button';
        copyBtn.addEventListener('click', function () {
          V.mlm.copiarAlPortapapeles(link).then(function () {
            V.toast('Enlace copiado ✓');
          }).catch(function () {
            V.toast('No se pudo copiar el enlace', true);
          });
        });
        linkRow.appendChild(copyBtn);
        body.appendChild(linkRow);

        if (theUser.sponsorId) {
          V.mlm.datosPatrocinador(theUser.sponsorId).then(function (sp) {
            var label = sp && (sp.nombre || sp.email) ? (sp.nombre || sp.email) : '—';
            var row = profileRow('Patrocinado por', label);
            row.setAttribute('data-mlm-sponsor', '1');
            var old = body.querySelector('[data-mlm-sponsor]');
            if (old) old.replaceWith(row); else body.appendChild(row);
          }).catch(function () {
            body.appendChild(profileRow('Patrocinado por', '—'));
          });
        } else {
          body.appendChild(profileRow('Patrocinado por', '—'));
        }
      } else {
        body.appendChild(el('p', 'dash-profile-value', 'Aún no tienes código de invitación.'));
      }

      // Tarjeta interactiva MLM (5 niveles): métricas + acordeón.
      if (V.mlm && typeof V.mlm.renderMlmCard === 'function') {
        V.mlm.renderMlmCard(body);
      } else {
        body.appendChild(el('p', 'dash-profile-value', 'El módulo MLM no está disponible.'));
      }
    }

    if (user.referralCode) { draw(user); return; }
    V.mlm.aplicarPatrocinio(V.userId, null).then(function () {
      return V.db.collection(V.COL_USUARIOS).doc(V.userId).get();
    }).then(function (doc) {
      var theUser = doc.exists ? doc.data() : user;
      theUser.uid = V.userId;
      user.referralCode = theUser.referralCode || user.referralCode;
      user.sponsorId = theUser.sponsorId || user.sponsorId;
      V._lastUserDoc = user;
      draw(theUser);
    }).catch(function () { draw(user); });
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
      if (V.isAnon) {
        $('dashName').textContent = 'Visitante';
        $('dashRoleBadge').textContent = '👋 Visitante';
        $('dashRole').textContent = 'Explora el catálogo y las lecciones de prueba. Crea tu cuenta para conservar tu progreso.';
        var pillAnon = $('dashRolePill');
        if (pillAnon) { pillAnon.textContent = '👋 Visitante'; pillAnon.className = 'status-pill blue'; }
        return;
      }
      $('dashName').textContent = ((user.nombre || '') + ' ' + (user.apellido || '')).trim() || (V.currentUser && V.currentUser.email ? V.currentUser.email.split('@')[0] : 'Usuario');
      var rol = user.rol || V.userRole || 'estudiante';
      var rl = ROLES[rol];
      $('dashRoleBadge').textContent = (rl ? rl.icon + ' ' : '') + (rl ? rl.label : rol);
      $('dashRole').textContent = 'Bienvenido a tu centro de control como ' + (rl ? rl.label.toLowerCase() : rol) + '.';
      var pill = $('dashRolePill');
      if (pill) { pill.textContent = (rl ? rl.icon + ' ' : '') + (rl ? rl.label : rol); pill.className = 'status-pill gold'; }
      renderProfileView(user);
      fillForm(user);
      goViewMode();
      renderMlmPanel(user);
    }).catch(function (e) {
      V.toast('No se pudo cargar tu perfil: ' + e.message, true);
    });
  }

  V.onDashboardShow = showDashboard;

  /* ─── MODULE INTERFACE ────────────────────────────────────── */
  var DashboardModule = {
    onReady: function () {
      runCascade();
      loadUbicacionFromConfig().then(function () {
        populateDeptos();
        populateCiudades();
      });
      bindProfileEvents();
    }
  };

  V.registerModule(DashboardModule);
})();
