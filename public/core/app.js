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
  var isAnon = false;             // sesión de visitante (Firebase Auth anónimo)
  var userRole = 'estudiante';
  // Superadmin: control absoluto. esAdmin()/V.esAdmin marcan la sesión con
  // rol superadmin; los módulos (finanzas, MLM, CRM) y las reglas de
  // Firestore lo tratan como bypass total de validaciones de parentesco,
  // cadenas de patrocinio, límites de asignación y restricciones de edición.
  function esAdmin() { return userRole === 'superadmin'; }
  function canManage() { return userRole === 'superadmin' || userRole === 'gestor'; }
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

  // UID anónimo capturado antes de una fusión con cuenta existente.
  var _anonUidToMerge = null;

  function buildSocialAuthProvider(key) {
    var cfg = SOCIAL_PROVIDERS[key];
    if (!cfg || !firebase || !firebase.auth || !auth) return null;
    if (key === 'google' && firebase.auth.GoogleAuthProvider) {
      try { return new firebase.auth.GoogleAuthProvider(); } catch (e) { /* noop */ }
    }
    return null;
  }

  function isAccountConflict(code) {
    return code === 'auth/account-exists-with-different-credential' ||
           code === 'auth/credential-already-in-use' ||
           code === 'auth/email-already-in-use';
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

    var current = auth.currentUser;
    var anonUid = (current && current.isAnonymous) ? current.uid : null;
    // Si hay sesión de visitante, la vinculamos (account linking); si
    // la fusión con una cuenta existente fuera necesaria, guardamos el
    // UID anónimo para transferir el progreso.
    if (anonUid) _anonUidToMerge = anonUid;

    var op = anonUid ? current.linkWithPopup(provider) : auth.signInWithPopup(provider);

    op.then(function (result) {
      // Mismo UID (caso típico de account linking): el progreso ya se
      // conserva por construcción, no hay nada que copiar.
      if (anonUid && result.user && result.user.uid === anonUid) _anonUidToMerge = null;
      return adoptAnonymousData(result.user)
        .then(function () { return finalizeLinking(result.user, 'google', null, !!anonUid); })
        .then(function () {
          closeAuth();
          if (anonUid) toast('Sesión vinculada con Google. Tu progreso se conservó.');
        });
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
        if (isAccountConflict(code)) {
          // El correo de la cuenta Google ya pertenece a otra cuenta:
          // se inicia sesión con Google y se FUSIONA el progreso de la
          // sesión anónima en la cuenta formal.
          var anon = _anonUidToMerge;
          return auth.signInWithPopup(provider)
            .then(function (r) {
              if (anon) _anonUidToMerge = anon;
              return adoptAnonymousData(r.user)
                .then(function () { return finalizeLinking(r.user, 'google', null, true); })
                .then(function () {
                  closeAuth();
                  toast('Cuenta fusionada. Tu progreso de visitante se transfirió a tu cuenta.');
                });
            })
            .catch(function (e2) { showAuthError(authErrorMessage(e2)); });
        }
        showAuthError(authErrorMessage(err));
      })
      .then(function () {
        socialPending = false;
        setAuthLoading(btn, false);
      });
  }

  /* ─── FUSIÓN DE CUENTAS (ACCOUNT LINKING) ──────────────────
     El UID de la sesión anónima es temporal y el progreso vive en
     subcolecciones {cursos|modulos}/.../progreso/{uid}. Dos escenarios:

     1) CUENTA NUEVA (linkWithCredential/linkWithPopup): el UID
        anónimo se CONVIERTE en el UID de la cuenta formal. Como el
        identificador no cambia, todo el progreso (y el documento de
        perfil) continúa apuntando al mismo sitio: transferencia
        completa sin pérdida de datos y sin operaciones de copia.

     2) CUENTA EXISTENTE (mismo correo): el enlace falla con
        credential-already-in-use. Se inicia sesión con la cuenta
        formal y se MIGRA el progreso de la sesión anónima (copiando
        las subcolecciones de progreso y los campos de perfil). El UID
        anónimo huérfano queda marcado y es eliminado por la limpieza
        automática de cuentas anónimas (30 días) configurada en
        Firebase Console.                                             */

  // Marca la cuenta destino como vinculada/migrada y limpia la bandera.
  function finalizeLinking(user, proveedor, nombre, viaAnon) {
    if (!user) return Promise.resolve();
    isAnon = false;
    var upd = {
      anonimo: false,
      proveedor: proveedor
    };
    if (viaAnon) {
      upd.fusionado = true;
      upd.fusionadoFecha = new Date().toISOString();
    }
    if (user.email) upd.email = user.email;
    if (nombre) upd.nombre = nombre;
    var ref = db.collection(COL_USUARIOS).doc(user.uid);
    // Solo actualiza si el perfil ya existe; nunca crea documentos aquí.
    return ref.get().then(function (doc) {
      if (!doc.exists) return user;
      return ref.set(upd, { merge: true }).catch(function () {}).then(function () { return user; });
    });
  }

  // Copia los datos de la sesión anónima a la cuenta destino (escenario 2).
  function adoptAnonymousData(targetUser) {
    var anonUid = _anonUidToMerge || null;
    _anonUidToMerge = null;
    if (!anonUid || !targetUser || anonUid === targetUser.uid) return Promise.resolve();
    return Promise.all([
      copyUserProfile(anonUid, targetUser.uid),
      copyAllProgreso(anonUid, targetUser.uid)
    ]).then(function () {
      // Auditoría: solo si el perfil anónimo existía se marca como fusionado.
      // Nunca se crea un documento nuevo aquí (el anónimo que abandonó el
      // registro no debe dejar rastro en la colección).
      return db.collection(COL_USUARIOS).doc(anonUid).get().then(function (doc) {
        if (!doc.exists) return null;
        return db.collection(COL_USUARIOS).doc(anonUid).set({
          fusionadoCon: targetUser.uid,
          fusionadoFecha: new Date().toISOString(),
          estado: 'Fusionado'
        }, { merge: true }).catch(function () {});
      });
    });
  }

  function copyUserProfile(anonUid, targetUid) {
    var src = db.collection(COL_USUARIOS).doc(anonUid);
    var dst = db.collection(COL_USUARIOS).doc(targetUid);
    return Promise.all([src.get(), dst.get()]).then(function (res) {
      var a = res[0], t = res[1];
      if (!a.exists) return null;
      var ad = a.data() || {};
      var upd = {};
      ['nombre', 'apellido', 'documento', 'telefono', 'sexo', 'sexoCustom',
        'rangoEdad', 'departamento', 'ciudad', 'barrio', 'notas', 'perfil', 'profesion', 'oficio'].forEach(function (k) {
        if (ad[k] && (ad[k] + '').trim() !== '') upd[k] = ad[k];
      });
      if (t.exists) {
        var td = t.data() || {};
        Object.keys(upd).forEach(function (k) { if (td[k]) delete upd[k]; });
      }
      if (!Object.keys(upd).length) return null;
      return dst.set(upd, { merge: true });
    }).catch(function () {});
  }

  // Une sin duplicar el progreso (union de completados + max indice).
  function mergeProgressData(srcData, dstData) {
    var list = (dstData && dstData.completed) ? dstData.completed.slice() : [];
    (srcData.completed || []).forEach(function (id) {
      if (list.indexOf(String(id)) === -1) list.push(String(id));
    });
    return {
      completed: list,
      indice: Math.max((srcData.indice || 0), ((dstData && dstData.indice) || 0)),
      fusionado: true
    };
  }

  function copyProgresoForCourse(courseRef, anonUid, targetUid) {
    var src = courseRef.collection(COL_PROGRESO).doc(anonUid);
    var dst = courseRef.collection(COL_PROGRESO).doc(targetUid);
    return src.get().then(function (doc) {
      if (!doc.exists) return null;
      return dst.get().then(function (tdoc) {
        return dst.set(mergeProgressData(doc.data(), tdoc.exists ? tdoc.data() : null), { merge: true });
      });
    }).catch(function () {});
  }

  // Recorre el progreso en las dos rutas de curso existentes: raíz
  // legacy (cursos/{id}/progreso) y anidada (categorias/…/cursos/…).
  function copyAllProgreso(anonUid, targetUid) {
    if (!db) return Promise.resolve();
    var tasks = [];
    tasks.push(db.collection(COL_CURSOS).get()
      .then(function (cs) {
        var ops = [];
        cs.forEach(function (c) { ops.push(copyProgresoForCourse(c.ref, anonUid, targetUid)); });
        return Promise.all(ops);
      }).catch(function () {}));
    tasks.push(db.collection(COL_CATEGORIAS).get()
      .then(function (cats) {
        var ops = [];
        cats.forEach(function (cat) {
          ops.push(cat.ref.collection(COL_CURSOS).get()
            .then(function (cs) {
              var ops2 = [];
              cs.forEach(function (c) { ops2.push(copyProgresoForCourse(c.ref, anonUid, targetUid)); });
              return Promise.all(ops2);
            }).catch(function () {}));
        });
        return Promise.all(ops);
      }).catch(function () {}));
    return Promise.all(tasks);
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
  // existe (p. ej. visitante anónimo o sesión a medio formar) no se crea
  // nada; se devuelve el rol por defecto 'estudiante' y la app funciona
  // leyendo el perfil de forma tolerante (dashboard, MLM, etc.).
  function ensureUserDoc(user) {
    var ref = db.collection(COL_USUARIOS).doc(user.uid);
    return ref.get().then(function (doc) {
      if (doc.exists) return { rol: doc.data().rol || 'estudiante' };
      return { rol: 'estudiante' };
    });
  }

  // Crea/actualiza el perfil de usuario exclusivamente dentro del cierre de
  // handleRegister, cuando el formulario ya fue enviado. Un documento NUEVO
  // nace completo: nombre, correo, rol inicial, estado, proveedor y, si el
  // MLM está activo, el sponsorId (el referralCode lo asegura aplicarPatrocinio,
  // que se encadena en el mismo cierre). Si el documento YA existe (fusión
  // con una cuenta previa) solo se actualizan los datos personales sin tocar
  // rol, estado ni fecha de creación.
  function crearPerfilRegistro(user, datos) {
    var ref = db.collection(COL_USUARIOS).doc(user.uid);
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
      if (datos.sponsorId) data.sponsorId = datos.sponsorId;
      return ref.set(data, { merge: true });
    }).catch(function () { return null; });
  }

  function setupUserChip(user) {
    var email = (user && user.email) || '';
    $('userEmail').textContent = email;
    $('userAvatar').textContent = email ? email.charAt(0) : '?';
    $('userChip').style.display = '';
  }

  // Chip para visitantes anónimos: sin correo, con aviso de invitado.
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

    // Login con sesión real activa: no hace nada (flujo anónimo aparte).
    if (auth.currentUser && !auth.currentUser.isAnonymous) {
      closeAuth();
      setAuthLoading(btn, false);
      return;
    }
    // Si el visitante anónimo inicia sesión con un correo existente, la
    // cuenta anónima se FUSIONA con la formal (migración de progreso).
    var anonUid = (auth.currentUser && auth.currentUser.isAnonymous) ? auth.currentUser.uid : null;
    if (anonUid) _anonUidToMerge = anonUid;

    auth.signInWithEmailAndPassword(email, pass)
      .then(function (cred) {
        if (anonUid && cred.user && cred.user.uid !== anonUid) {
          return adoptAnonymousData(cred.user);
        }
        if (anonUid) _anonUidToMerge = null;
        return null;
      })
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

  // Vincula la sesión anónima con un nuevo correo/contraseña. Si el correo
  // ya pertenece a una cuenta formal, la fusiona migrando el progreso.
  function linkOrMergeEmail(email, pass, nombre) {
    var current = auth.currentUser;
    var anonUid = (current && current.isAnonymous) ? current.uid : null;
    if (anonUid) _anonUidToMerge = anonUid;
    return current.linkWithCredential(firebase.auth.EmailAuthProvider.credential(email, pass))
      .then(function (result) {
        // Mismo UID: el progreso de la sesión anónima queda en el mismo
        // documento; nada que copiar.
        if (result.user && result.user.uid === anonUid) _anonUidToMerge = null;
        return finalizeLinking(result.user, 'correo', nombre, true);
      })
      .catch(function (err) {
        var code = err && err.code ? err.code : '';
        if (isAccountConflict(code)) {
          var anon = anonUid;
          return auth.signInWithEmailAndPassword(email, pass)
            .then(function (cred) {
              if (anon) _anonUidToMerge = anon;
              return adoptAnonymousData(cred.user).then(function () { return cred.user; });
            })
            .then(function (u) { return finalizeLinking(u, 'correo', nombre, true); })
            .then(function (u) {
              toast('Ya existía una cuenta con este correo. Se fusionó el progreso de tu sesión.');
              return u;
            });
        }
        throw err;
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

    // Sesión formal ya activa: no hay nada que registrar.
    if (auth.currentUser && !auth.currentUser.isAnonymous) {
      closeAuth();
      setAuthLoading(btn, false);
      return;
    }

    // Referido capturado manualmente o desde ?ref= de la URL. El módulo
    // MLM valida el código y lo asocia como sponsor solo si mlmEnabled.
    var refInput = $('regReferido');
    var codigoRef = refInput ? refInput.value.trim().toUpperCase() : '';
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

    sponsorTask.then(function (sponsorId) {
      var op;
      if (auth.currentUser && auth.currentUser.isAnonymous) {
        // CUENTA NUEVA sobre una sesión de visitante → account linking:
        // se preserva el UID (y con él todo el progreso ya acumulado). El
        // perfil se crea a continuación en crearPerfilRegistro.
        op = linkOrMergeEmail(email, pass, nombre);
      } else {
        // Sin sesión previa (proveedor anónimo deshabilitado): regístrase
        // de forma estándar. La autenticación aquí NO escribe en Firestore;
        // el perfil se crea abajo, solo tras el envío exitoso del formulario.
        op = auth.createUserWithEmailAndPassword(email, pass);
      }
      return op.then(function (user) {
        if (user && user.uid) {
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
            return mlmApply.then(function () {
              if (typeof V.onDashboardShow === 'function') {
                try { V.onDashboardShow(); } catch (er) { /* noop */ }
              }
              return user;
            });
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
    // Un visitante anónimo nunca "cierra sesión": salir destruiría su UID
    // temporal y con él el progreso de las lecciones de prueba. Se le
    // ofrece registrarse/vincular para conservarlo.
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

  /* ─── SESIÓN ANÓNIMA AUTOMÁTICA ────────────────────────────
     Todo visitante sin sesión recibe al instante un UID temporal de
     Firebase Authentication (signInAnonymously). Con él puede ver el
     catálogo general y las lecciones de prueba; al registrarse con
     correo o Google la sesión se vincula (account linking) y el
     progreso se conserva. La limpieza de cuentas anónimas inactivas
     se configura en Firebase Console → Authentication → Settings
     (limpieza automática a los 30 días).                             */
  var anonSignInPending = false;

  function initAnonymousSession() {
    if (!auth || anonSignInPending) return;
    anonSignInPending = true;
    auth.signInAnonymously()
      .then(function () { anonSignInPending = false; })
      .catch(function (err) {
        anonSignInPending = false;
        var code = err && err.code ? err.code : '';
        if (code === 'auth/operation-not-allowed' || code === 'auth/admin-restricted-operation') {
          showFbError('El acceso de visitantes no está habilitado. Actívalo en Firebase Console → Authentication → Sign-in method (Anónimo).');
        } else {
          showFbError('No se pudo iniciar la sesión de visitante: ' + (err.message || err));
        }
        showPortal();
      });
  }

  function initAuth() {
    auth.onAuthStateChanged(function (user) {
      if (user) {
        currentUser = user;
        userId = user.uid;
        isAnon = !!user.isAnonymous;
        ensureUserDoc(user)
          .then(function (r) { startApp(r.rol); })
          .catch(function () {
            showFbError('No se pudo inicializar tu perfil. Recarga la página.');
            showPortal();
          });
      } else {
        currentUser = null;
        isAnon = false;
        initAnonymousSession();
      }
    });
  }

  /* ─── ROUTING ─────────────────────────────────────────────── */
  var _navHistory = [];

  function showView(id) {
    var top = _navHistory[_navHistory.length - 1];
    if (top !== id) _navHistory.push(id);
    if (_navHistory.length > 20) _navHistory.shift();
    var allViews = ['viewDashboard', 'viewCatalog', 'viewEditor', 'viewCourse', 'viewLesson', 'viewAdmin', 'viewComunidades', 'viewFinanzas', 'viewReportes', 'viewRedGlobal'];
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

  /* ─── APP SHELL / SIDEBAR ─────────────────────────────────── */
  function updateSidebarAccess() {
    var isAdmin = esAdmin();
    var linkAdmin = $('sidebarLinkAdmin');
    var grpAdmin = $('sidebarGroupAdmin');
    if (linkAdmin) linkAdmin.style.display = isAdmin ? '' : 'none';
    if (grpAdmin) grpAdmin.style.display = isAdmin ? '' : 'none';
    // Finanzas y Reportes Financieros: módulo centralizado de superadmin
    // (control absoluto, bypass total). Acceso exclusivo desde el menú
    // lateral y el escritorio de superadmin.
    var linkFinanzas = $('sidebarLinkFinanzas');
    if (linkFinanzas) linkFinanzas.style.display = isAdmin ? '' : 'none';
    var linkReportes = $('sidebarLinkReportes');
    if (linkReportes) linkReportes.style.display = isAdmin ? '' : 'none';
    // Red MLM Global: página independiente del multinivel, solo superadmin.
    var linkRedGlobal = $('sidebarLinkRedGlobal');
    if (linkRedGlobal) linkRedGlobal.style.display = isAdmin ? '' : 'none';
    var settings = $('sidebarSettings');
    if (settings) settings.style.display = userRole === 'estudiante' ? 'none' : '';
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
      viewRedGlobal: 'redglobal'
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
  // Arranque completo de la aplicación. Puede re-emitirse cuando la
  // sesión cambia (p.ej. fusión anónimo→real): en ese caso solo se
  // refresca la UI sin volver a vincular eventos ni inicializar módulos.
  var appStarted = false;
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
    else if (rol === 'superadmin') mode = 'gestor';
    localStorage.setItem('vconv_mode', mode);

    showApp();
    applyTheme();
    applyFont();
    if (isAnon) setupGuestChip(currentUser); else setupUserChip(currentUser);
    var logoutBtn = $('btnLogout');
    if (logoutBtn) logoutBtn.textContent = isAnon ? '🔐 Crear cuenta' : 'Salir';
    if (localStorage.getItem('vconv_sidebar') === 'collapsed') updateSidebarCollapsed(true);

    if (appStarted) {
      refreshAuthUi();
      return;
    }
    appStarted = true;
    bindEvents();
    $('modeAdmin').style.display = userRole === 'superadmin' ? '' : 'none';
    setMode(mode);
    goDashboard();

    // Initialize modules
    if (V._modules) {
      V._modules.forEach(function (mod) {
        if (mod.onReady) mod.onReady();
      });
    }
  }

  function refreshAuthUi() {
    $('modeAdmin').style.display = userRole === 'superadmin' ? '' : 'none';
    updateSidebarAccess();
    setMode(mode);
    goDashboard();
  }

  /* ─── EVENTS ──────────────────────────────────────────────── */
  function bindEvents() {
    $('themeToggle').addEventListener('click', toggleTheme);
    var rt = $('readerTheme');
    if (rt) rt.addEventListener('click', toggleTheme);
    var brandHome = $('brandHome');
    if (brandHome) brandHome.addEventListener('click', function (e) {
      e.preventDefault();
      V.showPublicPortal();
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
  V.showFinanzas = showFinanzas;
  V.showReportes = showReportes;
  V.showRedGlobal = showRedGlobal;
  V.showPortal = showPortal;
  V.showPublicPortal = showPublicPortal;
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
  V.userRole = userRole;
  V.userId = userId;
  V.currentUser = currentUser;
  V.db = db;
  V.auth = auth;
  V.storage = storage;
  V.mode = mode;
  V.isAnon = isAnon;

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
