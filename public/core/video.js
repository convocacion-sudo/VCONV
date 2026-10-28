/* ════════════════════════════════════════════════════════════════
   VCONV · Vídeo (independiente, selector manual de plataforma)

   El usuario elige SIEMPRE la plataforma en el desplegable; el código
   no la adivina a partir de la URL. La plataforma elegida solo decide
   cómo convertir el enlace/embed pegado en una URL reproducible.

   No comparte código ni estados con core/images.js.
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var V = window.VCONV;
  if (!V) { console.error('VCONV core not loaded'); return; }

  var PLATAFORMAS = [
    {
      id: 'youtube',
      label: 'YouTube',
      placeholder: 'https://www.youtube.com/watch?v=…',
      ayuda: 'Pega el enlace del vídeo (watch, youtu.be o Shorts) o su código embed.'
    },
    {
      id: 'vimeo',
      label: 'Vimeo',
      placeholder: 'https://vimeo.com/…',
      ayuda: 'Pega la URL del vídeo o el iframe del reproductor de Vimeo.'
    },
    {
      id: 'facebook',
      label: 'Facebook',
      placeholder: 'https://www.facebook.com/watch/?v=…',
      ayuda: 'Pega la URL pública del vídeo o su iframe; se usará el reproductor de Facebook.'
    },
    {
      id: 'instagram',
      label: 'Instagram',
      placeholder: 'https://www.instagram.com/reel/…',
      ayuda: 'Pega la URL del post, reel o IGTV, o su código embed.'
    },
    {
      id: 'drive',
      label: 'Google Drive',
      placeholder: 'https://drive.google.com/file/d/…/view',
      ayuda: 'Pega el enlace para compartir del archivo o el iframe de vista previa.'
    },
    {
      id: 'dailymotion',
      label: 'Dailymotion',
      placeholder: 'https://www.dailymotion.com/video/…',
      ayuda: 'Pega la URL del vídeo o el iframe de Dailymotion.'
    },
    {
      id: 'mp4',
      label: 'MP4 directo',
      placeholder: 'https://…/video.mp4',
      ayuda: 'Pega la URL directa al archivo (MP4, WebM u OGV). No uses una página que lo contenga.'
    },
    {
      id: 'embed',
      label: 'Embed / otro reproductor',
      placeholder: 'https://…  o  <iframe src="…"></iframe>',
      ayuda: 'Pega la URL de un reproductor o el código <iframe> completo.'
    }
  ];

  var PORID = {};
  PLATAFORMAS.forEach(function (p) { PORID[p.id] = p; });

  function urlSegura(raw) {
    if (typeof raw !== 'string') return '';
    var url = raw.trim();
    if (!url || /\s/.test(url)) return '';
    if (/^https?:\/\//i.test(url)) return url;
    if (/^\/(?!\/)/.test(url)) return url;
    if (/^[\w.-]+\.[a-z]{2,}(?:[/?#]|$)/i.test(url)) return 'https://' + url;
    return '';
  }

  /* Del embed solo interesa su src: nunca se guarda ni se inyecta el
     marcado HTML que pegue el usuario. */
  function extraerSrc(raw) {
    if (typeof raw !== 'string') return '';
    var texto = raw.trim();
    if (!texto) return '';
    if (/<iframe/i.test(texto)) {
      var m = texto.match(/<iframe[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
      if (!m) return '';
      texto = m[1].replace(/&amp;/gi, '&');
    }
    return urlSegura(texto);
  }

  function youtubeEmbed(url) {
    var m = url.match(/(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/|live\/|v\/))([A-Za-z0-9_-]{11})/);
    if (m) return 'https://www.youtube-nocookie.com/embed/' + m[1];
    if (/youtube(?:-nocookie)?\.com\/embed\/videoseries/i.test(url)) return url;
    return '';
  }

  function vimeoEmbed(url) {
    var m = url.match(/vimeo\.com\/(?:video\/|channels\/[^\/?#]+\/|groups\/[^\/?#]+\/videos\/)?(\d+)/);
    if (!m) return '';
    var h = url.match(/[?&]h=([A-Za-z0-9]+)/);
    return 'https://player.vimeo.com/video/' + m[1] + (h ? '?h=' + h[1] : '');
  }

  function facebookEmbed(url) {
    if (!/^https?:\/\/(?:[^/]+\.)?(?:facebook\.com|fb\.watch)\//i.test(url)) return '';
    if (/facebook\.com\/plugins\/video\.php/i.test(url)) return url;
    return 'https://www.facebook.com/plugins/video.php?href=' + encodeURIComponent(url) + '&show_text=false';
  }

  function instagramEmbed(url) {
    var m = url.match(/instagram\.com\/(p|reel|tv)\/([A-Za-z0-9_-]+)/);
    if (!m) return '';
    return 'https://www.instagram.com/' + m[1] + '/' + m[2] + '/embed';
  }

  function driveEmbed(url) {
    if (/drive\.google\.com\/file\/d\/[^/]+\/preview/i.test(url)) return url;
    var m = url.match(/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]{10,})/)
      || url.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
    if (!m) return '';
    return 'https://drive.google.com/file/d/' + m[1] + '/preview';
  }

  function dailymotionEmbed(url) {
    var m = url.match(/dailymotion\.com\/(?:video|embed\/video)\/([A-Za-z0-9]+)/i)
      || url.match(/dai\.ly\/([A-Za-z0-9]+)/i);
    if (!m) return '';
    return 'https://www.dailymotion.com/embed/video/' + m[1];
  }

  function normalizarPlataforma(raw) {
    var id = String(raw || '').trim().toLowerCase();
    return PORID[id] ? id : '';
  }

  function plataformaDe(raw) {
    return PORID[normalizarPlataforma(raw)] || null;
  }

  function plataformas() {
    return PLATAFORMAS.map(function (p) {
      return { id: p.id, label: p.label, placeholder: p.placeholder, ayuda: p.ayuda };
    });
  }

  function etiqueta(raw) {
    var p = plataformaDe(raw);
    return p ? p.label : '';
  }

  /* No hay autodetección: la plataforma es obligatoria. */
  function normalizar(plataforma, raw) {
    var id = normalizarPlataforma(plataforma);
    if (!id) return '';

    if (id === 'mp4') return urlSegura(raw);

    var url = extraerSrc(raw);
    if (!url) return '';

    switch (id) {
      case 'youtube': return youtubeEmbed(url);
      case 'vimeo': return vimeoEmbed(url);
      case 'facebook': return facebookEmbed(url);
      case 'instagram': return instagramEmbed(url);
      case 'drive': return driveEmbed(url);
      case 'dailymotion': return dailymotionEmbed(url);
      case 'embed': return url;
      default: return '';
    }
  }

  function montar(contenedor, plataforma, raw, opts) {
    if (!contenedor) return null;
    opts = opts || {};
    var id = normalizarPlataforma(plataforma);
    var src = normalizar(id, raw);
    contenedor.innerHTML = '';

    if (!id || !src) {
      var aviso = document.createElement('p');
      aviso.className = 'field-hint is-warn';
      aviso.textContent = !id
        ? 'Selecciona una plataforma de vídeo.'
        : 'Enlace no válido para ' + etiqueta(id) + '.';
      contenedor.appendChild(aviso);
      return null;
    }

    if (id === 'mp4') {
      var video = document.createElement('video');
      video.className = opts.clase || '';
      video.src = src;
      video.controls = true;
      video.preload = 'metadata';
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      video.setAttribute('controlsList', 'nodownload noremoteplayback');
      if (opts.alt) video.setAttribute('aria-label', opts.alt);
      video.addEventListener('error', function () {
        contenedor.innerHTML = '';
        var error = document.createElement('p');
        error.className = 'field-hint is-warn';
        error.textContent = '⚠ No se pudo cargar el vídeo.';
        contenedor.appendChild(error);
      });
      contenedor.appendChild(video);
      return video;
    }

    var frame = document.createElement('iframe');
    frame.className = opts.clase || '';
    frame.src = src;
    frame.title = opts.alt || 'Vídeo';
    frame.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen');
    frame.setAttribute('allowfullscreen', '');
    frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    frame.setAttribute('loading', 'lazy');
    contenedor.appendChild(frame);
    return frame;
  }

  V.video = {
    PLATAFORMAS: PLATAFORMAS,
    plataformas: plataformas,
    normalizarPlataforma: normalizarPlataforma,
    plataformaDe: plataformaDe,
    etiqueta: etiqueta,
    urlSegura: urlSegura,
    extraerSrc: extraerSrc,
    normalizar: normalizar,
    montar: montar
  };
})();
