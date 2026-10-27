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
  var COL_PODCAST_CATEGORIAS = 'podcast_categorias';
  var COL_PODCAST_COLECCIONES = 'podcast_colecciones';

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
  V.COL_PODCAST_CATEGORIAS = COL_PODCAST_CATEGORIAS;
  V.COL_PODCAST_COLECCIONES = COL_PODCAST_COLECCIONES;

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
  // Conjunto EFECTIVO de roles de la sesión (Fase A · multi-rol). Es la
  // unión del rol principal heredado (`rol`) y del arreglo `roles` que
  // guarda el documento usuarios/{uid}. Ver normalizarRoles() y el catálogo
  // ROLES_MULTI más abajo.
  var userRoles = [];
  // Superadmin: control absoluto. esAdmin()/V.esAdmin marcan la sesión con
  // rol superadmin; los módulos (finanzas, MLM, CRM) y las reglas de
  // Firestore lo tratan como bypass total de validaciones de parentesco,
  // cadenas de patrocinio, límites de asignación y restricciones de edición.
  function esAdmin() { return userRoles.indexOf('superadmin') !== -1; }
  function canManage() { return userRoles.indexOf('superadmin') !== -1 || userRoles.indexOf('gestor') !== -1; }
  // Rol "avanzado": hereda el modo estudiante y suma acceso de SOLO LECTURA a
  // Finanzas/MLM sobre su PROPIA red (él mismo y hasta 5 niveles por debajo,
  // según esMiArbolFin() en firestore.rules). No gestiona contenido del CMS
  // (canManage() lo excluye) ni escribe datos financieros: los paneles de
  // configuración (porcentajes, Red MLM Global) siguen siendo de superadmin.
  function esAvanzado() { return userRoles.indexOf('avanzado') !== -1; }

  /* ─── ROLES MULTIPLES (Fase A) ───────────────────────────────
     El documento usuarios/{uid} admite DOS campos de rol:
       - `rol`   → rol PRINCIPAL, heredado de la versión anterior de la
                   plataforma: estudiante | avanzado | gestor | superadmin.
                   Es el que leen los módulos antiguos y el que sigue
                   siendo la fuente de la etiqueta en la interfaz.
       - `roles` → ARREGLO con todos los roles del usuario, incluidos los
                   nuevos de Fase A: superadmin, cursos_pago,
                   coordinador_comunidad y comptable. Un usuario puede
                   combinar CUALQUIERA de ellos a la vez.

     El conjunto efectivo es la UNIÓN de ambos, y esa unión es la que
     consultan esAdmin()/esContable()/esCoordinador()/esCursosPago().
     La unión (y no el arreglo) es lo que hace la migración segura: los
     documentos antiguos que solo tienen `rol` siguen funcionando tal cual,
     y un documento que solo tenga `roles` (sin `rol`) también cuenta.

     El panel de administración escribe los DOS campos siempre
     sincronizados: `roles` es el conjunto completo y `rol` se deriva de él
     (el rol principal). Así el código heredado que compara `rol` con
     'superadmin' o 'gestor' nunca discrepa de las reglas de Firestore,
     que ya leen el conjunto. */
  /* ─── CATÁLOGO ÚNICO DE ROLES (Fase A) ──────────────────────────
     Este es el ÚNICO lugar donde se declaran los roles de la
     plataforma. Antes vivían en tres archivos (core/app.js,
     modules/roles/roles.js y modules/dashboard/dashboard.js) y
     cambiar una etiqueta obligaba a editar tres sitios.

     Cada rol tiene:
       - grupo:    'base'  → es un ROL PRINCIPAL heredado (se guarda en
                             `rol` y sirve para derivar el principal);
                  'faseA' → rol NUEVO, que solo existe dentro de `roles`.
       - combinable: si puede añadirse ENCIMA del rol principal. Los
                      cuatro combinables son los que el CRM ofrece en su
                      rejilla de casillas.

     Los módulos que necesiten los metadatos (etiqueta, icono, color,
     descripción) los leen de aquí: V.ROLES_CATALOG. */
  var ROLES_CATALOG = {
    estudiante: {
      label: 'Estudiante', icon: '🎓', color: 'blue', grupo: 'base', combinable: false,
      desc: 'Acceso al contenido de la plataforma.'
    },
    avanzado: {
      label: 'Avanzado', icon: '📈', color: 'green', grupo: 'base', combinable: false,
      desc: 'Solo lectura sobre los datos financieros de su propia red.'
    },
    gestor: {
      label: 'Gestor', icon: '🛠️', color: 'gold', grupo: 'base', combinable: false,
      desc: 'Gestiona el contenido del CMS (cursos, podcasts, tienda).'
    },
    superadmin: {
      label: 'Superadmin', icon: '🔐', color: 'gold', grupo: 'base', combinable: true,
      desc: 'Acceso total: usuarios, contenido, finanzas, red global y configuración.'
    },
    cursos_pago: {
      label: 'Cursos de pago', icon: '💎', color: 'blue', grupo: 'faseA', combinable: true,
      desc: 'Acceso al contenido y a los cursos prémium de la plataforma.'
    },
    coordinador_comunidad: {
      label: 'Coordinador de comunidad', icon: '🌐', color: 'green', grupo: 'faseA', combinable: true,
      desc: 'Consulta la red MLM jerárquica (4 niveles) de los usuarios de su red.'
    },
    comptable: {
      label: 'Contable', icon: '🧮', color: 'purple', grupo: 'faseA', combinable: true,
      desc: 'Acceso exclusivo a los reportes financieros y al módulo de finanzas.'
    }
  };
  // Roles heredados que NO son de Fase A, pero conviven en `roles` porque
  // `rol` forma parte del conjunto. Sirven para derivar el rol principal.
  var ROLES_BASE = ['superadmin', 'gestor', 'avanzado', 'estudiante'];
  // Los roles COMBINABLES (los que el CRM ofrece en su rejilla). Se
  // derivan del catálogo para que no haya dos listas que puedan divergir.
  var ROLES_MULTI = (function () {
    var out = {};
    Object.keys(ROLES_CATALOG).forEach(function (k) {
      if (ROLES_CATALOG[k].combinable) out[k] = ROLES_CATALOG[k];
    });
    return out;
  })();

  /* ─── PARÁMETROS POR DEFECTO COMPARTIDOS ──────────────────────
     Los porcentajes de la red MLM (N1–N5) son el MISMO dato en dos
     documentos (config/mlm y config/finanzas). Antes cada módulo
     llevaba su propia copia del valor inicial y podían divergir sin
     que nadie se enterara. Aquí vive el valor inicial ÚNICO: lo
     consumen el motor MLM y el módulo de Finanzas.

     Red de 5 niveles: 30% (N1) + 10% (N2) + 5% (N3–N5) = 55% de
     bolsa; el 45% restante se destina a la Caja Mayor / Fondo
     Estructura General. Editable desde Configuración → Finanzas y MLM. */
  var DEFAULT_MLM_PORCENTAJES = { 1: 30, 2: 10, 3: 5, 4: 5, 5: 5 };

  /* ─── FUSIÓN DE OBJETOS (compartida) ───────────────────────────
     Fusiona `sobre` encima de `base`. La usan el Módulo de
     Configuración (para componer el copy guardado con la base local)
     y la portada (para aplicar config/portal.copy sobre
     data/content.json).

     Reglas:
       · Los objetos se fusionan campo a campo (recursivo).
       · Los ARREGLOS se reemplazan completos: la lista guardada es la
         lista buena, no una mezcla de las dos.
       · Una cadena vacía en `sobre` NO borra el valor de `base`: vacío
         significa "usa el valor por defecto", igual que en los campos
         de texto del panel del superadmin. */
  function mergeProfundo(base, sobre) {
    if (sobre === undefined || sobre === null) return base;
    if (base === undefined || base === null) return sobre;
    var esObj = function (v) { return v && typeof v === 'object' && !Array.isArray(v); };
    if (!esObj(base) || !esObj(sobre)) {
      if (typeof sobre === 'string' && !sobre.trim() && typeof base === 'string') return base;
      return sobre;
    }
    var out = {};
    Object.keys(base).forEach(function (k) { out[k] = base[k]; });
    Object.keys(sobre).forEach(function (k) {
      if (typeof sobre[k] === 'string' && !sobre[k].trim() && typeof out[k] === 'string') return;
      out[k] = esObj(out[k]) ? mergeProfundo(out[k], sobre[k]) : sobre[k];
    });
    return out;
  }

  // Normaliza el documento de usuario a un arreglo de roles sin duplicados
  // ni valores basura. Acepta tanto el documento completo como un par
  // {rol, roles}. Tolera que `roles` no sea un arreglo (un documentoEdited a
  // mano puede tener cualquier cosa ahí) y que falte el campo.
  function normalizarRoles(data) {
    var out = [];
    if (!data) return out;
    var arr = data.roles;
    if (Object.prototype.toString.call(arr) === '[object Array]') {
      for (var i = 0; i < arr.length; i++) {
        var r = arr[i];
        if (typeof r === 'string' && r && out.indexOf(r) === -1) out.push(r);
      }
    }
    if (typeof data.rol === 'string' && data.rol && out.indexOf(data.rol) === -1) {
      out.push(data.rol);
    }
    return out;
  }
  // ¿La sesión tiene este rol? Responde sobre el conjunto efectivo.
  function tieneRol(r) { return userRoles.indexOf(r) !== -1; }
  // Rol "contable": acceso exclusivo al módulo de finanzas y a los reportes
  // financieros. El superadmin lo incluye por bypass.
  function esContable() { return tieneRol('contable'); }
  // Rol "coordinador de comunidad": vista de la red MLM jerárquica de 4
  // niveles de su propia red. El superadmin lo incluye por bypass.
  function esCoordinador() { return tieneRol('coordinador_comunidad'); }
  // Rol "cursos de pago": acceso al contenido y a los cursos prémium.
  function esCursosPago() { return tieneRol('cursos_pago'); }
  // El módulo de finanzas/balances y sus reportes quedan restringidos a
  // estos dos roles: ni estudiantes, ni gestores, ni coordinators.
  function puedeVerFinanzas() { return esContable() || esAdmin(); }
  // La vista jerárquica de la red la pueden abrir los coordinadores y el
  // superadmin (que la ve completa).
  function puedeVerRedCoordinador() { return esCoordinador() || esAdmin(); }
  // Vista UNIFICADA "Red MLM": un solo ítem de menú para las dos caras de
  // la red. La abre el superadmin (que alterna entre la red global completa
  // y su propio árbol de 4 niveles) y el coordinador de comunidad (que ve
  // su árbol de 4 niveles). El conjunto de roles es el mismo que el de la
  // vista de árbol, porque el superadmin ya entra por bypass.
  function puedeVerRedMlm() { return puedeVerRedCoordinador(); }
  // MÓDULO DE CONFIGURACIÓN: lo abre el superadmin (edita todas las
  // secciones) y el contable (que solo ve la pestaña de datos
  // operativos: cuentas bancarias y transacciones). El resto de roles
  // no entran: ni por el menú, ni por una ruta interna (showView lo
  // deniega), ni por las reglas (config/* solo lo escribe isAdmin()).
  function puedeVerConfiguraciones() { return esContable() || esAdmin(); }

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

  /* ─── TOAST ───────────────────────────────────────────────────
     Aviso flotante (notificación emergente) con TRES niveles:
       · sin tipo     → éxito: verde, se oculta solo a los 3 s
       · true/'error' → error: rojo, permanece 8 s (da tiempo a leerlo)
       · 'critico'    → error crítico: rojo, NO se oculta solo; lleva un
                        ✕ y espera a que el usuario lo cierre
     El segundo argumento conserva el booleano de siempre (true = error),
     de modo que los avisos ya escritos en los módulos siguen valiendo. */
  var TOAST_MS = { exito: 3000, error: 8000 };

  function ocultarToast() {
    var t = $('toast');
    if (!t) return;
    clearTimeout(toast._t);
    t.classList.remove('show');
  }

  function toast(msg, tipo) {
    var t = $('toast');
    if (!t) return;
    var clase = 'toast';
    var ms = TOAST_MS.exito;
    var critico = false;
    if (tipo === true || tipo === 'error') {
      clase += ' error';
      ms = TOAST_MS.error;
    } else if (tipo === 'critico' || tipo === 'critical' || tipo === 'fatal') {
      clase += ' error critico';
      ms = 0;
      critico = true;
    }
    /* El contenido se rehace en cada aviso: el texto va en su propio <span>
       para que el ✕ no se mezcle con el mensaje ni lo desplace. */
    t.innerHTML = '';
    var texto = document.createElement('span');
    texto.className = 'toast-texto';
    texto.textContent = (msg === null || msg === undefined) ? '' : String(msg);
    t.appendChild(texto);
    if (critico) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toast-x';
      btn.setAttribute('aria-label', 'Cerrar aviso');
      btn.innerHTML = '&times;';
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        ocultarToast();
      });
      t.appendChild(btn);
    }
    t.className = clase + ' show';
    clearTimeout(toast._t);
    if (ms > 0) toast._t = setTimeout(ocultarToast, ms);
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
      vistaInvitadoPendiente = 'catalog';
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
  // Acceso directo de la portada a los podcasts. El módulo también es de
  // lectura abierta (las reglas de Firestore lo permiten sin sesión), así que
  // el visitante llega igual que a los cursos. El showApp() es imprescindible:
  // showPodcasts() solo enciende la vista, y con la portada delante el shell
  // seguiría oculto — se vería una pantalla en blanco.
  function showGuestPodcasts() {
    if (isAnon && !appStarted) {
      vistaInvitadoPendiente = 'podcasts';
      return;
    }
    showApp();
    showPodcasts();
  }
  // Acceso directo de la portada a la Tienda Consolidada (marketplace). La
  // vitrina de tiendas externas es de lectura abierta (reglas esPublico()), así
  // que el visitante llega igual que a cursos/podcasts. showApp() es imprescindible:
  // showTienda() solo enciende la vista, y con la portada delante el shell
  // seguiría oculto.
  function showGuestTienda() {
    if (isAnon && !appStarted) {
      vistaInvitadoPendiente = 'tienda';
      return;
    }
    showApp();
    showTienda();
  }
  function openAuth(tab) {
    if (tab) setAuthTab(tab);
    if (authInitFailure) showAuthError(authInitFailure);
    var hint = $('authHint');
    if (hint) hint.style.display = isAnon ? '' : 'none';
    $('authScreen').classList.add('show');
    // La estructura de campos vigente se aplica AL ABRIR la pantalla: si el
    // superadmin cambió los estados de los campos de Registro mientras la
    // sesión estaba abierta, el formulario que ve el visitante es el nuevo.
    if (typeof V.onFormularioShow === 'function') {
      try { V.onFormularioShow(); } catch (e) { /* noop */ }
    }
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
        if (doc.exists) {
          var data = doc.data() || {};
          // Se devuelve el rol principal Y el arreglo de roles: el core los
          // necesita para reconstruir el conjunto efectivo de la sesión.
          return { rol: data.rol || 'estudiante', roles: data.roles || [] };
        }
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
        // Los campos personalizados del registro se guardan en `extras`.
        // Se FUSIONAN con los que ya había: al repetir el registro no se
        // pierde lo que el usuario ya había escrito en otra sesión.
        if (datos.extras && Object.keys(datos.extras).length) {
          var prev = (doc.data() && doc.data().extras && typeof doc.data().extras === 'object') ? doc.data().extras : {};
          var merged = {};
          Object.keys(prev).forEach(function (k) { merged[k] = prev[k]; });
          Object.keys(datos.extras).forEach(function (k) { merged[k] = datos.extras[k]; });
          upd.extras = merged;
        }
        return ref.set(upd, { merge: true });
      }
      var data = {
        nombre: datos.nombre || '',
        email: datos.email || user.email || '',
        rol: datos.rol || 'estudiante',
        // El conjunto de roles nace completo y coherente con el rol
        // principal: un usuario nuevo es 'estudiante' y no tiene todavía
        // ningún rol de Fase A. El superadmin puede combinarlos después
        // desde el panel de usuarios.
        roles: [datos.rol || 'estudiante'],
        estado: 'Activo',
        creado: new Date().toISOString(),
        anonimo: false,
        proveedor: datos.proveedor || 'correo'
      };
      if (sponsor) data.sponsorId = sponsor;
      if (datos.extras && Object.keys(datos.extras).length) data.extras = datos.extras;
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

  /* Valores de los campos PERSONALIZADOS del registro (los que no son
     nombre, correo, contraseña ni referido). Se guardan en `extras` dentro
     del documento del usuario: las reglas de Firestore permiten claves
     extra, así que no hay que tocar el esquema de `usuarios`.
     Los campos ocultos y eliminados no aportan valor (no aparecen), y los
     eliminados además se borran al guardar el perfil. */
  function extrasDelRegistro() {
    var out = {};
    if (!V.formulario || typeof V.formulario.valoresRegistro !== 'function') return out;
    var vals = V.formulario.valoresRegistro() || {};
    Object.keys(vals).forEach(function (k) {
      if (k === 'nombre' || k === 'correo' || k === 'contrasena' || k === 'referido') return;
      var v = vals[k];
      if (v === '' || v === undefined || v === null) return;
      out[k] = v;
    });
    return out;
  }

  function handleRegister(e) {
    if (e) e.preventDefault();
    if (!auth) { showAuthError('Firebase Authentication no está disponible. Recarga la página.'); return; }

    // La estructura vigente de campos decide qué se exige. Los campos que el
    // superadmin marcó como obligatorios se comprueban aquí, con su
    // etiqueta; los ocultos y eliminados no se piden ni se guardan.
    if (V.formulario && typeof V.formulario.validarRegistro === 'function') {
      var check = V.formulario.validarRegistro();
      if (!check || check.ok !== true) {
        showAuthError((check && check.mensaje) || 'Revisa los campos del formulario.');
        return;
      }
    }

    var nombre = $('regName') ? $('regName').value.trim() : '';
    var email = $('regEmail') ? $('regEmail').value.trim() : '';
    var pass = $('regPassword') ? $('regPassword').value : '';

    // Correo y contraseña son la puerta de entrada a Firebase Auth: sin ellos
    // no hay cuenta. Si el administrador los dejó ocultos o eliminados, el
    // registro quedaría roto, así que se avisa en vez de fallar con un error
    // incomprensible.
    var estadoCampo = function (id) {
      if (!V.formulario || typeof V.formulario.estadoDe !== 'function') return 'obligatorio';
      return V.formulario.estadoDe('registro', id);
    };
    if (estadoCampo('correo') !== 'visible' && estadoCampo('correo') !== 'obligatorio') {
      showAuthError('El correo es necesario para crear la cuenta. Avisa al administrador.');
      return;
    }
    if (estadoCampo('contrasena') !== 'visible' && estadoCampo('contrasena') !== 'obligatorio') {
      showAuthError('La contraseña es necesaria para crear la cuenta. Avisa al administrador.');
      return;
    }

    // El nombre solo se exige si su estado es OBLIGATORIO: si el
    // administrador lo dejó opcional (o lo ocultó), el registro se acepta
    // sin él. El mensaje exacto lo pone validarRegistro(), que ya conoce
    // la etiqueta de cada campo.
    if (!email || !pass) { showAuthError('Completa todos los campos.'); return; }
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
              sponsorId: sponsorId,
              extras: extrasDelRegistro()
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
    // Firebase. El botón muestra "Ingresar": se abre la pantalla de
    // autenticación en la pestaña de acceso (que permite cambiar a registro).
    if (isAnon) { openAuth('login'); return; }
    // En móvil el botón "Salir" vive dentro del cajón: se recoge para que
    // no quede el menú a medio abrir mientras se cierra la sesión.
    sidebarClose();
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
          .then(function (r) { startApp(r.rol, r.roles); })
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
     nueva. viewSuperadmin (el panel del super admin) queda cubierto por la
     MISMA comprobación. La red global ya NO es una vista aparte: vive dentro
     de la vista unificada "Red MLM", cuya pestaña global se oculta por rol y
     la comprueba además el propio selector de pestaña.

     Cuando se deniega se cae al Escritorio. No hace falta tocar la pila: la
     vista solicitada se sustituye por viewDashboard ANTES de apilarla, así que
     "← Volver" nunca reencuentra una vista prohibida. */
  var VISTAS_SOLO_SUPERADMIN = ['viewSuperadmin'];

  /* Vistas con ACCESO RESTRINGIDO POR ROL. Cada entrada trae su propia
     condición, así que añadir un rol nuevo no obliga a reescribir este
     bloque: se declara la vista y su predicado y el guard la aplica.
     - viewFinanzas / viewReportes → solo 'contable' o 'superadmin'.
     - viewRedMlm               → superadmin o 'coordinador_comunidad'. */
  var VISTAS_POR_ROL = {
    viewFinanzas: puedeVerFinanzas,
    viewReportes: puedeVerFinanzas,
    viewRedMlm: puedeVerRedMlm,
    viewConfiguraciones: puedeVerConfiguraciones
  };

  function showView(id) {
    // Modo mantenimiento: si está activo, quien no tiene un rol con acceso
    // (superadmin o contable) no navega por la aplicación. El bloqueo está
    // AQUÍ, en el único punto por el que pasan todas las vistas, para que
    // ninguna ruta nueva pueda abrirse por la puerta de atrás.
    if (V.mantenimiento && typeof V.mantenimiento.bloquea === 'function' && V.mantenimiento.bloquea()) {
      V.mantenimiento.aplicar();
      return;
    }
    if (VISTAS_SOLO_SUPERADMIN.indexOf(id) !== -1 && !esAdmin()) {
      toast('Acceso restringido al super administrador.', true);
      id = 'viewDashboard';
    }
    // Guard por rol: la navegación lateral, las migas de pan y cualquier
    // enlace interno pasan por aquí, así que la puerta queda cerrada en un
    // solo punto (igual que el guard de superadmin de arriba).
    var guardRol = VISTAS_POR_ROL[id];
    if (guardRol && !guardRol()) {
      toast('Acceso restringido: tu rol no incluye este módulo.', true);
      id = 'viewDashboard';
    }
    var top = _navHistory[_navHistory.length - 1];
    if (top !== id) _navHistory.push(id);
    if (_navHistory.length > 20) _navHistory.shift();
    var allViews = ['viewDashboard', 'viewCatalog', 'viewEditor', 'viewCourse', 'viewLesson', 'viewAdmin', 'viewComunidades', 'viewPodcasts', 'viewTienda', 'viewFinanzas', 'viewReportes', 'viewRedMlm', 'viewSuperadmin', 'viewConfiguraciones'];
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
      case 'viewPodcasts':
        return [dash, { label: 'Podcasts' }];
      case 'viewTienda':
        return [dash, { label: 'Tienda' }];
      case 'viewFinanzas':
        return [dash, { label: 'Finanzas' }];
      case 'viewReportes':
        return [dash, { label: 'Reportes Financieros' }];
      case 'viewRedMlm':
        return [dash, { label: 'Red MLM' }];
      case 'viewSuperadmin':
        return [dash, { label: 'Panel Super Admin' }];
      case 'viewConfiguraciones':
        return [dash, { label: 'Configuración' }];
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

  /* ─── DEEP LINKING (enlaces directos) ──────────────────────────
     Una URL como  index.html?curso=abc123&leccion=l1  debe abrir
     directamente ese curso y esa lección al cargar la app, en lugar de
     aterrizar en el Escritorio o, para el visitante, en la landing.

     Aquí vive solo la MECÁNICA, que es agnóstica del módulo: parseo de
     la URL, registro de manejadores y sincronización de la barra de
     direcciones. Cada módulo publica sus parámetros con
     registerDeepLink() y decide qué abrir con su propio resolver, así
     que dar deep linking a otro módulo no toca una línea de este código.

     Se aceptan las dos fuentes porque el enlace se pega tal cual en
     WhatsApp, correo o Slack: si quien lo recibe lo copia de la barra de
     direcciones puede llegar con ?curso=… o con #curso=…, y las dos
     tienen que abrir exactamente lo mismo. */
  var _deepLinks = [];
  // El enlace que trae la URL se aplica UNA sola vez, en el arranque. Sin este
  // cierre, un cambio de identidad posterior (el visitante que crea su cuenta)
  // volvería a dispararlo y le quitaría al usuario la vista que acaba de abrir
  // para devolverlo al curso del enlace.
  var _deepLinkAplicado = false;

  // Parsea "a=1&b=2" en un objeto plano, tolerando el prefijo ? # / y un
  // porcentaje mal formado (un enlace pegado a mano no debe romper el
  // arranque). No se usa URLSearchParams: para cuatro claves no compensa
  // depender de la API moderna, igual que en mlm.js → leerRefDeUrl.
  function _parseQuery(str) {
    var out = {};
    if (!str) return out;
    String(str).replace(/^[?#\/]+/, '').split('&').forEach(function (par) {
      if (!par) return;
      var i = par.indexOf('=');
      var k = i === -1 ? par : par.slice(0, i);
      var v = i === -1 ? '' : par.slice(i + 1);
      try {
        k = decodeURIComponent(k);
        v = decodeURIComponent(v.replace(/\+/g, ' '));
      } catch (e) { /* valor crudo: mejor un enlace raro que una URL muerta */ }
      if (k) out[k] = v;
    });
    return out;
  }

  // Claves de enlace directo declaradas por los módulos.
  function _deepLinkKeys() {
    var keys = [];
    _deepLinks.forEach(function (d) { keys = keys.concat(d.nombres); });
    return keys;
  }
  function _esDeepLinkKey(k) { return _deepLinkKeys().indexOf(k) !== -1; }

  // Parámetros presentes ahora mismo en la URL: query y hash unidos, con
  // prioridad para el query. Un hash de ancla suelto (#seccion) no genera
  // ninguna clave con valor, así que no llega a ser enlace directo.
  function leerParamsUrl() {
    var params = _parseQuery(window.location.search);
    var hash = _parseQuery(window.location.hash);
    Object.keys(hash).forEach(function (k) { if (params[k] === undefined) params[k] = hash[k]; });
    return params;
  }

  // Parámetros del enlace directo CONGELADOS en el arranque. No se releen al
  // aplicar porque, para una cuenta registrada, el arranque pasa por
  // goDashboard() —que borra las claves de enlace directo del query— antes de
  // llegar a aplicarDeepLink(): si se leyera la URL en ese instante el enlace
  // ya no estaría y el deep link se perdería en silencio, sin error ni aviso.
  var _deepLinkParams = null;
  function congelarDeepLink() {
    if (_deepLinkParams) return;
    _deepLinkParams = leerParamsUrl();
  }

  // Un módulo declara qué parámetros son suyos y qué hacer con ellos:
  //   V.registerDeepLink(['curso','leccion'], function (params) { … })
  function registerDeepLink(paramNames, resolver) {
    if (!paramNames || !paramNames.length || typeof resolver !== 'function') return;
    _deepLinks.push({ nombres: paramNames, resolver: resolver });
  }

  // Enlace directo pendiente de aplicar: el de la URL que algún módulo sabe
  // abrir. Null en cuanto se haya aplicado, para no volver a saltar.
  function deepLinkPendiente() {
    if (_deepLinkAplicado) return null;
    congelarDeepLink();
    var params = _deepLinkParams;
    for (var i = 0; i < _deepLinks.length; i++) {
      var nombres = _deepLinks[i].nombres;
      for (var j = 0; j < nombres.length; j++) {
        if (params[nombres[j]]) return { params: params, handler: _deepLinks[i] };
      }
    }
    return null;
  }

  // Aplica el enlace directo de la URL, si lo hay. Se invoca UNA vez, al
  // final de startApp(): antes ni la identidad de sesión ni los módulos están
  // listos, y el resolver necesita de ambos (Firestore con el UID correcto)
  // para abrir el curso. showApp() se antepone porque el visitante anónimo
  // que llega por un enlace directo debe ver el contenido, no la landing: el
  // enlace es una intención explícita de abrir cursos, y esa landing exige un
  // clic que ya se ha dado con el propio enlace.
  function aplicarDeepLink() {
    var link = deepLinkPendiente();
    if (!link) return false;
    _deepLinkAplicado = true;
    showApp();
    try {
      link.handler.resolver(link.params);
    } catch (e) {
      toast('No se pudo abrir el enlace: ' + (e && e.message ? e.message : e), true);
    }
    return true;
  }

  // Serializa el query que resulta de aplicar `params` (null = borrar las
  // claves de enlace directo) sobre el query actual. Devuelve '' o '?a=1'.
  function _serializarQueryDeepLink(params) {
    var actuales = _parseQuery(window.location.search);
    var propias = _deepLinkKeys();
    propias.forEach(function (k) { delete actuales[k]; });
    if (params) {
      propias.forEach(function (k) { if (params[k]) actuales[k] = params[k]; });
    }
    var qs = '';
    Object.keys(actuales).forEach(function (k) {
      qs += (qs ? '&' : '?') + encodeURIComponent(k) + '=' + encodeURIComponent(actuales[k]);
    });
    return qs;
  }

  // Quita del hash las claves de enlace directo. Un hash sin '=' (un ancla) se
  // devuelve tal cual: solo se reescribe el hash que realmente es una gramática
  // de parámetros, así que un #seccion existente nunca se convierte en #seccion=.
  function _hashSinDeepLink() {
    var hash = window.location.hash;
    if (!hash || hash.indexOf('=') === -1) return hash;
    var keep = [];
    hash.replace(/^[?#\/]+/, '').split('&').forEach(function (par) {
      var i = par.indexOf('=');
      var k = i === -1 ? par : par.slice(0, i);
      var dec = k;
      try { dec = decodeURIComponent(k); } catch (e) { /* crudo */ }
      if (!_esDeepLinkKey(dec)) keep.push(par);
    });
    return keep.length ? '#' + keep.join('&') : '';
  }

  // Deja la barra de direcciones sincronizada con lo que el usuario está
  // viendo, para que copiarla, recargar con F5 o compartir el enlace devuelvan
  // siempre a la misma lección. Se usa replaceState y NO pushState a
  // propósito: la app lleva su propia pila (_navHistory) y apilar en el
  // historial del navegador haría que "atrás" saltara entre cursos en lugar de
  // proseguir por la pila de la app.
  //
  // Solo se tocan las claves declaradas por los módulos: el resto del query
  // sobrevive intacto, y eso es lo que mantiene vivo el ?ref= de las
  // invitaciones MLM, que se sigue leyendo en cualquier momento al abrir el
  // formulario de registro (mlm.js → aplicarEstadoRegistro).
  function escribirDeepLinkUrl(params) {
    try {
      if (!window.history || !window.history.replaceState) return;
      var url = window.location.pathname + _serializarQueryDeepLink(params) + _hashSinDeepLink();
      window.history.replaceState(null, '', url);
    } catch (e) { /* noop: la app navega igual sin la URL sincronizada */ }
  }

  // Enlace absoluto y compartible para esos mismos parámetros. No toca la URL
  // del navegador: es solo para el portapapeles, así que el usuario puede
  // copiar el enlace de un curso sin que la barra de direcciones se mueva.
  function construirDeepLinkUrl(params) {
    return window.location.origin + window.location.pathname + _serializarQueryDeepLink(params);
  }

  function goDashboard() {
    // El Escritorio es el home: aquí termina el enlace directo. Sin esto la URL
    // seguiría anunciando el curso anterior y un F5 lo volvería a abrir,
    // contradiciendo la vista en la que está el usuario.
    escribirDeepLinkUrl(null);
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

  // Podcasts: catálogo público de audio. La lectura es abierta (reglas de
  // Firestore), así que la vista no filtra por rol; el panel de gestión dentro
  // del propio módulo sí depende de canManage().
  function showPodcasts() {
    showView('viewPodcasts');
    try {
      if (typeof V.onPodcastsShow === 'function') V.onPodcastsShow();
    } catch (e) {
      toast('No se pudo cargar Podcasts: ' + (e && e.message ? e.message : e), true);
    }
  }

  // Tienda Consolidada (marketplace): vitrina pública de tiendas externas
  // vinculadas por los vendedores, con visor embebido. La lectura es abierta
  // (reglas de Firestore esPublico()), así que la vista no filtra por rol; el
  // panel "Mi Tienda Externa" del propio módulo depende de tener sesión y el
  // permiso Vendedor Autorizado.
  function showTienda() {
    showView('viewTienda');
    try {
      if (typeof V.onTiendaShow === 'function') V.onTiendaShow();
    } catch (e) {
      toast('No se pudo cargar la Tienda: ' + (e && e.message ? e.message : e), true);
    }
  }

  /* Módulo de finanzas y balances. A PARTIR DE LA FASE A el acceso queda
     restringido a los roles 'contable' y 'superadmin': ni estudiantes, ni
     gestores, ni coordinadores entran al módulo. El guard se repite aquí
     (además del guard por rol de showView) porque showFinanzas() y
     showReportes() son la frontera de UX: avisan y devuelven al Escritorio
     en vez de dejar la vista a medio pintar. */
  function showFinanzas() {
    if (!puedeVerFinanzas()) {
      toast('Acceso restringido: se requiere el rol Contable.', true);
      goDashboard();
      return;
    }
    showView('viewFinanzas');
    try {
      if (typeof V.onFinanzasShow === 'function') V.onFinanzasShow();
    } catch (e) {
      toast('No se pudo cargar Finanzas: ' + (e && e.message ? e.message : e), true);
    }
  }

  function showReportes() {
    if (!puedeVerFinanzas()) {
      toast('Acceso restringido: se requiere el rol Contable.', true);
      goDashboard();
      return;
    }
    showView('viewReportes');
    try {
      if (typeof V.onReportesShow === 'function') V.onReportesShow();
    } catch (e) {
      toast('No se pudo cargar Reportes: ' + (e && e.message ? e.message : e), true);
    }
  }

  /* ═══ VISTA UNIFICADA "RED MLM" ══════════════════════════════
     Un único ítem de menú para las dos caras de la red:
       · 'global' → la red completa de la plataforma (métricas, multinivel
         y dinero). EXCLUSIVA del superadmin: el botón se oculta por rol y
         la función la vuelve a denegar si alguien la fuerza.
       · 'propia' → el árbol jerárquico de 4 niveles del usuario. La ven los
         coordinadores de comunidad y el superadmin.
     El superadmin puede ALTERNAR entre las dos; el coordinador solo ve la
     suya, así que el conmutador se oculta cuando solo hay una opción.

     RED_MLM_TAB recuerda la última pestaña usada: al volver a abrir la vista
     desde el menú lateral, el superadmin aterriza donde se quedó. Vacío al
     principio = todavía no ha abierto la vista (la primera vez se le abre la
     global, que es lo que le interesa como administrador). */
  var RED_MLM_TAB = '';

  function setRedMlmTab(tab) {
    // La pestaña global exige superadmin; si no lo es, se cae a la propia.
    var esGlobal = tab === 'global' && esAdmin();
    var esPropia = !esGlobal && puedeVerRedCoordinador();
    if (!esGlobal && !esPropia) {
      toast('Acceso restringido: tu rol no incluye la Red MLM.', true);
      goDashboard();
      return;
    }
    RED_MLM_TAB = esGlobal ? 'global' : 'propia';

    var panelGlobal = $('redMlmPanelGlobal');
    var panelPropia = $('redMlmPanelPropia');
    if (panelGlobal) panelGlobal.style.display = esGlobal ? '' : 'none';
    if (panelPropia) panelPropia.style.display = esGlobal ? 'none' : '';

    // Estado visual del conmutador.
    var tabGlobal = $('redMlmTabGlobal');
    var tabPropia = $('redMlmTabPropia');
    if (tabGlobal) {
      tabGlobal.classList.toggle('is-active', esGlobal);
      tabGlobal.style.display = esAdmin() ? '' : 'none';
    }
    if (tabPropia) {
      tabPropia.classList.toggle('is-active', !esGlobal);
      tabPropia.style.display = puedeVerRedCoordinador() ? '' : 'none';
    }
    var tabs = $('redMlmTabs');
    // Con una sola pestaña disponible el conmutador sobra: se oculta.
    if (tabs) tabs.style.display = (esAdmin() && puedeVerRedCoordinador()) ? '' : 'none';

    var sub = $('redMlmSubtitle');
    if (sub) {
      sub.textContent = esGlobal
        ? 'Multinivel y dinero de toda la plataforma: métricas globales, comisiones MLM y estructura completa.'
        : 'Tu red de comunidad en 4 niveles: Nivel 1 (referidos directos), Nivel 2, Nivel 3 y Nivel 4.';
    }

    // Cada panel carga lo suyo: el global lo pinta el módulo MLM y el árbol
    // jerárquico, el módulo de roles.
    try {
      if (esGlobal) {
        if (typeof V.onRedGlobalShow === 'function') V.onRedGlobalShow();
      } else {
        if (typeof V.onRedCoordinadorShow === 'function') V.onRedCoordinadorShow();
      }
    } catch (e) {
      toast('No se pudo cargar la Red MLM: ' + (e && e.message ? e.message : e), true);
    }
  }

  /* Punto de entrada único de la vista "Red MLM". Sin `tab` se abre la
     pestaña que le corresponde por rol: la global para el superadmin y la
     propia para el coordinador. */
  function showRedMlm(tab) {
    if (!puedeVerRedMlm()) {
      toast('Acceso restringido: se requiere el rol Coordinador de comunidad.', true);
      goDashboard();
      return;
    }
    showView('viewRedMlm');
    // Sin destino explícito: se recuerda la última pestaña usada y, si no
    // hay ninguna (o ya no le corresponde al rol), la que toca por rol.
    var destino = tab;
    if (!destino) {
      destino = (RED_MLM_TAB === 'global' && esAdmin()) ? 'global'
              : (RED_MLM_TAB === 'propia' && puedeVerRedCoordinador()) ? 'propia'
              : (esAdmin() ? 'global' : 'propia');
    }
    setRedMlmTab(destino);
  }

  /* Vista jerárquica de la red MLM en 4 niveles (pestaña "Mi red"). La abren
     los coordinadores de comunidad y el superadmin (que la ve completa); el
     guard se repite aquí por la misma razón que en showFinanzas/showReportes. */
  function showRedCoordinador() {
    if (!puedeVerRedCoordinador()) {
      toast('Acceso restringido: se requiere el rol Coordinador de comunidad.', true);
      goDashboard();
      return;
    }
    showRedMlm('propia');
  }

  function showRedGlobal() {
    if (!esAdmin()) {
      toast('Acceso restringido a administradores.', true);
      goDashboard();
      return;
    }
    showRedMlm('global');
  }

  /* Panel de configuración. El guard se repite aquí por la misma razón
     que en showSuperadmin: showView es la frontera de navegación y
     esta función la de experiencia (avisa y devuelve al Escritorio).
     Dentro, el módulo de configuración decide qué pestañas ve cada rol:
     el superadmin todas, el contable solo "Datos operativos". */
  function showConfiguraciones() {
    if (!puedeVerConfiguraciones()) {
      toast('Acceso restringido: se requiere el rol Superadmin o Contable.', true);
      goDashboard();
      return;
    }
    showView('viewConfiguraciones');
    try {
      if (typeof V.onConfiguracionesShow === 'function') V.onConfiguracionesShow();
    } catch (e) {
      toast('No se pudo cargar la configuración: ' + (e && e.message ? e.message : e), true);
    }
  }

  /* Panel exclusivo del super administrador. El guard se repite aquí a
     propósito, aunque showView ya lo aplica: showRedMlm y showSuperadmin son
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
    // FASE A · multi-rol: el módulo de finanzas/balances y los reportes
    // quedan restringidos a 'contable' y 'superadmin'. El resto de roles
    // (estudiante, avanzado, gestor, coordinador, cursos de pago) ya NO
    // ven el enlace: el acceso al módulo lo decide el rol, no la sesión.
    // El panel de aporte del Escritorio sigue abierto para cualquier
    // miembro (es el autoservicio de donación, no el módulo contable).
    var veFinanzas = puedeVerFinanzas();
    var linkFinanzas = $('sidebarLinkFinanzas');
    if (linkFinanzas) linkFinanzas.style.display = veFinanzas ? '' : 'none';
    var linkReportes = $('sidebarLinkReportes');
    if (linkReportes) linkReportes.style.display = veFinanzas ? '' : 'none';
    // Red MLM (UNIFICADA): un solo ítem para las dos caras de la red.
    //  · superadmin → red global completa + su propio árbol de 4 niveles;
    //  · coordinador_comunidad → su árbol de 4 niveles.
    var linkRedMlm = $('sidebarLinkRedMlm');
    if (linkRedMlm) linkRedMlm.style.display = puedeVerRedMlm() ? '' : 'none';
    // Las pestañas de la vista unificada también dependen del rol: la global
    // es del superadmin y la de árbol, de coordinadores y superadmin. Si solo
    // hay una disponible, el conmutador se oculta (se aplica en
    // setRedMlmTab, que además marca la pestaña activa).
    var tabGlobal = $('redMlmTabGlobal');
    if (tabGlobal) tabGlobal.style.display = isAdmin ? '' : 'none';
    var tabPropia = $('redMlmTabPropia');
    if (tabPropia) tabPropia.style.display = puedeVerRedCoordinador() ? '' : 'none';
    var tabsRed = $('redMlmTabs');
    if (tabsRed) tabsRed.style.display = (isAdmin && puedeVerRedCoordinador()) ? '' : 'none';
    // Panel del Super Admin: reúne los ajustes que solo el superadmin puede
    // tocar (hoy, el video corporativo de la portada). Se oculta por rol, y
    // además showView lo vuelve a denegar a quien llegue por otra ruta.
    var linkSuperadmin = $('sidebarLinkSuperadmin');
    if (linkSuperadmin) linkSuperadmin.style.display = isAdmin ? '' : 'none';
    // El avanzado no administra cursos: se oculta el botón de modo Gestor y
    // solo queda el modo Estudiante (los controles de texto se conservan).
    var btnGestor = $('modeGestor');
    if (btnGestor) btnGestor.style.display = (esAvanzado() && !esAdmin() && !tieneRol('gestor')) ? 'none' : '';
    var settings = $('sidebarSettings');
    if (settings) settings.style.display = '';
    // Solo se oculta el selector de "Modo de vista", no todo el bloque: los
    // controles A- / A+ viven dentro de sidebarSettings y se comparten con
    // quien no gestiona cursos. Ocultar el contenedor entero los dejaba
    // inalcanzables justo para el rol estudiante y el avanzado, que son
    // quienes más leen.
    var modeBlock = $('modeSwitchBlock');
    if (modeBlock) modeBlock.style.display = canManage() ? '' : 'none';
    // Configuración: la abre el superadmin (todas las secciones) y el
    // contable (solo "Datos operativos"). Se oculta por rol y, además,
    // showView la vuelve a denegar a quien llegue por otra ruta.
    var linkConfig = $('sidebarLinkConfig');
    if (linkConfig) linkConfig.style.display = puedeVerConfiguraciones() ? '' : 'none';
  }

  function updateSidebarActive() {
    var current = '';
    var v = document.querySelector('#appRoot .view.active');
    if (v) current = v.id;
    var navMap = {
      viewDashboard: 'escritorio',
      viewCatalog: 'cursos', viewCourse: 'cursos', viewLesson: 'cursos', viewEditor: 'cursos',
      viewComunidades: 'comunidades',
      viewPodcasts: 'podcasts',
      viewTienda: 'tienda',
      viewAdmin: 'admin',
      viewFinanzas: 'finanzas',
      viewReportes: 'reportes',
      viewRedMlm: 'redmlm',
      viewSuperadmin: 'superadmin',
      viewConfiguraciones: 'config'
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
      case 'viewPodcasts': label = 'Podcasts'; break;
      case 'viewTienda': label = 'Tienda'; break;
      case 'viewFinanzas': label = 'Finanzas'; break;
      case 'viewReportes': label = 'Reportes Financieros'; break;
      case 'viewRedMlm': label = 'Red MLM'; break;
      case 'viewSuperadmin': label = 'Panel Super Admin'; break;
      case 'viewConfiguraciones': label = 'Configuración'; break;
      case 'viewCatalog': label = ($('catalogTitle') && $('catalogTitle').textContent) || 'Cursos'; break;
      case 'viewCourse': label = ($('courseTitle') && $('courseTitle').textContent) || 'Curso'; break;
      case 'viewLesson': label = ($('readerTitle') && $('readerTitle').textContent) || 'Lección'; break;
      case 'viewEditor': label = ($('courseTitle') && $('courseTitle').textContent) || 'Editor'; break;
      default: label = ''; break;
    }
    t.textContent = label;
  }

  /* El cajón se marca con DOS clases equivalentes: .show (la que usa el
     CSS de siempre) y .open (nombre explícito del estado "cajón
     desplegado"). Ambas se pon y se quitan siempre juntas para que
     cualquier comprobación del DOM vea el mismo estado. */
  function sidebarOpen() {
    var sb = $('appSidebar');
    if (sb) {
      sb.classList.add('show');
      sb.classList.add('open');
      sb.setAttribute('aria-hidden', 'false');
    }
    var ov = $('sidebarOverlay');
    if (ov) ov.classList.add('show');
    document.body.classList.add('sidebar-open');
    var burger = $('appBurger');
    if (burger) burger.setAttribute('aria-expanded', 'true');
  }

  function sidebarClose() {
    var sb = $('appSidebar');
    /* En escritorio el menú sigue visible (lo único que se recoge es
       el modo colapsado), así que no se marca como oculto para los
       lectores de pantalla. En móvil, el cajón sí desaparece. */
    var visibleEnEscritorio = window.innerWidth >= 1024;
    if (sb) {
      sb.classList.remove('show');
      sb.classList.remove('open');
      sb.setAttribute('aria-hidden', visibleEnEscritorio ? 'false' : 'true');
    }
    var ov = $('sidebarOverlay');
    if (ov) ov.classList.remove('show');
    document.body.classList.remove('sidebar-open');
    var burger = $('appBurger');
    if (burger) burger.setAttribute('aria-expanded', 'false');
  }

  function sidebarEstaAbierto() {
    var sb = $('appSidebar');
    if (!sb) return false;
    return sb.classList.contains('show') || sb.classList.contains('open');
  }

  function sidebarToggle() {
    if (window.innerWidth >= 1024) {
      updateSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed'));
      return;
    }
    if (sidebarEstaAbierto()) sidebarClose();
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
      case 'podcasts': showPodcasts(); break;
      case 'tienda': showTienda(); break;
      case 'admin': setMode('admin'); break;
      case 'finanzas': showFinanzas(); break;
      case 'reportes': showReportes(); break;
      case 'redmlm': showRedMlm(); break;
      case 'superadmin': showSuperadmin(); break;
      case 'config': showConfiguraciones(); break;
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

  /* ─── CONTROLES DEL MENÚ LATERAL (☰ / ✕ / velo) ─────────────
     Se enlazan al cargar el script, igual que los controles del lector,
     y NO dentro de bindEvents().

     El motivo es el mismo que en bindReaderControls(): bindEvents()
     cuelga de startApp(), que cuelga de ensureUserDoc().then(...). Si
     ese then rechaza (Firestore sin permisos, sin red, perfil ilegible)
     el .catch muestra el aviso y llama a showPortal(), y bindEvents()
     no llega a ejecutarse NUNCA. La app cargaba, pero la ☰ se quedaba
     sin ni un listener y el menú lateral no se abría en el móvil.

     Aquí no hay nada que esperar: son controles estáticos de index.html
     y solo dependen del ancho de la ventana. La guarda de
     shellControlsBound evita cualquier enlace doble. */
  var shellControlsBound = false;
  function bindShellControls() {
    if (shellControlsBound) return;
    shellControlsBound = true;
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
  }

  /* ─── MODE SWITCH ─────────────────────────────────────────── */
  function setMode(m) {
    if (m !== 'gestor' && m !== 'estudiante' && m !== 'admin') return;
    if (m === 'gestor' && !tieneRol('gestor') && !esAdmin()) {
      toast('Tu rol no permite el modo Gestor.');
      return;
    }
    if (m === 'admin' && !esAdmin()) return;
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
  // Una visita tocó un atajo de la portada ("Cursos gratuitos", "Podcasts")
  // durante el arranque (aún sin sesión de Firebase): al montar la app se abre
  // esa sección en vez de quedarse en la landing. Guarda el destino —no un
  // booleano— porque ya hay más de una sección que se puede pedir así.
  var vistaInvitadoPendiente = '';
  // Resuelve el atajo pendiente. showApp() va siempre por delante: sin él el
  // shell sigue oculto y la navegación elegida no se vería.
  function abrirVistaInvitadoPendiente() {
    var destino = vistaInvitadoPendiente;
    vistaInvitadoPendiente = '';
    if (!destino) return false;
    showApp();
    if (destino === 'podcasts') showPodcasts();
    if (destino === 'tienda') showTienda();
    // 'catalog' no navega: setMode() de más arriba ya dejó el catálogo abierto
    // y volver a llamarlo solo repetiría el pintado de todos los módulos.
    return true;
  }
  function startApp(rol, roles) {
    userRole = rol || 'estudiante';
    // Conjunto efectivo de roles = unión del rol principal y del arreglo
    // `roles` del documento. Se calcula AQUÍ, antes de cualquier esAdmin():
    // todas las guardas de la interfaz leen el conjunto, no el rol suelto.
    userRoles = normalizarRoles({ rol: userRole, roles: roles });
    V.userRole = userRole;
    V.userRoles = userRoles;
    V.userId = userId;
    V.currentUser = currentUser;
    V.db = db;
    V.auth = auth;
    V.storage = storage;
    V.isAnon = isAnon;

    // Número de WhatsApp del widget flotante. Aquí y no en init() porque la
    // lectura de config/whatsapp depende de la identidad: startApp corre
    // también tras un login (appStarted), y ahí es donde se reintenta si la
    // escucha murió por permisos mientras el visitante no tenía sesión.
    subscribeWhatsApp();

    // Estructura vigente de los formularios (Registro y Perfil). Se lee UNA
    // vez al arrancar y se aplica al DOM: a partir de ahí, el formulario que
    // ve el visitante es el que el superadmin guardó en config/formulario.
    if (V.formulario && typeof V.formulario.cargar === 'function') {
      V.formulario.cargar();
    }

    // Modo mantenimiento. El estado se lee al arrancar y se sigue en vivo:
    // si el superadmin activa el interruptor, las pestañas abiertas se
    // bloquean al instante. Se aplica AQUÍ, con los roles ya fijados: un
    // contable o un superadmin que entra durante el mantenimiento sigue
    // usando la plataforma con normalidad, y el resto ve el aviso.
    if (V.mantenimiento && typeof V.mantenimiento.aplicar === 'function') {
      V.mantenimiento.aplicar();
      V.mantenimiento.cargar();
      V.mantenimiento.suscribir();
    }

    if (isAnon) {
      // Visitantes: siempre modo estudiante y sin permisos de gestión.
      userRole = 'estudiante';
      userRoles = [];
      V.userRole = userRole;
      V.userRoles = userRoles;
      mode = 'estudiante';
    } else if (esAdmin() || tieneRol('gestor')) mode = 'gestor';
    else mode = 'estudiante';
    localStorage.setItem('vconv_mode', mode);

    applyTheme();
    applyFont();
    if (isAnon) setupGuestChip(currentUser); else setupUserChip(currentUser);
    var logoutBtn = $('btnLogout');
    if (logoutBtn) logoutBtn.textContent = isAnon ? '🔓 Ingresar' : 'Salir';
    if (localStorage.getItem('vconv_sidebar') === 'collapsed') updateSidebarCollapsed(true);

    if (appStarted) {
      // Identidad ya montada: si sigue siendo visitante (modo local) se
      // conserva la landing page visible; si ya es una cuenta registrada se
      // refresca la UI y se muestra su escritorio.
      if (isAnon) {
        // abrirVistaInvitadoPendiente() ya llama a showApp() por su cuenta, así
        // que solo se muestra el shell cuando no había atajo pendiente.
        if (!abrirVistaInvitadoPendiente()) {
          if (deepLinkPendiente()) {
            showApp();
          } else {
            $('appRoot').style.display = 'none';
            var pwPortal = $('portalScreen');
            if (pwPortal) pwPortal.style.display = '';
          }
        }
      } else {
        refreshAuthUi();
      }
      aplicarDeepLink();
      return;
    }
    appStarted = true;
    bindEvents();
    $('modeAdmin').style.display = esAdmin() ? '' : 'none';
    setMode(mode);

    // Visitante sin sesión: se MANTIENE la landing page principal; NO hay
    // redirección automática al Escritorio de invitado. El shell de la app
    // queda montado en segundo plano (eventos + suscripciones del catálogo)
    // para que el acceso "Cursos gratuitos" abra el catálogo al instante.
    if (isAnon) {
      if (vistaInvitadoPendiente) {
        abrirVistaInvitadoPendiente();
      } else if (deepLinkPendiente()) {
        // Un enlace directo (?curso=…) es una intención explícita de abrir
        // cursos: se muestra el shell, pero la navegación real la hace
        // aplicarDeepLink() más abajo, cuando los módulos ya estén listos.
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

    // Enlaces directos: se resuelven AL FINAL del arranque, con los módulos ya
    // inicializados (onReady es quien enlaza el botón de compartir y registra
    // el manejador) y con la identidad de sesión ya fijada, que es lo que
    // permite a Firestore leer el curso con el UID correcto y aplicar el
    // filtrado de acceso de la sesión (el visitante no ve los bloques de pago).
    aplicarDeepLink();
  }

  function refreshAuthUi() {
    // El shell pudo quedar oculto (visitante en la portada: appRoot display:none).
    // Al detectar una sesión activa hay que mostrar la app ANTES de navegar; de
    // lo contrario el usuario permanece en la landing y solo ve su Escritorio
    // tras pulsar el logo o recargar.
    showApp();
    if (isAnon) setupGuestChip(currentUser); else setupUserChip(currentUser);
    var logoutBtn = $('btnLogout');
    if (logoutBtn) logoutBtn.textContent = isAnon ? '🔓 Ingresar' : 'Salir';
    $('modeAdmin').style.display = esAdmin() ? '' : 'none';
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
    ensureUserDoc(user).then(function (r) { startApp(r.rol, r.roles); }).catch(function () {});
  }

  /* ─── EVENTS ──────────────────────────────────────────────── */
  /* A- / A+ y el conmutador de tema del lector NO se enlazan aquí: lo hace
     bindReaderControls() en DOMContentLoaded, para que no dependan de que el
     arranque con la sesión llegue hasta esta función (ver el comentario de
     bindReaderControls). Enlazarlos en los dos sitios haría que cada clic
     sumase dos pasos y los botones pareciesen saltarse el tope.

     Lo mismo vale para la ☰, el ✕ del menú y el velo: los enlaza
     bindShellControls() en DOMContentLoaded (mismo motivo: bindEvents()
     depende de la cadena de autenticación). */
  function bindEvents() {
    $('themeToggle').addEventListener('click', toggleTheme);
    var brandHome = $('brandHome');
    if (brandHome) brandHome.addEventListener('click', function (e) {
      e.preventDefault();
      V.showPublicPortal();
    });
    $('btnNewCourse').addEventListener('click', function () { if (V.onNewCourse) V.onNewCourse(); });
    $('modeGestor').addEventListener('click', function () { setMode('gestor'); sidebarClose(); });
    $('modeEstudiante').addEventListener('click', function () { setMode('estudiante'); sidebarClose(); });
    $('modeAdmin').addEventListener('click', function () { setMode('admin'); sidebarClose(); });
    $('btnCancelEdit').addEventListener('click', function () { showView('viewCatalog'); });
    bindBreadcrumbEvents();

    var sidebarLogoutBtn = $('btnLogout');
    if (sidebarLogoutBtn) sidebarLogoutBtn.addEventListener('click', handleLogout);
    // Conmutador de pestañas de la vista unificada "Red MLM": el superadmin
    // alterna entre la red global y su árbol de 4 niveles. Se delega con
    // `data-red-tab` para que el marcado y la lógica no dependan uno del otro.
    var tabsRed = $('redMlmTabs');
    if (tabsRed) {
      tabsRed.addEventListener('click', function (e) {
        var btn = e.target && e.target.closest ? e.target.closest('[data-red-tab]') : null;
        if (!btn) return;
        e.preventDefault();
        setRedMlmTab(btn.getAttribute('data-red-tab'));
      });
    }
    updateSidebarAccess();
  }

  /* ─── WIDGET DE CHAT WHATSAPP ───────────────────────────────
     Botón flotante verde + ventana de chat (#waFloatBtn / #waChatPanel en
     index.html). El número al que se abre la conversación vive en
     config/whatsapp y lo escribe el superadmin desde su panel: aquí solo se
     lee, se muestra el panel y se construye el enlace wa.me. */
  var WA_COLLECTION = 'config';
  var WA_DOC = 'whatsapp';
  var waNumero = '';
  var waUnsub = null;

  // onSnapshot (y no get) para que el número cambie en la portada abierta en
  // cuanto el superadmin lo guarda, sin recargar. Se reintenta en cada cambio
  // de identidad: con una sesión invitada la lectura de config/{id} está
  // cerrada en firestore.rules y la escucha muere por permisos; al liberar el
  // hueco aquí, startApp() (que corre en cada login) puede volver a abrirla.
  function subscribeWhatsApp() {
    if (!db || waUnsub) return;
    try {
      waUnsub = db.collection(WA_COLLECTION).doc(WA_DOC).onSnapshot(function (doc) {
        var data = doc && doc.exists ? doc.data() : {};
        waNumero = data && typeof data.numero === 'string' ? data.numero.trim() : '';
      }, function (err) {
        console.warn('[chat] no se pudo leer config/whatsapp:', err && err.message);
        try { if (waUnsub) waUnsub(); } catch (e) { /* ya dada de baja */ }
        waUnsub = null;
      });
    } catch (e) {
      waUnsub = null;
      console.warn('[chat] no se pudo suscribir a config/whatsapp:', e && e.message);
    }
  }

  function chatAbierto() {
    var panel = $('waChatPanel');
    return !!(panel && panel.classList.contains('open'));
  }

  function openChat() {
    var panel = $('waChatPanel');
    if (!panel) return;
    panel.classList.add('open');
    subscribeWhatsApp();
    var input = $('waChatInput');
    if (input) input.focus();
  }

  function closeChat() {
    var panel = $('waChatPanel');
    if (panel) panel.classList.remove('open');
  }

  function toggleChat() { if (chatAbierto()) closeChat(); else openChat(); }

  // El botón de envío abre WhatsApp con el mensaje escrito. Sin número
  // guardado no se construye la URL: avisar es mejor que abrir una
  // conversación a la nada.
  function enviarChat() {
    var numero = String(waNumero || '').replace(/\D/g, '');
    if (!numero) {
      toast('El canal de WhatsApp de soporte aún no está configurado.', true);
      return;
    }
    var input = $('waChatInput');
    var texto = input ? String(input.value || '').trim() : '';
    var mensaje = texto || 'Hola 👋, escribo desde el portal de Vida en Convocación. ¿Me pueden ayudar?';
    window.open('https://wa.me/' + numero + '?text=' + encodeURIComponent(mensaje), '_blank', 'noopener');
    if (input) input.value = '';
  }

  /* Marcado del widget. La plantilla global (index.html) lo trae YA montado,
     fuera de #appRoot y de #portalScreen, por eso se ve en todas las vistas
     de la plataforma. Esta construcción es la red de seguridad: si el bloque
     llegara a faltar en el HTML, se añade al <body> ANTES de enlazar los
     eventos, de modo que el botón y la ventana existan siempre.

     Los SVG son texto fijo (icono de WhatsApp): nada de datos de usuario ni
     de contenido editado, así que su innerHTML no abre ninguna puerta. */
  var WA_ICON_PATH = 'M12.04 2C6.58 2 2.13 6.45 2.13 11.91C2.13 13.66 2.59 15.36 3.45 16.86L2.05 22L7.3 20.62C8.75 21.41 10.38 21.83 12.04 21.83C17.5 21.83 21.95 17.38 21.95 11.92C21.95 9.27 20.92 6.78 19.05 4.91C17.18 3.03 14.69 2 12.04 2M12.05 3.67C14.25 3.67 16.31 4.53 17.87 6.09C19.42 7.65 20.28 9.72 20.28 11.92C20.28 16.46 16.58 20.15 12.04 20.15C10.56 20.15 9.11 19.76 7.85 19.03L7.55 18.83L4.43 19.65L5.26 16.61L5.06 16.29C4.24 14.99 3.8 13.47 3.8 11.91C3.81 7.37 7.5 3.67 12.05 3.67M8.53 7.33C8.37 7.33 8.1 7.39 7.87 7.64C7.65 7.89 7 8.5 7 9.71C7 10.93 7.89 12.1 8 12.27C8.14 12.44 9.76 14.94 12.25 16C12.84 16.25 13.3 16.42 13.66 16.53C14.25 16.72 14.79 16.69 15.22 16.63C15.7 16.56 16.68 16.03 16.89 15.45C17.1 14.87 17.1 14.38 17.04 14.27C16.97 14.17 16.81 14.11 16.56 13.99C16.31 13.87 15.09 13.27 14.87 13.18C14.64 13.1 14.48 13.06 14.31 13.3C14.15 13.55 13.67 14.11 13.53 14.27C13.38 14.44 13.24 14.46 12.99 14.34C12.74 14.21 11.94 13.95 11 13.11C10.26 12.45 9.77 11.64 9.62 11.39C9.48 11.14 9.6 11 9.73 10.88C9.84 10.78 9.98 10.6 10.1 10.45C10.23 10.31 10.27 10.2 10.36 10.04C10.45 9.87 10.41 9.73 10.35 9.61C10.29 9.5 9.77 8.26 9.56 7.77C9.36 7.29 9.16 7.35 9 7.34C8.86 7.34 8.7 7.33 8.53 7.33Z';

  function waWidgetBtnHtml() {
    return '<button class="wa-float-btn" id="waFloatBtn" aria-label="Chat de Soporte WhatsApp">' +
      '<svg width="28" height="28" viewBox="0 0 24 24" fill="white" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="' + WA_ICON_PATH + '"/></svg></button>';
  }

  function waWidgetPanelHtml() {
    return '<div class="wa-chat-panel" id="waChatPanel">' +
      '<div class="wa-chat-header"><div class="wa-chat-header-info">' +
      '<svg width="24" height="24" viewBox="0 0 24 24" fill="white" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="' + WA_ICON_PATH + '"/></svg><span>Soporte WhatsApp</span></div>' +
      '<button class="wa-chat-close" id="waChatClose" aria-label="Cerrar">✕</button></div>' +
      '<div class="wa-chat-body">' +
      '<div class="wa-chat-msg">¡Hola! 👋<br>¿En qué podemos ayudarte?</div>' +
      '<textarea class="wa-chat-input" id="waChatInput" placeholder="Escribe tu mensaje..." rows="3"></textarea>' +
      '<button class="wa-chat-send" id="waChatSend">Enviar</button>' +
      '</div></div>';
  }

  // Idempotente y por partes: solo añade lo que falte, nunca duplica ids. Se
  // engancha al <body> para que el widget quede por fuera de #appRoot y
  // #portalScreen y se vea igual en Escritorio, Cursos, Tienda, Pilares o la
  // portada pública.
  function mountChatWidget() {
    if (!document.body) return;
    var faltan = '';
    if (!$('waFloatBtn')) faltan += waWidgetBtnHtml();
    if (!$('waChatPanel')) faltan += waWidgetPanelHtml();
    if (faltan) document.body.insertAdjacentHTML('beforeend', faltan);
  }

  // Enlazado en init(), con independencia de la sesión: el widget es un
  // control estático de la plantilla y debe responder aunque el arranque de
  // Firebase falle.
  function bindChatWidget() {
    mountChatWidget();
    var floatBtn = $('waFloatBtn');
    if (floatBtn) floatBtn.addEventListener('click', toggleChat);
    var closeBtn = $('waChatClose');
    if (closeBtn) closeBtn.addEventListener('click', closeChat);
    var sendBtn = $('waChatSend');
    if (sendBtn) sendBtn.addEventListener('click', enviarChat);
    var input = $('waChatInput');
    if (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); enviarChat(); }
      });
    }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && chatAbierto()) closeChat();
    });
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
  V.showPodcasts = showPodcasts;
  V.showTienda = showTienda;
  V.showFinanzas = showFinanzas;
  V.showReportes = showReportes;
  V.showRedGlobal = showRedGlobal;
  V.showRedCoordinador = showRedCoordinador;
  // Vista unificada "Red MLM": showRedMlm() abre la pestaña que le toca por
  // rol y setRedMlmTab() alterna entre la global y la propia.
  V.showRedMlm = showRedMlm;
  V.setRedMlmTab = setRedMlmTab;
  V.showSuperadmin = showSuperadmin;
  V.showConfiguraciones = showConfiguraciones;
  V.showPortal = showPortal;
  V.showPublicPortal = showPublicPortal;
  V.showGuestCatalog = showGuestCatalog;
  V.showGuestPodcasts = showGuestPodcasts;
  V.showGuestTienda = showGuestTienda;
  V.showApp = showApp;
  V.registerDeepLink = registerDeepLink;
  // API de enlaces directos para los módulos: publicar sus parámetros, saber si
  // hay uno pendiente, aplicarlo y construir/sincronizar la URL.
  V.deepLink = {
    registrar: registerDeepLink,
    pendiente: deepLinkPendiente,
    aplicar: aplicarDeepLink,
    escribirUrl: escribirDeepLinkUrl,
    construirUrl: construirDeepLinkUrl
  };
  V.openAuth = openAuth;
  V.closeAuth = closeAuth;
  // Menú lateral: core/responsive.js lo usa para recoger el cajón
  // cuando se pulsa cualquier opción, se pulsa Escape o se pasa a
  // escritorio.
  V.openSidebar = sidebarOpen;
  V.closeSidebar = sidebarClose;
  // Ventana de chat flotante: la usan los enlaces "Chat en Vivo / Soporte"
  // de la navegación del portal (portal.js), que abren el mismo panel que el
  // botón flotante.
  V.chat = {
    open: openChat,
    close: closeChat,
    toggle: toggleChat,
    send: enviarChat,
    mount: mountChatWidget
  };
  // Número de soporte vivo (config/whatsapp). Lo consulta el módulo de
  // finanzas para el aviso de comprobantes: la foto se envía por WhatsApp,
  // no se sube desde el formulario.
  V.getWhatsAppNumero = function () { return waNumero; };
  V.setMode = setMode;
  V.toggleTheme = toggleTheme;
  V.changeFont = changeFont;
  V.applyTheme = applyTheme;
  V.applyFont = applyFont;
  V.clearFbError = clearFbError;
  V.esAdmin = esAdmin;
  V.canManage = canManage;
  V.esAvanzado = esAvanzado;
  // ─── API DE ROLES (Fase A · multi-rol) ───────────────────────
  // V.tieneRol('contable') → ¿la sesión tiene ese rol?
  // V.userRoles            → conjunto efectivo de roles de la sesión.
  // V.ROLES_MULTI          → roles COMBINABLES (Fase A + superadmin).
  // V.ROLES_BASE           → arreglo con los roles principales heredados.
  // V.ROLES_CATALOG        → CATÁLOGO ÚNICO de la plataforma: todos los
  //                           roles con etiqueta, icono, color, grupo
  //                           (base|faseA), combinable y descripción.
  V.tieneRol = tieneRol;
  V.esContable = esContable;
  V.esCoordinador = esCoordinador;
  V.esCursosPago = esCursosPago;
  V.puedeVerFinanzas = puedeVerFinanzas;
  V.puedeVerRedCoordinador = puedeVerRedCoordinador;
  V.puedeVerRedMlm = puedeVerRedMlm;
  V.puedeVerConfiguraciones = puedeVerConfiguraciones;
  V.normalizarRoles = normalizarRoles;
  V.ROLES_MULTI = ROLES_MULTI;
  V.ROLES_BASE = ROLES_BASE;
  V.ROLES_CATALOG = ROLES_CATALOG;
  // Valor inicial ÚNICO de los porcentajes de la red MLM (N1–N5).
  V.DEFAULT_MLM_PORCENTAJES = DEFAULT_MLM_PORCENTAJES;
  // Fusión de objetos profunda, compartida por el módulo de
  // Configuración y por la portada (config/portal.copy sobre
  // data/content.json).
  V.mergeProfundo = mergeProfundo;
  V.userRoles = userRoles;
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
    // Los parámetros de enlace directo se congelan lo primero de todo, con la
    // URL todavía intacta: es el único momento en que ?curso=… está garantizado.
    // Nada más abajo (la navegación al Escritorio, el arranque de módulos) puede
    // llegar a rescribir el query antes de que el enlace llegue a aplicarse.
    congelarDeepLink();
    // Los controles de texto y tema del lector se enlazan aquí, antes y con
    // independencia de initFirebase()/initAuth(): son controles estáticos que
    // no necesitan sesión, y así funcionan aunque el arranque con la cuenta
    // falle antes de llegar a bindEvents().
    bindReaderControls();
    // Los controles del menú lateral (☰ / ✕ / velo) se enlazan igual, por el
    // mismo motivo: si el arranque con la cuenta falla, el menú tiene que
    // seguir siendo utilizable.
    bindShellControls();
    // Botón flotante y ventana de chat de WhatsApp: controles estáticos del
    // HTML de la landing, igual que los del lector, sin depender de sesión.
    bindChatWidget();
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
