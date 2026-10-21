/* ════════════════════════════════════════════════════════════════
   VCONV · Modo mantenimiento
   Un interruptor en el panel de Configuración (pestaña «Portal / Home»
   → Ajustes generales) que deja la plataforma en modo mantenimiento:
   quien no puede gestionarla ve una pantalla de aviso en lugar de la
   aplicación.

   DÓNDE VIVE EL ESTADO
   En el MISMO documento que el copy de la portada: `config/portal`.
   Se guarda en la clave `mantenimiento`:
       { activo: true, mensaje: 'Estamos realizando mejoras…' }

   Por qué ahí y no en un documento aparte: `config/portal` ya es legible
   SIN sesión (regla `esPublico()` en firestore.rules), que es justo lo que
   necesita el visitante anónimo para saber que la plataforma está en
   mantenimiento. Y `mantenimiento` NO está dentro de `copy`: es un dato
   de OPERACIÓN, no un texto de la landing, así que la portada no lo
   mezcla con el contenido editable.

   QUIÉN PUEDE SEGUIR ENTRANDO
   El superadmin y el contable: son los que tienen que poder entrar
   mientras la plataforma está en mantenimiento para probarla, operarla y
   comprobar que todo funciona. El resto (visitantes anónimos y cuentas
   con rol estudiante o cualquier otro) ven la pantalla de aviso.

   CÓMO SE APLICA
   El estado se lee al arrancar y se sigue en vivo con onSnapshot: si el
   superadmin activa el interruptor, las pestañas abiertas se bloquean
   al instante, sin recargar. La navegación interna se corta en el ÚNICO
   punto por el que pasan todas las vistas (showView, en core/app.js), y
   la pantalla se pinta encima de todo con position:fixed.
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var V = window.VCONV;
  if (!V) { console.error('VCONV core not loaded'); return; }

  var CONFIG_COLLECTION = 'config';
  var PORTAL_DOC = 'portal';

  var MENSAJE_POR_DEFECTO = 'Estamos realizando mejoras en la plataforma. Vuelve en breve.';

  /* Roles que NO se ven afectados por el modo mantenimiento: pueden entrar,
     probar y operar la plataforma mientras el resto ve el aviso. */
  var ROLES_CON_ACCESO = ['superadmin', 'contable'];

  var estado = { activo: false, mensaje: MENSAJE_POR_DEFECTO, cargado: false };
  var unsub = null;

  function normalizar(bruto) {
    var m = (bruto && typeof bruto === 'object' && !Array.isArray(bruto)) ? bruto : {};
    return {
      activo: m.activo === true,
      mensaje: (typeof m.mensaje === 'string' && m.mensaje.trim()) ? m.mensaje.trim() : MENSAJE_POR_DEFECTO
    };
  }

  /* ¿La sesión actual tiene un rol con acceso durante el mantenimiento? */
  function tieneAcceso() {
    if (typeof V.tieneRol !== 'function') return false;
    for (var i = 0; i < ROLES_CON_ACCESO.length; i++) {
      if (V.tieneRol(ROLES_CON_ACCESO[i])) return true;
    }
    return false;
  }

  /* ¿Hay que bloquear a quien está mirando ahora mismo? */
  function bloquea() {
    return estado.activo === true && !tieneAcceso();
  }

  function pantalla() {
    return document.getElementById('maintenanceScreen');
  }

  /* Pinta (o retira) la pantalla de mantenimiento. Se llama cada vez que
     cambia el estado o la identidad de la sesión: un contable que inicia
     sesión durante el mantenimiento deja de ver el aviso, y al salir de
     su sesión vuelve a verlo. */
  function aplicar() {
    var p = pantalla();
    if (!p) return false;
    var bloqueado = bloquea();
    if (bloqueado) {
      var msg = document.getElementById('maintenanceMessage');
      if (msg) msg.textContent = estado.mensaje;
      p.style.display = 'flex';
      if (document.documentElement) document.documentElement.classList.add('is-maintenance');
    } else {
      p.style.display = 'none';
      if (document.documentElement) document.documentElement.classList.remove('is-maintenance');
    }
    return bloqueado;
  }

  function guardar(bruto) {
    var nuevo = normalizar(bruto);
    estado = {
      activo: nuevo.activo,
      mensaje: nuevo.mensaje,
      cargado: true
    };
    aplicar();
    return estado;
  }

  /* Lectura inicial. Si la escucha en vivo falla (permisos o red), esta
     lectura deja el estado en su valor por defecto: sin mantenimiento. */
  function cargar() {
    if (!V.db) return Promise.resolve(estado);
    return V.db.collection(CONFIG_COLLECTION).doc(PORTAL_DOC).get()
      .then(function (doc) {
        var data = (doc && doc.exists) ? (doc.data() || {}) : {};
        return guardar(data.mantenimiento);
      })
      .catch(function (e) {
        console.warn('[mantenimiento] no se pudo leer el estado:', e && e.message);
        return estado;
      });
  }

  /* Seguimiento en vivo: el interruptor del panel se nota en las pestañas
     ya abiertas, sin recargar. */
  function suscribir() {
    if (!V.db || unsub) return;
    try {
      unsub = V.db.collection(CONFIG_COLLECTION).doc(PORTAL_DOC).onSnapshot(function (doc) {
        var data = (doc && doc.exists) ? (doc.data() || {}) : {};
        guardar(data.mantenimiento);
      }, function (err) {
        console.warn('[mantenimiento] no se pudo observar config/portal:', err && err.message);
        try { if (unsub) unsub(); } catch (e) { /* ya dado de baja */ }
        unsub = null;
      });
    } catch (e) {
      unsub = null;
    }
  }

  V.mantenimiento = {
    ROLES_CON_ACCESO: ROLES_CON_ACCESO,
    MENSAJE_POR_DEFECTO: MENSAJE_POR_DEFECTO,
    estado: function () { return estado; },
    activo: function () { return estado.activo === true; },
    mensaje: function () { return estado.mensaje; },
    cargado: function () { return estado.cargado === true; },
    tieneAcceso: tieneAcceso,
    bloquea: bloquea,
    normalizar: normalizar,
    cargar: cargar,
    suscribir: suscribir,
    aplicar: aplicar,
    guardar: guardar
  };

  /* El aviso de mantenimiento no puede tapar el formulario de acceso: si lo
     tapara, el superadmin no podría entrar mientras la plataforma está en
     mantenimiento (justo cuando más lo necesita). El botón abre el login
     normal, que se pinta por encima de la capa de mantenimiento. */
  var btnLogin = document.getElementById('maintenanceLogin');
  if (btnLogin) {
    btnLogin.addEventListener('click', function () {
      if (typeof V.openAuth === 'function') V.openAuth('login');
    });
  }
})();
