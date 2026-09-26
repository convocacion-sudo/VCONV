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
  var COL_CATEGORIAS = 'categorias';
  var COL_CURSOS   = 'cursos';
  var COL_MODULOS  = 'modulos';
  var COL_BLOQUES  = 'bloques';
  var COL_LECCIONES = 'lecciones';
  var COL_PROGRESO = 'progreso';
  var COL_COMUNIDADES = 'comunidades';
  var COL_COMUNIDAD_MIEMBROS = 'comunidad_miembros';
  var COL_REUNIONES = 'reuniones';
  var COL_COMUNIDAD_CATEGORIAS = 'comunidad_categorias';

  /* ─── GLOBAL NAMESPACE ────────────────────────────────────── */
  var V = window.VCONV = window.VCONV || {};
  V.COL_USUARIOS = COL_USUARIOS;
  V.COL_CATEGORIAS = COL_CATEGORIAS;
  V.COL_CURSOS   = COL_CURSOS;
  V.COL_MODULOS  = COL_MODULOS;
  V.COL_BLOQUES  = COL_BLOQUES;
  V.COL_LECCIONES = COL_LECCIONES;
  V.COL_PROGRESO = COL_PROGRESO;
  V.COL_COMUNIDADES = COL_COMUNIDADES;
  V.COL_COMUNIDAD_MIEMBROS = COL_COMUNIDAD_MIEMBROS;
  V.COL_REUNIONES = COL_REUNIONES;
  V.COL_COMUNIDAD_CATEGORIAS = COL_COMUNIDAD_CATEGORIAS;

  /* ─── STATE ───────────────────────────────────────────────── */
  var db = null;
  var auth = null;
  var storage = null;
  var userId = localStorage.getItem('vconv_user_id') || '';
  var currentUser = null;
  // Modo visitante LOCAL: sin sesión en Firebase Authentication. El visitante
  // explora catálogo y lecciones de prueba en modo de solo lectura, SIN
  // generar registros fantasma en Auth.
  var isAnon = false;
  var userRole = 'estudiante';
  // Superadmin: control absoluto. esAdmin()/V.esAdmin marcan la sesión con
  // rol superadmin; los módulos (finanzas, MLM, CRM) y las reglas de
  // Firestore lo tratan como bypass total de validaciones de parentesco,
  // cadenas de patrocinio, límites de asignación y restricciones de edición.
  function esAdmin() { return userRole === 'superadmin'; }
  function canManage() { return userRole === 'superadmin' || userRole === 'gestor'; }
  // Rol "avanzado": hereda el modo estudiante y suma acceso de SOLO LECTURA a
  // Finanzas/MLM sobre su PROPIA red (él mismo y hasta 5 niveles por debajo,
  // según esMiArbolFin() en firestore.rules). No gestiona contenido del CMS
  // (canManage() lo excluye) ni escribe datos financieros: los paneles de
  // configuración (porcentajes, Red MLM Global) siguen siendo de superadmin.
  function esAvanzado() { return userRole === 'avanzado'; }

  /* ─── UID DE SESIÓN (FUENTE ÚNICA) ── Centralizado aquí.
     DEBE usarse en absolutamente TODAS las operaciones de lectura y
     escritura a Firestore de cualquier módulo. Devuelve estrictamente
     el UID real de la sesión activa de Firebase Authentication
     (firebase.auth().currentUser.uid), que es exactamente el
     request.auth.uid que validan las reglas de Firestore (
     `progreso/{uid}: request.auth.uid == uid`, `usuarios/{uid}`,
     finanzas, MLM, CRM…). Nunca usa una variable local de ID
     desactualizada (V.userId cacheado en localStorage) que quede vacía
     o desfasada tras el registro/login/vinculación y provoque
     'Missing or insufficient permissions'.                                 */
  function uidSesion() {
    if (auth && auth.currentUser && auth.currentUser.uid) return String(auth.currentUser.uid);
    // Sin sesión autenticada no hay documento de usuario válido: devolver
    // vacío fuerza que la consulta se deniegue limpiamente en lugar de
    // escribir bajo un UID obsoleto.
    return '';
  }

  var mode = localStorage.getItem('vconv_mode') || 'gestor';
  var theme = localStorage.getItem('vconv_theme') || 'dark';
  /* Límites de la escala de texto. Viven aquí, en el bloque de estado, porque
     los necesita también la saneadora de la preferencia guardada (readFontPref),
     que corre en la línea siguiente. */
  var FONT_MIN = 0.8;
  var FONT_MAX = 1.5;
  var fontScale = readFontPref();
  var authInitFailure = null;
  // Bandera de redirección forzosa al login: el documento de registro del
  // usuario fue eliminado de Firestore. Mientras está activa no se entra en
  // modo visitante ni se deja cargar el escritorio.
  var forceLoginPending = false;

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
      storage = firebase.storage();
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
    // mostrar la landing pública. La sesión (documento de usuario y
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
  function showPublicPortal() {
    // Muestra la landing pública aunque haya sesión activa (clic en el logo),
    // sin cerrar sesión. El usuario puede volver al escritorio con otro clic.
    var app = $('appRoot');
    if (app) app.style.display = 'none';
    var authSc = $('authScreen');
    if (authSc) authSc.classList.remove('show');
    var portal = $('portalScreen');
    if (portal) portal.style.display = '';
  }
  // Acceso directo de la landing page a los cursos: abre el catálogo público
  // SIN pasar por el Escritorio de invitado. Los visitantes (modo local de
  // solo lectura, sin sesión de Firebase) entran en modo estudiante sobre el
  // catálogo; las cuentas registradas vuelven a su app en la vista de cursos.
  function showGuestCatalog() {
    // La sesión de Firebase aún se está resolviendo (arranque pendiente): se
    // deja la landing en pantalla y se abre el catálogo apenas concluya.
    if (isAnon && !appStarted) {
      openCatalogPending = true;
      return;
    }
    showApp();
    if (isAnon) {
      mode = 'estudiante';
      V.mode = mode;
      localStorage.setItem('vconv_mode', 'estudiante');
    }
    setMode(mode);
  }
  function openAuth(tab) {
    if (tab) setAuthTab(tab);
    if (authInitFailure) showAuthError(authInitFailure);
    var hint = $('authHint');
    if (hint) hint.style.display = isAnon ? '' : 'none';
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
      'auth/network-request-failed': 'Error de red. Comprueba tu conexión.',
      'auth/account-exists-with-different-credential': 'Ya existe una cuenta con ese correo usando otro método de acceso.',
      'auth/credential-already-in-use': 'Ya existe una cuenta vinculada a esa credencial.',
      'auth/provider-already-linked': 'Ya tienes vinculado ese método de acceso.',
      'auth/requires-recent-login': 'Por seguridad, vuelve a iniciar sesión para completar esta acción.'
    };
    return map[code] || (err && err.message) || 'Ocurrió un error de autenticación.';
  }

  /* ─── ACCESOS (SOLO PROVEEDORES NATIVOS) ───────────────────
     Autenticación formal única con correo/contraseña y Google.
     Facebook, Instagram y TikTok se retiran por no tener soporte
     nativo en el proyecto (sin SDK/credenciales operativas).     */
  var SOCIAL_PROVIDERS = {
    google: { authId: 'google.com', label: 'Google' }
  };
  var socialPending = false;

  function buildSocialAuthProvider(key) {
    var cfg = SOCIAL_PROVIDERS[key];
    if (!cfg || !firebase || !firebase.auth || !auth) return null;
    if (key === 'google' && firebase.auth.GoogleAuthProvider) {
      try { return new firebase.auth.GoogleAuthProvider(); } catch (e) { /* noop */ }
    }
    return null;
  }

  function handleSocialLogin(key, btn) {
    if (!auth) { showAuthError('Firebase Authentication no está disponible. Recarga la página.'); return; }
    if (socialPending) return;
    var provider = buildSocialAuthProvider(key);
    if (!provider) {
      showAuthError('No se pudo preparar el acceso con ' + (SOCIAL_PROVIDERS[key] ? SOCIAL_PROVIDERS[key].label : key) + '.');
      return;
    }
    clearAuthError();
    socialPending = true;
    setAuthLoading(btn, true);

    // El visitante no tiene sesión ni cuenta anónima: se inicia sesión con
    // el proveedor de forma estándar. No existe account linking.
    auth.signInWithPopup(provider)
      .then(function () {
        closeAuth();
        toast('Sesión iniciada con ' + (SOCIAL_PROVIDERS[key] ? SOCIAL_PROVIDERS[key].label : key) + '.');
      })
      .catch(function (err) {
        var code = err && err.code ? err.code : '';
        if (code === 'auth/popup-closed-by-user') return;
        if (code === 'auth/cancelled-popup-request') return;
        if (code === 'auth/popup-blocked') {
          showAuthError('El navegador bloqueó la ventana emergente. Permite las ventanas emergentes para este sitio e inténtalo de nuevo.');
          return;
        }
        if (code === 'auth/operation-not-allowed' || code === 'auth/unauthorized-domain') {
          showAuthError('Este acceso aún no está habilitado. Actívalo y configura sus credenciales en Firebase Console → Authentication.');
          return;
        }
        showAuthError(authErrorMessage(err));
      })
      .then(function () {
        socialPending = false;
        setAuthLoading(btn, false);
      });
  }

  function bindSocialAuthButtons() {
    var btns = document.querySelectorAll('.auth-social-btn');
    Array.prototype.forEach.call(btns, function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        handleSocialLogin(btn.getAttribute('data-auth-provider'), btn);
      });
    });
  }

  // Único punto de creación del perfil en Firestore (solo dentro de
  // handleRegister). Aquí únicamente se LEE el documento existente: si no
  // existe se trata como perfil eliminado o no creado: se fuerza el cierre de
  // sesión y se redirige al login, evitando que el escritorio intente
  // consultar subcolecciones sin permiso ('Missing or insufficient
  // permissions'). Con reintentos cortos para no romper el alta recién
  // terminada (la creación del perfil se encadena tras la autenticación).
  // Los visitantes sin sesión NO pasan por aquí: entran en modo guest
  // (V.isAnon) directamente desde onAuthStateChanged.
  function ensureUserDoc(user, intentos) {
    var ref = db.collection(COL_USUARIOS).doc(user.uid);
    return ref.get()
      .then(function (doc) {
        if (doc.exists) return { rol: doc.data().rol || 'estudiante' };
        return confirmarPerfilEliminado(user, intentos);
      })
      .catch(function (err) {
        // La lectura del propio perfil fue DENEGADA: sobre un documento
        // borrado las reglas pueden negar el get() ('permission-denied' /
        // 'Missing or insufficient permissions'). Se trata igual que un
        // perfil inexistente. Los fallos de red u otros errores reales se
        // re-lanzan para que el manejo general los cubra.
        if (!esPerfilDenegado(err)) throw err;
        return confirmarPerfilEliminado(user, intentos);
      });
  }

  // Reintenta la lectura del perfil (puede estar creándose en ese instante
  // tras el registro) y, si el documento sigue sin existir o sin poder
  // leerse, fuerza el cierre de sesión y la redirección al login.
  function confirmarPerfilEliminado(user, intentos) {
    if ((intentos || 0) < 5) {
      return new Promise(function (resolve, reject) {
        setTimeout(function () {
          ensureUserDoc(user, (intentos || 0) + 1).then(resolve, reject);
        }, 400);
      });
    }
    handleMissingUserProfile();
    throw new Error('perfil-eliminado');
  }

  function esPerfilDenegado(err) {
    var code = err && err.code ? err.code : '';
    if (code === 'permission-denied') return true;
    return !!(err && err.message && /missing or insufficient permissions/i.test(err.message));
  }

  // Cierre de sesión forzoso y redirección al login cuando el documento de
  // registro no existe en Firestore (cuenta eliminada por un administrador).
  function handleMissingUserProfile() {
    forceLoginPending = true;
    var app = $('appRoot');
    if (app) app.style.display = 'none';
    var portal = $('portalScreen');
    if (portal) portal.style.display = 'none';
    openAuth('login');
    if (auth && auth.currentUser) {
      auth.signOut().catch(function () {});
    }
  }

  // Crea/actualiza el perfil de usuario exclusivamente dentro del cierre de
  // handleRegister, cuando el formulario ya fue enviado. Un documento NUEVO
  // nace completo: nombre, correo, rol inicial, estado, proveedor y, si el
  // MLM está activo, el sponsorId (el referralCode lo asegura aplicarPatrocinio,
  // que se encadena en el mismo cierre). Si el documento YA existe (registro
  // duplicado/reintento) solo se actualizan los datos personales sin tocar
  // rol, estado ni fecha de creación.
  function crearPerfilRegistro(user, datos) {
    var ref = db.collection(COL_USUARIOS).doc(user.uid);
    // Código de referido (MLM) OPcional: si llega vacío, nulo o solo
    // espacios, se normaliza y se OMITE el campo sponsorId por completo
    // (nunca se persisten '', null ni '  '). Así el documento nace íntegro
    // y el login/validación de perfil no encuentra valores basura.
    var sponsor = datos && datos.sponsorId ? String(datos.sponsorId).trim() : '';
    return ref.get().then(function (doc) {
      if (doc.exists) {
        var upd = { anonimo: false, proveedor: datos.proveedor || 'correo' };
        if (user.email) upd.email = user.email;
        if (datos.nombre) upd.nombre = datos.nombre;
        return ref.set(upd, { merge: true });
      }
      var data = {
        nombre: datos.nombre || '',
        email: datos.email || user.email || '',
        rol: datos.rol || 'estudiante',
        estado: 'Activo',
        creado: new Date().toISOString(),
        anonimo: false,
        proveedor: datos.proveedor || 'correo'
      };
      if (sponsor) data.sponsorId = sponsor;
      return ref.set(data, { merge: true });
    }).catch(function () { return null; });
  }

  function setupUserChip(user) {
    var email = (user && user.email) || '';
    $('userEmail').textContent = email;
    $('userAvatar').textContent = email ? email.charAt(0) : '?';
    $('userChip').style.display = '';
  }

  // Chip para visitantes en modo local: sin correo, con aviso de invitado.
  function setupGuestChip(user) {
    $('userEmail').textContent = 'Visitante';
    $('userAvatar').textContent = (user && user.email) ? user.email.charAt(0) : '?';
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

    // Sesión real ya activa: no hay nada que iniciar.
    if (auth.currentUser) {
      closeAuth();
      setAuthLoading(btn, false);
      return;
    }
    // Login estándar. No existe sesión anónima previa que fusionar: los
    // visitantes navegan sin cuenta (modo local) y aquí solo se autentica
    // una cuenta formal existente con correo/contraseña.
    auth.signInWithEmailAndPassword(email, pass)
      .then(function () {
        closeAuth();
        toast('Bienvenido de nuevo.');
      })
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

    // Sesión real ya activa: no hay nada que registrar.
    if (auth.currentUser) {
      closeAuth();
      setAuthLoading(btn, false);
      return;
    }

    // Referido capturado manualmente o desde ?ref= de la URL. El módulo
    // MLM valida el código y lo asocia como sponsor solo si mlmEnabled.
    // Si el campo queda VACÍO se resuelve sponsorId = null y el perfil se
    // crea sin sponsorId (omitido), sin romper la validación del login.
    var refInput = $('regReferido');
    var codigoRef = refInput ? String(refInput.value || '').trim().toUpperCase() : '';
    var sponsorTask = Promise.resolve(null);
    if (codigoRef && V.mlm) {
      sponsorTask = V.mlm.resolverSponsor(codigoRef).then(function (sponsorId) {
        if (!sponsorId) {
          return V.mlm.getConfig().then(function (mlmConfig) {
            if (mlmConfig.mlmEnabled) V.toast('El código de referido no es válido.', true);
            return null;
          });
        }
        return sponsorId;
      });
    }

    // El visitante no tiene ninguna sesión anónima previa: el alta es siempre
    // estándar (createUserWithEmailAndPassword). La identidad se sincroniza
    // de inmediato para que ningún render intermedio conserve la vista de
    // 'Visitante'.
    return sponsorTask.then(function (sponsorId) {
      return auth.createUserWithEmailAndPassword(email, pass)
        .then(function (cred) {
          var user = (cred && cred.user) ? cred.user : cred;
          if (user && user.uid) {
            currentUser = user;
            userId = user.uid;
            isAnon = false;
            V.currentUser = user;
            V.userId = userId;
            V.isAnon = false;

            // Escritura atómica del perfil: único punto de creación del
            // documento. Nace con correo, nombre, rol inicial y proveedor;
            // el referralCode (y el sponsorId si el MLM está activo) los
            // asegura aplicarPatrocinio en la misma cadena.
            return crearPerfilRegistro(user, {
              nombre: nombre,
              email: email,
              rol: 'estudiante',
              proveedor: 'correo',
              sponsorId: sponsorId
            }).then(function () {
              var mlmApply = V.mlm ? V.mlm.aplicarPatrocinio(user.uid, sponsorId) : Promise.resolve();
              return mlmApply.then(function () { return user; });
            }).then(function (u) {
              // Actualización de sesión + redibujado INMEDIATOS: el usuario
              // termina el registro y entra directo a su escritorio/perfil
              // activo, sin esperar (ni depender de) la llegada de
              // onAuthStateChanged ni verse atrapado en 'Visitante'.
              redrawSession(u);
              return u;
            });
          }
          return user;
        });
    })
      .then(function () {
        closeAuth();
        toast('¡Cuenta creada! Bienvenido a VCONV.');
      })
      .catch(function (err) { showAuthError(authErrorMessage(err)); })
      .then(function () { setAuthLoading(btn, false); });
  }

  function handleLogout() {
    // Un visitante en modo local nunca "cierra sesión": no tiene sesión de
    // Firebase. El botón muestra "Crear cuenta": se abre la pantalla de
    // autenticación para registrarse e iniciar sesión.
    if (isAnon) { openAuth('login'); return; }
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
    bindSocialAuthButtons();
  }

  /* ─── MODO VISITANTE LOCAL ──────────────────────────────
     Los visitantes navegan SIN sesión en Firebase Authentication: no se
     crea ningún registro fantasma en Auth. Cuando auth.currentUser es
     null, la app entra en modo visitante de SOLO LECTURA (catálogo
     publicado + lecciones de prueba), con las lecturas públicas
     habilitadas en firestore.rules (esPublico()). El visitante no tiene
     UID ni escribe nada: progreso, comunidades, finanzas y MLM quedan
     reservados a cuentas registradas.      */
  function initAuth() {
    // Clave de la última identidad con la que se construyeron las
    // suscripciones de los módulos. Permite detectar un cambio de identidad
    // (visitante local ⇄ cuenta registrada, o restauración de sesión al
    // cargar) y reconstruirlas INMEDIATAMENTE, sin esperar a
    // ensureUserDoc/startApp.
    var lastSessionKey = '';
    auth.onAuthStateChanged(function (user) {
      // Cierre forzoso por perfil eliminado: la sesión formal ya fue cerrada
      // en handleMissingUserProfile(); no se entra en modo visitante y se
      // deja el login en pantalla.
      if (forceLoginPending) {
        if (!user) {
          forceLoginPending = false;
          currentUser = null;
          isAnon = false;
          openAuth('login');
        }
        return;
      }
      // Cuentas anónimas heredadas: ya no se usan; se cierra la sesión y se
      // pasa a modo visitante local. Cero registros fantasma activos.
      if (user && user.isAnonymous) {
        auth.signOut().catch(function () {});
        return;
      }
      if (user) {
        currentUser = user;
        userId = user.uid;
        isAnon = false;
        V.currentUser = user;
        V.userId = userId;
        V.isAnon = isAnon;
        // La identidad de Firebase YA es la nueva; sincronizarla con los
        // módulos en este mismo instante. Si se espera a ensureUserDoc →
        // startApp → onModeChange, las suscripciones construidas bajo la
        // identidad anterior (p. ej. visitante local) siguen vivas en el
        // intervalo y Firestore las deniega porque request.auth ya no es
        // null ('Missing or insufficient permissions' = toast rojo al login).
        var sessionKey = 'user:' + user.uid;
        if (V.onSessionRefresh && sessionKey !== lastSessionKey) {
          try { V.onSessionRefresh(); } catch (e) { /* noop */ }
        }
        lastSessionKey = sessionKey;
        ensureUserDoc(user)
          .then(function (r) { startApp(r.rol); })
          .catch(function () {
            if (forceLoginPending) return;
            showFbError('No se pudo inicializar tu perfil. Recarga la página.');
            showPortal();
          });
      } else {
        // Sin sesión en Firebase Authentication → MODO VISITANTE LOCAL.
        // El visitante navega (solo lectura) sin generar ningún registro en
        // Auth. No hay UID ni documento de perfil: uidSesion() devuelve ''.
        currentUser = null;
        userId = '';
        isAnon = true;
        V.currentUser = null;
        V.userId = '';
        V.isAnon = true;
        var guestKey = 'guest';
        if (V.onSessionRefresh && guestKey !== lastSessionKey) {
          try { V.onSessionRefresh(); } catch (e) { /* noop */ }
        }
        lastSessionKey = guestKey;
        startApp('estudiante');
      }
    });
  }

  /* ─── ROUTING ─────────────────────────────────────────────── */
  var _navHistory = [];

  /* Vistas que NUNCA se muestran a un rol que no sea superadmin. El bloqueo
     vive AQUÍ, en el único punto por el que pasan todas las vistas, y no solo
     en la función que abre el panel: showView es alcanzable también desde las
     migas de pan y desde cualquier módulo, así que un guard repartido en
     varios sitios dejaría la puerta abierta en cuanto se añadiera una ruta
     nueva. viewRedGlobal y viewSuperadmin (el panel del super admin) quedan
     cubiertos por la MISMA comprobación.

     Cuando se deniega se cae al Escritorio. No hace falta tocar la pila: la
     vista solicitada se sustituye por viewDashboard ANTES de apilarla, así que
     "← Volver" nunca reencuentra una vista prohibida. */
  var VISTAS_SOLO_SUPERADMIN = ['viewRedGlobal', 'viewSuperadmin'];

  function showView(id) {
    if (VISTAS_SOLO_SUPERADMIN.indexOf(id) !== -1 && !esAdmin()) {
      toast('Acceso restringido al super administrador.', true);
      id = 'viewDashboard';
    }
    var top = _navHistory[_navHistory.length - 1];
    if (top !== id) _navHistory.push(id);
    if (_navHistory.length > 20) _navHistory.shift();
    var allViews = ['viewDashboard', 'viewCatalog', 'viewEditor', 'viewCourse', 'viewLesson', 'viewAdmin', 'viewComunidades', 'viewFinanzas', 'viewReportes', 'viewRedGlobal', 'viewSuperadmin'];
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
      case 'viewFinanzas':
        return [dash, { label: 'Finanzas' }];
      case 'viewReportes':
        return [dash, { label: 'Reportes Financieros' }];
      case 'viewRedGlobal':
        return [dash, { label: 'Red MLM Global' }];
      case 'viewSuperadmin':
        return [dash, { label: 'Panel Super Admin' }];
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

  function showFinanzas() {
    showView('viewFinanzas');
    try {
      if (typeof V.onFinanzasShow === 'function') V.onFinanzasShow();
    } catch (e) {
      toast('No se pudo cargar Finanzas: ' + (e && e.message ? e.message : e), true);
    }
  }

  function showReportes() {
    showView('viewReportes');
    try {
      if (typeof V.onReportesShow === 'function') V.onReportesShow();
    } catch (e) {
      toast('No se pudo cargar Reportes: ' + (e && e.message ? e.message : e), true);
    }
  }

  function showRedGlobal() {
    if (!esAdmin()) {
      toast('Acceso restringido a administradores.', true);
      goDashboard();
      return;
    }
    showView('viewRedGlobal');
    try {
      if (typeof V.onRedGlobalShow === 'function') V.onRedGlobalShow();
    } catch (e) {
      toast('No se pudo cargar la Red Global: ' + (e && e.message ? e.message : e), true);
    }
  }

  /* Panel exclusivo del super administrador. El guard se repite aquí a
     propósito, aunque showView ya lo aplica: showRedGlobal y showSuperadmin son
     la frontera de UX (avisan y devuelven al Escritorio) y showView la de
     navegación. Si alguien añadiera una entrada nueva y solo pasara por una de
     las dos, la otra sigue cerrada. */
  function showSuperadmin() {
    if (!esAdmin()) {
      toast('Acceso restringido al super administrador.', true);
      goDashboard();
      return;
    }
    showView('viewSuperadmin');
    try {
      if (typeof V.onSuperadminShow === 'function') V.onSuperadminShow();
    } catch (e) {
      toast('No se pudo cargar el panel del super admin: ' + (e && e.message ? e.message : e), true);
    }
  }

  /* ─── APP SHELL / SIDEBAR ─────────────────────────────────── */
  function updateSidebarAccess() {
    var isAdmin = esAdmin();
    var linkAdmin = $('sidebarLinkAdmin');
    var grpAdmin = $('sidebarGroupAdmin');
    if (linkAdmin) linkAdmin.style.display = isAdmin ? '' : 'none';
    if (grpAdmin) grpAdmin.style.display = isAdmin ? '' : 'none';
    // Finanzas: lectura completa (CRUD) para superadmin; lectura restringida a
    // su propia red para el rol avanzado. Reportes Financieros y Red MLM
    // Global siguen siendo exclusivos de superadmin (consolidan la base
    // completa y los porcentajes, que el avanzado no debe ver).
    var veFinanzas = isAdmin || esAvanzado();
    var linkFinanzas = $('sidebarLinkFinanzas');
    if (linkFinanzas) linkFinanzas.style.display = veFinanzas ? '' : 'none';
    var linkReportes = $('sidebarLinkReportes');
    if (linkReportes) linkReportes.style.display = isAdmin ? '' : 'none';
    // Red MLM Global: página independiente del multinivel, solo superadmin.
    var linkRedGlobal = $('sidebarLinkRedGlobal');
    if (linkRedGlobal) linkRedGlobal.style.display = isAdmin ? '' : 'none';
    // Panel del Super Admin: reúne los ajustes que solo el superadmin puede
    // tocar (hoy, el video corporativo de la portada). Se oculta por rol, y
    // además showView lo vuelve a denegar a quien llegue por otra ruta.
    var linkSuperadmin = $('sidebarLinkSuperadmin');
    if (linkSuperadmin) linkSuperadmin.style.display = isAdmin ? '' : 'none';
    // El avanzado no administra cursos: se oculta el botón de modo Gestor y
    // solo queda el modo Estudiante (los controles de texto se conservan).
    var btnGestor = $('modeGestor');
    if (btnGestor) btnGestor.style.display = esAvanzado() ? 'none' : '';
    var settings = $('sidebarSettings');
    if (settings) settings.style.display = '';
    // Solo se oculta el selector de "Modo de vista", no todo el bloque: los
    // controles A- / A+ viven dentro de sidebarSettings y se comparten con
    // quien no gestiona cursos. Ocultar el contenedor entero los dejaba
    // inalcanzables justo para el rol estudiante y el avanzado, que son
    // quienes más leen.
    var modeBlock = $('modeSwitchBlock');
    if (modeBlock) modeBlock.style.display = canManage() ? '' : 'none';
    // Configuración: pendiente; visible como "Próximamente" para gestores
    // y superadmin, oculto para visitantes y estudiantes.
    var linkConfig = $('sidebarLinkConfig');
    var grpProx = $('sidebarGroupProximamente');
    if (linkConfig) linkConfig.style.display = canManage() ? '' : 'none';
    if (grpProx) grpProx.style.display = canManage() ? '' : 'none';
  }

  function updateSidebarActive() {
    var current = '';
    var v = document.querySelector('#appRoot .view.active');
    if (v) current = v.id;
    var navMap = {
      viewDashboard: 'escritorio',
      viewCatalog: 'cursos', viewCourse: 'cursos', viewLesson: 'cursos', viewEditor: 'cursos',
      viewComunidades: 'comunidades',
      viewAdmin: 'admin',
      viewFinanzas: 'finanzas',
      viewReportes: 'reportes',
      viewRedGlobal: 'redglobal',
      viewSuperadmin: 'superadmin'
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
      case 'viewFinanzas': label = 'Finanzas'; break;
      case 'viewReportes': label = 'Reportes Financieros'; break;
      case 'viewRedGlobal': label = 'Red MLM Global'; break;
      case 'viewSuperadmin': label = 'Panel Super Admin'; break;
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
      case 'finanzas': showFinanzas(); break;
      case 'reportes': showReportes(); break;
      case 'redglobal': showRedGlobal(); break;
      case 'superadmin': showSuperadmin(); break;
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
  /* Techo de la escala según el ancho: en móvil y tablet la medida
     disponible es mucho menor, y con 1.5 la letra ampliada deja líneas
     demasiado cortas. El límite se aplica AQUÍ y en un solo lugar, no
     también en CSS: si el tope viviera en ambos sitios, el JS dejaría
     subir el valor interno por encima del tope mientras el texto se
     quedaba clavado, y los botones parecerían muertos sin motivo. */
  function fontCap() { return window.innerWidth <= 600 ? 1.25 : FONT_MAX; }

  /* Lee y SANEA la preferencia de tamaño guardada.
     Un valor no numérico (escrito a mano, de una versión anterior del sitio o
     corrupto) hace que parseFloat devuelva NaN, y un NaN que llega a
     --font-scale es CSS inválido: el texto de la lección cae a 0px
     (invisible) y los botones A- / A+ siguen pareciendo activos sin cambiar
     nada, porque NaN + delta sigue siendo NaN. Peor: applyFont() volvía a
     guardar ese "NaN", así que el estado se perpetuaba en cada recarga sin
     salida. Aquí cualquier valor no finito o fuera de rango vuelve a 1. */
  function readFontPref() {
    var raw;
    try { raw = parseFloat(localStorage.getItem('vconv_font')); } catch (e) { return 1; }
    if (!isFinite(raw)) return 1;
    return Math.min(FONT_MAX, Math.max(FONT_MIN, raw));
  }

  function applyFont() {
    // Se acota y se sanea en un solo punto: nada que no sea un número finito
    // dentro de [FONT_MIN, FONT_MAX] puede llegar a la variable CSS.
    fontScale = isFinite(fontScale) ? Math.min(FONT_MAX, Math.max(FONT_MIN, fontScale)) : 1;
    // Se aplica el valor efectivo (ya limitado por el techo) pero se guarda
    // la preferencia del usuario, para que al pasar a pantalla grande se
    // recupere el tamaño que realmente eligió.
    var eff = Math.min(fontScale, fontCap());
    document.documentElement.style.setProperty('--font-scale', eff.toFixed(2));
    var fl = $('fontLabel');
    if (fl) fl.textContent = Math.round(eff * 100) + '%';
    // La escritura va protegida: si localStorage falla (modo privado, cookies
    // bloqueadas) no debe abortar la función y dejar los botones con el estado
    // de hace varias interacciones.
    try { localStorage.setItem('vconv_font', fontScale.toString()); } catch (e) { /* solo memoria */ }
    // Alcanzado el techo o el suelo, el botón se desactiva: el límite se ve
    // en lugar de que un clic parezca no hacer nada. La barra del lector no
    // tiene indicador de porcentaje, así que sin esto el tope es invisible.
    var atMax = eff >= fontCap() - 0.005;
    var atMin = eff <= FONT_MIN + 0.005;
    var up = $('fontIncrease'), down = $('fontDecrease');
    var rUp = $('readerFontUp'), rDown = $('readerFontDown');
    if (up) up.disabled = atMax;
    if (down) down.disabled = atMin;
    if (rUp) rUp.disabled = atMax;
    if (rDown) rDown.disabled = atMin;
  }

  function changeFont(delta) {
    // Se parte del valor EFECTIVO (el que se ve), no de la preferencia
    // guardada: si no, en móvil los clics se irían comiendo descendiendo
    // desde un valor guardado por encima del techo sin que se notara nada.
    var eff = Math.min(fontScale, fontCap());
    fontScale = parseFloat((eff + delta).toFixed(2));
    applyFont();
  }

  /* ─── CONTROLES DEL LECTOR (A- / A+ y tema) ───────────────────
     Se enlazan AQUÍ, al cargar el script, y no dentro de bindEvents().

     El motivo es que antes solo respondían si bindEvents() llegaba a
     ejecutarse, y bindEvents() se llama desde startApp(), que a su vez cuelga
     de la cadena de autenticación: ensureUserDoc().then(...). Si ese then
     rechaza (Firestore sin permisos, sin red, perfil ilegible) el .catch
     muestra el aviso y llama a showPortal(), y bindEvents() no se llega a
     ejecutar NUNCA. El resultado era el peor posible: la app cargaba, la
     lección se leía y los A- / A+ no tenían ni un listener, muertos al 100 %
     y sin ninguna pista visual de por qué.

     Aquí no hay nada que esperar: son botones estáticos de index.html y
     changeFont() / applyTheme() solo dependen del estado de este módulo, sin
     sesión ni Firebase. Se enlazan en DOMContentLoaded junto a applyFont(),
     que es quien garantiza que el texto tiene su escala aplicada. */
  var readerControlsBound = false;
  function bindReaderControls() {
    if (readerControlsBound) return;
    readerControlsBound = true;
    var rUp = $('readerFontUp'), rDown = $('readerFontDown');
    var up = $('fontIncrease'), down = $('fontDecrease');
    if (rUp) rUp.addEventListener('click', function () { changeFont(0.05); });
    if (rDown) rDown.addEventListener('click', function () { changeFont(-0.05); });
    if (up) up.addEventListener('click', function () { changeFont(0.05); });
    if (down) down.addEventListener('click', function () { changeFont(-0.05); });
    var rt = $('readerTheme');
    if (rt) rt.addEventListener('click', toggleTheme);
    // El techo de la escala depende del ancho: al girar el móvil o redimensionar
    // la ventana hay que reaplicarlo. Solo cuando el techo cambia en verdad,
    // para no escribir en localStorage en cada pixel de arrastre.
    var capVisto = fontCap();
    window.addEventListener('resize', function () {
      var c = fontCap();
      if (c === capVisto) return;
      capVisto = c;
      applyFont();
    });
  }

  /* ─── MODE SWITCH ─────────────────────────────────────────── */
  function setMode(m) {
    if (m !== 'gestor' && m !== 'estudiante' && m !== 'admin') return;
    if (m === 'gestor' && userRole !== 'gestor' && userRole !== 'superadmin') {
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
    // Los controles A- / A+ quedan disponibles en TODOS los modos: solo
    // redimensionan la letra del cuerpo de la lección (único consumidor de
    // --font-scale, .lesson-content en modules/cursos/cursos.css), así que
    // limitarlos a un modo dejaría sin efecto una función de accesibilidad
    // justo a quien más la necesita (quien está leyendo).
    $('fontControls').style.display = '';
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
  // Arranque completo de la aplicación. Puede re-emitirse cuando la
  // identidad cambia (visitante local ⇄ cuenta registrada): en ese caso
  // solo se refresca la UI sin volver a vincular eventos ni inicializar
  // módulos.
  var appStarted = false;
  // Un visitante tocó "Cursos gratuitos" durante el arranque (aún sin sesión
  // resuelta en Firebase): al montar la app se abre el catálogo en vez de
  // quedarse en la landing.
  var openCatalogPending = false;
  function startApp(rol) {
    userRole = rol;
    V.userRole = rol;
    V.userId = userId;
    V.currentUser = currentUser;
    V.db = db;
    V.auth = auth;
    V.storage = storage;
    V.isAnon = isAnon;

    if (isAnon) {
      // Visitantes: siempre modo estudiante y sin permisos de gestión.
      userRole = 'estudiante';
      mode = 'estudiante';
    } else if (rol === 'gestor') mode = 'gestor';
    else if (rol === 'estudiante') mode = 'estudiante';
    else if (rol === 'avanzado') mode = 'estudiante';
    else if (rol === 'superadmin') mode = 'gestor';
    localStorage.setItem('vconv_mode', mode);

    applyTheme();
    applyFont();
    if (isAnon) setupGuestChip(currentUser); else setupUserChip(currentUser);
    var logoutBtn = $('btnLogout');
    if (logoutBtn) logoutBtn.textContent = isAnon ? '🔐 Crear cuenta' : 'Salir';
    if (localStorage.getItem('vconv_sidebar') === 'collapsed') updateSidebarCollapsed(true);

    if (appStarted) {
      // Identidad ya montada: si sigue siendo visitante (modo local) se
      // conserva la landing page visible; si ya es una cuenta registrada se
      // refresca la UI y se muestra su escritorio.
      if (isAnon) {
        if (openCatalogPending) {
          openCatalogPending = false;
          showApp();
        } else {
          $('appRoot').style.display = 'none';
          var pwPortal = $('portalScreen');
          if (pwPortal) pwPortal.style.display = '';
        }
      } else {
        refreshAuthUi();
      }
      return;
    }
    appStarted = true;
    bindEvents();
    $('modeAdmin').style.display = userRole === 'superadmin' ? '' : 'none';
    setMode(mode);

    // Visitante sin sesión: se MANTIENE la landing page principal; NO hay
    // redirección automática al Escritorio de invitado. El shell de la app
    // queda montado en segundo plano (eventos + suscripciones del catálogo)
    // para que el acceso "Cursos gratuitos" abra el catálogo al instante.
    if (isAnon) {
      if (openCatalogPending) {
        openCatalogPending = false;
        showApp();
      } else {
        $('appRoot').style.display = 'none';
        $('authScreen').classList.remove('show');
        var anonPortal = $('portalScreen');
        if (anonPortal) anonPortal.style.display = '';
      }
    } else {
      showApp();
      goDashboard();
    }

    // Initialize modules
    if (V._modules) {
      V._modules.forEach(function (mod) {
        if (mod.onReady) mod.onReady();
      });
    }
  }

  function refreshAuthUi() {
    if (isAnon) setupGuestChip(currentUser); else setupUserChip(currentUser);
    var logoutBtn = $('btnLogout');
    if (logoutBtn) logoutBtn.textContent = isAnon ? '🔐 Crear cuenta' : 'Salir';
    $('modeAdmin').style.display = userRole === 'superadmin' ? '' : 'none';
    updateSidebarAccess();
    setMode(mode);
    goDashboard();
  }

  // Actualiza la identidad global de la sesión y REDIBUJA la interfaz con la
  // identidad indicada, de inmediato. Usada al terminar el registro formal:
  // el usuario entra directo a su escritorio y perfil activo sin quedarse en
  // la vista de 'Visitante'. Si la app aún no arrancó, se lanza el bootstrap
  // (ensureUserDoc → startApp); si ya estaba en pantalla, se refresca la UI.
  // onAuthStateChanged ya dispara lo mismo después; ambas llamadas son
  // idempotentes (startApp guarda con appStarted) y seguras.
  function redrawSession(user) {
    if (!user) return;
    currentUser = user;
    userId = user.uid;
    isAnon = false;
    V.currentUser = user;
    V.userId = userId;
    V.isAnon = isAnon;
    if (appStarted) {
      refreshAuthUi();
      return;
    }
    ensureUserDoc(user).then(function (r) { startApp(r.rol); }).catch(function () {});
  }

  /* ─── EVENTS ──────────────────────────────────────────────── */
  /* A- / A+ y el conmutador de tema del lector NO se enlazan aquí: lo hace
     bindReaderControls() en DOMContentLoaded, para que no dependan de que el
     arranque con la sesión llegue hasta esta función (ver el comentario de
     bindReaderControls). Enlazarlos en los dos sitios haría que cada clic
     sumase dos pasos y los botones pareciesen saltarse el tope. */
  function bindEvents() {
    $('themeToggle').addEventListener('click', toggleTheme);
    var brandHome = $('brandHome');
    if (brandHome) brandHome.addEventListener('click', function (e) {
      e.preventDefault();
      V.showPublicPortal();
    });
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
  V.showFinanzas = showFinanzas;
  V.showReportes = showReportes;
  V.showRedGlobal = showRedGlobal;
  V.showSuperadmin = showSuperadmin;
  V.showPortal = showPortal;
  V.showPublicPortal = showPublicPortal;
  V.showGuestCatalog = showGuestCatalog;
  V.showApp = showApp;
  V.openAuth = openAuth;
  V.closeAuth = closeAuth;
  V.setMode = setMode;
  V.toggleTheme = toggleTheme;
  V.changeFont = changeFont;
  V.applyTheme = applyTheme;
  V.applyFont = applyFont;
  V.clearFbError = clearFbError;
  V.esAdmin = esAdmin;
  V.canManage = canManage;
  V.esAvanzado = esAvanzado;
  V.userRole = userRole;
  V.userId = userId;
  V.uidSesion = uidSesion;
  V.currentUser = currentUser;
  V.db = db;
  V.auth = auth;
  V.storage = storage;
  V.mode = mode;
  V.isAnon = isAnon;

  /* ─── INIT ────────────────────────────────────────────────── */
  function init() {
    applyTheme();
    applyFont();
    // Los controles de texto y tema del lector se enlazan aquí, antes y con
    // independencia de initFirebase()/initAuth(): son controles estáticos que
    // no necesitan sesión, y así funcionan aunque el arranque con la cuenta
    // falle antes de llegar a bindEvents().
    bindReaderControls();
    initFirebase();
    bindAuthEvents();
    if (auth) { initAuth(); }
    else {
      authInitFailure = 'No se pudo iniciar Firebase Authentication.';
      showPortal();
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
