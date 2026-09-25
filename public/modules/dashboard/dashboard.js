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
  var pfProfesionesOptions = [];
  var pfOficiosOptions = [];

  function $(id) { return V.$(id); }
  function el(tag, cls, text) { return V.el(tag, cls, text); }

  var ROLES = {
    estudiante: { label: 'Estudiante', icon: '🎓' },
    // "avanzado" hereda el modo estudiante y suma lectura de Finanzas/MLM
    // sobre su propia red (sin escrituras ni configuración).
    avanzado: { label: 'Avanzado', icon: '🔎' },
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
    // Los visitantes sin sesión omiten config/* (las reglas exigen signedIn()).
    if (!V.db || V.isAnon) return Promise.resolve(ubicacionData);
    return V.db.collection('config').doc('ubicacion').get()
      .then(function (doc) {
        return applyUbicacion(doc.exists ? doc.data() : {});
      })
      .catch(function () {
        return ubicacionData;
      });
  }

  // Carga una lista maestra de opciones desde config/{doc} (categorias).
  function loadOptionList(docName) {
    // Los visitantes sin sesión omiten config/* (las reglas exigen signedIn()).
    if (!V.db || V.isAnon) return Promise.resolve([]);
    return V.db.collection('config').doc(docName).get()
      .then(function (doc) {
        var raw = doc.exists ? (doc.data().categorias || []) : [];
        return Array.isArray(raw)
          ? raw.filter(function (x) { return typeof x === 'string' && x.trim(); }).map(function (x) { return x.trim(); })
          : [];
      })
      .catch(function () { return []; });
  }

  // Carga en paralelo Profesiones y Oficios para el formulario de edición.
  // Se mutan los arreglos en sitio para que los closures de bindPfOtro que
  // capturan la referencia sigan viendo las opciones cargadas.
  function loadProfeOficioOptions() {
    return Promise.all([loadOptionList('profesiones'), loadOptionList('oficios')])
      .then(function (res) {
        pfProfesionesOptions.length = 0;
        res[0].forEach(function (o) { pfProfesionesOptions.push(o); });
        pfOficiosOptions.length = 0;
        res[1].forEach(function (o) { pfOficiosOptions.push(o); });
      });
  }

  // Rellena un select (id) con las opciones de la lista, la opción seleccionada
  // (aunque no exista en la lista) y la opción "Otros..." para creación dinámica.
  function populatePfListSelect(selId, options, selected) {
    var sel = $(selId);
    if (!sel) return;
    sel.innerHTML = '<option value="">—</option>';
    var has = false;
    options.forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o; opt.textContent = o;
      if (String(selected || '') === o) { opt.selected = true; has = true; }
      sel.appendChild(opt);
    });
    if (selected && !has) {
      var cur = document.createElement('option');
      cur.value = selected; cur.textContent = selected;
      cur.selected = true;
      sel.appendChild(cur);
    }
    var optOtro = document.createElement('option');
    optOtro.value = '__otro__'; optOtro.textContent = 'Otros...';
    sel.appendChild(optOtro);
  }

  // Binding "Otros...": permite escribir un valor nuevo, lo suma a la lista local
  // y, en silencio, intenta agregarlo a la lista maestra (solo el admin puede
  // escribir config/; para el resto el valor se guarda en su propio perfil).
  function bindPfOtro(selId, optionsRef, label, docName) {
    var sel = $(selId);
    if (!sel) return;
    sel.addEventListener('change', function () {
      if (this.value !== '__otro__') { markDirty(); return; }
      var custom = prompt('Escribe ' + label + ':');
      if (custom === null || !custom.trim()) {
        populatePfListSelect(selId, optionsRef, '');
        return;
      }
      var val = custom.trim();
      if (optionsRef.indexOf(val) === -1) optionsRef.push(val);
      populatePfListSelect(selId, optionsRef, val);
      if (V.db) {
        V.db.collection('config').doc(docName).set({ categorias: optionsRef }, { merge: true }).catch(function () {});
      }
      markDirty();
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
    } else if (rol === 'avanzado') {
      cards.push({ icon: '📖', title: 'Catálogo de Cursos', tag: 'Explorar', desc: 'Explora y comienza tus cursos.', action: function () { V.setMode('estudiante'); } });
      // El módulo se abre en solo lectura y limitado a la red del usuario
      // (regla esMiArbolFin en firestore.rules).
      cards.push({ icon: '💰', title: 'Finanzas de mi red', tag: 'Solo lectura', desc: 'Consulta aportes, comisiones y pagos de tu red. Sin edición.', action: function () { if (V.showFinanzas) V.showFinanzas(); } });
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
    bindPfOtro('pfProfesion', pfProfesionesOptions, 'la profesión', 'profesiones');
    bindPfOtro('pfOficio', pfOficiosOptions, 'el oficio', 'oficios');
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

  // Fila dedicada del código de referido con botón de copiar,
  // seguida del enlace de referido completo en un campo de solo lectura.
  function profileRefRow(code) {
    var wrap = el('div', 'dash-profile-ref-block');
    wrap.setAttribute('data-dash-referido', '1');

    var hasMlm = V.mlm && typeof V.mlm.copiarAlPortapapeles === 'function';

    var codeRow = el('div', 'dash-profile-row');
    codeRow.appendChild(el('span', 'dash-profile-label', 'Código de referido'));
    var codeGroup = el('div', 'dash-profile-ref');
    codeGroup.appendChild(el('span', 'dash-profile-value', code || '—'));
    if (code && hasMlm) {
      var copyBtn = el('button', 'btn btn-outline btn-sm dash-ref-copy', '📋 Copiar');
      copyBtn.type = 'button';
      copyBtn.title = 'Copiar código de referido';
      copyBtn.addEventListener('click', function () {
        V.mlm.copiarAlPortapapeles(code).then(function () {
          V.toast('Código de referido copiado ✓');
        }).catch(function () {
          V.toast('No se pudo copiar el código', true);
        });
      });
      codeGroup.appendChild(copyBtn);
    }
    codeRow.appendChild(codeGroup);
    wrap.appendChild(codeRow);

    var linkRow = el('div', 'dash-profile-row');
    linkRow.appendChild(el('span', 'dash-profile-label', 'Enlace de referido'));
    var linkGroup = el('div', 'dash-profile-ref');
    var link = (code && V.mlm && typeof V.mlm.enlaceInvitacion === 'function') ? V.mlm.enlaceInvitacion(code) : '';
    if (link) {
      var input = document.createElement('input');
      input.type = 'text';
      input.readOnly = true;
      input.className = 'input dash-mlm-link';
      input.value = link;
      input.setAttribute('aria-label', 'Enlace de referido');
      linkGroup.appendChild(input);
      if (hasMlm) {
        var copyLinkBtn = el('button', 'btn btn-outline btn-sm dash-ref-copy', '🔗 Copiar Enlace');
        copyLinkBtn.type = 'button';
        copyLinkBtn.title = 'Copiar enlace de referido';
        copyLinkBtn.addEventListener('click', function () {
          V.mlm.copiarAlPortapapeles(link).then(function () {
            V.toast('Enlace de referido copiado ✓');
          }).catch(function () {
            V.toast('No se pudo copiar el enlace', true);
          });
        });
        linkGroup.appendChild(copyLinkBtn);
      }
    } else {
      linkGroup.appendChild(el('span', 'dash-profile-value', '—'));
    }
    linkRow.appendChild(linkGroup);
    wrap.appendChild(linkRow);

    return wrap;
  }

  // Actualiza (o crea) la fila del código en la vista de perfil sin borrar el resto.
  function refreshProfileReferido(code) {
    var container = $('dashProfileView');
    if (!container) return;
    var old = container.querySelector('[data-dash-referido]');
    var host = old ? old.parentElement : null;
    if (old) old.remove();
    if (host && host.classList.contains('dash-prof-section-body')) {
      host.appendChild(profileRefRow(code || ''));
      return;
    }
    var sectionBody = container.querySelector('.dash-prof-section-body');
    if (sectionBody) sectionBody.appendChild(profileRefRow(code || ''));
  }

  // Crea un bloque de sección con barra de encabezado de color y contenedor de filas.
  function profileSection(colorCls, title) {
    var section = el('section', 'dash-prof-section ' + colorCls);
    section.appendChild(el('h5', 'dash-prof-section-head ' + colorCls, title));
    var body = el('div', 'dash-prof-section-body');
    section.appendChild(body);
    return { el: section, body: body };
  }

  function renderProfileView(user) {
    var container = $('dashProfileView');
    if (!container) return;
    container.innerHTML = '';
    var ubicacion = [user.departamento, user.ciudad, user.barrio].filter(Boolean).join(', ');
    var bancoNum = [user.banco, user.numeroCuenta].filter(Boolean).join(' · ');
    var nombre = ((user.nombre || '') + ' ' + (user.apellido || '')).trim();

    // DATOS PERSONALES · azul
    var sPersonal = profileSection('prof-blue', 'Datos personales');
    sPersonal.body.appendChild(profileRow('Nombre', nombre));
    sPersonal.body.appendChild(profileRow('Correo', user.email || ''));
    sPersonal.body.appendChild(profileRow('Documento', user.documento));
    sPersonal.body.appendChild(profileRow('Teléfono', user.telefono));
    sPersonal.body.appendChild(profileRow('Sexo', user.sexo === 'Otro' ? (user.sexoCustom || 'Otro') : user.sexo));
    sPersonal.body.appendChild(profileRow('Rango de edad', user.rangoEdad));
    sPersonal.body.appendChild(profileRow('Rol', ROLES[user.rol] ? (ROLES[user.rol].icon + ' ' + ROLES[user.rol].label) : (user.rol || '—')));
    sPersonal.body.appendChild(profileRow('Fecha de suscripción', V.fmtDate(getFechaSuscripcion(user))));
    sPersonal.body.appendChild(profileRow('Registro', user.creado ? V.fmtDate(user.creado) : '—'));
    sPersonal.body.appendChild(profileRow('Profesión', user.profesion));
    sPersonal.body.appendChild(profileRow('Oficio', user.oficio));
    container.appendChild(sPersonal.el);

    // UBICACIÓN · púrpura
    var sUbi = profileSection('prof-purple', 'Ubicación');
    sUbi.body.appendChild(profileRow('Ubicación', ubicacion));
    sUbi.body.appendChild(profileRow('Departamento', user.departamento));
    sUbi.body.appendChild(profileRow('Ciudad', user.ciudad));
    sUbi.body.appendChild(profileRow('Barrio', user.barrio));
    container.appendChild(sUbi.el);

    // DATOS BANCARIOS (PAGOS) · marrón
    var sBanco = profileSection('prof-brown', 'Datos bancarios (pagos)');
    sBanco.body.appendChild(profileRow('Banco', bancoNum || '—'));
    sBanco.body.appendChild(profileRow('Estado en banco/portal', user.registradoPortal ? '✅ Registrado para pagos' : '—'));
    container.appendChild(sBanco.el);

    // NOTAS · naranja
    var sNotas = profileSection('prof-orange', 'Notas');
    sNotas.body.appendChild(profileRow('Notas', user.notas));
    container.appendChild(sNotas.el);

    // RED DE REFERIDOS (MLM) · verde esmeralda
    var sRed = profileSection('prof-green', 'Red de referidos (MLM)');
    sRed.body.appendChild(profileRefRow(user.referralCode || ''));
    container.appendChild(sRed.el);
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
    return Promise.all([
      loadUbicacionFromConfig().then(function () {
        setCascade(user);
      }),
      loadProfeOficioOptions().then(function () {
        populatePfListSelect('pfProfesion', pfProfesionesOptions, user.profesion);
        populatePfListSelect('pfOficio', pfOficiosOptions, user.oficio);
      })
    ]).then(function () {});
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
      profesion: $('pfProfesion').value,
      oficio: $('pfOficio').value,
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
    var linked = { apellido: data.apellido, documento: data.documento, telefono: data.telefono, sexo: data.sexo, sexoCustom: data.sexoCustom, rangoEdad: data.rangoEdad, profesion: data.profesion, oficio: data.oficio, departamento: data.departamento, ciudad: data.ciudad, barrio: data.barrio, notas: data.notas, banco: data.banco, numeroCuenta: data.numeroCuenta, registradoPortal: data.registradoPortal };
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
      refreshProfileReferido(user.referralCode);
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
    // Visitante en modo local (sin sesión, sin UID): perfil de invitado de
    // solo lectura. No hay documento usuarios/ que consultar.
    if (V.isAnon) {
      $('dashName').textContent = 'Visitante';
      $('dashRoleBadge').textContent = '👋 Visitante';
      $('dashRole').textContent = 'Explora el catálogo y las lecciones de prueba. Crea tu cuenta para guardar tu avance.';
      var pillAnon = $('dashRolePill');
      if (pillAnon) { pillAnon.textContent = '👋 Visitante'; pillAnon.className = 'status-pill blue'; }
      // Sin sesión no hay documento de perfil que editar: se oculta la
      // edición para no disparar escrituras protegidas en Firestore.
      var btnEditAnon = $('dashEditProfile');
      if (btnEditAnon) btnEditAnon.style.display = 'none';
      return;
    }
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
      bindProfileEvents();
      // El Escritorio de invitado es de solo lectura: los visitantes sin
      // sesión omiten la consulta protegida config/ubicacion (las reglas de
      // Firestore exigen signedIn() para config/*).
      if (!V.isAnon) {
        loadUbicacionFromConfig().then(function () {
          populateDeptos();
          populateCiudades();
        });
      }
    }
  };

  V.registerModule(DashboardModule);
})();
