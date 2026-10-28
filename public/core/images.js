/* ════════════════════════════════════════════════════════════════
   VCONV · Imágenes (compartido)
   Fuente única para lo que la aplicación hace con una imagen:

     · validar la URL (solo http/https o ruta absoluta del sitio:
       un javascript: acabaría siendo el src de una <img>);
     · montarla en cualquier contenedor con el mismo tratamiento
       (carga diferida, texto alternativo y aviso si no carga).

   Lo usan el editor de fichas y la portada, de modo que la vista
   previa y la tarjeta publicada no pueden divergir.
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var V = window.VCONV;
  if (!V) { console.error('VCONV core not loaded'); return; }

  /* Devuelve una URL segura para un <img> o '' si no lo es.
     Se aceptan enlaces absolutos http(s), rutas absolutas del sitio
     (/imagen.jpg) y dominios pegados sin esquema, que se normalizan a
     https. Cualquier otro esquema (javascript:, data:, blob:) se
     descarta en origen. */
  function urlSegura(raw) {
    if (typeof raw !== 'string') return '';
    var url = raw.trim();
    if (!url || /\s/.test(url)) return '';
    if (/^https?:\/\//i.test(url)) return url;
    if (/^\/(?!\/)/.test(url)) return url;
    if (/^[\w.-]+\.[a-z]{2,}(?:[/?#]|$)/i.test(url)) return 'https://' + url;
    return '';
  }

  function montar(contenedor, raw, opts) {
    if (!contenedor) return null;
    opts = opts || {};
    var url = urlSegura(raw);
    contenedor.innerHTML = '';
    if (!url) {
      var aviso = document.createElement('p');
      aviso.className = 'field-hint is-warn';
      aviso.textContent = opts.vacio || 'Sin imagen.';
      contenedor.appendChild(aviso);
      return null;
    }
    var img = document.createElement('img');
    img.className = opts.clase || '';
    img.src = url;
    img.alt = opts.alt || '';
    img.loading = opts.loading || 'lazy';
    img.decoding = 'async';
    img.addEventListener('error', function () {
      contenedor.innerHTML = '';
      var error = document.createElement('p');
      error.className = 'field-hint is-warn';
      error.textContent = '⚠ No se pudo cargar la imagen.';
      contenedor.appendChild(error);
    });
    contenedor.appendChild(img);
    return img;
  }

  V.imagenes = {
    urlSegura: urlSegura,
    montar: montar
  };
})();
