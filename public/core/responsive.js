/* ════════════════════════════════════════════════════════════════
   VCONV · CAPA GLOBAL DE RESPONSIVE (JS)
   ════════════════════════════════════════════════════════════════
   Complemento de core/responsive.css. Tres trabajos:

     1. Tablas → cada <table> que no tenga ya un contenedor con scroll
        horizontal se mete en uno (.rs-table-scroll). Se hace también
        con las tablas que el código inserta en caliente, porque la
        aplicación es casi toda dinamicidad.

     2. Tablas → se convierten en tarjetas apiladas en móvil (clase
        .rs-cards): cada celda recibe en data-rs-label el texto de su
        columna, que el CSS pinta como etiqueta. Así ninguna tabla
        necesita desplazamiento horizontal en el móvil ni ve sus
        celdas aplastadas.

     3. Menú lateral → en móvil es un cajón: se abre con la
        hamburguesa y se cierra solo al pulsar cualquier opción, con
        Escape o al pasar a escritorio.

   Estilo: ES5 (var, function), sin arrow functions, igual que el
   resto de módulos de producción.
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var MOBILE_MAX = 768;      /* breakpoint móvil de la plataforma  */
  var DESKTOP_MIN = 1024;    /* a partir de aquí el menú es fijo   */
  var WRAP_CLASS = 'rs-table-scroll';
  var CARDS_CLASS = 'rs-cards';
  var KEEP_HEAD_CLASS = 'rs-keep-head';

  var V = window.VCONV = window.VCONV || {};

  /* ── Utilidades ─────────────────────────────────────────── */
  function $(id) { return document.getElementById(id); }

  function esMovil() { return window.innerWidth <= MOBILE_MAX; }

  function tieneScrollX(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.classList && el.classList.contains(WRAP_CLASS)) return true;
    var ov;
    try { ov = window.getComputedStyle(el).overflowX; } catch (e) { return false; }
    return ov === 'auto' || ov === 'scroll';
  }

  /* ── 1. Tablas con scroll horizontal ────────────────────── */
  function envolverTabla(tabla) {
    if (!tabla || tabla.nodeType !== 1 || tabla.tagName !== 'TABLE') return;
    var padre = tabla.parentNode;
    if (!padre || padre.nodeType !== 1) return;
    if (padre.classList && padre.classList.contains(WRAP_CLASS)) return;
    /* ¿Ya vive dentro de un contenedor con scroll horizontal? */
    var p = padre;
    while (p && p.nodeType === 1 && p !== document.body) {
      if (tieneScrollX(p)) return;
      p = p.parentNode;
    }
    var wrap = document.createElement('div');
    wrap.className = WRAP_CLASS;
    padre.insertBefore(wrap, tabla);
    wrap.appendChild(tabla);
  }

  /* ── 2. Tablas → tarjetas apiladas ─────────────────────── */
  /* El contenido de una lección es TEXTO para leer, no una rejilla de
     datos: sus tablas no se convierten en tarjetas (cada celda con su
     etiqueta quedaría como una lista interminable) y conservan su
     desplazamiento propio. */
  function estaEnContenidoDeLeccion(tabla) {
    var p = tabla.parentNode;
    while (p && p.nodeType === 1) {
      if (p.classList && (p.classList.contains('lesson-content') || p.classList.contains('reader-content'))) return true;
      p = p.parentNode;
    }
    return false;
  }

  function esAptaParaTarjetas(tabla) {
    if (!tabla || tabla.nodeType !== 1) return false;
    if (tabla.getAttribute('data-rs-tarjetas') === 'no') return false;
    if (estaEnContenidoDeLeccion(tabla)) return false;
    var thead = tabla.querySelector('thead');
    if (!thead) return false;
    var ths = thead.querySelectorAll('th');
    /* Con menos de dos columnas no hay etiquetas que poner: se deja
       como tabla con desplazamiento. */
    if (ths.length < 2) return false;
    return true;
  }

  function marcarEtiquetas(tabla) {
    var ths = tabla.querySelectorAll('thead th');
    var etiquetas = [];
    var i;
    for (i = 0; i < ths.length; i++) etiquetas.push((ths[i].textContent || '').trim());
    var filas = tabla.querySelectorAll('tbody tr');
    for (i = 0; i < filas.length; i++) {
      var celdas = filas[i].children;
      for (var c = 0; c < celdas.length; c++) {
        var celda = celdas[c];
        if (!celda || celda.tagName !== 'TD') continue;
        var colspan = celda.getAttribute('colspan');
        if (colspan && Number(colspan) > 1) { celda.setAttribute('data-rs-label', ''); continue; }
        celda.setAttribute('data-rs-label', etiquetas[c] || '');
      }
    }
  }

  function prepararTabla(tabla) {
    if (!tabla || tabla.nodeType !== 1 || tabla.tagName !== 'TABLE') return;
    if (!tabla.classList.contains(CARDS_CLASS)) {
      if (!esAptaParaTarjetas(tabla)) return;
      tabla.classList.add(CARDS_CLASS);
      /* Si la cabecera lleva una casilla ("seleccionar todo"), esa
         celda se conserva visible en el móvil: sin ella la selección
         múltiple se pierde (el CSS oculta el resto de la cabecera). */
      if (tabla.querySelector('thead input')) tabla.classList.add(KEEP_HEAD_CLASS);
    }
    marcarEtiquetas(tabla);
  }

  function procesarTabla(tabla) {
    envolverTabla(tabla);
    prepararTabla(tabla);
  }

  function tablaRelevante(nodo) {
    if (!nodo || nodo.nodeType !== 1) return null;
    if (nodo.tagName === 'TABLE') return nodo;
    if (typeof nodo.querySelector === 'function') {
      var t = nodo.querySelector('table');
      if (t) return t;
    }
    var padre = nodo.parentNode;
    if (padre && padre.nodeType === 1 && padre.tagName === 'TABLE') return padre;
    return null;
  }

  var pendiente = false;
  function programar() {
    if (pendiente) return;
    pendiente = true;
    var ejecutar = function () {
      pendiente = false;
      var tablas = document.querySelectorAll('table');
      for (var i = 0; i < tablas.length; i++) procesarTabla(tablas[i]);
    };
    if (window.requestAnimationFrame) window.requestAnimationFrame(ejecutar);
    else window.setTimeout(ejecutar, 0);
  }

  /* ── 3. Menú lateral ─────────────────────────────────────── */
  function cerrarMenu() {
    if (typeof V.closeSidebar === 'function') { V.closeSidebar(); return; }
    var sb = $('appSidebar');
    if (sb) {
      sb.classList.remove('show');
      sb.classList.remove('open');
      sb.setAttribute('aria-hidden', window.innerWidth >= DESKTOP_MIN ? 'false' : 'true');
    }
    var ov = $('sidebarOverlay');
    if (ov) ov.classList.remove('show');
    document.body.classList.remove('sidebar-open');
    var burger = $('appBurger');
    if (burger) burger.setAttribute('aria-expanded', 'false');
  }

  function menuAbierto() {
    var sb = $('appSidebar');
    if (!sb) return false;
    return sb.classList.contains('show') || sb.classList.contains('open');
  }

  /* Al pulsar cualquier enlace del menú el cajón se recoge: en móvil se
     quiere ver la vista a la que se acaba de ir.

     OJO: solo cuentan los clics DENTRO del cajón. La ☰ vive en la barra
     superior, FUERA del menú, y su propio manejador abre el cajón; si
     este escuchador también lo cerrara, el mismo toque que abría el
     menú lo cerraría detrás y el usuario vería que "la ☰ no hace
     nada" en el móvil (quedándose sin acceso a los módulos de
     administración ni al botón "Salir"). Por eso se comprueba que el
     destino del clic esté dentro del propio cajón. */
  function alPulsarEnMenu(e) {
    if (window.innerWidth >= DESKTOP_MIN) return;
    var sb = $('appSidebar');
    if (!sb) return;
    if (!menuAbierto()) return;
    var n = e.target;
    if (!n || !sb.contains(n)) return;
    while (n && n !== sb) {
      if (n.tagName === 'A') { cerrarMenu(); return; }
      n = n.parentNode;
    }
  }

  function sincronizarSidebar() {
    var sb = $('appSidebar');
    if (!sb) return;
    if (window.innerWidth >= DESKTOP_MIN) sb.setAttribute('aria-hidden', 'false');
    else if (!menuAbierto()) sb.setAttribute('aria-hidden', 'true');
  }

  /* ── Arranque ────────────────────────────────────────────── */
  function iniciar() {
    var html = document.documentElement;
    if (html && html.classList) {
      if (esMovil()) html.classList.add('rs-movil');
      else html.classList.remove('rs-movil');
    }

    /* Tablas que ya están en el documento */
    programar();

    /* Tablas que se añaden después (casi toda la aplicación) */
    if (window.MutationObserver) {
      var observador = new window.MutationObserver(function (mutaciones) {
        for (var i = 0; i < mutaciones.length; i++) {
          var anadidos = mutaciones[i].addedNodes;
          for (var j = 0; j < anadidos.length; j++) {
            if (tablaRelevante(anadidos[j])) { programar(); return; }
          }
        }
      });
      observador.observe(document.body, { childList: true, subtree: true });
    }

    document.addEventListener('click', alPulsarEnMenu, false);

    document.addEventListener('keydown', function (e) {
      var esEscape = e.key === 'Escape' || e.keyCode === 27;
      if (!esEscape) return;
      if (menuAbierto()) cerrarMenu();
    }, false);

    var anchoAnterior = window.innerWidth;
    window.addEventListener('resize', function () {
      var ancho = window.innerWidth;
      if (ancho === anchoAnterior) return;
      anchoAnterior = ancho;
      if (html && html.classList) {
        if (ancho <= MOBILE_MAX) html.classList.add('rs-movil');
        else html.classList.remove('rs-movil');
      }
      if (ancho >= DESKTOP_MIN && menuAbierto()) cerrarMenu();
      sincronizarSidebar();
    }, false);

    sincronizarSidebar();
  }

  /* API mínima por si algún módulo quiere usarla */
  V.responsive = {
    envolverTablas: programar,
    cerrarMenu: cerrarMenu,
    esMovil: esMovil
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciar, false);
  } else {
    iniciar();
  }
})();
