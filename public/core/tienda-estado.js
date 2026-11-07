(function () {
  'use strict';

  var V = window.VCONV;
  if (!V) { console.error('VCONV core not loaded'); return; }

  var CONFIG_COLLECTION = 'config';
  var PORTAL_DOC = 'portal';

  var estado = { activa: true, cargado: false };
  var unsub = null;

  function normalizar(bruto) {
    var t = (bruto && typeof bruto === 'object' && !Array.isArray(bruto)) ? bruto : {};
    return { activa: t.activa !== false };
  }

  function lista(selector) {
    return document.querySelectorAll(selector);
  }

  function aplicar() {
    var activa = estado.activa === true;

    if (document.documentElement) {
      document.documentElement.classList.toggle('tienda-off', !activa);
    }

    Array.prototype.forEach.call(lista('.sidebar-link[data-nav="tienda"]'), function (n) {
      n.style.display = activa ? '' : 'none';
    });

    Array.prototype.forEach.call(lista('a[href="#portalTienda"]'), function (n) {
      n.style.display = activa ? '' : 'none';
    });

    var seccion = document.getElementById('portalTienda');
    if (seccion) seccion.style.display = activa ? '' : 'none';

    if (!activa) {
      var vista = document.querySelector('#appRoot .view.active');
      if (vista && vista.id === 'viewTienda' && typeof V.goDashboard === 'function') {
        V.goDashboard();
      }
    }
  }

  function guardar(bruto) {
    var n = normalizar(bruto);
    estado = { activa: n.activa, cargado: true };
    aplicar();
    return estado;
  }

  function cargar() {
    if (!V.db) return Promise.resolve(estado);
    return V.db.collection(CONFIG_COLLECTION).doc(PORTAL_DOC).get()
      .then(function (doc) {
        var data = (doc && doc.exists) ? (doc.data() || {}) : {};
        return guardar(data.tienda);
      })
      .catch(function (e) {
        console.warn('[tienda-estado] no se pudo leer el estado:', e && e.message);
        return estado;
      });
  }

  function suscribir() {
    if (!V.db || unsub) return;
    try {
      unsub = V.db.collection(CONFIG_COLLECTION).doc(PORTAL_DOC).onSnapshot(function (doc) {
        var data = (doc && doc.exists) ? (doc.data() || {}) : {};
        guardar(data.tienda);
      }, function (err) {
        console.warn('[tienda-estado] no se pudo observar config/portal:', err && err.message);
        try { if (unsub) unsub(); } catch (e) { /* ya dada de baja */ }
        unsub = null;
      });
    } catch (e) {
      unsub = null;
    }
  }

  V.tiendaEstado = {
    CONFIG_COLLECTION: CONFIG_COLLECTION,
    PORTAL_DOC: PORTAL_DOC,
    estado: function () { return estado; },
    activa: function () { return estado.activa === true; },
    cargado: function () { return estado.cargado === true; },
    normalizar: normalizar,
    cargar: cargar,
    suscribir: suscribir,
    aplicar: aplicar,
    guardar: guardar
  };

  aplicar();
})();
