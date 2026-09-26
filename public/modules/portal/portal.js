/* ════════════════════════════════════════════════════════════════
   VCONV · Portal Público — Landing page para visitantes no autenticados
   Render editable desde public/data/content.json, formulario de
   contacto con validación y acceso integrado con Firebase Auth.
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var V = window.VCONV;
  if (!V) { console.error('VCONV core not loaded'); return; }

  var CONTENT_PATH = 'data/content.json';
  var CONTACT_FIELDS = ['ctNombre', 'ctEmail', 'ctAsunto', 'ctMensaje'];
  var CONTACT_TO_EMAIL = 'convocacion@gmail.com';
  var EMAILJS_CONFIG = {
    serviceId: 'TU_SERVICE_ID',
    templateId: 'TU_TEMPLATE_ID',
    publicKey: 'TU_PUBLIC_KEY'
  };
  var contentData = null;

  /* ─── VIDEO CORPORATIVO ──────────────────────────────────────
     Ajustes del video que se publica en la portada. Viven en el
     documento config/portal de Firestore (colección `config`), NO en
     content.json: así el superadmin los cambia desde el panel sin
     desplegar nada y la portada los toma siempre frescos por onSnapshot.
     Coincide con el resto de ajustes de la app (config/mlm,
     config/finanzas, config/perfiles…), que usan la misma colección. */
  var CONFIG_COLLECTION = 'config';
  var PORTAL_DOC = 'portal';

  /* Bitácora de los cambios del panel. Colección APARTE, y no un campo más
     de config/portal, porque ese documento se lee sin sesión: guardar ahí el
     UID de quien edito lo haría público (bastaría con abrir la landing en
     incógnito y leerlo en la respuesta de red). En superadmin_auditoria solo
     entra y solo lee isAdmin(). */
  var AUDIT_COLLECTION = 'superadmin_auditoria';

  // Estado vivo del documento config/portal (normalizado). Se rellena con el
  // primer onSnapshot y se mantiene al día con los siguientes.
  var videoCfg = { videoUrl: '', videoTitulo: '', videoTipo: 'auto', videoActivo: true };
  var videoUnsub = null;

  function $(id) { return V.$(id); }
  function el(tag, cls, text) { return V.el(tag, cls, text); }

  function setText(id, value) {
    var n = $(id);
    if (n && value) n.textContent = value;
  }

  // El brand tiene un punto decorativo (<span>.</span>); setText lo
  // borraría, así que se reconstruye el contenido preservando el acento.
  function setBrand(id, value) {
    var n = $(id);
    if (!n || !value) return;
    n.textContent = '';
    n.appendChild(document.createTextNode(value));
    var dot = document.createElement('span');
    dot.textContent = '.';
    n.appendChild(dot);
  }

  function loadContent() {
    return fetch(CONTENT_PATH)
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .catch(function () {
        return {
          portal: { hero: {}, sections: { blocks: {}, contact: {} } },
          blocks: [],
          contact: {},
          footer: {}
        };
      });
  }

  function renderBlocks(data) {
    var container = $('portalBlocksGrid');
    if (!container) return;
    container.innerHTML = '';
    var blocks = data.blocks || [];
    if (!blocks.length) {
      container.appendChild(V.emptyState('📚', 'Contenido por configurar', 'Edita public/data/content.json para publicar los bloques.'));
      return;
    }
    blocks.forEach(function (b) {
      if (!b || !b.title) return;
      var card = el('article', 'portal-block');
      if (b.accent) card.classList.add('accent-' + b.accent);
      card.appendChild(el('div', 'portal-block-icon', b.icon || '✦'));
      var body = el('div', 'portal-block-body');
      body.appendChild(el('h3', 'portal-block-title', b.title));
      if (b.text) body.appendChild(el('p', 'portal-block-text', b.text));
      if (b.highlight) body.appendChild(el('span', 'portal-block-highlight', b.highlight));
      card.appendChild(body);
      container.appendChild(card);
    });
  }

  function fillContactSelects(data) {
    var labels = (data.contact && data.contact.labels) || {};
    var placeholders = (data.contact && data.contact.placeholders) || {};
    setText('lblNombre', labels.nombre || 'Nombre');
    setText('lblEmail', labels.email || 'Correo electrónico');
    setText('lblAsunto', labels.asunto || 'Asunto');
    setText('lblMensaje', labels.mensaje || 'Mensaje');
    setText('ctSubmit', labels.submit || 'Enviar mensaje');
    var nombre = $('ctNombre');
    if (nombre) nombre.placeholder = placeholders.nombre || '';
    var email = $('ctEmail');
    if (email) email.placeholder = placeholders.email || '';
    var msg = $('ctMensaje');
    if (msg) msg.placeholder = placeholders.mensaje || '';

    var selAsunto = $('ctAsunto');
    if (!selAsunto) return;
    selAsunto.innerHTML = '';
    var asuntos = (data.contact && data.contact.asuntos) || [];
    if (!asuntos.length) asuntos = ['Información general'];
    asuntos.forEach(function (a) {
      var opt = document.createElement('option');
      opt.value = a; opt.textContent = a;
      selAsunto.appendChild(opt);
    });
  }

  function renderContent(data) {
    contentData = data;
    var p = data.portal || {};
    var hero = p.hero || {};
    var sections = p.sections || {};
    var coursesSec = sections.courses || {};
    var videoSec = sections.video || {};
    var blocksSec = sections.blocks || {};
    var contactSec = sections.contact || {};
    var contact = data.contact || {};
    var footer = data.footer || {};

    setBrand('portalFooterBrand', p.brand || 'VCONV');

    setText('portalHeroBadge', hero.badge);
    setText('portalHeroTitle', hero.title);
    setText('portalHeroSubtitle', hero.subtitle);
    setText('portalCtaPrimary', hero.ctaPrimary);
    setText('portalCtaSecondary', hero.ctaSecondary);

    setText('coursesEyebrow', coursesSec.eyebrow);
    setText('coursesTitle', coursesSec.title);
    setText('coursesSubtitle', coursesSec.subtitle);
    setText('portalCtaCourses', hero.ctaCourses);

    setText('videoEyebrow', videoSec.eyebrow);
    setText('videoTitle', videoSec.title);
    setText('videoSubtitle', videoSec.subtitle);

    setText('blocksEyebrow', blocksSec.eyebrow);
    setText('blocksTitle', blocksSec.title);
    setText('blocksSubtitle', blocksSec.subtitle);

    setText('contactEyebrow', contactSec.eyebrow);
    setText('contactTitle', contact.title || contactSec.title);
    setText('contactSubtitle', contact.subtitle || contactSec.subtitle);

    setText('portalFooterText', footer.text);
    setText('portalCopyright', footer.copyright);

    fillContactSelects(data);
    renderBlocks(data);
    // content.json y config/portal llegan por caminos distintos (fetch local
    // vs onSnapshot a Firestore) y el orden no está garantizado: se vuelve a
    // fijar el estado de la sección al terminar de pintar los textos, para
    // que no se quede visible con los títulos vacíos si Firestore ganó la
    // carrera.
    renderVideoSection();
  }

  function markInvalid(id, isInvalid) {
    var n = $(id);
    if (n) n.classList.toggle('invalid', isInvalid);
  }

  function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
  }

  function handleContactSubmit(e) {
    e.preventDefault();
    CONTACT_FIELDS.forEach(function (id) { markInvalid(id, false); });

    var nombre = $('ctNombre').value.trim();
    var email = $('ctEmail').value.trim();
    var mensaje = $('ctMensaje').value.trim();

    if (!nombre) { markInvalid('ctNombre', true); V.toast('Escribe tu nombre.', true); return; }
    if (!email) { markInvalid('ctEmail', true); V.toast('Escribe tu correo electrónico.', true); return; }
    if (!isValidEmail(email)) { markInvalid('ctEmail', true); V.toast('El correo electrónico no es válido.', true); return; }
    var asunto = $('ctAsunto').value.trim();
    if (!asunto) { markInvalid('ctAsunto', true); V.toast('Selecciona un asunto.', true); return; }
    if (mensaje.length < 10) { markInvalid('ctMensaje', true); V.toast('Escribe un mensaje de al menos 10 caracteres.', true); return; }

    var btn = $('ctSubmit');
    var original = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳ Enviando…';

    if (!window.emailjs || !EMAILJS_CONFIG.serviceId || !EMAILJS_CONFIG.templateId || EMAILJS_CONFIG.publicKey.indexOf('TU_') === 0) {
      btn.disabled = false;
      btn.textContent = original;
      V.toast('El envío de correos no está configurado.', true);
      return;
    }

    var params = {
      from_name: nombre,
      reply_to: email,
      to_email: CONTACT_TO_EMAIL,
      subject: asunto,
      message: mensaje
    };

    emailjs.send(EMAILJS_CONFIG.serviceId, EMAILJS_CONFIG.templateId, params, { publicKey: EMAILJS_CONFIG.publicKey })
      .then(function () {
        btn.disabled = false;
        btn.textContent = original;
        $('contactForm').reset();
        V.toast((contentData.contact && contentData.contact.successMessage) || '¡Mensaje enviado!');
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = original;
        V.toast('No se pudo enviar el mensaje: ' + (err && err.text ? err.text : 'Error desconocido'), true);
      });
  }

  function setThemeButton(isDark) {
    ['portalThemeToggle', 'portalSidebarThemeToggle'].forEach(function (id) {
      var btn = $(id);
      if (!btn) return;
      btn.textContent = isDark ? '🌙' : '☀️';
      btn.title = isDark ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro';
    });
  }

  function currentIsDark() {
    var stored = localStorage.getItem('vconv_theme');
    if (stored) return stored !== 'light';
    return document.documentElement.getAttribute('data-theme') !== 'light';
  }

  // Lógica autónoma del botón: alterna data-theme en document.documentElement,
  // persiste en vconv_theme y actualiza el ícono de inmediato.
  function togglePortalTheme() {
    var next = currentIsDark() ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('vconv_theme', next);
    setThemeButton(next === 'dark');
  }

  function openSidebar() {
    var sidebar = $('portalSidebar');
    var overlay = $('portalSidebarOverlay');
    var burger = $('portalBurger');
    if (sidebar) { sidebar.classList.add('open'); sidebar.setAttribute('aria-hidden', 'false'); }
    if (overlay) { overlay.hidden = false; requestAnimationFrame(function () { overlay.classList.add('open'); }); }
    if (burger) burger.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
  }

  function closeSidebar() {
    var sidebar = $('portalSidebar');
    var overlay = $('portalSidebarOverlay');
    var burger = $('portalBurger');
    if (sidebar) { sidebar.classList.remove('open'); sidebar.setAttribute('aria-hidden', 'true'); }
    if (overlay) { overlay.classList.remove('open'); overlay.hidden = true; }
    if (burger) burger.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
  }

  // Sesión real autenticada (los visitantes navegan sin sesión de Firebase,
  // en modo local de solo lectura: deben poder registrarse/iniciar sesión).
  function hasRealSession() {
    return !!(V.auth && V.auth.currentUser);
  }

  // Acceso destacado de la landing a los cursos gratuitos del catálogo:
  // el botón de la tarjeta y los enlaces de navegación abren el catálogo
  // público directamente (visitante: solo lectura; cuenta: su vista de
  // cursos) sin redirigir al Escritorio de invitado.
  function goCourses() {
    closeSidebar();
    if (typeof V.showGuestCatalog === 'function') { V.showGuestCatalog(); return; }
    if (hasRealSession()) { V.showApp(); return; }
    V.openAuth('login');
  }

  function bindPortalEvents() {
    var themeBtn = $('portalThemeToggle');
    if (themeBtn) themeBtn.addEventListener('click', togglePortalTheme);
    var sidebarThemeBtn = $('portalSidebarThemeToggle');
    if (sidebarThemeBtn) sidebarThemeBtn.addEventListener('click', togglePortalTheme);
    var loginBtn = $('portalLoginBtn');
    if (loginBtn) loginBtn.addEventListener('click', function () {
      if (hasRealSession()) { V.showApp(); return; }
      V.openAuth('login');
    });
    var regBtn = $('portalRegisterBtn');
    if (regBtn) regBtn.addEventListener('click', function () {
      if (hasRealSession()) { V.showApp(); return; }
      V.openAuth('register');
    });
    var sidebarLoginBtn = $('portalSidebarLoginBtn');
    if (sidebarLoginBtn) sidebarLoginBtn.addEventListener('click', function () {
      closeSidebar();
      if (hasRealSession()) { V.showApp(); return; }
      V.openAuth('login');
    });
    var sidebarRegBtn = $('portalSidebarRegisterBtn');
    if (sidebarRegBtn) sidebarRegBtn.addEventListener('click', function () {
      closeSidebar();
      if (hasRealSession()) { V.showApp(); return; }
      V.openAuth('register');
    });

    // Logo del portal: con sesión real vuelve al escritorio, si no, a la landing.
    var portalBrands = document.querySelectorAll('.portal-brand, .portal-hero-inner a[href="index.html"]');
    portalBrands.forEach(function (brand) {
      brand.addEventListener('click', function (e) {
        e.preventDefault();
        if (hasRealSession()) { V.showApp(); return; }
        window.location.href = brand.getAttribute('href') || 'index.html';
      });
    });

    var cta = $('portalCtaPrimary');
    if (cta) {
      cta.addEventListener('click', function () {
        if (hasRealSession()) { V.showApp(); return; }
        var target = (contentData && contentData.portal && contentData.portal.hero && contentData.portal.hero.ctaPrimaryTarget) || 'register';
        V.openAuth(target === 'login' ? 'login' : 'register');
      });
    }
    var cta2 = $('portalCtaSecondary');
    if (cta2) {
      cta2.addEventListener('click', function () {
        var blocks = $('portalBlocks');
        if (blocks) blocks.scrollIntoView({ behavior: 'smooth' });
      });
    }

    // Acceso directo a los cursos gratuitos: el botón de la tarjeta destacada
    // y los enlaces de navegación (escritorio + móvil) abren el catálogo
    // público sin disparar la sesión anónima ni errores de permisos.
    var coursesCta = $('portalCtaCourses');
    if (coursesCta) coursesCta.addEventListener('click', goCourses);
    document.querySelectorAll('.portal-courses-go').forEach(function (link) {
      link.addEventListener('click', function (e) {
        e.preventDefault();
        goCourses();
      });
    });

    var form = $('contactForm');
    if (form) form.addEventListener('submit', handleContactSubmit);
    CONTACT_FIELDS.forEach(function (id) {
      var n = $(id);
      if (n) n.addEventListener('input', function () { markInvalid(id, false); });
    });

    var burger = $('portalBurger');
    if (burger) burger.addEventListener('click', function () {
      var isOpen = burger.getAttribute('aria-expanded') === 'true';
      if (isOpen) { closeSidebar(); } else { openSidebar(); }
    });
    var overlay = $('portalSidebarOverlay');
    if (overlay) overlay.addEventListener('click', closeSidebar);
    var closeBtn = $('portalSidebarClose');
    if (closeBtn) closeBtn.addEventListener('click', closeSidebar);
    var sidebarNav = $('portalSidebarNav');
    if (sidebarNav) sidebarNav.addEventListener('click', function (e) {
      if (e.target && typeof e.target.closest === 'function' && e.target.closest('a')) closeSidebar();
    });
  }

  /* ════════════════════════════════════════════════════════════
     VIDEO CORPORATIVO
     ════════════════════════════════════════════════════════════ */

  // Extensiones que se entregan directamente como archivo de vídeo. Aunque
  // .mkv/.avi/.flv no las reproduce cualquier navegador, se tratan como
  // archivo (no como página) para que el <video> muestre su error con el
  // enlace de "abrir en otra pestaña" en lugar de un iframe en blanco.
  var VIDEO_EXT_RE = /\.(mp4|webm|ogv|ogg|m4v|mov|mkv|avi|flv|wmv|m3u8)(?:$|[?#])/i;

  // Etiquetas legibles de cada fuente, reutilizadas por el reproductor y por
  // el aviso de "fuente detectada" del panel de administración.
  var SOURCE_LABELS = {
    youtube: '🎬 YouTube',
    drive: '📁 Google Drive',
    vimeo: '🎥 Vimeo',
    directo: '🎬 Archivo de video directo',
    externo: '🔗 Reproductor externo'
  };

  function cleanUrl(raw) {
    // Recorta espacios/caracteres de control que se cuelan al copiar y
    // valida que sea http(s): cualquier otro esquema (javascript:, data:)
    // se descarta en origen para no acabar en un atributo src.
    if (typeof raw !== 'string') return '';
    var url = raw.trim();
    if (!url) return '';
    if (!/^https?:\/\//i.test(url)) {
      // Tolerancia operativa: un enlace pegado sin esquema se normaliza a
      // https en vez de rechazarse, que es el error más común al copiar.
      if (/^[\w.-]+\.[a-z]{2,}\//i.test(url)) url = 'https://' + url;
      else return '';
    }
    return url;
  }

  function youtubeIdFrom(url) {
    var m = url.match(/(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|live\/|v\/))([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
  }

  function vimeoIdFrom(url) {
    var m = url.match(/vimeo\.com\/(?:video\/|channels\/[^\/?#]+\/|groups\/[^\/?#]+\/videos\/)?(\d+)/);
    return m ? m[1] : null;
  }

  function driveIdFrom(url) {
    var m = url.match(/(?:drive|docs)\.google\.com\/file\/d\/([A-Za-z0-9_-]{10,})/)
      || url.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
    return m ? m[1] : null;
  }

  // Monta la fuente ya clasificada. Todas las ramas terminan aquí para que el
  // destino de cada proveedor quede en un único sitio (y sea auditable: un
  // enlace de página nunca acaba siendo el src de un iframe).
  function buildSource(kind, id, original) {
    if (kind === 'youtube') {
      return { kind: 'youtube', src: 'https://www.youtube-nocookie.com/embed/' + id, original: original, label: SOURCE_LABELS.youtube };
    }
    if (kind === 'drive') {
      // /preview es la única forma de incrustar un archivo de Drive: /view y
      // /uc solo sirven para descargar o abrir la página de detalles.
      return { kind: 'drive', src: 'https://drive.google.com/file/d/' + id + '/preview', original: original, label: SOURCE_LABELS.drive };
    }
    if (kind === 'vimeo') {
      return { kind: 'vimeo', src: 'https://player.vimeo.com/video/' + id, original: original, label: SOURCE_LABELS.vimeo };
    }
    if (kind === 'directo') {
      return { kind: 'directo', src: id, original: original, label: SOURCE_LABELS.directo };
    }
    return { kind: 'externo', src: id, original: original, label: SOURCE_LABELS.externo };
  }

  // Identificador suelto, sin URL: solo tiene sentido con el tipo marcado a mano
  // (copiar el ID de YouTube/Vimeo/Drive de la barra del navegador es el error
  // más común). En 'auto' un ID suelto NO se adivina: sería indistinguible de
  // un texto cualquiera.
  function idSuelto(raw, tipo) {
    if (tipo === 'youtube') return /^[A-Za-z0-9_-]{11}$/.test(raw) ? raw : null;
    if (tipo === 'vimeo') return /^\d{4,}$/.test(raw) ? raw : null;
    if (tipo === 'drive') return /^[A-Za-z0-9_-]{10,}$/.test(raw) ? raw : null;
    return null;
  }

  /* Traduce la URL guardada por el superadmin a una fuente reproducible.
     `tipoForzado` permite saltarse la detección ('auto' por defecto) para
     enlaces que no se pueden clasificar solos. Devuelve null si la URL está
     vacía, no es válida o no encaja en el tipo elegido. */
  function resolveVideoSource(rawUrl, tipoForzado) {
    var tipo = (tipoForzado || 'auto').toLowerCase();
    var raw = typeof rawUrl === 'string' ? rawUrl.trim() : '';
    if (!raw) return null;

    // Identificador suelto: solo se acepta con tipo explícito. La URL de
    // apertura pasa a ser el propio embed, porque no hay página de origen.
    var suelto = idSuelto(raw, tipo);
    if (suelto) {
      var s = buildSource(tipo, suelto, raw);
      s.original = s.src;
      return s;
    }

    var url = cleanUrl(raw);
    if (!url) return null;

    // Tipo elegido a mano: se respeta y se exige que el enlace encaje. Si no,
    // se rechaza (null) en lugar de montar un reproductor que no va a
    // funcionar y dejar un recuadro negro en la portada.
    if (tipo === 'youtube') {
      var ytId = youtubeIdFrom(url);
      return ytId ? buildSource('youtube', ytId, url) : null;
    }
    if (tipo === 'vimeo') {
      var vimeoId = vimeoIdFrom(url);
      return vimeoId ? buildSource('vimeo', vimeoId, url) : null;
    }
    if (tipo === 'drive') {
      var driveId = driveIdFrom(url);
      return driveId ? buildSource('drive', driveId, url) : null;
    }
    if (tipo === 'directo') return buildSource('directo', url, url);
    if (tipo === 'externo') return buildSource('externo', url, url);

    // Detección automática: primero los proveedores que exigen reescribir la
    // URL a su forma de embed, después el archivo directo y, por último,
    // cualquier otra web como reproductor genérico.
    var a = youtubeIdFrom(url);
    if (a) return buildSource('youtube', a, url);
    var b = driveIdFrom(url);
    if (b) return buildSource('drive', b, url);
    var c = vimeoIdFrom(url);
    if (c) return buildSource('vimeo', c, url);
    if (VIDEO_EXT_RE.test(url)) return buildSource('directo', url, url);

    return buildSource('externo', url, url);
  }

  function buildVideoFrame(source, titulo) {
    var frame = el('div', 'portal-video-box');
    frame.appendChild(el('span', 'portal-video-badge', source.label));

    if (source.kind === 'directo') {
      var v = document.createElement('video');
      v.controls = true;
      v.controlsList = 'nodownload noremoteplayback';
      v.preload = 'metadata';
      v.playsInline = true;
      v.setAttribute('playsinline', '');
      v.setAttribute('disablePictureInPicture', '');
      v.title = titulo;
      // El error se avisa en la tarjeta, no solo en la consola: un .mkv o un
      // enlace caído se ven como un recuadro negro sin explicación.
      v.addEventListener('error', function () { showVideoError(true); });
      v.src = source.src;
      frame.appendChild(v);
      return frame;
    }

    var f = document.createElement('iframe');
    f.src = source.src;
    f.title = titulo;
    f.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen');
    f.setAttribute('allowfullscreen', '');
    f.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    f.setAttribute('loading', 'lazy');
    frame.appendChild(f);
    return frame;
  }

  function showVideoError(isError) {
    var box = $('portalVideoError');
    if (box) {
      box.style.display = isError ? '' : 'none';
      if (isError) {
        box.textContent = 'No se pudo reproducir el video en el navegador. Ábrelo en otra pestaña para verlo o descarga el archivo.';
      }
    }
    var open = $('portalVideoOpen');
    if (open && isError) open.style.display = '';
  }

  // Dibuja (o borra) la sección de la portada. Si no hay URL, está inactiva
  // o la URL no es válida, la sección se oculta entera: la portada nunca
  // muestra un recuadro vacío ni un error de reproducción.
  function renderVideoSection() {
    var section = $('portalVideo');
    var host = $('portalVideoFrame');
    if (!section || !host) return;

    var source = resolveVideoSource(videoCfg.videoUrl, videoCfg.videoTipo);
    if (!source || videoCfg.videoActivo === false) {
      section.style.display = 'none';
      host.innerHTML = '';
      showVideoError(false);
      var open0 = $('portalVideoOpen');
      if (open0) open0.style.display = 'none';
      return;
    }

    var titulo = videoCfg.videoTitulo || 'Video Corporativo · Vida en Convocación';
    host.innerHTML = '';
    host.appendChild(buildVideoFrame(source, titulo));
    showVideoError(false);

    var open = $('portalVideoOpen');
    if (open) {
      open.href = source.original;
      // El enlace de escape solo aporta algo cuando la reproducción incrustada
      // puede fallar (archivo directo o reproductor externo); YouTube, Drive y
      // Vimeo se ven bien embebidos.
      open.style.display = (source.kind === 'directo' || source.kind === 'externo') ? '' : 'none';
    }
    section.style.display = '';
  }

  function normalizeVideoConfig(raw) {
    raw = raw || {};
    return {
      videoUrl: typeof raw.videoUrl === 'string' ? raw.videoUrl.trim() : '',
      videoTitulo: typeof raw.videoTitulo === 'string' ? raw.videoTitulo.trim() : '',
      videoTipo: typeof raw.videoTipo === 'string' && raw.videoTipo ? raw.videoTipo : 'auto',
      // Activo por defecto: si el superadmin publica la URL, se muestra.
      videoActivo: raw.videoActivo === false ? false : true
    };
  }

  /* Suscripción viva a config/portal. onSnapshot (y no get) porque la portada
     es pública: los visitantes sin sesión también pueden leer este documento
     (regla esPublico() en firestore.rules) y así el video cambia en la
     pantalla abierta en cuanto el superadmin lo publica, sin recargar. */
  function subscribeVideoConfig() {
    if (!V.db || videoUnsub) return;
    try {
      videoUnsub = V.db.collection(CONFIG_COLLECTION).doc(PORTAL_DOC).onSnapshot(function (doc) {
        videoCfg = normalizeVideoConfig(doc && doc.exists ? doc.data() : {});
        renderVideoSection();
        // Solo si el panel existe y hay quien lo pueda ver: los dos renders
        // son internal no-ops cuando el superadmin no está dentro.
        renderAdminPortalConfig();
        renderAdminVideoPreview();
      }, function (err) {
        // Sin permisos (reglas sin desplegar) o sin red: la portada sigue
        // funcionando, solo sin video. No se rompe la landing por ello.
        console.warn('[portal] no se pudo leer config/portal:', err && err.message);
        // Se libera el hueco. onSnapshot devuelve la función de baja incluso
        // cuando la escucha falla por permisos, así que videoUnsub quedaba
        // ocupado para siempre: con el hueco ocupado, subscribeVideoConfig()
        // ya no volaba nunca más y el formulario del superadmin se quedaba
        // vacío de por vida, aunque las reglas se desplegaran después o el
        // usuario entrara más tarde con su cuenta. onModeChange llama a esta
        // función en cada cambio de identidad, y ahí es donde se reintenta.
        try { if (videoUnsub) videoUnsub(); } catch (e) { /* ya dado de baja */ }
        videoUnsub = null;
      });
    } catch (e) {
      videoUnsub = null;
      console.warn('[portal] no se pudo suscribir a config/portal:', e && e.message);
    }
  }

  /* ════════════════════════════════════════════════════════════
     PANEL DEL SUPER ADMIN · VIDEO CORPORATIVO
     ════════════════════════════════════════════════════════════ */

  var VIDEO_TIPOS = [
    ['auto', 'Detectar automáticamente'],
    ['youtube', 'YouTube'],
    ['drive', 'Google Drive'],
    ['vimeo', 'Vimeo'],
    ['directo', 'Archivo de video directo (.mp4, .webm…)'],
    ['externo', 'Otra web (reproductor incrustado)']
  ];

  // El formulario vive en el Panel del Super Admin (#saVideoForm), no en la
  // vista de gestión de usuarios. Se dibuja solo con V.esAdmin() y el propio
  // guardado vuelve a comprobar el rol; la frontera que de verdad importa es
  // firestore.rules, donde config/portal solo acepta escritura de isAdmin().
  function renderAdminPortalConfig() {
    var body = $('saVideoForm');
    if (!body) return;
    if (!V.esAdmin()) { body.innerHTML = ''; return; }

    // No se redibuja si el superadmin está escribiendo en el formulario: se
    // perdería lo tecleado con cada instantánea de config/portal.
    if (document.activeElement && body.contains(document.activeElement)) return;
    body.innerHTML = '';

    var form = el('div', 'sa-form');

    var rowUrl = el('div', 'form-row');
    var fUrl = el('div', 'field field-full');
    fUrl.appendChild(el('label', '', 'URL del video corporativo'));
    var inUrl = document.createElement('input');
    inUrl.type = 'url';
    inUrl.id = 'pvcUrl';
    inUrl.className = 'input';
    inUrl.placeholder = 'https://www.youtube.com/watch?v=… · https://drive.google.com/file/d/… · https://…/video.mp4';
    inUrl.value = videoCfg.videoUrl;
    inUrl.autocomplete = 'off';
    fUrl.appendChild(inUrl);
    var detect = el('p', 'field-hint', '');
    detect.id = 'pvcDetect';
    fUrl.appendChild(detect);
    rowUrl.appendChild(fUrl);
    form.appendChild(rowUrl);

    var row2 = el('div', 'form-row');
    var fTit = el('div', 'field');
    fTit.appendChild(el('label', '', 'Título (opcional)'));
    var inTit = document.createElement('input');
    inTit.type = 'text';
    inTit.id = 'pvcTitulo';
    inTit.className = 'input';
    inTit.placeholder = 'Video Corporativo';
    inTit.value = videoCfg.videoTitulo;
    fTit.appendChild(inTit);
    row2.appendChild(fTit);

    var fTipo = el('div', 'field');
    fTipo.appendChild(el('label', '', 'Tipo de fuente'));
    var selTipo = document.createElement('select');
    selTipo.id = 'pvcTipo';
    selTipo.className = 'select';
    VIDEO_TIPOS.forEach(function (t) {
      var o = document.createElement('option');
      o.value = t[0];
      o.textContent = t[1];
      o.selected = videoCfg.videoTipo === t[0];
      selTipo.appendChild(o);
    });
    fTipo.appendChild(selTipo);
    row2.appendChild(fTipo);
    form.appendChild(row2);

    var fAct = el('div', 'field field-full');
    var lblAct = el('label', 'cms-check-label');
    var chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.id = 'pvcActivo';
    chk.checked = videoCfg.videoActivo;
    lblAct.appendChild(chk);
    lblAct.appendChild(el('span', '', 'Mostrar el video en la portada pública'));
    fAct.appendChild(lblAct);
    form.appendChild(fAct);

    var btn = el('button', 'btn btn-primary btn-sm', '💾 Guardar video corporativo');
    btn.type = 'button';
    btn.id = 'pvcSave';
    var clear = el('button', 'btn btn-outline btn-sm', '🗑 Quitar el video');
    clear.type = 'button';
    clear.id = 'pvcClear';
    var actions = el('div', 'form-actions');
    actions.appendChild(btn);
    actions.appendChild(clear);
    form.appendChild(actions);

    body.appendChild(form);

    function refrescarDeteccion() {
      var url = inUrl.value;
      var sel = selTipo.value;
      var src = resolveVideoSource(url, sel);
      if (!url.trim()) {
        detect.textContent = 'Sin URL, la sección no se publica en la portada.';
        detect.className = 'field-hint';
      } else if (!src) {
        detect.textContent = '⚠ Esa URL no encaja con el tipo elegido. Debe empezar por https://';
        detect.className = 'field-hint is-warn';
      } else {
        detect.textContent = 'Fuente detectada: ' + src.label;
        detect.className = 'field-hint is-ok';
      }
      // La vista previa se refresca con lo que hay en el formulario, no con
      // lo guardado: así se juzga el cambio antes de confirmarlo.
      renderAdminVideoPreview();
    }
    inUrl.addEventListener('input', refrescarDeteccion);
    selTipo.addEventListener('change', refrescarDeteccion);
    inTit.addEventListener('input', renderAdminVideoPreview);
    refrescarDeteccion();

    btn.addEventListener('click', function () { saveVideoConfig(btn); });
    // "Quitar" no borra nada del servidor todavía: vacía los campos y deja el
    // guardado al botón de arriba, que es quien escribe. Un botón destructivo
    // que publica en el instante es la clase de control que nadie quiere
    // pulsar creyendo que va a otra cosa.
    clear.addEventListener('click', function () {
      inUrl.value = '';
      inTit.value = '';
      selTipo.value = 'auto';
      chk.checked = false;
      refrescarDeteccion();
      inUrl.focus();
    });
  }

  /* Vista previa del panel. Comparte buildVideoFrame() con la portada, así
     que lo que se ve aquí es literalmente el mismo reproductor que verá un
     visitante, no una aproximación. El aviso distingue los tres estados
     posibles (sin URL, con URL inválida, con video publicado) porque los dos
     últimos se ven igual de vacíos si no se dice nada. */
  function renderAdminVideoPreview(cfg) {
    var host = $('saVideoPreview');
    var note = $('saVideoPreviewNote');
    if (!host) return;

    // Sin argumento (llamada desde onSnapshot) se previsualiza lo GUARDADO.
    // Con argumento se previsualiza el formulario.
    var fuente = cfg || {
      videoUrl: videoCfg.videoUrl,
      videoTitulo: videoCfg.videoTitulo,
      videoTipo: videoCfg.videoTipo,
      videoActivo: videoCfg.videoActivo
    };

    var url = fuente.videoUrl || '';
    var source = resolveVideoSource(url, fuente.videoTipo);
    host.innerHTML = '';

    if (!url) {
      if (note) {
        note.textContent = 'Todavía no hay ningún video configurado. La sección queda oculta en la portada.';
        note.className = 'sa-preview-note';
      }
      return;
    }
    if (!source) {
      if (note) {
        note.textContent = '⚠ La URL guardada no se puede reproducir. Revisa el enlace o el tipo de fuente.';
        note.className = 'sa-preview-note is-warn';
      }
      return;
    }

    var titulo = fuente.videoTitulo || 'Video Corporativo · Vida en Convocación';
    host.appendChild(buildVideoFrame(source, titulo));
    if (note) {
      if (fuente.videoActivo === false) {
        note.textContent = 'Reconocido como ' + source.label + ', pero la publicación está desactivada: no se verá en la portada.';
        note.className = 'sa-preview-note is-warn';
      } else {
        note.textContent = 'Publicado en la portada como ' + source.label + '.';
        note.className = 'sa-preview-note is-ok';
      }
    }
  }

  function saveVideoConfig(btn) {
    // Frontera real: firestore.rules solo permite escribir config/portal al
    // superadmin. Esta comprobación evita siquiera el intento y explica por qué.
    if (!V.esAdmin()) {
      V.toast('Solo el superadmin puede modificar el video corporativo.', true);
      return;
    }
    if (!V.db) { V.toast('Firestore no disponible.', true); return; }

    var inUrl = $('pvcUrl');
    var inTit = $('pvcTitulo');
    var selTipo = $('pvcTipo');
    var chk = $('pvcActivo');
    var url = inUrl ? String(inUrl.value || '').trim() : '';
    var tipo = selTipo ? selTipo.value : 'auto';
    var titulo = inTit ? String(inTit.value || '').trim() : '';
    var activo = !!(chk && chk.checked);

    // Una URL vacía es válida: es la forma de despublicar el video. Lo que no
    // se admite es una URL no vacía que no se pueda reproducir.
    if (url && !resolveVideoSource(url, tipo)) {
      V.toast('La URL del video no es válida. Debe ser https:// de YouTube, Google Drive, Vimeo, un archivo de video o una web con reproductor.', true);
      return;
    }

    // config/portal es PÚBLICO (lo lee esPublico() en firestore.rules), así que
    // solo guarda lo que un visitante ya ve en pantalla. El UID de quien
    // edita NO va aquí: se escribiría en un documento que cualquiera puede
    // leer. Va a la bitácora, que es de solo super admin.
    var data = {
      videoUrl: url,
      videoTitulo: titulo,
      videoTipo: tipo,
      videoActivo: activo,
      videoActualizado: new Date().toISOString()
    };

    // Lo anterior, para poder registrar en la bitácora qué cambió y no solo
    // que alguien guardó. Se lee del estado vivo, no del documento: el
    // formulario puede traer valores a medio escribir y la bitácora debe
    // reflejar lo que había PUBLICADO, no lo que había en el formulario.
    var antes = {
      url: videoCfg.videoUrl,
      titulo: videoCfg.videoTitulo,
      tipo: videoCfg.videoTipo,
      activo: videoCfg.videoActivo
    };

    btn.disabled = true;
    var original = btn.textContent;
    btn.textContent = '⏳ Guardando…';

    return V.db.collection(CONFIG_COLLECTION).doc(PORTAL_DOC).set(data, { merge: true })
      .then(function () {
        // El onSnapshot de esta misma página repinta la portada; aquí solo se
        // confirma y se evita depender de esa llegada.
        videoCfg = normalizeVideoConfig(data);
        renderVideoSection();
        renderAdminVideoPreview();
        return registrarAuditoria(antes, data);
      })
      .then(function () {
        V.toast('Video corporativo actualizado ✓');
      })
      .catch(function (e) {
        // El cambio ya está hecho aunque la bitácora falle (son dos
        // escrituras independientes): se avisa del fallo sin dar el guardado
        // por perdido, que sería mentira.
        V.toast('Video guardado, pero la bitácora no se pudo registrar: ' + (e && e.message ? e.message : e), true);
      })
      .then(function () {
        if (!document.body.contains(btn)) return;
        btn.disabled = false;
        btn.textContent = original;
      });
  }

  /* Escribe una entrada en la bitácora. Se descarta en silencio si la regla
     aún no está desplegada (el guardado del video ya está hecho y no debe
     darse por fallido por un documento de auditoría): el panel sigue siendo
     utilizable y el superadmin ve que la bitácora está vacía. */
  function registrarAuditoria(antes, despues) {
    if (!V.db || !V.esAdmin()) return Promise.resolve();
    var cambios = [];
    if (antes.url !== despues.videoUrl) {
      cambios.push(antes.url ? 'Cambió la URL del video' : 'Se publicó un video por primera vez');
    }
    if (antes.titulo !== despues.videoTitulo) cambios.push('Cambió el título');
    if (antes.tipo !== despues.videoTipo) cambios.push('Cambió el tipo de fuente');
    if (antes.activo !== despues.videoActivo) {
      cambios.push(despues.videoActivo ? 'Se activó la publicación' : 'Se desactivó la publicación');
    }
    if (!cambios.length) cambios.push('Se guardaron los ajustes sin cambios');

    var user = V.currentUser;
    return V.db.collection(AUDIT_COLLECTION).add({
      accion: 'video corporativo',
      resumen: cambios.join(' · '),
      url: despues.videoUrl || '',
      titulo: despues.videoTitulo || '',
      activo: !!despues.videoActivo,
      // Esto sí lleva identidad, y es justamente lo que hace segura la
      // separación: aquí el documento no lo lee nadie que no sea superadmin.
      autorUid: V.uidSesion(),
      autorEmail: (user && user.email) || 'desconocido',
      fecha: new Date().toISOString()
    }).then(function () { /* escrito */ }).catch(function () { /* sin bitácora */ });
  }

  function init() {
    setThemeButton(currentIsDark());
    bindPortalEvents();
    loadContent().then(function (data) {
      renderContent(data);
    });
  }

  /* ════════════════════════════════════════════════════════════
     ARRANQUE
     ════════════════════════════════════════════════════════════ */

  // onReady corre dentro de startApp(), que es el primer momento en que
  // V.db/V.userRole ya valen: antes, la portada arranca antes de que Firebase
  // resuelva la sesión y la lectura del documento fallaría por DB nula.
  var PortalModule = {
    onReady: function () {
      subscribeVideoConfig();
      renderAdminPortalConfig();
      renderAdminVideoPreview();
    }
  };
  V.registerModule(PortalModule);

  // setMode() se dispara al cambiar de modo y también tras un login o un
  // registro (refreshAuthUi), así que es el punto fiable para repintar el
  // panel de administración cuando la identidad cambia de visitante a
  // superadmin sin recargar la página. Se encadena con el de cursos.js en
  // lugar de sustituirlo.
  var _onModeChangePrev = V.onModeChange;
  V.onModeChange = function (m) {
    if (typeof _onModeChangePrev === 'function') {
      try { _onModeChangePrev(m); } catch (e) { /* noop */ }
    }
    subscribeVideoConfig();
    renderAdminPortalConfig();
    renderAdminVideoPreview();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* ════════════════════════════════════════════════════════════
     API PÚBLICA
     ════════════════════════════════════════════════════════════ */
  V.portal = {
    CONFIG_COLLECTION: CONFIG_COLLECTION,
    PORTAL_DOC: PORTAL_DOC,
    AUDIT_COLLECTION: AUDIT_COLLECTION,
    getVideoConfig: function () { return videoCfg; },
    resolveVideoSource: resolveVideoSource,
    subscribeVideoConfig: subscribeVideoConfig,
    renderVideoSection: renderVideoSection,
    renderAdminPortalConfig: renderAdminPortalConfig,
    renderAdminVideoPreview: renderAdminVideoPreview
  };
})();