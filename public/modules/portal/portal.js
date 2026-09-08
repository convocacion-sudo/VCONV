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
  var CONTACT_FIELDS = ['ctNombre', 'ctEmail', 'ctMensaje'];
  var contentData = null;

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
    if (mensaje.length < 10) { markInvalid('ctMensaje', true); V.toast('Escribe un mensaje de al menos 10 caracteres.', true); return; }

    var btn = $('ctSubmit');
    var original = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳ Enviando…';

    window.setTimeout(function () {
      btn.disabled = false;
      btn.textContent = original;
      $('contactForm').reset();
      V.toast((contentData.contact && contentData.contact.successMessage) || '¡Mensaje enviado!');
    }, 900);
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

  function bindPortalEvents() {
    var themeBtn = $('portalThemeToggle');
    if (themeBtn) themeBtn.addEventListener('click', togglePortalTheme);
    var sidebarThemeBtn = $('portalSidebarThemeToggle');
    if (sidebarThemeBtn) sidebarThemeBtn.addEventListener('click', togglePortalTheme);
    var loginBtn = $('portalLoginBtn');
    if (loginBtn) loginBtn.addEventListener('click', function () { V.openAuth('login'); });
    var regBtn = $('portalRegisterBtn');
    if (regBtn) regBtn.addEventListener('click', function () { V.openAuth('register'); });
    var sidebarLoginBtn = $('portalSidebarLoginBtn');
    if (sidebarLoginBtn) sidebarLoginBtn.addEventListener('click', function () { closeSidebar(); V.openAuth('login'); });
    var sidebarRegBtn = $('portalSidebarRegisterBtn');
    if (sidebarRegBtn) sidebarRegBtn.addEventListener('click', function () { closeSidebar(); V.openAuth('register'); });

    var cta = $('portalCtaPrimary');
    if (cta) {
      cta.addEventListener('click', function () {
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

  function init() {
    // Si ya hay sesión activa, el router (core/app.js -> showPortal)
    // redirige al escritorio; no inicializamos la landing anónima.
    if (V.auth && V.auth.currentUser) return;
    setThemeButton(currentIsDark());
    bindPortalEvents();
    loadContent().then(function (data) {
      renderContent(data);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();