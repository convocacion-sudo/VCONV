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

  /* ─── CONFIGURACIÓN DE LA PORTADA ────────────────────────────
     El copy de la portada vive en el documento config/portal de
     Firestore (colección `config`), NO en content.json: así el
     superadmin lo cambia desde el panel sin desplegar nada y la portada
     lo toma siempre fresco por onSnapshot. Coincide con el resto de
     ajustes de la app (config/mlm, config/finanzas, config/perfiles…),
     que usan la misma colección. */
  var CONFIG_COLLECTION = 'config';
  var PORTAL_DOC = 'portal';

  // Suscripción viva a config/portal (solo copy de la portada).
  var portalUnsub = null;

  /* COPY DE LA PORTADA (config/portal.copy).
     El archivo public/data/content.json sigue siendo la BASE; lo que el
     superadmin guarda en config/portal.copy se fusiona ENCIMA con
     V.mergeProfundo (mismas reglas que el módulo de Configuración usa
     para componer lo guardado). Así:
       · el contenido se edita sin desplegar nada;
       · si el documento no existe o se borra, la portada vuelve al
         contenido local sin romperse;
       · un texto vacío en el copy NO borra el texto de base (vacío
         significa "usa el valor por defecto").
     La forma del copy es la MISMA que la de content.json, para que la
     fusión sea un 'merge' y no una traducción de claves. */
  var copyCfg = null;
  // Contenido local (public/data/content.json): la BASE. El copy de
  // Firestore se fusiona encima en cada repintado.
  var baseContent = null;

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

  /* Aplica el copy guardado sobre el contenido local. Se hace aquí, en un
     solo punto, para que ninguna otra parte de la portada tenga que
     combinar las dos fuentes por su cuenta (y para que la vista previa
     del panel y la portadaSeen miren exactamente lo mismo). */
  function aplicarCopy(data) {
    if (!copyCfg) return data;
    if (typeof V.mergeProfundo === 'function') return V.mergeProfundo(data || {}, copyCfg);
    return data;
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

  /* ════════════════════════════════════════════════════════════
     FICHAS DEL HOME
     ════════════════════════════════════════════════════════════
     Las fichas las crea el superadmin en el panel de configuraciones
     (pestaña «Fichas del Home») y viven en la colección `fichas`. La
     lectura es pública, así que el visitante las ve sin iniciar sesión.

     Solo se pintan las que están publicadas, ordenadas por el campo
     `orden` (y a igual orden, por título, para que el orden sea
     estable entre recargas). */
  var FICHAS_COLLECTION = 'fichas';
  var fichasUnsub = null;

  function renderFichasGrid(fichas) {
    var grid = $('portalFichasGrid');
    var section = $('portalFichas');
    if (!grid) return;

    grid.innerHTML = '';
    if (!fichas.length) {
      // Sin fichas publicadas la sección no se muestra: es preferible un
      // hueco limpio que un bloque de texto vacío en mitad de la portada.
      if (section) section.style.display = 'none';
      return;
    }
    if (section) section.style.display = '';

    // Ordenamiento con prioridad: si alguna ficha tiene prioridadEncima/prioridad
    // se considera "por encima de la primera ficha estática" - forzamos su posición
    var fichasOrdenadas = fichas.slice();
    fichasOrdenadas.sort(function (a, b) {
      var pa = (a.prioridadEncima === true || a.encimaEstaticas === true || a.prioridad === true) ? 1 : 0;
      var pb = (b.prioridadEncima === true || b.encimaEstaticas === true || b.prioridad === true) ? 1 : 0;
      if (pa !== pb) return pb - pa; // priority first
      var oa = typeof a.orden === 'number' ? a.orden : 9999;
      var ob = typeof b.orden === 'number' ? b.orden : 9999;
      if (oa !== ob) return oa - ob;
      return String(a.titulo || '').localeCompare(String(b.titulo || ''));
    });

    fichasOrdenadas.forEach(function (f) {
      var card = el('article', 'portal-ficha');
      var tam = f.tamano || f.tamanio || '';
      if (tam) card.classList.add('portal-ficha-' + tam);

      var imagen = (V.imagenes && typeof V.imagenes.urlSegura === 'function')
        ? V.imagenes.urlSegura(f.imagen)
        : '';
      if (imagen) {
        var media = el('div', 'portal-ficha-media');
        if (V.imagenes && typeof V.imagenes.montar === 'function') {
          V.imagenes.montar(media, imagen, {
            alt: f.titulo || 'Imagen de la ficha',
            clase: 'portal-ficha-media-el'
          });
        }
        card.appendChild(media);
      }

      // Vídeo independiente de la imagen: la plataforma se guarda de forma
      // explícita, así que no se adivina nada a partir de la URL.
      var plataformaVideo = (V.video && typeof V.video.normalizarPlataforma === 'function')
        ? V.video.normalizarPlataforma(f.videoPlataforma)
        : '';
      var video = (plataformaVideo && V.video && typeof V.video.normalizar === 'function')
        ? V.video.normalizar(plataformaVideo, f.video)
        : '';
      if (video) {
        var videoBox = el('div', 'portal-ficha-video');
        if (V.video && typeof V.video.montar === 'function') {
          V.video.montar(videoBox, plataformaVideo, video, {
            alt: f.titulo || 'Vídeo de la ficha',
            clase: 'portal-ficha-video-el'
          });
        }
        card.appendChild(videoBox);
      }

      var body = el('div', 'portal-ficha-body');
      if (f.icono) body.appendChild(el('span', 'portal-ficha-tag', f.icono));
      if (f.titulo) body.appendChild(el('h3', 'portal-ficha-title', f.titulo));
      if (f.subtitulo) body.appendChild(el('p', 'portal-ficha-sub', f.subtitulo));

      // El texto viene enriquecido desde el panel y se guarda como HTML en
      // Firestore: se sanea con la lista blanca antes de pintarlo.
      if (f.texto) {
        var txt = el('div', 'portal-ficha-text');
        if (V.richtext && typeof V.richtext.sanitize === 'function') {
          txt.innerHTML = V.richtext.sanitize(f.texto);
        } else {
          txt.textContent = String(f.texto).replace(/<[^>]*>/g, '');
        }
        body.appendChild(txt);
      }

      card.appendChild(body);
      grid.appendChild(card);
    });
  }

  function subscribeFichas() {
    if (fichasUnsub || !V.db) return;
    try {
      // Se consulta SOLO lo publicado: la regla de Firestore apoya la
      // lectura de `fichas` en el campo `publicado`, así que el motor puede
      // probar la regla para la consulta (y un borrador nunca sale).
      fichasUnsub = V.db.collection(FICHAS_COLLECTION).where('publicado', '==', true).onSnapshot(function (snap) {
        var fichas = [];
        snap.forEach(function (d) {
          var f = d.data() || {};
          f.id = d.id;
          if (f.publicado !== true) return;
          fichas.push(f);
        });
        fichas.sort(function (a, b) {
          var oa = typeof a.orden === 'number' ? a.orden : 9999;
          var ob = typeof b.orden === 'number' ? b.orden : 9999;
          if (oa !== ob) return oa - ob;
          return String(a.titulo || '').localeCompare(String(b.titulo || ''));
        });
        renderFichasGrid(fichas);
      }, function (err) {
        console.warn('No se pudieron leer las fichas:', err);
      });
    } catch (e) {
      console.warn('No se pudieron leer las fichas:', e);
    }
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

  function renderContent() {
    // El contenido local se guarda aparte (baseContent): es la BASE sobre
    // la que se aplica el copy guardado en Firestore. A partir de aquí,
    // contentData es el contenido EFECTIVO (lo que ve el visitante). Si
    // el copy se borra de Firestore, la portada vuelve al contenido
    // local en vez de quedarse con el copy viejo congelado.
    var data = aplicarCopy(baseContent || {});
    contentData = data;
    var p = data.portal || {};
    var hero = p.hero || {};
    var sections = p.sections || {};
    var coursesSec = sections.courses || {};
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

    var podcastsSec = sections.podcasts || {};
    setText('podcastsEyebrow', podcastsSec.eyebrow);
    setText('podcastsTitle', podcastsSec.title);
    setText('podcastsSubtitle', podcastsSec.subtitle);
    setText('portalCtaPodcasts', podcastsSec.cta);

    var tiendaSec = sections.tienda || {};
    setText('tiendaPortalEyebrow', tiendaSec.eyebrow);
    setText('tiendaPortalTitle', tiendaSec.title);
    setText('tiendaPortalSubtitle', tiendaSec.subtitle);
    setText('portalCtaTienda', tiendaSec.cta);

    setText('blocksEyebrow', blocksSec.eyebrow);
    setText('blocksTitle', blocksSec.title);
    setText('blocksSubtitle', blocksSec.subtitle);

    var fichasSec = sections.fichas || {};
    setText('fichasEyebrow', fichasSec.eyebrow || 'Fichas');
    setText('fichasTitle', fichasSec.title || '');
    setText('fichasSubtitle', fichasSec.subtitle || '');

    setText('contactEyebrow', contactSec.eyebrow);
    setText('contactTitle', contact.title || contactSec.title);
    setText('contactSubtitle', contact.subtitle || contactSec.subtitle);

    setText('portalFooterText', footer.text);
    setText('portalCopyright', footer.copyright);

    fillContactSelects(data);
    renderBlocks(data);
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

  // Ficha de acceso a Podcasts: el catálogo es de lectura abierta, así que el
  // atajo sirve igual para el visitante que para la cuenta registrada y no hace
  // falta pasar por el Escritorio ni por el formulario de acceso.
  function goPodcasts() {
    closeSidebar();
    if (typeof V.showGuestPodcasts === 'function') { V.showGuestPodcasts(); return; }
    if (hasRealSession()) { V.showApp(); return; }
    V.openAuth('login');
  }

  // Ficha de acceso a la Tienda Consolidada: la vitrina de tiendas externas es
  // de lectura abierta (reglas esPublico()), así que el atajo sirve igual para
  // el visitante que para la cuenta registrada, sin pasar por el formulario.
  function goTienda() {
    closeSidebar();
    if (typeof V.showGuestTienda === 'function') { V.showGuestTienda(); return; }
    if (hasRealSession()) { V.showApp(); return; }
    V.openAuth('login');
  }

  // Resumen real de la ficha: cuántos conjuntos de audio hay publicados ahora.
  // Usa resumenPublico() del módulo de podcasts —un get suelto, sin suscripción
  // abierta— para que la portada no deje un oyente vivo por una cifra decorativa.
  // Si todavía no hay colecciones se conserva el texto de content.json: la
  // sección no se oculta, porque el módulo existe aunque se publique después.
  function renderPodcastsResumen() {
    var sub = $('podcastsSubtitle');
    if (!sub) return;
    if (!V.podcasts || typeof V.podcasts.resumenPublico !== 'function') return;
    var base = sub.textContent;
    V.podcasts.resumenPublico(function (lista) {
      if (!sub || !lista || !lista.length) return;
      var n = lista.length;
      var extra = n + (n === 1 ? ' colección de audio' : ' colecciones de audio') + ' para escuchar';
      var titulo = lista[0] && typeof lista[0].titulo === 'string' ? lista[0].titulo.trim() : '';
      sub.textContent = extra + (titulo ? '. La más reciente: ' + titulo : '.');
    });
  }

  // Resumen real de la ficha de la tienda: cuántas tiendas externas hay
  // publicadas ahora. Usa resumenPublico() del módulo de tienda —un get
  // suelto, sin suscripción abierta— para no dejar una escucha viva por una
  // cifra decorativa. Si todavía no hay tiendas se conserva el texto de
  // content.json.
  function renderTiendaResumen() {
    var sub = $('tiendaPortalSubtitle');
    if (!sub) return;
    if (!V.tienda || typeof V.tienda.resumenPublico !== 'function') return;
    V.tienda.resumenPublico(function (lista) {
      if (!sub || !lista || !lista.length) return;
      var n = lista.length;
      sub.textContent = n + (n === 1 ? ' tienda vinculada' : ' tiendas vinculadas') +
        ' por vendedores de la comunidad. Explora cada negocio y visita su tienda desde VCONV.';
    });
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

    // Ficha de podcasts: botón de la tarjeta hacia la sección de audio.
    var podcastsCta = $('portalCtaPodcasts');
    if (podcastsCta) podcastsCta.addEventListener('click', goPodcasts);

    // Ficha de la tienda: botón de la tarjeta hacia el catálogo de productos.
    var tiendaCta = $('portalCtaTienda');
    if (tiendaCta) tiendaCta.addEventListener('click', goTienda);

    // "Chat en Vivo / Soporte" (nav superior y menú lateral): abre la MISMA
    // ventana flotante que el botón verde de la esquina. preventDefault
    // porque el href es "#" y saltaría al principio de la página; el menú
    // lateral se cierra antes, para que no quede tapando el panel.
    [$('portalChatBtn'), $('portalSidebarChatBtn')].forEach(function (link) {
      if (!link) return;
      link.addEventListener('click', function (e) {
        e.preventDefault();
        closeSidebar();
        if (V.chat && typeof V.chat.open === 'function') V.chat.open();
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

  /* Suscripción viva a config/portal. onSnapshot (y no get) porque la
     portada es pública: los visitantes sin sesión también pueden leer este
     documento (regla esPublico() en firestore.rules) y así el copy cambia
     en la pantalla abierta en cuanto el superadmin lo publica, sin recargar. */
  function subscribePortalConfig() {
    if (!V.db || portalUnsub) return;
    try {
      portalUnsub = V.db.collection(CONFIG_COLLECTION).doc(PORTAL_DOC).onSnapshot(function (doc) {
        var raw = doc && doc.exists ? (doc.data() || {}) : {};
        // El copy de la portada viaja en el mismo documento (campo `copy`).
        copyCfg = (raw.copy && typeof raw.copy === 'object' && !Array.isArray(raw.copy)) ? raw.copy : null;
        // Si el contenido local ya llegó, se repinta con el copy aplicado;
        // si no, llega después y se aplicará allí (renderContent llama a
        // aplicarCopy). Así ninguna de las dos fuentes gana por llegar antes.
        if (contentData) renderContent();
      }, function (err) {
        // Sin permisos (reglas sin desplegar) o sin red: la portada sigue
        // funcionando, solo sin el copy de Firestore.
        console.warn('[portal] no se pudo leer config/portal:', err && err.message);
        // Se libera el hueco para poder reintentar en el próximo cambio de
        // identidad (onModeChange llama a esta función).
        try { if (portalUnsub) portalUnsub(); } catch (e) { /* ya dada de baja */ }
        portalUnsub = null;
      });
    } catch (e) {
      portalUnsub = null;
      console.warn('[portal] no se pudo suscribir a config/portal:', e && e.message);
    }
  }

  function init() {
    setThemeButton(currentIsDark());
    bindPortalEvents();
    loadContent().then(function (data) {
      baseContent = data;
      renderContent();
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
      subscribePortalConfig();
      subscribeFichas();
      // El recuento de la ficha necesita V.db, que solo vale dentro de
      // startApp(); por eso se pide aquí y no en init().
      renderPodcastsResumen();
      renderTiendaResumen();
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
    subscribePortalConfig();
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
    subscribePortalConfig: subscribePortalConfig
  };
})();