/* ════════════════════════════════════════════════════════════════
   VCONV · Módulo Tienda Consolidada — Vitrina de tiendas externas
   ────────────────────────────────────────────────────────────────
   Módulo PÚBLICO (Nivel 1): el marketplace lista tiendas de vendedores
   SIN iniciar sesión. Cada tarjeta muestra Avatar, Nombre de Negocio,
   Categoría, Icono de Red y la Descripción/Detalles del vendedor.
   NO se publica ningún porcentaje de comisión.

   El vendedor NO crea productos individuales ni sube imágenes locales:
   vincula su tienda externa (WhatsApp Business, Instagram, Facebook,
   TikTok o Web/E-commerce) con su categoría principal, una descripción
   propia y la URL o el código embed de su tienda.

   "Mi Tienda Externa" solo está disponible para cuentas con el permiso
   explícito usuarios/{uid}.vendedorAutorizado, que concede el CRM
   (Gestión de Usuarios). El superadmin/gestor conserva el bypass.

   Todo el contenido vive en Firestore, sin tocar el código:
     tienda_vendedores/{uid} → tienda externa vinculada (perfil público)

   El candado real está en firestore.rules: lectura abierta a cualquier
   identidad y escritura del dueño con permiso (o admin). La comprobación
   de este archivo solo evita el intento y explica el motivo, igual que
   en el resto de módulos del panel.
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var V = window.VCONV;
  if (!V) { console.error('VCONV core not loaded'); return; }

  var COL_TIENDAS = 'tienda_vendedores';
  // Colecciones legacy del modelo anterior (productos individuales). Se
  // conservan aquí solo como referencia; el módulo ya no las escribe.
  var COL_CATEGORIAS = 'tienda_categorias';
  var COL_PRODUCTOS = 'tienda_productos';

  var PLATAFORMAS = [
    { id: 'whatsapp', label: 'WhatsApp Business', icon: '💬' },
    { id: 'instagram', label: 'Instagram', icon: '📸' },
    { id: 'facebook', label: 'Facebook', icon: '📘' },
    { id: 'tiktok', label: 'TikTok', icon: '🎵' },
    { id: 'web', label: 'Web / E-commerce', icon: '🌐' }
  ];

  /* ─── ESTADO ────────────────────────────────────────────────
     Las suscripciones viven fuera del DOM: la vista se redibuja en cada
     navegación y una suscripción atada a un nodo se quedaría escuchando
     una pantalla que ya no existe. */
  var tiendasCache = [];
  var tiendasSub = null;
  var perfilTienda = null;
  var permisoVendedor = false;
  var permisoCargado = false;
  var categoriaFiltro = '';
  var gestionando = false;
  var visor = null;

  function $(id) { return V.$(id); }
  function el(tag, cls, text) { return V.el(tag, cls, text); }

  /* ─── HELPERS ──────────────────────────────────────────────── */
  function texto(v) { return typeof v === 'string' ? v.trim() : ''; }

  // Misma tolerancia que esVisiblePublico() en firestore.rules: sin campo
  // cuenta como publicado y solo un false explícito esconde el documento.
  function esPublicado(d) {
    return !d || d.publicado !== false;
  }

  function uidActual() {
    if (typeof V.uidSesion === 'function') return V.uidSesion();
    return V.userId || '';
  }

  function haySesion() {
    return !V.isAnon && !!uidActual();
  }

  function puedeCategorias() {
    return typeof V.canManage === 'function' ? !!V.canManage() : false;
  }

  // Solo las cuentas con el permiso del CRM pueden configurar "Mi Tienda
  // Externa". El superadmin conserva el bypass, igual que en firestore.rules
  // (isAdmin()); un gestor NO lo tiene y la regla le negaría la escritura.
  function esAdminSesion() {
    return typeof V.esAdmin === 'function' && !!V.esAdmin();
  }

  function puedeGestionarTienda() {
    return haySesion() && (permisoVendedor || esAdminSesion());
  }

  function normPlataforma(raw) {
    var v = texto(raw).toLowerCase();
    for (var i = 0; i < PLATAFORMAS.length; i++) {
      if (PLATAFORMAS[i].id === v || PLATAFORMAS[i].label.toLowerCase() === v) return PLATAFORMAS[i].id;
    }
    // Compatibilidad con perfiles antiguos que solo guardaban redSocialNombre.
    if (v.indexOf('instagram') !== -1) return 'instagram';
    if (v.indexOf('facebook') !== -1) return 'facebook';
    if (v.indexOf('tiktok') !== -1) return 'tiktok';
    if (v.indexOf('whatsapp') !== -1) return 'whatsapp';
    return 'web';
  }

  function plataformaMeta(id) {
    var key = normPlataforma(id);
    for (var i = 0; i < PLATAFORMAS.length; i++) {
      if (PLATAFORMAS[i].id === key) return PLATAFORMAS[i];
    }
    return PLATAFORMAS[PLATAFORMAS.length - 1];
  }

  // Solo http(s): el campo lo escribe alguien con el panel en la mano y un
  // javascript: acabaría siendo el src de un iframe o el href de un enlace.
  function urlSegura(raw) {
    var u = texto(raw);
    if (!u) return '';
    if (/^https?:\/\//i.test(u)) return u;
    if (/^[\w.-]+\.[a-z]{2,}(\/|$|\?)/i.test(u)) return 'https://' + u;
    return '';
  }

  // El vendedor puede pegar una URL o el código embed de su plataforma.
  // Se extrae el src con DOMParser (no ejecuta scripts ni inserta HTML en
  // la página) y se valida que sea http(s). Nunca se inyecta el código.
  function extraerSrcEmbed(raw) {
    var directa = urlSegura(raw);
    if (directa) return directa;
    var code = texto(raw);
    if (!code) return '';
    try {
      var doc = new DOMParser().parseFromString(code, 'text/html');
      var node = doc.querySelector('iframe[src], embed[src], object[data]');
      if (node) {
        var cand = node.getAttribute('src') || node.getAttribute('data') || '';
        return urlSegura(cand);
      }
    } catch (e) { /* código no parseable */ }
    return '';
  }

  // Primer enlace absoluto del código, para el botón "abrir en pestaña nueva"
  // cuando la plataforma no permite incrustarse en un iframe.
  function primeraUrl(raw) {
    var m = texto(raw).match(/https?:\/\/[^\s"'<>]+/i);
    return m ? urlSegura(m[0]) : '';
  }

  function enlaceTienda(t) {
    return extraerSrcEmbed(t && t.tiendaUrl) || primeraUrl(t && t.tiendaUrl);
  }

  // Devuelve la URL parseada solo si el campo es una URL directa http(s).
  // Los códigos embed (empiezan por "<") se tratan aparte porque muchas
  // redes ofrecen plugins oficiales que sí permiten iframe.
  function urlDirecta(raw) {
    var u = urlSegura(raw);
    if (!u) return null;
    try { return new URL(u); } catch (e) { return null; }
  }

  function hostSinWww(u) {
    return u.hostname.toLowerCase().replace(/^www\./, '');
  }

  // Plugins/embeds oficiales pegados como URL directa: sí se pueden incrustar
  // (p. ej. facebook.com/plugins/page.php, instagram.com/p/…/embed).
  function esEmbedOficial(u) {
    var host = hostSinWww(u);
    var path = (u.pathname || '').toLowerCase();
    if ((host === 'facebook.com' || /\.facebook\.com$/.test(host)) && path.indexOf('/plugins/') === 0) return true;
    if ((host === 'instagram.com' || /\.instagram\.com$/.test(host)) && /\/(p|reel|tv)\/[^/]+\/embed\/?$/.test(path)) return true;
    if ((host === 'tiktok.com' || /\.tiktok\.com$/.test(host)) && path.indexOf('/embed/') === 0) return true;
    return false;
  }

  // Una URL directa de estas redes no se puede incrustar: bloquean el iframe
  // con X-Frame-Options / frame-ancestors. WhatsApp también cae aquí porque
  // sus enlaces wa.me/api.whatsapp.com tampoco admiten iframe.
  function redBloqueaIframe(raw) {
    var u = urlDirecta(raw);
    if (!u || esEmbedOficial(u)) return '';
    var host = hostSinWww(u);
    if (host === 'facebook.com' || host === 'fb.com' || /\.facebook\.com$/.test(host) || /\.fb\.com$/.test(host)) return 'facebook';
    if (host === 'instagram.com' || /\.instagram\.com$/.test(host)) return 'instagram';
    if (host === 'tiktok.com' || /\.tiktok\.com$/.test(host)) return 'tiktok';
    if (host === 'wa.me' || host === 'api.whatsapp.com' || host === 'whatsapp.com' || /\.whatsapp\.com$/.test(host)) return 'whatsapp';
    return '';
  }

  // Heurística para X-Frame-Options/CSP: un iframe rechazado queda en
  // about:blank. Si leer location lanza SecurityError es porque cargó un
  // documento de otro origen (se considera correcto). No es infalible, por
  // eso también hay un temporizador de carga y el botón de pestaña nueva.
  function iframeBloqueado(frame) {
    try {
      var href = frame.contentWindow && frame.contentWindow.location.href;
      return !href || href === 'about:blank';
    } catch (e) {
      return false;
    }
  }

  /* ─── REDES ADICIONALES DE LA FICHA ─────────────────────────
     Un vendedor puede estar en varias redes: la "Plataforma Principal"
     conserva su URL/embed para el visor y las demás se muestran como
     accesos directos con su ícono. Campos planos, fáciles de consultar. */
  var RED_FIELDS = {
    whatsapp: 'whatsappUrl',
    instagram: 'instagramUrl',
    tiktok: 'tiktokUrl',
    facebook: 'facebookUrl',
    web: 'webUrl'
  };

  function idRedPorCampo(campo) {
    for (var i = 0; i < PLATAFORMAS.length; i++) {
      if (RED_FIELDS[PLATAFORMAS[i].id] === campo) return PLATAFORMAS[i].id;
    }
    return 'web';
  }

  // Acepta URL, dominio suelto o, para WhatsApp, un número de teléfono
  // (se convierte a un enlace wa.me). Devuelve '' si no es utilizable.
  function normalizarRed(id, raw) {
    var v = texto(raw);
    if (!v) return '';
    if (id === 'whatsapp' && !/^https?:\/\//i.test(v) && !/^[\w.-]+\.[a-z]{2,}(\/|$|\?)/i.test(v)) {
      var digits = v.replace(/[^\d]/g, '');
      if (digits) return 'https://wa.me/' + digits;
    }
    return urlSegura(v);
  }

  // Una URL de YouTube en el campo web se etiqueta como "YouTube" en vez de
  // "Web / E-commerce", tanto en la tarjeta como en el visor.
  function esYouTube(url) {
    var u = urlDirecta(url);
    if (!u) return false;
    var host = hostSinWww(u);
    return host === 'youtube.com' || /\.youtube\.com$/.test(host)
      || host === 'youtu.be' || /\.youtu\.be$/.test(host);
  }

  function metaRed(id, url) {
    if (id === 'web' && esYouTube(url)) return { label: 'YouTube', icon: '▶️' };
    var p = plataformaMeta(id);
    return { label: p.label, icon: p.icon };
  }

  // Redes adicionales configuradas, sin repetir la plataforma principal
  // (que ya se destaca aparte en la tarjeta y en el modal).
  function redesSecundarias(t) {
    if (!t) return [];
    var principal = normPlataforma(t.plataforma);
    var lista = [];
    PLATAFORMAS.forEach(function (p) {
      if (p.id === principal) return;
      var url = urlSegura(t[RED_FIELDS[p.id]]);
      if (!url) return;
      var meta = metaRed(p.id, url);
      lista.push({ id: p.id, label: meta.label, icon: meta.icon, url: url });
    });
    return lista;
  }

  function chipRed(red, cls) {
    var a = el('a', cls);
    a.href = red.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = red.label;
    a.appendChild(el('span', 'red-icon', red.icon));
    a.appendChild(el('span', 'red-label', red.label));
    return a;
  }

  function iniciales(nombre) {
    var partes = texto(nombre).split(/\s+/).filter(Boolean);
    if (!partes.length) return '🏪';
    var a = partes[0].charAt(0);
    var b = partes.length > 1 ? partes[partes.length - 1].charAt(0) : '';
    return (a + b).toUpperCase();
  }

  function nombreTienda(t) {
    return texto(t && t.nombre) || texto(t && t.tiendaNombre) || 'Tienda sin nombre';
  }

  function porNombre(a, b) {
    var oa = typeof a.orden === 'number' ? a.orden : Number.MAX_SAFE_INTEGER;
    var ob = typeof b.orden === 'number' ? b.orden : Number.MAX_SAFE_INTEGER;
    if (oa !== ob) return oa - ob;
    return nombreTienda(a).localeCompare(nombreTienda(b), 'es');
  }

  function normOrden(v) {
    var n = parseInt(v, 10);
    return isFinite(n) ? n : 0;
  }

  /* ─── FIRESTORE ────────────────────────────────────────────── */
  /* Consultas de un SOLO campo. `!= false` no sirve: en una consulta descarta
     los documentos sin el campo. Se unen las mitades publicadas (true y null)
     y, si quien mira gestiona, también los borradores. */
  function consultasTiendas(col, conBorradores) {
    var qs = [
      col.where('publicado', '==', true),
      col.where('publicado', '==', null)
    ];
    if (conBorradores) qs.push(col.where('publicado', '==', false));
    return qs;
  }

  function subscribeTiendas(onDocs, conBorradores, onError) {
    var map = {};
    var unsubs = [];
    var qs = consultasTiendas(V.db.collection(COL_TIENDAS), conBorradores);
    function emit() {
      onDocs(Object.keys(map).map(function (id) { return map[id]; }).sort(porNombre));
    }
    qs.forEach(function (q, i) {
      var propia = q.onSnapshot(function (snap) {
        snap.docChanges().forEach(function (ch) {
          if (ch.type === 'removed') delete map[ch.doc.id];
        });
        snap.forEach(function (d) {
          var data = d.data();
          data.id = d.id;
          map[d.id] = data;
        });
        emit();
      }, function (err) {
        console.warn('[tienda] no se pudo leer ' + COL_TIENDAS + ': ' + (err && err.message));
        try { propia(); } catch (e) { /* ya dada de baja */ }
        unsubs[i] = null;
        if (!unsubs.some(function (fn) { return !!fn; })) {
          unsubs = [];
          if (typeof onError === 'function') onError();
        }
      });
      unsubs[i] = propia;
    });
    return function () {
      unsubs.forEach(function (fn) { if (fn) { try { fn(); } catch (e) { /* noop */ } } });
      unsubs = [];
    };
  }

  function baja(subscription) {
    if (!subscription) return;
    try { subscription(); } catch (e) { /* ya dada de baja */ }
  }

  function suscribirTiendas() {
    if (!V.db || tiendasSub) return;
    tiendasSub = subscribeTiendas(function (docs) {
      tiendasCache = docs;
      renderCategorias();
      renderTiendas();
    }, puedeCategorias(), function () { tiendasSub = null; });
  }

  function reconstruirSuscripciones() {
    baja(tiendasSub); tiendasSub = null;
    if (!V.db) return;
    suscribirTiendas();
  }

  /* ─── PERMISO Y PERFIL ─────────────────────────────────────── */
  function cargarPermisoVendedor(cb) {
    var uid = uidActual();
    permisoCargado = false;
    permisoVendedor = false;
    if (!V.db || !haySesion()) {
      permisoCargado = true;
      if (cb) cb();
      return;
    }
    V.db.collection(V.COL_USUARIOS).doc(uid).get()
      .then(function (doc) {
        if (uid !== uidActual()) return;
        permisoVendedor = !!(doc.exists && doc.data().vendedorAutorizado);
      })
      .catch(function () {
        // Sin lectura del propio perfil no se concede el permiso.
        permisoVendedor = false;
      })
      .then(function () {
        if (uid !== uidActual()) return;
        permisoCargado = true;
        if (cb) cb();
      });
  }

  function cargarPerfilTienda(cb) {
    if (!V.db || !haySesion()) { perfilTienda = null; if (cb) cb(); return; }
    var uid = uidActual();
    V.db.collection(COL_TIENDAS).doc(uid).get()
      .then(function (doc) {
        if (uid !== uidActual()) return;
        perfilTienda = doc.exists ? doc.data() : null;
        if (cb) cb();
      })
      .catch(function () {
        perfilTienda = null;
        if (cb) cb();
      });
  }

  /* ─── CATÁLOGO PÚBLICO ─────────────────────────────────────── */
  function tiendasVisibles() {
    var lista = puedeCategorias()
      ? tiendasCache
      : tiendasCache.filter(esPublicado);
    if (categoriaFiltro) {
      lista = lista.filter(function (t) { return texto(t.categoria) === categoriaFiltro; });
    }
    return lista;
  }

  function renderCategorias() {
    var bar = $('tiendaCategoriasBar');
    if (!bar) return;
    bar.innerHTML = '';

    var valores = [];
    tiendasCache.forEach(function (t) {
      if (!esPublicado(t) && !puedeCategorias()) return;
      var c = texto(t.categoria);
      if (c && valores.indexOf(c) === -1) valores.push(c);
    });
    valores.sort(function (a, b) { return a.localeCompare(b, 'es'); });
    if (!valores.length) return;

    if (valores.indexOf(categoriaFiltro) === -1) categoriaFiltro = '';

    var todas = el('button', 'tienda-cat' + (categoriaFiltro === '' ? ' active' : ''), 'Todas');
    todas.type = 'button';
    todas.addEventListener('click', function () {
      categoriaFiltro = '';
      renderCategorias();
      renderTiendas();
    });
    bar.appendChild(todas);

    valores.forEach(function (cat) {
      var b = el('button', 'tienda-cat' + (categoriaFiltro === cat ? ' active' : ''), cat);
      b.type = 'button';
      b.addEventListener('click', function () {
        categoriaFiltro = (categoriaFiltro === cat) ? '' : cat;
        renderCategorias();
        renderTiendas();
      });
      bar.appendChild(b);
    });
  }

  function avatarTienda(t) {
    var url = urlSegura(t && t.avatarUrl);
    if (url) {
      var img = document.createElement('img');
      img.className = 'tienda-store-avatar';
      img.src = url;
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', function () {
        if (img.parentNode) img.parentNode.replaceChild(el('div', 'tienda-store-avatar tienda-store-avatar-initials', iniciales(nombreTienda(t))), img);
      });
      return img;
    }
    return el('div', 'tienda-store-avatar tienda-store-avatar-initials', iniciales(nombreTienda(t)));
  }

  function renderTiendas() {
    var grid = $('tiendaGrid');
    if (!grid) return;
    grid.innerHTML = '';
    var lista = tiendasVisibles();

    if (!lista.length) {
      grid.appendChild(V.emptyState(
        '🏪',
        'Todavía no hay tiendas vinculadas',
        (puedeCategorias() || puedeGestionarTienda())
          ? 'Vincula tu tienda desde "Mi Tienda Externa" y aparecerá aquí al instante.'
          : 'Pronto los vendedores de la comunidad publicarán sus tiendas. Vuelve pronto.'
      ));
      return;
    }

    lista.forEach(function (t) {
      var card = el('article', 'tienda-store-card');

      var head = el('div', 'tienda-store-head');
      head.appendChild(avatarTienda(t));

      var ident = el('div', 'tienda-store-ident');
      ident.appendChild(el('h3', 'tienda-store-name', nombreTienda(t)));

      var meta = el('div', 'tienda-store-meta');
      meta.appendChild(el('span', 'tienda-store-cat', texto(t.categoria) || 'Sin categoría'));
      var plat = plataformaMeta(t.plataforma);
      meta.appendChild(el('span', 'tienda-store-platform', plat.icon + ' ' + plat.label));
      ident.appendChild(meta);
      head.appendChild(ident);
      card.appendChild(head);

      if (!esPublicado(t)) card.appendChild(el('span', 'status-pill', 'Borrador'));

      var desc = texto(t.descripcion);
      card.appendChild(el('p', 'tienda-store-desc', desc || 'El vendedor aún no agregó detalles de su tienda.'));

      var redes = redesSecundarias(t);
      if (redes.length) {
        var links = el('div', 'tienda-store-links');
        redes.forEach(function (red) { links.appendChild(chipRed(red, 'tienda-store-link')); });
        card.appendChild(links);
      }

      var foot = el('div', 'tienda-store-foot');
      var verBtn = el('button', 'btn btn-primary btn-sm', 'Ver Tienda');
      verBtn.type = 'button';
      verBtn.addEventListener('click', function () { abrirVisor(t); });
      foot.appendChild(verBtn);
      card.appendChild(foot);

      grid.appendChild(card);
    });
  }

  /* ─── VISOR DE TIENDA (modal + iframe seguro) ──────────────── */
  function asegurarVisor() {
    if (visor && document.body.contains(visor.overlay)) return visor;

    var overlay = el('div', 'tienda-viewer-overlay');
    var modal = el('div', 'tienda-viewer');

    var head = el('div', 'tienda-viewer-head');
    var ident = el('div', 'tienda-viewer-ident');
    var avatarHost = el('div', 'tienda-viewer-avatar-host');
    ident.appendChild(avatarHost);
    var texts = el('div', 'tienda-viewer-texts');
    var name = el('h3', 'tienda-viewer-name');
    var sub = el('p', 'tienda-viewer-sub');
    texts.appendChild(name);
    texts.appendChild(sub);
    ident.appendChild(texts);
    head.appendChild(ident);

    var closeBtn = el('button', 'tienda-viewer-close', '✕');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Cerrar');
    closeBtn.addEventListener('click', cerrarVisor);
    head.appendChild(closeBtn);
    modal.appendChild(head);

    var desc = el('p', 'tienda-viewer-desc');
    modal.appendChild(desc);

    // Accesos directos a las demás redes/canales del vendedor.
    var links = el('div', 'tienda-viewer-links');
    modal.appendChild(links);

    var body = el('div', 'tienda-viewer-body');

    // Interfaz limpia para cuando la red bloquea el iframe: logo, título,
    // motivo, descripción del vendedor y un botón destacado a la plataforma.
    var fallback = el('div', 'tienda-viewer-fallback');
    var fbLogo = el('div', 'tienda-viewer-fallback-logo');
    var fbTitle = el('h4', 'tienda-viewer-fallback-title');
    var fbText = el('p', 'tienda-viewer-fallback-text');
    var fbDesc = el('p', 'tienda-viewer-fallback-desc');
    var fbCta = el('a', 'btn btn-primary tienda-viewer-fallback-cta');
    fbCta.target = '_blank';
    fbCta.rel = 'noopener noreferrer';
    fallback.appendChild(fbLogo);
    fallback.appendChild(fbTitle);
    fallback.appendChild(fbText);
    fallback.appendChild(fbDesc);
    fallback.appendChild(fbCta);
    body.appendChild(fallback);

    modal.appendChild(body);

    var foot = el('div', 'tienda-viewer-foot');
    var openLink = el('a', 'btn btn-outline', '↗ Abrir en pestaña nueva');
    openLink.target = '_blank';
    openLink.rel = 'noopener noreferrer';
    foot.appendChild(openLink);
    var close2 = el('button', 'btn btn-outline', 'Cerrar');
    close2.type = 'button';
    close2.addEventListener('click', cerrarVisor);
    foot.appendChild(close2);
    modal.appendChild(foot);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) cerrarVisor(); });

    visor = {
      overlay: overlay,
      avatarHost: avatarHost,
      name: name,
      sub: sub,
      desc: desc,
      links: links,
      body: body,
      frame: null,
      fallback: fallback,
      fbLogo: fbLogo,
      fbTitle: fbTitle,
      fbText: fbText,
      fbDesc: fbDesc,
      fbCta: fbCta,
      openLink: openLink,
      tienda: null,
      plataforma: null,
      timer: null
    };
    return visor;
  }

  // Monta un iframe NUEVO en cada apertura: así una navegación about:blank
  // de un cierre anterior no dispara el detector de X-Frame-Options con el
  // src de la tienda actual. Los listeners quedan atados a este elemento.
  function crearFrame(m, src, t, plat) {
    if (m.frame && m.frame.parentNode) m.frame.parentNode.removeChild(m.frame);
    var frame = document.createElement('iframe');
    frame.className = 'tienda-viewer-frame';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('loading', 'lazy');
    frame.title = 'Tienda externa';
    // Un iframe rechazado por X-Frame-Options dispara "load" con about:blank:
    // se detecta y se cae a la interfaz limpia. Si cargó un documento real
    // (aunque sea de otro origen) se cancela el temporizador de respaldo.
    frame.addEventListener('load', function () {
      if (!m.overlay.classList.contains('show')) return;
      if (m.frame !== frame || frame.getAttribute('src') !== src) return;
      if (iframeBloqueado(frame)) {
        mostrarFallback(m, t, plat,
          'La tienda bloqueó la vista incrustada (X-Frame-Options). Ábrela en una pestaña nueva para verla completa.');
        return;
      }
      if (m.timer) { clearTimeout(m.timer); m.timer = null; }
    });
    frame.addEventListener('error', function () {
      if (m.frame !== frame) return;
      mostrarFallback(m, t, plat, 'No fue posible cargar la tienda dentro de VCONV.');
    });
    m.body.insertBefore(frame, m.fallback);
    m.frame = frame;
    return frame;
  }

  // Muestra la interfaz limpia (sin iframe) con logo, descripción y botón
  // destacado "Abrir tienda en [Plataforma]". Se usa tanto para redes que
  // bloquean el iframe como cuando la carga real falla o tarda demasiado.
  function mostrarFallback(m, t, plat, motivo) {
    if (!m) return;
    if (m.timer) { clearTimeout(m.timer); m.timer = null; }

    if (m.frame) {
      m.frame.style.display = 'none';
      try { m.frame.src = 'about:blank'; } catch (e) { /* noop */ }
      m.frame.removeAttribute('src');
    }
    m.desc.style.display = 'none';

    var label = (plat && plat.label) ? plat.label : 'la tienda';
    var descTxt = texto(t && t.descripcion);
    var href = enlaceTienda(t);

    m.fbLogo.innerHTML = '';
    m.fbLogo.appendChild(avatarTienda(t));
    m.fbTitle.textContent = 'Abre esta tienda en ' + label;
    m.fbText.textContent = motivo || 'Esta tienda no se puede mostrar dentro de VCONV.';
    m.fbDesc.textContent = descTxt;
    m.fbDesc.style.display = descTxt ? '' : 'none';

    if (href) {
      m.fbCta.href = href;
      m.fbCta.textContent = '↗ Abrir tienda en ' + label;
      m.fbCta.style.display = '';
    } else {
      m.fbCta.removeAttribute('href');
      m.fbCta.style.display = 'none';
    }

    m.fallback.style.display = 'flex';
  }

  function abrirVisor(t) {
    var m = asegurarVisor();
    var raw = texto(t && t.tiendaUrl);
    var bloqueada = redBloqueaIframe(raw);
    var plat = plataformaMeta(bloqueada || (t && t.plataforma));
    var src = bloqueada ? '' : extraerSrcEmbed(raw);
    var externa = primeraUrl(raw) || src;

    m.tienda = t;
    m.plataforma = plat;
    if (m.timer) { clearTimeout(m.timer); m.timer = null; }

    m.avatarHost.innerHTML = '';
    m.avatarHost.appendChild(avatarTienda(t));
    m.name.textContent = nombreTienda(t);
    m.sub.textContent = (texto(t && t.categoria) || 'Sin categoría') + ' · ' + plat.icon + ' ' + plat.label;

    // Plataforma principal ya se destaca arriba; aquí van los demás canales.
    m.links.innerHTML = '';
    var redes = redesSecundarias(t);
    if (redes.length) {
      redes.forEach(function (red) { m.links.appendChild(chipRed(red, 'tienda-viewer-link')); });
      m.links.style.display = 'flex';
    } else {
      m.links.style.display = 'none';
    }

    if (src) {
      m.desc.textContent = texto(t && t.descripcion);
      m.desc.style.display = m.desc.textContent ? '' : 'none';
      m.fallback.style.display = 'none';
      m.frame = crearFrame(m, src, t, plat);
      m.frame.style.display = '';
      m.frame.src = src;
      m.timer = setTimeout(function () {
        if (!m.overlay.classList.contains('show')) return;
        if (m.frame.getAttribute('src') !== src) return;
        mostrarFallback(m, t, plat,
          'La tienda tardó demasiado en cargar o bloqueó la vista incrustada. Ábrela en una pestaña nueva para verla completa.');
      }, 8000);
    } else if (bloqueada) {
      mostrarFallback(m, t, plat,
        'Esta plataforma no permite mostrar su contenido dentro de otra web. Ábrela en una pestaña nueva para verla completa.');
    } else {
      mostrarFallback(m, t, plat,
        'La tienda no incluye un enlace válido que se pueda mostrar aquí. Ábrela en una pestaña nueva para verla completa.');
    }

    if (externa) {
      m.openLink.href = externa;
      m.openLink.style.display = '';
    } else {
      m.openLink.removeAttribute('href');
      m.openLink.style.display = 'none';
    }

    m.overlay.classList.add('show');
  }

  function cerrarVisor() {
    if (!visor) return;
    visor.overlay.classList.remove('show');
    if (visor.timer) { clearTimeout(visor.timer); visor.timer = null; }
    // Detiene audio/video y libera el iframe al cerrar.
    if (visor.frame) {
      try { visor.frame.src = 'about:blank'; } catch (e) { /* noop */ }
      visor.frame.removeAttribute('src');
    }
  }

  function onEscape(e) {
    if (e.key === 'Escape' && visor && visor.overlay.classList.contains('show')) cerrarVisor();
  }

  /* ─── PANEL "MI TIENDA EXTERNA" ─────────────────────────────
     Se construye con el() en vez de vivir en index.html: el módulo ocupa un
     hueco en el HTML y todo el formulario está en un único sitio. */
  function campo(rotulo, control, hint, full) {
    var wrap = el('div', 'field' + (full ? ' field-full' : ''));
    var l = el('label', '', rotulo);
    l.htmlFor = control.id;
    wrap.appendChild(l);
    wrap.appendChild(control);
    if (hint) wrap.appendChild(el('p', 'field-hint', hint));
    return wrap;
  }

  function fila() { return el('div', 'form-row'); }

  function input(id, type, value, placeholder) {
    var n = document.createElement('input');
    n.id = id;
    n.type = type || 'text';
    n.className = 'input';
    n.value = value === undefined || value === null ? '' : String(value);
    if (placeholder) n.placeholder = placeholder;
    n.autocomplete = 'off';
    return n;
  }

  function textarea(id, value, placeholder, rows) {
    var n = document.createElement('textarea');
    n.id = id;
    n.className = 'textarea';
    n.rows = rows || 3;
    n.value = value || '';
    if (placeholder) n.placeholder = placeholder;
    return n;
  }

  function check(id, etiqueta, checked) {
    var wrap = el('label', 'cms-check-label');
    var chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.id = id;
    chk.checked = !!checked;
    wrap.appendChild(chk);
    wrap.appendChild(el('span', '', etiqueta));
    return wrap;
  }

  function boton(txt, cls, onClick) {
    var b = el('button', 'btn ' + cls, txt);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function adminCard(titulo, subtitulo, icono) {
    var card = el('div', 'tienda-admin-card');
    var head = el('div', 'tienda-admin-head');
    head.appendChild(el('h3', '', (icono ? icono + ' ' : '') + titulo));
    if (subtitulo) head.appendChild(el('p', '', subtitulo));
    card.appendChild(head);
    return card;
  }

  function renderAdmin() {
    var host = $('tiendaAdmin');
    if (!host) return;
    if (!gestionando) { host.style.display = 'none'; host.innerHTML = ''; return; }
    host.style.display = '';
    host.innerHTML = '';

    if (!haySesion()) {
      host.appendChild(el('p', 'tienda-admin-empty', 'Inicia sesión para configurar tu tienda externa.'));
      return;
    }
    if (!puedeGestionarTienda()) {
      host.appendChild(el('p', 'tienda-admin-empty', 'Tu cuenta no tiene el permiso "Vendedor Autorizado". Solicítalo al administrador para vincular tu tienda externa.'));
      return;
    }
    host.appendChild(formTiendaExterna());
  }

  function formTiendaExterna() {
    var perfil = perfilTienda || {};
    var card = adminCard(
      'Mi Tienda Externa',
      'Vincula tu tienda o red social. No creas productos aquí: el catálogo se muestra directamente desde tu plataforma.',
      '🏪'
    );

    var r1 = fila();
    r1.appendChild(campo('Nombre del negocio', input('tiendaNombre', 'text', nombreTienda(perfil), 'Ej: Tejidos MP')));
    var selPlat = document.createElement('select');
    selPlat.id = 'tiendaPlataforma';
    selPlat.className = 'select';
    PLATAFORMAS.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.icon + ' ' + p.label;
      selPlat.appendChild(o);
    });
    selPlat.value = normPlataforma(perfil.plataforma || perfil.redSocialNombre);
    r1.appendChild(campo('Plataforma', selPlat));
    card.appendChild(r1);

    var r2 = fila();
    r2.appendChild(campo('Categoría principal del negocio', input('tiendaCategoria', 'text', texto(perfil.categoria), 'Ej: Artesanías, Moda, Belleza, Comida')));
    r2.appendChild(campo('Logo / Avatar (URL, opcional)', input('tiendaAvatar', 'url', texto(perfil.avatarUrl), 'https://…/logo.png')));
    card.appendChild(r2);

    var r3 = fila();
    r3.appendChild(campo(
      'Descripción / Detalles de la Tienda',
      textarea('tiendaDescripcion', texto(perfil.descripcion), 'Agrega tu propuesta de valor, términos, garantía o información que no está en tu red social…', 4),
      'Este texto es el que verán los visitantes en la tarjeta pública.',
      true
    ));
    card.appendChild(r3);

    var r4 = fila();
    r4.appendChild(campo(
      'URL o Código Embed HTML de la tienda',
      textarea('tiendaEnlace', texto(perfil.tiendaUrl), 'https://mitienda.com  ó  <iframe src="https://mitienda.com"></iframe>', 3),
      'Acepta una URL directa o el código embed que te da tu plataforma. El visor extrae el enlace de forma segura.',
      true
    ));
    card.appendChild(r4);

    // Otras redes/canales: se muestran como accesos directos con su ícono en
    // la tarjeta pública y en el visor. Todos opcionales.
    card.appendChild(el('h4', 'tienda-admin-subtitle', '🔗 Otras redes y canales (opcional)'));
    card.appendChild(el('p', 'field-hint', 'Agrega solo las que tengas. Aparecerán como botones con ícono en tu ficha pública.'));

    var rWa = fila();
    rWa.appendChild(campo('💬 WhatsApp', input('tiendaWhatsapp', 'text', texto(perfil.whatsappUrl), 'https://wa.me/573001234567 o tu número')));
    rWa.appendChild(campo('📸 Instagram', input('tiendaInstagram', 'url', texto(perfil.instagramUrl), 'https://instagram.com/tunegocio')));
    card.appendChild(rWa);

    var rTf = fila();
    rTf.appendChild(campo('🎵 TikTok', input('tiendaTiktok', 'url', texto(perfil.tiktokUrl), 'https://tiktok.com/@tunegocio')));
    rTf.appendChild(campo('📘 Facebook', input('tiendaFacebook', 'url', texto(perfil.facebookUrl), 'https://facebook.com/tunegocio')));
    card.appendChild(rTf);

    var rWeb = fila();
    rWeb.appendChild(campo(
      '🌐 Sitio Web / YouTube',
      input('tiendaWeb', 'url', texto(perfil.webUrl), 'https://tunegocio.com  ó  https://youtube.com/@tucanal'),
      'Sitio Web / YouTube: si pegas un enlace de YouTube se mostrará con su ícono y etiqueta.'
    ));
    card.appendChild(rWeb);

    var r5 = fila();
    r5.appendChild(campo('Publicación', check('tiendaPublicado', 'Publicada (visible en el marketplace público)', perfil.publicado !== false), null, true));
    card.appendChild(r5);

    var acciones = el('div', 'form-actions');
    var btn = boton(perfil.id || perfil.nombre ? '💾 Actualizar tienda' : '💾 Vincular tienda', 'btn btn-primary', function () {
      guardarTienda({
        nombre: $('tiendaNombre').value,
        plataforma: $('tiendaPlataforma').value,
        categoria: $('tiendaCategoria').value,
        descripcion: $('tiendaDescripcion').value,
        avatarUrl: $('tiendaAvatar').value,
        tiendaUrl: $('tiendaEnlace').value,
        whatsapp: $('tiendaWhatsapp').value,
        instagram: $('tiendaInstagram').value,
        tiktok: $('tiendaTiktok').value,
        facebook: $('tiendaFacebook').value,
        web: $('tiendaWeb').value,
        publicado: $('tiendaPublicado').checked
      }, btn);
    });
    acciones.appendChild(btn);
    card.appendChild(acciones);

    if (perfilTienda) {
      card.appendChild(el('p', 'field-hint', 'Última actualización: ' + (V.fmtDate && perfilTienda.actualizado ? V.fmtDate(perfilTienda.actualizado) : (perfilTienda.actualizado || '—'))));
    }
    return card;
  }

  function guardarTienda(datos, btn) {
    if (!puedeGestionarTienda()) {
      V.toast('Tu cuenta no tiene el permiso "Vendedor Autorizado".', true);
      return;
    }
    if (!V.db) { V.toast('Firestore no disponible.', true); return; }
    if (!texto(datos.nombre)) {
      V.toast('El nombre del negocio es obligatorio.', true);
      return;
    }
    if (!texto(datos.categoria)) {
      V.toast('Indica la categoría principal del negocio.', true);
      return;
    }
    var enlace = texto(datos.tiendaUrl);
    if (!enlace || (!extraerSrcEmbed(enlace) && !primeraUrl(enlace))) {
      V.toast('Indica una URL o un código embed válido (http/https).', true);
      return;
    }

    // Normaliza las redes adicionales y avisa si alguna no es utilizable.
    var enlacesRed = {
      whatsappUrl: normalizarRed('whatsapp', datos.whatsapp),
      instagramUrl: normalizarRed('instagram', datos.instagram),
      tiktokUrl: normalizarRed('tiktok', datos.tiktok),
      facebookUrl: normalizarRed('facebook', datos.facebook),
      webUrl: normalizarRed('web', datos.web)
    };
    var crudos = {
      whatsappUrl: datos.whatsapp,
      instagramUrl: datos.instagram,
      tiktokUrl: datos.tiktok,
      facebookUrl: datos.facebook,
      webUrl: datos.web
    };
    var invalido = '';
    Object.keys(crudos).forEach(function (k) {
      if (texto(crudos[k]) && !enlacesRed[k]) invalido = k;
    });
    if (invalido) {
      V.toast('El enlace de ' + plataformaMeta(idRedPorCampo(invalido)).label + ' no es válido.', true);
      return;
    }

    var uid = uidActual();
    var payload = {
      nombre: texto(datos.nombre),
      tiendaNombre: texto(datos.nombre),
      plataforma: normPlataforma(datos.plataforma),
      categoria: texto(datos.categoria),
      descripcion: texto(datos.descripcion),
      avatarUrl: urlSegura(datos.avatarUrl),
      tiendaUrl: enlace,
      whatsappUrl: enlacesRed.whatsappUrl,
      instagramUrl: enlacesRed.instagramUrl,
      tiktokUrl: enlacesRed.tiktokUrl,
      facebookUrl: enlacesRed.facebookUrl,
      webUrl: enlacesRed.webUrl,
      publicado: !!datos.publicado,
      actualizado: new Date().toISOString()
    };
    // Conserva datos de contacto del perfil anterior, sin exponerlos en la
    // tarjeta: el modelo ahora se centra en la tienda externa.
    if (perfilTienda && perfilTienda.whatsapp) payload.whatsapp = perfilTienda.whatsapp;

    var eraNueva = !(perfilTienda && (perfilTienda.nombre || perfilTienda.tiendaNombre));
    if (btn) { btn.disabled = true; btn._t = btn.textContent; btn.textContent = '⏳ Guardando…'; }
    var ref = V.db.collection(COL_TIENDAS).doc(uid);
    return ref.get().then(function (doc) {
      payload.creado = (doc.exists && doc.data().creado) || new Date().toISOString();
      return ref.set(payload, { merge: true });
    }).then(function () {
      perfilTienda = payload;
      V.toast(eraNueva ? 'Tienda vinculada ✓' : 'Tienda actualizada ✓');
      renderAdmin();
    }).catch(function (e) {
      V.toast('No se pudo guardar la tienda: ' + e.message, true);
    }).then(function () {
      if (btn) { btn.disabled = false; btn.textContent = btn._t || btn.textContent; }
    });
  }

  /* ─── RESUMEN PARA LA PORTADA PÚBLICA ────────────────────────
     Un solo paso (get, no suscripción): la landing no necesita refrescarse al
     segundo y no mantiene una escucha abierta por una cifra decorativa. Filtra
     SIEMPRE por publicación, aunque quien mire sea gestor: la portada pública
     debe enseñar lo mismo que verá un visitante. */
  function resumenPublico(alTerminar) {
    var avisar = function (lista) {
      try { alTerminar(lista || []); } catch (e) { /* la portada sigue igual */ }
    };
    if (!V.db) { avisar([]); return; }
    var snaps = consultasTiendas(V.db.collection(COL_TIENDAS), false).map(function (q) {
      return q.get().catch(function () { return null; });
    });
    Promise.all(snaps).then(function (res) {
      var map = {};
      res.forEach(function (snap) {
        if (!snap) return;
        snap.forEach(function (d) {
          var data = d.data();
          data.id = d.id;
          map[d.id] = data;
        });
      });
      avisar(Object.keys(map).map(function (id) { return map[id]; })
        .filter(esPublicado).sort(porNombre));
    });
  }

  /* ─── SHOW HOOK ──────────────────────────────────────────────
     showTienda() del core solo enciende la vista: el repintado y la
     suscripción de datos viven aquí, igual que onPodcastsShow(). */
  function onShow() {
    actualizarBotonesCabecera();
    renderAdmin();

    if (!haySesion()) {
      permisoVendedor = false;
      permisoCargado = true;
      perfilTienda = null;
      gestionando = false;
      actualizarBotonesCabecera();
    } else {
      cargarPermisoVendedor(function () {
        if (!puedeVenderActivo()) gestionando = false;
        cargarPerfilTienda(function () {
          actualizarBotonesCabecera();
          renderAdmin();
        });
      });
    }

    if (!V.db) {
      renderCategorias();
      renderTiendas();
      return;
    }
    // onShow también es el reintento: si una suscripción se cayó por reglas sin
    // desplegar, su hueco quedó libre y aquí se vuelve a abrir.
    suscribirTiendas();
    renderCategorias();
    renderTiendas();
  }

  // Estado de permiso ya resuelto (evita mostrar el panel antes de saberlo).
  function puedeVenderActivo() {
    return permisoCargado && puedeGestionarTienda();
  }

  function actualizarBotonesCabecera() {
    var acciones = $('tiendaHeaderActions');
    if (acciones) acciones.style.display = '';
    var btnGest = $('btnTiendaGestionar');
    if (btnGest) {
      var visible = puedeVenderActivo();
      btnGest.style.display = visible ? '' : 'none';
      btnGest.textContent = gestionando ? '👁 Ver tiendas' : '⚙ Mi Tienda Externa';
    }
    var sub = $('tiendaSub');
    if (sub) {
      sub.textContent = gestionando
        ? 'Mi Tienda Externa: vincula tu negocio, su categoría, una descripción propia y la URL o embed de tu tienda.'
        : 'Tiendas de vendedores de la comunidad. Explora cada negocio y visita su tienda sin salir de VCONV.';
    }
  }

  function bindEvents() {
    var btnGest = $('btnTiendaGestionar');
    if (btnGest) btnGest.addEventListener('click', function () {
      if (!haySesion()) { if (V.openAuth) V.openAuth('login'); return; }
      if (!puedeVenderActivo()) {
        V.toast('Tu cuenta no tiene el permiso "Vendedor Autorizado".', true);
        return;
      }
      gestionando = !gestionando;
      actualizarBotonesCabecera();
      if (!gestionando) { renderAdmin(); return; }
      // Refresca el perfil guardado antes de pintar el formulario (evita
      // reescribir lo que el vendedor esté escribiendo con datos viejos).
      cargarPerfilTienda(function () {
        renderAdmin();
        var admin = $('tiendaAdmin');
        if (admin) admin.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
    document.addEventListener('keydown', onEscape);
  }

  /* ─── MÓDULO ────────────────────────────────────────────────── */
  V.registerModule({
    onReady: function () {
      bindEvents();
      onShow();
    }
  });
  V.onTiendaShow = onShow;

  // La identidad puede cambiar después de montado el módulo (el visitante crea
  // su cuenta): las suscripciones se rehacen con el alcance que corresponde.
  var _onSessionRefreshPrev = V.onSessionRefresh;
  V.onSessionRefresh = function () {
    if (typeof _onSessionRefreshPrev === 'function') {
      try { _onSessionRefreshPrev(); } catch (e) { /* noop */ }
    }
    cerrarVisor();
    gestionando = false;
    perfilTienda = null;
    permisoVendedor = false;
    permisoCargado = false;
    reconstruirSuscripciones();
    onShow();
  };

  var _onModeChangePrev = V.onModeChange;
  V.onModeChange = function (m) {
    if (typeof _onModeChangePrev === 'function') {
      try { _onModeChangePrev(m); } catch (e) { /* noop */ }
    }
    if (!puedeVenderActivo()) {
      gestionando = false;
      cerrarVisor();
    }
    reconstruirSuscripciones();
    actualizarBotonesCabecera();
    renderAdmin();
  };

  /* API mínima para el resto de la app (la ficha de la portada la usa). */
  V.tienda = {
    COL_TIENDAS: COL_TIENDAS,
    COL_VENDEDORES: COL_TIENDAS,
    COL_CATEGORIAS: COL_CATEGORIAS,
    COL_PRODUCTOS: COL_PRODUCTOS,
    show: function () { if (V.showTienda) V.showTienda(); },
    abrirTienda: abrirVisor,
    lista: tiendasVisibles,
    resumenPublico: resumenPublico,
    plataformaMeta: plataformaMeta
  };
})();
