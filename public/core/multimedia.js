/* ════════════════════════════════════════════════════════════════
   VCONV · Multimedia (compartido)
   Fuente única de todo lo que tiene que ver con medios:

     · la validación de URLs (solo http/https: un javascript: acabaría
       siendo el src de una imagen o el href de un enlace);
     · la clasificación de un VIDEO (YouTube, Google Drive, Vimeo,
       archivo directo o reproductor externo) y la URL de incrustación
       de cada caso;
     · el montaje del medio (imagen o vídeo) en cualquier pantalla.

   Este módulo nació al extraer la lógica que ya tenía la portada
   (modules/portal/portal.js) y el módulo de Tiendas, que tenían cada
   uno su propia copia. Ahora hay UNA: la portada la consume, la consume
   el panel de Configuración para el selector de medios y la consumirá
   cualquier módulo nuevo que necesite asociar una imagen o un vídeo.
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var V = window.VCONV;
  if (!V) { console.error('VCONV core not loaded'); return; }

  // Extensiones que se entregan directamente como archivo de vídeo. Aunque
  // .mkv/.avi/.flv no las reproduce cualquier navegador, se tratan como
  // archivo (no como página) para que el <video> muestre su error con el
  // enlace de "abrir en otra pestaña" en lugar de un iframe en blanco.
  var VIDEO_EXT_RE = /\.(mp4|webm|ogv|ogg|m4v|mov|mkv|avi|flv|wmv|m3u8)(?:$|[?#])/i;
  var IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|avif|bmp|svg)(?:$|[?#])/i;

  // Etiquetas legibles de cada fuente, reutilizadas por el reproductor y por
  // el aviso de "fuente detectada" del panel de administración.
  var SOURCE_LABELS = {
    youtube: '🎬 YouTube',
    drive: '📁 Google Drive',
    vimeo: '🎥 Vimeo',
    directo: '🎬 Archivo de video directo',
    externo: '🔗 Reproductor externo'
  };

  /* Tipos de fuente de vídeo que se pueden elegir a mano en el selector. */
  var TIPOS_VIDEO = [
    ['auto', 'Detectar automáticamente'],
    ['youtube', 'YouTube'],
    ['drive', 'Google Drive'],
    ['vimeo', 'Vimeo'],
    ['directo', 'Archivo de video directo (.mp4, .webm…)'],
    ['externo', 'Otra web (reproductor incrustado)']
  ];

  function texto(v) { return v === undefined || v === null ? '' : String(v); }

  /* Recorta espacios/caracteres de control que se cuelan al copiar y
     valida que sea http(s): cualquier otro esquema (javascript:, data:)
     se descarta en origen para no acabar en un atributo src. */
  function cleanUrl(raw) {
    if (typeof raw !== 'string') return '';
    var url = raw.trim();
    if (!url) return '';
    if (!/^https?:\/\//i.test(url)) {
      // Tolerancia operativa: un enlace pegado sin esquema se normaliza a
      // https en vez de rechazarse, que es el error más común al copiar.
      if (/^[\w.-]+\.[a-z]{2,}\//i.test(url)) url = 'https://' + url;
      else return '';
    }
    return url;
  }

  function youtubeIdFrom(url) {
    var m = url.match(/(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|live\/|v\/))([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
  }

  function vimeoIdFrom(url) {
    var m = url.match(/vimeo\.com\/(?:video\/|channels\/[^\/?#]+\/|groups\/[^\/?#]+\/videos\/)?(\d+)/);
    return m ? m[1] : null;
  }

  function driveIdFrom(url) {
    var m = url.match(/(?:drive|docs)\.google\.com\/file\/d\/([A-Za-z0-9_-]{10,})/)
      || url.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
    return m ? m[1] : null;
  }

  // Monta la fuente ya clasificada. Todas las ramas terminan aquí para que el
  // destino de cada proveedor quede en un único sitio (y sea auditable: un
  // enlace de página nunca acaba siendo el src de un iframe).
  function buildSource(kind, id, original) {
    if (kind === 'youtube') {
      return { kind: 'youtube', src: 'https://www.youtube-nocookie.com/embed/' + id, original: original, label: SOURCE_LABELS.youtube };
    }
    if (kind === 'drive') {
      // /preview es la única forma de incrustar un archivo de Drive: /view y
      // /uc solo sirven para descargar o abrir la página de detalles.
      return { kind: 'drive', src: 'https://drive.google.com/file/d/' + id + '/preview', original: original, label: SOURCE_LABELS.drive };
    }
    if (kind === 'vimeo') {
      return { kind: 'vimeo', src: 'https://player.vimeo.com/video/' + id, original: original, label: SOURCE_LABELS.vimeo };
    }
    if (kind === 'directo') {
      return { kind: 'directo', src: id, original: original, label: SOURCE_LABELS.directo };
    }
    return { kind: 'externo', src: id, original: original, label: SOURCE_LABELS.externo };
  }

  // Identificador suelto, sin URL: solo tiene sentido con el tipo marcado a mano
  // (copiar el ID de YouTube/Vimeo/Drive de la barra del navegador es el error
  // más común). En 'auto' un ID suelto NO se adivina: sería indistinguible de
  // un texto cualquiera.
  function idSuelto(raw, tipo) {
    if (tipo === 'youtube') return /^[A-Za-z0-9_-]{11}$/.test(raw) ? raw : null;
    if (tipo === 'vimeo') return /^\d{4,}$/.test(raw) ? raw : null;
    if (tipo === 'drive') return /^[A-Za-z0-9_-]{10,}$/.test(raw) ? raw : null;
    return null;
  }

  /* Traduce la URL guardada a una fuente reproducible.
     `tipoForzado` permite saltarse la detección ('auto' por defecto) para
     enlaces que no se pueden clasificar solos. Devuelve null si la URL está
     vacía, no es válida o no encaja en el tipo elegido. */
  function detectarVideo(rawUrl, tipoForzado) {
    var tipo = (tipoForzado || 'auto').toLowerCase();
    var raw = typeof rawUrl === 'string' ? rawUrl.trim() : '';
    if (!raw) return null;

    // Identificador suelto: solo se acepta con tipo explícito. La URL de
    // apertura pasa a ser el propio embed, porque no hay página de origen.
    var suelto = idSuelto(raw, tipo);
    if (suelto) {
      var s = buildSource(tipo, suelto, raw);
      s.original = s.src;
      return s;
    }

    var url = cleanUrl(raw);
    if (!url) return null;

    // Tipo elegido a mano: se respeta y se exige que el enlace encaje. Si no,
    // se rechaza (null) en lugar de montar un reproductor que no va a
    // funcionar y dejar un recuadro negro en la portada.
    if (tipo === 'youtube') {
      var ytId = youtubeIdFrom(url);
      return ytId ? buildSource('youtube', ytId, url) : null;
    }
    if (tipo === 'vimeo') {
      var vimeoId = vimeoIdFrom(url);
      return vimeoId ? buildSource('vimeo', vimeoId, url) : null;
    }
    if (tipo === 'drive') {
      var driveId = driveIdFrom(url);
      return driveId ? buildSource('drive', driveId, url) : null;
    }
    if (tipo === 'directo') return buildSource('directo', url, url);
    if (tipo === 'externo') return buildSource('externo', url, url);

    // Detección automática: primero los proveedores que exigen reescribir la
    // URL a su forma de embed, después el archivo directo y, por último,
    // cualquier otra web como reproductor genérico.
    var a = youtubeIdFrom(url);
    if (a) return buildSource('youtube', a, url);
    var b = driveIdFrom(url);
    if (b) return buildSource('drive', b, url);
    var c = vimeoIdFrom(url);
    if (c) return buildSource('vimeo', c, url);
    if (VIDEO_EXT_RE.test(url)) return buildSource('directo', url, url);

    return buildSource('externo', url, url);
  }

  function esVideoUrl(raw) {
    var url = cleanUrl(raw);
    if (!url) return false;
    return !!detectarVideo(url);
  }

  function esImagenUrl(raw) {
    var url = cleanUrl(raw);
    if (!url) return false;
    if (IMAGE_EXT_RE.test(url)) return true;
    // Una URL sin extensión reconocible se admite como imagen si el gestor
    // de medios la sirve con una extensión de imagen en la ruta.
    return false;
  }

  /* Normaliza el medio que se guarda en Firestore.
     { tipo: 'imagen'|'video'|'ninguna', url: '', fuente: 'auto'|… } */
  function normalizarMedio(medio) {
    var m = medio || {};
    var tipo = m.tipo === 'imagen' || m.tipo === 'video' ? m.tipo : 'ninguna';
    var url = cleanUrl(m.url);
    if (!url) return { tipo: 'ninguna', url: '', fuente: 'auto' };
    return { tipo: tipo, url: url, fuente: m.fuente || 'auto' };
  }

  /* Monta el medio en un contenedor. Devuelve el elemento creado (o null si
     no hay medio válido). Es el mismo montaje en la portada, en la vista
     previa del panel y en las fichas: así lo que ve el administrador es
     exactamente lo que verá el visitante. */
  function montarMedio(contenedor, medio, opts) {
    if (!contenedor) return null;
    opts = opts || {};
    var m = normalizarMedio(medio);
    contenedor.innerHTML = '';
    if (m.tipo === 'ninguna' || !m.url) return null;

    if (m.tipo === 'imagen') {
      var img = document.createElement('img');
      img.className = opts.clase || 'set-media-img';
      img.src = m.url;
      img.alt = opts.alt || '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.addEventListener('error', function () {
        contenedor.innerHTML = '';
        var aviso = document.createElement('p');
        aviso.className = 'field-hint is-warn';
        aviso.textContent = '⚠ No se pudo cargar la imagen.';
        contenedor.appendChild(aviso);
      });
      contenedor.appendChild(img);
      return img;
    }

    var fuente = detectarVideo(m.url, m.fuente);
    if (!fuente) {
      var p = document.createElement('p');
      p.className = 'field-hint is-warn';
      p.textContent = '⚠ La URL del vídeo no es válida para el tipo elegido.';
      contenedor.appendChild(p);
      return null;
    }
    if (fuente.kind === 'directo') {
      var v = document.createElement('video');
      v.className = opts.clase || 'set-media-video';
      v.controls = true;
      v.controlsList = 'nodownload noremoteplayback';
      v.preload = 'metadata';
      v.playsInline = true;
      v.setAttribute('playsinline', '');
      v.src = fuente.src;
      contenedor.appendChild(v);
      return v;
    }
    var f = document.createElement('iframe');
    f.className = opts.clase || 'set-media-video';
    f.src = fuente.src;
    f.title = opts.alt || 'Vídeo';
    f.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen');
    f.setAttribute('allowfullscreen', '');
    f.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    f.setAttribute('loading', 'lazy');
    contenedor.appendChild(f);
    return f;
  }

  V.multimedia = {
    VIDEO_EXT_RE: VIDEO_EXT_RE,
    IMAGE_EXT_RE: IMAGE_EXT_RE,
    SOURCE_LABELS: SOURCE_LABELS,
    TIPOS_VIDEO: TIPOS_VIDEO,
    cleanUrl: cleanUrl,
    urlSegura: cleanUrl,
    youtubeIdFrom: youtubeIdFrom,
    vimeoIdFrom: vimeoIdFrom,
    driveIdFrom: driveIdFrom,
    buildSource: buildSource,
    idSuelto: idSuelto,
    detectarVideo: detectarVideo,
    esVideoUrl: esVideoUrl,
    esImagenUrl: esImagenUrl,
    normalizarMedio: normalizarMedio,
    montarMedio: montarMedio
  };
})();
