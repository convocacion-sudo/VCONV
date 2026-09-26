/* ════════════════════════════════════════════════════════════════
   VCONV · Panel del Super Admin
   Contenedor de los ajustes que solo el super administrador puede
   cambiar. Hoy, el video corporativo de la portada.

   Este archivo NO protege nada por sí mismo: la frontera real está en
   firestore.rules (config/portal y superadmin_auditoria solo admiten
   escritura de isAdmin()) y en el guard de showView() en core/app.js.
   Aquí solo se dibuja la interfaz. La separación es deliberada: un
   panel "protegido" que solo se protege en el cliente no está protegido,
   y uno que parece seguro porque el botón está oculto invites a confiar
   en el sitio equivocado.
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var V = window.VCONV;
  if (!V) { console.error('VCONV core not loaded'); return; }

  function $(id) { return V.$(id); }
  function el(tag, cls, text) { return V.el(tag, cls, text); }

  // Colección de ajustes de la app. Se lee entera (y en vivo) para poder
  // mostrar qué documentos existen de verdad, en vez de una lista de
  // ajustes que este panel no controla y que podrían no existir.
  var CONFIG_COLLECTION = 'config';
  var AUDIT_COLLECTION = 'superadmin_auditoria';

  // Descripción de cada documento de config: qué es y quién puede leerlo.
  // Los permisos NO se inventan aquí, se traducen de firestore.rules, que es
  // donde viven. Si cambia una regla, hay que tocar esta tabla también, y por
  // eso los textos dicen "regla" y no "permiso": lo que se afirma aquí es lo
  // que el archivo de reglas concede.
  var CONFIG_DOCS = {
    portal: { label: 'Video corporativo', lectura: 'Público (esPublico())' },
    mlm: { label: 'Porcentajes MLM', lectura: 'Sesión iniciada' },
    finanzas: { label: 'Ajustes financieros', lectura: 'Sesión iniciada' },
    ubicacion: { label: 'Ubicaciones (departamentos, ciudades, barrios)', lectura: 'Sesión iniciada' },
    perfiles: { label: 'Perfiles organizacionales', lectura: 'Sesión iniciada' },
    profesiones: { label: 'Profesiones', lectura: 'Sesión iniciada' },
    oficios: { label: 'Oficios', lectura: 'Sesión iniciada' }
  };

  var configCache = null;
  var auditCache = null;
  var configUnsub = null;
  var auditUnsub = null;

  /* ════════════════════════════════════════════════════════════
     SUSCRIPCIONES
     Solo se abren para un superadmin y se cierran en cuanto deja de
     serlo. La razón no es ahorrar lecturas: una suscripción viva a un
     documento que las reglas ya no leen empieza a escupir "Missing or
     insufficient permissions" en la consola en cada instantánea, y ese
     ruido esconde los errores de verdad. */

  // Firestore entrega la función de baja incluso cuando la escucha ya ha
  // muerto por un error de permisos, y darla de baja dos veces es inocuo.
  // Todo lo que llega de onSnapshot es "quizá función", así que aquí se
  // centraliza la comprobación en lugar de repetirla en cada baja.
  function release(unsub) {
    if (typeof unsub !== 'function') return;
    try { unsub(); } catch (e) { /* ya estaba dada de baja */ }
  }

  function openSubscriptions() {
    if (!V.db || !V.esAdmin()) return;
    subscribeConfig();
    subscribeAudit();
  }

  function closeSubscriptions() {
    release(configUnsub);
    release(auditUnsub);
    configUnsub = null;
    auditUnsub = null;
    configCache = null;
    auditCache = null;
  }

  function subscribeConfig() {
    if (!V.db || configUnsub) return;
    try {
      configUnsub = V.db.collection(CONFIG_COLLECTION).onSnapshot(function (snap) {
        var seen = {};
        configCache = [];
        snap.forEach(function (d) {
          seen[d.id] = true;
          configCache.push({ id: d.id, data: d.data() });
        });
        // Documentos conocidos que todavía no existen se listan igual, con
        // "Sin crear": es justo el caso que el superadmin quiere ver (la
        // diferencia entre "no hay video" y "hay un video que no se ve").
        Object.keys(CONFIG_DOCS).forEach(function (id) {
          if (!seen[id]) configCache.push({ id: id, data: null });
        });
        renderStatus();
      }, function (err) {
        // Sin desplegar las reglas, o con la identidad a medio resolver: el
        // panel sigue siendo utilizable, solo sin la tabla de estado. Se
        // libera el hueco igual que en portal.js: en onSnapshot la función de
        // baja se entrega también cuando la escucha muere por permisos, así
        // que sin esto configUnsub quedaría ocupado y la tabla no se
        // llenaría nunca, ni al reintentar ni tras un login posterior.
        console.warn('[superadmin] no se pudo leer la colección config:', err && err.message);
        release(configUnsub); configUnsub = null;
        configCache = null;
      });
    } catch (e) {
      configUnsub = null;
      console.warn('[superadmin] no se pudo suscribir a config:', e && e.message);
    }
  }

  function subscribeAudit() {
    if (!V.db || auditUnsub) return;
    try {
      // orderBy + limit: la bitácora se lee para mostrar los últimos cambios,
      // no para auditar los históricos. Pedir el orden sin índice compuesto
      // funcionaría igual, pero traería la colección entera a cada apertura.
      auditUnsub = V.db.collection(AUDIT_COLLECTION)
        .orderBy('fecha', 'desc')
        .limit(20)
        .onSnapshot(function (snap) {
          auditCache = [];
          snap.forEach(function (d) { auditCache.push(d.data() || {}); });
          renderStatus();
          renderLog();
        }, function (err) {
          // Regla aún no desplegada, o índice compuesto pendiente: la
          // bitácora se muestra vacía en vez de romper el panel.
          console.warn('[superadmin] no se pudo leer la bitácora:', err && err.message);
          release(auditUnsub); auditUnsub = null;
          auditCache = [];
          renderStatus();
          renderLog();
        });
    } catch (e) {
      auditUnsub = null;
      console.warn('[superadmin] no se pudo suscribir a la bitácora:', e && e.message);
    }
  }

  /* ════════════════════════════════════════════════════════════
     TABLA DE ESTADO
     ════════════════════════════════════════════════════════════ */

  // Traduce el estado real de un documento de config a la etiqueta que ve el
  // superadmin. El orden importa: primero "no existe", porque es el único
  // estado en el que aún no hay nada que ver, y "despublicado" (existe pero
  // con el interruptor apagado) no es lo mismo que "sin crear".
  function estadoDe(id, data) {
    if (!data) return ['Sin crear', 'sa-pill-none'];
    if (id === 'portal') {
      if (!data.videoUrl) return ['Sin video', 'sa-pill-none'];
      if (data.videoActivo === false) return ['Guardado, sin publicar', 'sa-pill-off'];
      return ['Publicado en la portada', 'sa-pill-on'];
    }
    // Las listas de opciones (perfiles, profesiones, oficios, ubicaciones)
    // guardan sus entradas en un array `categorias`: se muestra cuántas hay,
    // que es el dato que el superadmin quiere ver de un vistazo.
    if (data.categorias && data.categorias.length) {
      return [data.categorias.length + ' elemento(s)', 'sa-pill-on'];
    }
    return ['Creado', 'sa-pill-on'];
  }

  function renderStatus() {
    var body = $('saStatusBody');
    if (!body) return;
    body.innerHTML = '';

    var rows = [];

    // Todos los documentos de config que existen (o que son conocidos).
    var ids = [];
    if (configCache) {
      configCache.forEach(function (d) { if (ids.indexOf(d.id) === -1) ids.push(d.id); });
    }
    if (!ids.length) {
      Object.keys(CONFIG_DOCS).forEach(function (id) { ids.push(id); });
    }
    ids.forEach(function (id) {
      var meta = CONFIG_DOCS[id] || { label: id, lectura: 'Sesión iniciada' };
      var data = null;
      if (configCache) {
        configCache.forEach(function (d) { if (d.id === id) data = d.data; });
      }
      var est = estadoDe(id, data);
      rows.push({
        label: meta.label,
        path: CONFIG_COLLECTION + '/' + id,
        lectura: meta.lectura,
        escritura: 'Solo superadmin',
        estado: est
      });
    });

    // La bitácora vive en su propia colección porque config/portal es público.
    rows.push({
      label: 'Bitácora de cambios',
      path: AUDIT_COLLECTION,
      lectura: 'Solo superadmin',
      escritura: 'Solo superadmin',
      estado: auditCache && auditCache.length
        ? [auditCache.length + ' cambio(s)', 'sa-pill-on']
        : ['Vacía', 'sa-pill-none']
    });

    rows.forEach(function (r) {
      var tr = el('tr');
      tr.appendChild(el('td', '', r.label));

      var tdPath = el('td');
      tdPath.appendChild(el('code', '', r.path));
      tr.appendChild(tdPath);

      tr.appendChild(el('td', 'sa-cell-tight', r.lectura));
      tr.appendChild(el('td', 'sa-cell-tight', r.escritura));

      var tdEstado = el('td', 'sa-cell-tight');
      tdEstado.appendChild(el('span', 'sa-pill ' + r.estado[1], r.estado[0]));
      tr.appendChild(tdEstado);

      body.appendChild(tr);
    });
  }

  /* ════════════════════════════════════════════════════════════
     BITÁCORA
     ════════════════════════════════════════════════════════════ */

  function fechaLegible(iso) {
    if (!iso) return 'sin fecha';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return 'sin fecha';
    return d.toLocaleString('es');
  }

  function renderLog() {
    var host = $('saLog');
    if (!host) return;
    host.innerHTML = '';

    if (!V.esAdmin()) return;

    if (!auditCache || !auditCache.length) {
      var vacio = el('div', 'sa-log-empty');
      vacio.appendChild(el('span', 'sa-log-empty-ico', '🧾'));
      vacio.appendChild(el('p', '', 'Todavía no hay cambios registrados.'));
      vacio.appendChild(el('p', '', 'En cuanto guardes el video corporativo, aparecerá aquí.'));
      host.appendChild(vacio);
      return;
    }

    auditCache.forEach(function (a) {
      var item = el('div', 'sa-log-item');
      item.appendChild(el('span', 'sa-log-ico', a.activo === false ? '⏸️' : '🎬'));

      var body = el('div', 'sa-log-body');
      body.appendChild(el('div', 'sa-log-title', (a.accion || 'Ajuste') + ' · ' + (a.resumen || '')));
      body.appendChild(el('div', 'sa-log-meta', (a.autorEmail || 'desconocido') + ' · ' + fechaLegible(a.fecha)));
      if (a.url) body.appendChild(el('div', 'sa-log-url', a.url));
      item.appendChild(body);
      host.appendChild(item);
    });
  }

  /* ════════════════════════════════════════════════════════════
     APERTURA DEL PANEL
     ════════════════════════════════════════════════════════════ */

  function showPanel() {
    // El mismo guard que pone showView(), repetido aquí porque este módulo
    // también se puede invocar desde el Escritorio. showView() ya impide
    // que la vista llegue a pintarse; esto evita, además, que se abran
    // suscripciones a datos de configuración para quien no tiene permiso.
    if (!V.esAdmin()) {
      V.toast('Acceso restringido al super administrador.', true);
      if (V.goDashboard) V.goDashboard();
      return;
    }

    var pill = $('saRolPill');
    var user = V.currentUser;
    if (pill) pill.textContent = (user && user.email) ? 'Super Admin · ' + user.email : 'Super Admin';

    openSubscriptions();
    // El formulario y la vista previa los dibuja portal.js: es quien sabe
    // traducir una URL a una fuente reproducible y quien comparte
    // buildVideoFrame() con la portada, de modo que la vista previa y lo que
    // ve un visitante no pueden divergir.
    if (V.portal) {
      V.portal.renderAdminPortalConfig();
      V.portal.renderAdminVideoPreview();
    }
    renderStatus();
    renderLog();
  }

  /* ════════════════════════════════════════════════════════════
     ARRANQUE
     ════════════════════════════════════════════════════════════ */

  V.onSuperadminShow = showPanel;

  var SuperadminModule = {
    onReady: function () {
      // Nada que iniciar de forma preventiva: las suscripciones se abren
      // cuando el panel se abre, no siempre. Un superadmin que no visita
      // el panel no debería generar lecturas de config ni de la bitácora.
    }
  };
  V.registerModule(SuperadminModule);

  // Cambio de identidad (login, registro, cierre de sesión): el panel se
  // refresca si sigue siendo superadmin y se vacía si deja de serlo. Se
  // encadena con los handlers de cursos.js y portal.js en vez de sustituir
  // alguno, que es lo que ocurriría con una asignación directa.
  var _onModeChangePrev = V.onModeChange;
  V.onModeChange = function (m) {
    if (typeof _onModeChangePrev === 'function') {
      try { _onModeChangePrev(m); } catch (e) { /* noop */ }
    }
    if (V.esAdmin()) {
      renderStatus();
      renderLog();
    } else {
      closeSubscriptions();
    }
  };

  V.superadmin = {
    showPanel: showPanel,
    renderStatus: renderStatus,
    renderLog: renderLog
  };
})();
