/* ════════════════════════════════════════════════════════════════
   VCONV · Core — Autenticación, Sesión, Enrutamiento, Tema
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ─── CONFIG ──────────────────────────────────────────────── */
  var FIREBASE_CONFIG = {
    apiKey: "AIzaSyAYvbdS05f73i8h5yTbYhI1YnzP8gtUJOg",
    authDomain: "vconvocacion.firebaseapp.com",
    projectId: "vconvocacion",
    storageBucket: "vconvocacion.firebasestorage.app",
    messagingSenderId: "705488212528",
    appId: "1:705488212528:web:fda5f7affb6678741bd3f5"
  };

  var COL_USUARIOS = 'usuarios';
  var COL_CURSOS   = 'cursos';
  var COL_PROGRESO = 'progreso';
  var COL_COMUNIDADES = 'comunidades';
  var COL_COMUNIDAD_MIEMBROS = 'comunidad_miembros';
  var COL_REUNIONES = 'reuniones';

  /* ─── GLOBAL NAMESPACE ────────────────────────────────────── */
  var V = window.VCONV = window.VCONV || {};
  V.COL_USUARIOS = COL_USUARIOS;
  V.COL_CURSOS   = COL_CURSOS;
  V.COL_PROGRESO = COL_PROGRESO;
  V.COL_COMUNIDADES = COL_COMUNIDADES;
  V.COL_COMUNIDAD_MIEMBROS = COL_COMUNIDAD_MIEMBROS;
  V.COL_REUNIONES = COL_REUNIONES;

  /* ─── STATE ───────────────────────────────────────────────── */
  var db = null;
  var auth = null;
  var userId = localStorage.getItem('vconv_user_id') || '';
  var currentUser = null;
  var userRole = 'estudiante';
  var mode = localStorage.getItem('vconv_mode') || 'gestor';
  var theme = localStorage.getItem('vconv_theme') || 'dark';
  var fontScale = parseFloat(localStorage.getItem('vconv_font') || '1');
  var authInitFailure = null;

  /* ─── DOM HELPERS ─────────────────────────────────────────── */
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function fmtDate(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' }); }
    catch (e) { return ''; }
  }
  function emptyState(icon, title, text) {
    var es = el('div', 'empty-state');
    es.appendChild(el('span', 'es-icon', icon));
    es.appendChild(el('h3', '', title));
    es.appendChild(el('p', '', text));
    return es;
  }

  /* ─── TOAST ───────────────────────────────────────────────── */
  function toast(msg, isError) {
    var t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'toast' + (isError ? ' error' : '') + ' show';
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.className = 'toast' + (isError ? ' error' : ''); }, 2600);
  }

  /* ─── FIREBASE INIT ───────────────────────────────────────── */
  function initFirebase() {
    try {
      firebase.initializeApp(FIREBASE_CONFIG);
      db = firebase.firestore();
      db.settings({ ignoreUndefinedProperties: true });
      auth = firebase.auth();
    } catch (e) {
      showFbError('Error al inicializar Firebase: ' + e.message);
    }
  }

  function showFbError(msg) { var b = $('fbBanner'); if (b) { b.textContent = msg; b.classList.add('show'); } }
  function clearFbError() { var b = $('fbBanner'); if (b) b.classList.remove('show'); }

  /* ─── AUTH UI ─────────────────────────────────────────────── */
  function showApp() {
    var portal = $('portalScreen');
    if (portal) portal.style.display = 'none';
    $('authScreen').classList.remove('show');
    $('appRoot').style.display = '';
  }
  function showPortal() {
    // Si ya hay una sesión activa, redirigir al escritorio en lugar de
    // mostrar la landing anónima. La sesión (documento de usuario y
    // módulos) ya fue inicializada por onAuthStateChanged / startApp.
    if (auth && auth.currentUser) {
      if (currentUser) {
        showApp();
        goDashboard();
        return;
      }
      // Sesión activa pero aún sin inicializar: dejar que onAuthStateChanged
      // termine de montar la aplicación.
      return;
    }
    $('appRoot').style.display = 'none';
    $('authScreen').classList.remove('show');
    var portal = $('portalScreen');
    if (portal) portal.style.display = '';
  }
  function openAuth(tab) {
    if (tab) setAuthTab(tab);
    if (authInitFailure) showAuthError(authInitFailure);
    $('authScreen').classList.add('show');
  }
  function closeAuth() { $('authScreen').classList.remove('show'); }
  function showAuthError(msg) { var e = $('authError'); e.textContent = msg; e.classList.add('show'); }
  function clearAuthError() { $('authError').classList.remove('show'); }

  function authErrorMessage(err) {
    var code = err && err.code ? err.code : '';
    var map = {
      'auth/invalid-email': 'El correo electrónico no es válido.',
      'auth/user-disabled': 'Esta cuenta ha sido deshabilitada.',
      'auth/user-not-found': 'No existe una cuenta con ese correo.',
      'auth/wrong-password': 'Contraseña incorrecta.',
      'auth/email-already-in-use': 'Ya existe una cuenta con ese correo.',
      'auth/weak-password': 'La contraseña debe tener al menos 6 caracteres.',
      'auth/operation-not-allowed': 'Esta operación no está habilitada.',
      'auth/too-many-requests': 'Demasiados intentos. Espera y vuelve a intentarlo.',
      'auth/network-request-failed': 'Error de red. Comprueba tu conexión.'
    };
    return map[code] || (err && err.message) || 'Ocurrió un error de autenticación.';
  }

  function ensureUserDoc(user) {
    var ref = db.collection(COL_USUARIOS).doc(user.uid);
    return ref.get().then(function (doc) {
      if (doc.exists) return { rol: doc.data().rol || 'estudiante' };
      // Nuevos usuarios: rol por defecto siempre 'estudiante', sin permisos de gestor.
      var rol = 'estudiante';
      return ref.set({
        email: user.email || '',
        nombre: '',
        rol: rol,
        estado: 'Activo',
        creado: new Date().toISOString()
      }, { merge: true }).then(function () { return { rol: rol }; });
    });
  }

  function setupUserChip(user) {
    var email = (user && user.email) || '';
    $('userEmail').textContent = email;
    $('userAvatar').textContent = email ? email.charAt(0) : '?';
    $('userChip').style.display = '';
  }

  function setAuthLoading(btn, loading) {
    if (!btn) return;
    btn.disabled = loading;
    if (loading) {
      btn._origText = btn.textContent;
      btn.textContent = '⏳ Cargando…';
    } else {
      btn.textContent = btn._origText || btn.textContent;
    }
  }

  function handleLogin(e) {
    if (e) e.preventDefault();
    var email = $('loginEmail').value.trim();
    if (!auth) { showAuthError('Firebase Authentication no está disponible. Recarga la página.'); return; }
    var pass = $('loginPassword').value;
    if (!email || !pass) { showAuthError('Introduce el correo y la contraseña.'); return; }
    clearAuthError();
    var btn = $('btnLogin');
    setAuthLoading(btn, true);
    auth.signInWithEmailAndPassword(email, pass)
      .catch(function (err) { showAuthError(authErrorMessage(err)); })
      .then(function () { setAuthLoading(btn, false); });
  }

  function handleForgotPassword(e) {
    if (e) e.preventDefault();
    if (!auth) { showAuthError('Firebase Authentication no está disponible. Recarga la página.'); return; }
    var email = $('loginEmail').value.trim();
    if (!email) { showAuthError('Introduce tu correo electrónico para recuperar la contraseña.'); return; }
    clearAuthError();
    showAuthError('Enviando correo de restablecimiento…');
    auth.sendPasswordResetEmail(email)
      .then(function () {
        clearAuthError();
        toast('Se ha enviado un correo para restablecer tu contraseña.');
        alert('Se ha enviado un correo de restablecimiento a: ' + email + '\nRevisa tu bandeja de entrada.');
      })
      .catch(function (err) {
        showAuthError(authErrorMessage(err));
      });
  }

  function handleRegister(e) {
    if (e) e.preventDefault();
    if (!auth) { showAuthError('Firebase Authentication no está disponible. Recarga la página.'); return; }
    var nombre = $('regName').value.trim();
    var email = $('regEmail').value.trim();
    var pass = $('regPassword').value;
    if (!nombre || !email || !pass) { showAuthError('Completa todos los campos.'); return; }
    if (pass.length < 6) { showAuthError('La contraseña debe tener al menos 6 caracteres.'); return; }
    clearAuthError();
    var btn = $('btnRegister');
    setAuthLoading(btn, true);
    auth.createUserWithEmailAndPassword(email, pass)
      .then(function (cred) {
        if (nombre) {
          db.collection(COL_USUARIOS).doc(cred.user.uid)
            .set({ nombre: nombre, email: email, rol: 'estudiante' }, { merge: true })
            .catch(function (e) { showAuthError('No se pudo crear tu perfil en Firestore: ' + (e.message || e)); });
        }
      })
      .catch(function (err) {
        if (err && err.code === 'auth/email-already-in-use') {
          // El correo ya existe en Firebase Auth: intenta iniciar sesión para verificar
          // y regenerar/verificar el documento en Firestore, permitiendo el acceso sin conflictos.
          auth.signInWithEmailAndPassword(email, pass)
            .then(function (cred) {
              var uid = cred.user.uid;
              var ref = db.collection(COL_USUARIOS).doc(uid);
              return ref.get().then(function (doc) {
                if (doc.exists) {
                  return ref.update({
                    nombre: (nombre || doc.data().nombre || '').trim(),
                    email: email,
                    rol: doc.data().rol || 'estudiante'
                  }).catch(function (e) { showAuthError('No se pudo sincronizar tu perfil: ' + (e.message || e)); });
                }
                return ref.set({
                  email: email,
                  nombre: nombre || '',
                  rol: 'estudiante',
                  estado: 'Activo',
                  creado: new Date().toISOString()
                }, { merge: true });
              }).then(function () {
                clearAuthError();
                toast('Tu correo ya estaba registrado. Acceso sincronizado correctamente.');
              });
            })
            .catch(function (loginErr) {
              if (loginErr && loginErr.code === 'auth/wrong-password') {
                showAuthError('Este correo ya está registrado, pero la contraseña es incorrecta. Usa "¿Olvidaste tu contraseña?" para recuperarla.');
              } else {
                showAuthError(authErrorMessage(loginErr));
              }
            });
        } else {
          showAuthError(authErrorMessage(err));
        }
      })
      .then(function () { setAuthLoading(btn, false); });
  }

  function handleLogout() {
    auth.signOut()
      .then(function () { location.reload(); })
      .catch(function (e) { showAuthError('No se pudo cerrar sesión: ' + (e.message || e)); });
  }

  function setAuthTab(tab) {
    $('tabLogin').classList.toggle('active', tab === 'login');
    $('tabRegister').classList.toggle('active', tab === 'register');
    $('loginForm').classList.toggle('active', tab === 'login');
    $('registerForm').classList.toggle('active', tab === 'register');
    $('switchText').textContent = tab === 'login' ? '¿No tienes cuenta?' : '¿Ya tienes cuenta?';
    $('switchLink').textContent = tab === 'login' ? 'Regístrate' : 'Inicia sesión';
    $('switchLink').setAttribute('data-tab', tab === 'login' ? 'register' : 'login');
    clearAuthError();
  }

  function bindPasswordToggles() {
    $('authScreen').addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.password-toggle') : null;
      if (!btn) return;
      var input = $(btn.getAttribute('data-password'));
      if (!input) return;
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      var icon = btn.querySelector('i');
      if (icon) icon.className = 'far ' + (show ? 'fa-eye' : 'fa-eye-slash');
      btn.setAttribute('title', show ? 'Ocultar contraseña' : 'Mostrar contraseña');
    });
  }

  function bindAuthEvents() {
    $('loginForm').addEventListener('submit', handleLogin);
    $('registerForm').addEventListener('submit', handleRegister);
    $('btnLogin').addEventListener('click', function (e) { e.preventDefault(); handleLogin(null); });
    $('btnRegister').addEventListener('click', function (e) { e.preventDefault(); handleRegister(null); });
    $('btnLogout').addEventListener('click', handleLogout);
    $('forgotPasswordLink').addEventListener('click', handleForgotPassword);
    $('tabLogin').addEventListener('click', function () { setAuthTab('login'); });
    $('tabRegister').addEventListener('click', function () { setAuthTab('register'); });
    $('switchLink').addEventListener('click', function (e) {
      e.preventDefault();
      setAuthTab($('switchLink').getAttribute('data-tab'));
    });
    $('switchLink').setAttribute('data-tab', 'register');
    $('authClose').addEventListener('click', closeAuth);
    bindPasswordToggles();
  }

  function initAuth() {
    auth.onAuthStateChanged(function (user) {
      if (user) {
        currentUser = user;
        userId = user.uid;
        ensureUserDoc(user)
          .then(function (r) { startApp(r.rol); })
          .catch(function () {
            showPortal();
          });
      } else {
        currentUser = null;
        showPortal();
      }
    });
  }

  /* ─── ROUTING ─────────────────────────────────────────────── */
  var _navHistory = [];

  function showView(id) {
    var top = _navHistory[_navHistory.length - 1];
    if (top !== id) _navHistory.push(id);
    if (_navHistory.length > 20) _navHistory.shift();
    var allViews = ['viewDashboard', 'viewCatalog', 'viewEditor', 'viewCourse', 'viewLesson', 'viewAdmin', 'viewComunidades'];
    allViews.forEach(function (v) {
      var node = $(v);
      if (node) node.classList.toggle('active', v === id);
    });
    renderBreadcrumb(id);
    updateSidebarActive();
    updateSectionTitle();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function goBack() {
    if (_navHistory.length <= 1) { goDashboard(); return; }
    _navHistory.pop();
    var prev = _navHistory[_navHistory.length - 1];
    showView(prev);
  }

  function breadcrumbCrumb(label, view, current) {
    var node = el('span', 'crumb' + (current ? ' current' : '') + (view && !current ? ' crumb-link' : ''), label);
    if (view && !current) node.setAttribute('data-view', view);
    return node;
  }

  function buildBreadcrumb(id) {
    var dash = { label: '🏠 Escritorio', view: 'viewDashboard' };
    var catLabel = ($('catalogTitle') && $('catalogTitle').textContent) || 'Cursos';
    switch (id) {
      case 'viewDashboard':
        return [dash];
      case 'viewCatalog':
        return [dash, { label: catLabel }];
      case 'viewEditor':
        return [dash, { label: catLabel, view: 'viewCatalog' }, { label: ($('editorHeading') && $('editorHeading').textContent) || 'Editor de curso' }];
      case 'viewCourse':
        return [dash, { label: catLabel, view: 'viewCatalog' }, { label: ($('courseTitle') && $('courseTitle').textContent) || 'Curso' }];
      case 'viewLesson':
        return [dash, { label: catLabel, view: 'viewCatalog' }, { label: ($('courseTitle') && $('courseTitle').textContent) || 'Curso', view: 'viewCourse' }, { label: ($('readerTitle') && $('readerTitle').textContent) || 'Lección' }];
      case 'viewAdmin':
        return [dash, { label: 'Gestión de Usuarios' }];
      case 'viewComunidades':
        return [dash, { label: 'Comunidades' }];
      default:
        return [dash, { label: id }];
    }
  }

  function renderBreadcrumb(id) {
    var bc = $('breadcrumb');
    if (!bc) return;
    bc.innerHTML = '';
    if (id === 'viewDashboard') { bc.style.display = 'none'; return; }
    bc.style.display = '';

    var crumbs = el('div', 'breadcrumb-crumbs');
    var items = buildBreadcrumb(id);
    items.forEach(function (it, i) {
      if (i > 0) crumbs.appendChild(el('span', 'crumb-sep', '›'));
      crumbs.appendChild(breadcrumbCrumb(it.label, it.view, i === items.length - 1));
    });
    bc.appendChild(crumbs);

    var back = el('button', 'btn btn-outline btn-sm', '← Volver');
    back.id = 'btnBack';
    back.type = 'button';
    bc.appendChild(back);
  }

  function bindBreadcrumbEvents() {
    var bc = $('breadcrumb');
    if (!bc) return;
    bc.addEventListener('click', function (e) {
      var link = e.target.closest ? e.target.closest('.crumb-link') : null;
      if (link) {
        e.preventDefault();
        var view = link.getAttribute('data-view');
        if (view) showView(view);
        return;
      }
      if (e.target.closest && e.target.closest('#btnBack')) goBack();
    });
  }

  function goDashboard() {
    showView('viewDashboard');
    try {
      if (typeof V.onDashboardShow === 'function') V.onDashboardShow();
    } catch (e) {
      toast('No se pudo cargar el Escritorio: ' + (e && e.message ? e.message : e), true);
    }
  }

  function showComunidades() {
    showView('viewComunidades');
    try {
      if (typeof V.onComunidadesShow === 'function') V.onComunidadesShow();
    } catch (e) {
      toast('No se pudo cargar Comunidades: ' + (e && e.message ? e.message : e), true);
    }
  }

  /* ─── APP SHELL / SIDEBAR ─────────────────────────────────── */
  function updateSidebarAccess() {
    var isAdmin = userRole === 'superadmin';
    var linkAdmin = $('sidebarLinkAdmin');
    var grpAdmin = $('sidebarGroupAdmin');
    if (linkAdmin) linkAdmin.style.display = isAdmin ? '' : 'none';
    if (grpAdmin) grpAdmin.style.display = isAdmin ? '' : 'none';
    var settings = $('sidebarSettings');
    if (settings) settings.style.display = userRole === 'estudiante' ? 'none' : '';
  }

  function updateSidebarActive() {
    var current = '';
    var v = document.querySelector('#appRoot .view.active');
    if (v) current = v.id;
    var navMap = {
      viewDashboard: 'escritorio',
      viewCatalog: 'cursos', viewCourse: 'cursos', viewLesson: 'cursos', viewEditor: 'cursos',
      viewComunidades: 'comunidades',
      viewAdmin: 'admin'
    };
    var key = navMap[current] || '';
    var links = document.querySelectorAll('.sidebar-link[data-nav]');
    Array.prototype.forEach.call(links, function (l) {
      l.classList.toggle('active', l.getAttribute('data-nav') === key);
    });
  }

  function updateSectionTitle() {
    var t = $('sectionTitle');
    if (!t) return;
    var v = document.querySelector('#appRoot .view.active');
    var id = v ? v.id : '';
    var label = '';
    switch (id) {
      case 'viewDashboard': label = 'Escritorio'; break;
      case 'viewAdmin': label = 'Gestión de Usuarios'; break;
      case 'viewComunidades': label = 'Comunidades'; break;
      case 'viewCatalog': label = ($('catalogTitle') && $('catalogTitle').textContent) || 'Cursos'; break;
      case 'viewCourse': label = ($('courseTitle') && $('courseTitle').textContent) || 'Curso'; break;
      case 'viewLesson': label = ($('readerTitle') && $('readerTitle').textContent) || 'Lección'; break;
      case 'viewEditor': label = ($('courseTitle') && $('courseTitle').textContent) || 'Editor'; break;
      default: label = ''; break;
    }
    t.textContent = label;
  }

  function sidebarOpen() {
    var sb = $('appSidebar');
    if (sb) { sb.classList.add('show'); sb.setAttribute('aria-hidden', 'false'); }
    var ov = $('sidebarOverlay');
    if (ov) ov.classList.add('show');
    document.body.classList.add('sidebar-open');
    var burger = $('appBurger');
    if (burger) burger.setAttribute('aria-expanded', 'true');
  }

  function sidebarClose() {
    var sb = $('appSidebar');
    if (sb) { sb.classList.remove('show'); sb.setAttribute('aria-hidden', 'true'); }
    var ov = $('sidebarOverlay');
    if (ov) ov.classList.remove('show');
    document.body.classList.remove('sidebar-open');
    var burger = $('appBurger');
    if (burger) burger.setAttribute('aria-expanded', 'false');
  }

  function sidebarToggle() {
    if (window.innerWidth >= 1024) {
      updateSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed'));
      return;
    }
    var sb = $('appSidebar');
    if (sb && sb.classList.contains('show')) sidebarClose();
    else sidebarOpen();
  }

  function updateSidebarCollapsed(collapsed) {
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    localStorage.setItem('vconv_sidebar', collapsed ? 'collapsed' : 'open');
    var burger = $('appBurger');
    if (burger) burger.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  }

  function sidebarNavTo(nav) {
    sidebarClose();
    switch (nav) {
      case 'escritorio': goDashboard(); break;
      case 'cursos': setMode(userRole === 'estudiante' ? 'estudiante' : 'gestor'); break;
      case 'comunidades': showComunidades(); break;
      case 'admin': setMode('admin'); break;
      default: break;
    }
  }

  /* ─── THEME ───────────────────────────────────────────────── */
  function applyTheme() {
    document.documentElement.setAttribute('data-theme', theme);
    $('themeToggle').textContent = theme === 'dark' ? '🌙' : '☀️';
    var rt = $('readerTheme');
    if (rt) rt.textContent = theme === 'dark' ? '☀️' : '🌙';
    localStorage.setItem('vconv_theme', theme);
  }
  function toggleTheme() { theme = theme === 'dark' ? 'light' : 'dark'; applyTheme(); }

  /* ─── FONT ────────────────────────────────────────────────── */
  function applyFont() {
    fontScale = Math.min(1.6, Math.max(0.75, fontScale));
    document.documentElement.style.setProperty('--font-scale', fontScale.toFixed(2));
    $('fontLabel').textContent = Math.round(fontScale * 100) + '%';
    localStorage.setItem('vconv_font', fontScale.toString());
  }
  function changeFont(delta) { fontScale = parseFloat((fontScale + delta).toFixed(2)); applyFont(); }

  /* ─── MODE SWITCH ─────────────────────────────────────────── */
  function setMode(m) {
    if (m !== 'gestor' && m !== 'estudiante' && m !== 'admin') return;
    if (m === 'gestor' && userRole === 'estudiante') {
      toast('Tu rol no permite el modo Gestor.');
      return;
    }
    if (m === 'admin' && userRole !== 'superadmin') return;
    mode = m;
    V.mode = m;
    localStorage.setItem('vconv_mode', m === 'admin' ? 'gestor' : m);
    $('modeGestor').classList.toggle('active', m === 'gestor');
    $('modeEstudiante').classList.toggle('active', m === 'estudiante');
    $('modeAdmin').classList.toggle('active', m === 'admin');
    var ml = $('modeLabel');
    if (ml) ml.textContent = m === 'gestor' ? 'Gestor' : m === 'estudiante' ? 'Estudiante' : 'Admin';
    $('btnNewCourse').style.display = m === 'gestor' ? '' : 'none';
    $('progressBarWrap').style.display = m === 'estudiante' ? '' : 'none';
    $('fontControls').style.display = m === 'estudiante' ? '' : 'none';
    $('catalogTitle').textContent = m === 'gestor' ? 'Mis Cursos' : 'Catálogo de Cursos';
    $('catalogSub').textContent = m === 'gestor'
      ? 'Administra los cursos y sus lecciones.'
      : 'Selecciona un curso para comenzar tu aprendizaje.';

    if (m === 'admin') {
      showView('viewAdmin');
    } else {
      showView('viewCatalog');
    }

    // Notify modules of mode change
    if (V.onModeChange) V.onModeChange(m);
  }

  /* ─── START APP ───────────────────────────────────────────── */
  function startApp(rol) {
    userRole = rol;
    V.userRole = rol;
    V.userId = userId;
    V.currentUser = currentUser;
    V.db = db;
    V.auth = auth;

    if (rol === 'gestor') mode = 'gestor';
    else if (rol === 'estudiante') mode = 'estudiante';
    else if (rol === 'superadmin') mode = 'gestor';
    localStorage.setItem('vconv_mode', mode);

    showApp();
    applyTheme();
    applyFont();
    setupUserChip(currentUser);
    if (localStorage.getItem('vconv_sidebar') === 'collapsed') updateSidebarCollapsed(true);
    bindEvents();
    setMode(mode);
    goDashboard();

    $('modeAdmin').style.display = userRole === 'superadmin' ? '' : 'none';

    // Initialize modules
    if (V._modules) {
      V._modules.forEach(function (mod) {
        if (mod.onReady) mod.onReady();
      });
    }
  }

  /* ─── EVENTS ──────────────────────────────────────────────── */
  function bindEvents() {
    $('themeToggle').addEventListener('click', toggleTheme);
    var rt = $('readerTheme');
    if (rt) rt.addEventListener('click', toggleTheme);
    var brandHome = $('brandHome');
    if (brandHome) brandHome.addEventListener('click', function (e) {
      e.preventDefault();
      V.showPortal();
    });
    $('fontIncrease').addEventListener('click', function () { changeFont(0.05); });
    $('fontDecrease').addEventListener('click', function () { changeFont(-0.05); });
    var rfu = $('readerFontUp');
    if (rfu) rfu.addEventListener('click', function () { changeFont(0.05); });
    var rfd = $('readerFontDown');
    if (rfd) rfd.addEventListener('click', function () { changeFont(-0.05); });
    $('btnNewCourse').addEventListener('click', function () { if (V.onNewCourse) V.onNewCourse(); });
    $('modeGestor').addEventListener('click', function () { setMode('gestor'); });
    $('modeEstudiante').addEventListener('click', function () { setMode('estudiante'); });
    $('modeAdmin').addEventListener('click', function () { setMode('admin'); });
    $('btnCancelEdit').addEventListener('click', function () { showView('viewCatalog'); });
    bindBreadcrumbEvents();

    // App Shell: hamburguesa, drawer y navegación lateral
    var appBurger = $('appBurger');
    if (appBurger) appBurger.addEventListener('click', sidebarToggle);
    var sidebarCloseBtn = $('sidebarClose');
    if (sidebarCloseBtn) sidebarCloseBtn.addEventListener('click', sidebarClose);
    var sidebarOverlayEl = $('sidebarOverlay');
    if (sidebarOverlayEl) sidebarOverlayEl.addEventListener('click', sidebarClose);
    var sidebarNavEl = document.querySelector('.sidebar-nav');
    if (sidebarNavEl) {
      sidebarNavEl.addEventListener('click', function (e) {
        var link = e.target.closest ? e.target.closest('.sidebar-link') : null;
        if (!link) return;
        e.preventDefault();
        var nav = link.getAttribute('data-nav');
        if (nav) sidebarNavTo(nav);
      });
    }
    var sidebarLogoutBtn = $('btnLogout');
    if (sidebarLogoutBtn) sidebarLogoutBtn.addEventListener('click', handleLogout);
    updateSidebarAccess();
  }

  /* ─── MODULE REGISTRY ─────────────────────────────────────── */
  V._modules = [];
  V.registerModule = function (mod) { V._modules.push(mod); };

  /* ─── EXPORTS ─────────────────────────────────────────────── */
  V.$ = $;
  V.el = el;
  V.fmtDate = fmtDate;
  V.emptyState = emptyState;
  V.toast = toast;
  V.showView = showView;
  V.goDashboard = goDashboard;
  V.goBack = goBack;
  V.showComunidades = showComunidades;
  V.showPortal = showPortal;
  V.openAuth = openAuth;
  V.closeAuth = closeAuth;
  V.setMode = setMode;
  V.toggleTheme = toggleTheme;
  V.changeFont = changeFont;
  V.applyTheme = applyTheme;
  V.applyFont = applyFont;
  V.clearFbError = clearFbError;
  V.userRole = userRole;
  V.userId = userId;
  V.currentUser = currentUser;
  V.db = db;
  V.auth = auth;
  V.mode = mode;

  /* ─── INIT ────────────────────────────────────────────────── */
  function init() {
    initFirebase();
    applyTheme();
    applyFont();
    bindAuthEvents();
    if (auth) { initAuth(); }
    else {
      authInitFailure = 'No se pudo iniciar Firebase Authentication.';
      showPortal();
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
