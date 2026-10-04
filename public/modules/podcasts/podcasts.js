/* ════════════════════════════════════════════════════════════════
   VCONV · Módulo Podcasts — Colecciones de audio
   ────────────────────────────────────────────────────────────────
   Módulo PÚBLICO (Nivel 1): las listas se leen y los audios se
   reproducen SIN iniciar sesión. Quien llega sin cuenta (V.isAnon)
   ve el mismo catálogo que una cuenta registrada, menos los
   borradores, que solo se muestran a quien gestiona el contenido.

   Todo el contenido vive en Firestore, así que se crea, ordena y
   actualiza sin tocar el código de la aplicación:
     podcast_categorias/{catId}                     → clasificación
     podcast_colecciones/{colId}                    → la colección
     podcast_colecciones/{colId}/episodios/{epId}  → sus audios

   El candado real está en firestore.rules: lectura abierta a
   cualquier identidad y escritura exclusiva de canManage()
   (gestor/superadmin). La comprobación de rol de este archivo solo
   evita el intento y explica el motivo, igual que en el resto de
   módulos del panel.
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var V = window.VCONV;
  if (!V) { console.error('VCONV core not loaded'); return; }

  var COL_CATEGORIAS = V.COL_PODCAST_CATEGORIAS || 'podcast_categorias';
  var COL_COLECCIONES = V.COL_PODCAST_COLECCIONES || 'podcast_colecciones';
  var SUB_EPISODIOS = 'episodios';

  /* ─── ESTADO ────────────────────────────────────────────────
     Las suscripciones viven fuera del DOM: la vista se redibuja en
     cada navegación y una suscripción atada a un nodo se quedaría
     escuchando una pantalla que ya no existe. */
  var categoriasCache = [];
  var coleccionesCache = [];
  var episodiosCache = [];
  var categoriasSub = null;
  var coleccionesSub = null;
  var episodiosSub = null;
  var coleccionActualId = '';
  var episodioEditandoId = '';
  var categoriaFiltro = '';
  var gestionando = false;
  // Enlace directo pendiente (?podcast=…&episodio=…): llega antes que los
  // datos, así que se resuelve cuando la colección ya está cargada.
  var enlacePendiente = null;
  var enlacesResueltos = {};

  function $(id) { return V.$(id); }
  function el(tag, cls, text) { return V.el(tag, cls, text); }

  /* ─── HELPERS ──────────────────────────────────────────────── */
  function esPublicado(d) {
    // Misma toleratedad que esVisiblePublico() en firestore.rules: sin campo
    // cuenta como publicado y solo un false explícito esconde el documento.
    return !d || d.publicado !== false;
  }

  function texto(v) { return typeof v === 'string' ? v.trim() : ''; }

  // Orden estable: `orden` numérico primero y, a igualdad, el título. Todo en
  // cliente a propósito: las consultas de este módulo filtran por un único
  // campo (`publicado`), y ordenar en la consulta exigiría un índice compuesto
  // que además depende de cuántas colecciones se acumulen.
  function porOrden(a, b) {
    var oa = typeof a.orden === 'number' ? a.orden : Number.MAX_SAFE_INTEGER;
    var ob = typeof b.orden === 'number' ? b.orden : Number.MAX_SAFE_INTEGER;
    if (oa !== ob) return oa - ob;
    return texto(a.titulo).localeCompare(texto(b.titulo), 'es');
  }

  function puedeGestionar() {
    return typeof V.canManage === 'function' ? !!V.canManage() : false;
  }

  function normOrden(v) {
    var n = parseInt(v, 10);
    return isFinite(n) ? n : 0;
  }

  /* Solo http(s): el campo lo escribe alguien con el panel en la mano y un
     javascript: ahí acabaría siendo el src de un <audio>. */
  
  function sanitizeEmbed(html){if(typeof html!=="string")return "";var div=document.createElement("div");div.innerHTML=html;var ifr=div.querySelectorAll("iframe");for(var i=ifr.length-1;i>=0;i--){var fr=ifr[i];var src=fr.getAttribute("src")||"";if(!src||/^(javascript|data|vbscript):/i.test(src)){if(fr.parentNode)fr.parentNode.removeChild(fr);continue;}if(!/^https?:\/\//i.test(src)){if(fr.parentNode)fr.parentNode.removeChild(fr);continue;}fr.removeAttribute("onload");fr.removeAttribute("onclick");fr.removeAttribute("onerror");fr.removeAttribute("onmouseover");fr.removeAttribute("onmouseout");fr.removeAttribute("onfocus");fr.removeAttribute("onblur");if(!fr.hasAttribute("sandbox"))fr.setAttribute("sandbox","allow-scripts allow-same-origin allow-popups allow-forms allow-presentation");if(!fr.hasAttribute("referrerpolicy"))fr.setAttribute("referrerpolicy","strict-origin-when-cross-origin");if(!fr.hasAttribute("loading"))fr.setAttribute("loading","lazy");}var sc=div.querySelectorAll("script");for(var j=sc.length-1;j>=0;j--){if(sc[j].parentNode)sc[j].parentNode.removeChild(sc[j]);}return div.innerHTML;}
  function urlSegura(raw) {
    var u = texto(raw);
    if (!u) return '';
    if (/^https?:\/\//i.test(u)) return u;
    if (/^[\w.-]+\.[a-z]{2,}\//i.test(u)) return 'https://' + u;
    return '';
  }

  /* Las categorías se ordenan por `nombre` (no tienen `titulo`); para eso el
     comparador es un parámetro de subscribeUnion(). */
  function porNombre(a, b) {
    var oa = typeof a.orden === 'number' ? a.orden : Number.MAX_SAFE_INTEGER;
    var ob = typeof b.orden === 'number' ? b.orden : Number.MAX_SAFE_INTEGER;
    if (oa !== ob) return oa - ob;
    return texto(a.nombre).localeCompare(texto(b.nombre), 'es');
  }

  function indiceDeColeccion(colId) {
    for (var i = 0; i < coleccionesCache.length; i++) {
      if (coleccionesCache[i].id === colId) return i;
    }
    return -1;
  }

  /* ─── FIRESTORE ────────────────────────────────────────────── */
  /* Consultas de un SOLO campo. `!= false` no sirve: en una consulta descarta
     los documentos sin el campo, que son la mayoría hasta que alguien marque la
     casilla. Se unen las dos mitades —los que lo traen en true y los que no lo
     traen— y, cuando quien mira puede gestionarlo, una tercera con los
     borradores. */
  function consultas(col, conBorradores) {
    var qs = [
      col.where('publicado', '==', true),
      col.where('publicado', '==', null)
    ];
    if (conBorradores) qs.push(col.where('publicado', '==', false));
    return qs;
  }

  /* Suscripción combinada: lleva un mapa por id y re-emite la unión deduplicada
     en cada cambio, que es lo que permite pintar el catálogo sin esperar a que
     terminen las tres consultas.

      Si alguna falla (403 por reglas sin desplegar, red caída) se sueltan todas
      y se avisa con onError para liberar el hueco: al ocupar el hueco,
      suscribirColecciones() ya no volaría nunca más y el módulo se quedaría
      vacío de por vida aunque las reglas se publicaran después o el usuario
      entrara más tarde con su cuenta. showPodcasts() y onModeChange reintentan. */
  function subscribeUnion(col, onDocs, conBorradores, onError, cmp) {
    var map = {};
    var unsubs = [];
    var qs = consultas(col, conBorradores);
    var orden = cmp || porOrden;
    function emit() {
      onDocs(Object.keys(map).map(function (id) { return map[id]; }).sort(orden));
    }
    qs.forEach(function (q) {
      unsubs.push(q.onSnapshot(function (snap) {
        snap.docChanges().forEach(function (ch) {
          if (ch.type === 'removed') delete map[ch.doc.id];
        });
        snap.forEach(function (d) {
          var data = d.data();
          data.id = d.id;
          map[d.id] = data;
        });
        emit();
      }, function (err) {
        console.warn('[podcasts] no se pudo leer ' + col.id + ': ' + (err && err.message));
        unsubs.forEach(function (fn) { try { fn(); } catch (e) {} });
        unsubs = [];
        if (typeof onError === 'function') onError();
      }));
    });
    return function () {
      unsubs.forEach(function (fn) { try { fn(); } catch (e) {} });
      unsubs = [];
    };
  }

  function baja(subscription) {
    if (!subscription) return;
    try { subscription(); } catch (e) { /* ya dada de baja */ }
  }

  function suscribirCategorias() {
    if (!V.db || categoriasSub) return;
    categoriasSub = subscribeUnion(
      V.db.collection(COL_CATEGORIAS),
      function (docs) {
        categoriasCache = docs;
        renderCategorias();
        if (gestionando) renderAdmin();
      },
      puedeGestionar(),
      function () { categoriasSub = null; },
      porNombre
    );
  }

  function suscribirColecciones() {
    if (!V.db || coleccionesSub) return;
    coleccionesSub = subscribeUnion(
      V.db.collection(COL_COLECCIONES),
      function (docs) {
        coleccionesCache = docs;
        resolverEnlacePendiente();
        // Los datos llegan después del show: si el visitante entra al módulo sin
        // colección elegida, aquí se abre la primera. Sin esto la vista abriría
        // con la rejilla y sin episodios, que parece un módulo vacío.
        abrirPrimeraSiHaceFalta();
        renderColecciones();
        renderEpisodios();
        if (gestionando) renderAdmin();
      },
      puedeGestionar(),
      function () { coleccionesSub = null; }
    );
  }

  function suscribirEpisodios(colId) {
    baja(episodiosSub);
    episodiosSub = null;
    episodiosCache = [];
    if (!V.db || !colId) return;
    episodiosSub = subscribeUnion(
      V.db.collection(COL_COLECCIONES).doc(colId).collection(SUB_EPISODIOS),
      function (docs) {
        episodiosCache = docs;
        // El conteo se guarda en la colección para que su tarjeta pueda
        // mostrarlo sin volver a consultar sus episodios.
        var col = coleccionPorId(colId);
        if (col) col._episodios = visibles(docs).length;
        renderColecciones();
        renderEpisodios();
        if (gestionando) renderAdmin();
        resolverEpisodioEnlazado();
      },
      puedeGestionar(),
      function () { episodiosSub = null; }
    );
  }

  // Reconstruye las suscripciones bajo la identidad ACTUAL (login, registro,
  // salida): en un cambio de identidad la suscripción vieja se queda con el
  // alcance anterior, y lo que la app muestra dejaría de ser lo que las reglas
  // permiten.
  function reconstruirSuscripciones() {
    baja(categoriasSub); categoriasSub = null;
    baja(coleccionesSub); coleccionesSub = null;
    baja(episodiosSub); episodiosSub = null;
    if (!V.db) return;
    suscribirCategorias();
    suscribirColecciones();
    if (coleccionActualId) suscribirEpisodios(coleccionActualId);
  }

  function coleccionPorId(id) {
    var i = indiceDeColeccion(id);
    return i === -1 ? null : coleccionesCache[i];
  }

  function categoriaPorId(id) {
    for (var i = 0; i < categoriasCache.length; i++) {
      if (categoriasCache[i].id === id) return categoriasCache[i];
    }
    return null;
  }

  /* Lo que ve el visitante: todo menos los borradores. Quien gestiona los ve
     con su etiqueta para poder distinguirlos de un vistazo. */
  function visibles(lista) {
    if (puedeGestionar()) return lista;
    return lista.filter(esPublicado);
  }

  /* ─── CATÁLOGO ─────────────────────────────────────────────── */
  function renderCategorias() {
    var bar = $('podcastCategoriasBar');
    if (!bar) return;
    bar.innerHTML = '';
    if (!categoriasCache.length) return;

    var todas = el('button', 'podcast-cat' + (categoriaFiltro === '' ? ' active' : ''), 'Todas');
    todas.type = 'button';
    todas.addEventListener('click', function () {
      categoriaFiltro = '';
      renderCategorias();
      renderColecciones();
    });
    bar.appendChild(todas);

    categoriasCache.forEach(function (cat) {
      if (!esPublicado(cat) && !puedeGestionar()) return;
      var b = el('button', 'podcast-cat' + (categoriaFiltro === cat.id ? ' active' : ''), texto(cat.nombre) || 'Sin nombre');
      b.type = 'button';
      b.addEventListener('click', function () {
        categoriaFiltro = (categoriaFiltro === cat.id) ? '' : cat.id;
        renderCategorias();
        renderColecciones();
      });
      bar.appendChild(b);
    });
  }

  function coleccionesVisibles() {
    var lista = visibles(coleccionesCache);
    if (categoriaFiltro) {
      lista = lista.filter(function (c) { return c.categoriaId === categoriaFiltro; });
    }
    return lista;
  }

  function coverFallback() {
    return el('div', 'podcast-cover podcast-cover-fallback', '🎧');
  }

  function renderColecciones() {
    var grid = $('podcastCollections');
    if (!grid) return;
    grid.innerHTML = '';
    var lista = coleccionesVisibles();

    if (!lista.length) {
      grid.appendChild(V.emptyState(
        '🎧',
        'Todavía no hay colecciones',
        puedeGestionar()
          ? 'Crea la primera colección con el botón "Nueva colección" y añádele sus audios.'
          : 'Pronto publicaremos nuevas colecciones de audio. Vuelve pronto.'
      ));
      return;
    }

    lista.forEach(function (col) {
      var card = el('button', 'podcast-card' + (col.id === coleccionActualId ? ' active' : ''));
      card.type = 'button';

      var top = el('div', 'podcast-card-top');
      var portada = urlSegura(col.portada);
      if (portada) {
        var img = document.createElement('img');
        img.className = 'podcast-cover';
        img.alt = '';
        img.loading = 'lazy';
        img.src = portada;
        // Una portada rota no debe dejar una caja vacía ni el texto de alt:
        // se sustituye por el marcador de posición.
        img.addEventListener('error', function () {
          if (img.parentNode) img.parentNode.replaceChild(coverFallback(), img);
        });
        top.appendChild(img);
      } else {
        top.appendChild(coverFallback());
      }
      var head = el('div');
      head.appendChild(el('h3', 'podcast-card-title', texto(col.titulo) || 'Colección sin título'));
      var cat = categoriaPorId(col.categoriaId);
      head.appendChild(el('span', 'podcast-card-cat', cat ? texto(cat.nombre) : 'Sin categoría'));
      top.appendChild(head);
      card.appendChild(top);

      if (texto(col.descripcion)) card.appendChild(el('p', 'podcast-card-desc', texto(col.descripcion)));

      var foot = el('div', 'podcast-card-foot');
      var n = typeof col._episodios === 'number' ? col._episodios : null;
      // El conteo solo se conoce para la colección abierta (es la única que
      // tiene sus episodios cargados); en las demás se anuncia la acción en vez
      // de inventar un número.
      foot.appendChild(el('span', 'podcast-count', n === null
        ? 'Ver episodios →'
        : n + ' episodio' + (n === 1 ? '' : 's')));
      if (puedeGestionar() && !esPublicado(col)) foot.appendChild(el('span', 'status-pill', 'Borrador'));
      card.appendChild(foot);

      card.addEventListener('click', function () { seleccionarColeccion(col.id, true); });
      grid.appendChild(card);
    });
  }

  /* ─── EPISODIOS Y REPRODUCTOR ────────────────────────────────── */
  function renderEpisodios() {
    var head = $('podcastEpisodesHead');
    var list = $('podcastEpisodes');
    if (!head || !list) return;
    var col = coleccionPorId(coleccionActualId);
    list.innerHTML = '';

    if (!col) {
      head.style.display = 'none';
      return;
    }
    head.style.display = '';
    var ttl = $('podcastEpisodesTitle');
    if (ttl) ttl.textContent = texto(col.titulo) || 'Colección';
    var cnt = $('podcastEpisodesCount');
    if (cnt) cnt.textContent = visibles(episodiosCache).length + ' episodio(s)';

    var lista = visibles(episodiosCache);
    if (!lista.length) {
      list.appendChild(V.emptyState(
        '🎙️', 'Sin episodios',
        puedeGestionar()
          ? 'Añade el primer audio a esta colección desde el panel de gestión.'
          : 'Esta colección todavía no tiene audios publicados.'
      ));
      return;
    }

    lista.forEach(function (ep) {
      var row = el('div', 'podcast-episode');
      var play = el('button', 'podcast-play', '▶');
      play.type = 'button';
      play.setAttribute('data-ep', ep.id);
      play.title = 'Reproducir';
      play.setAttribute('aria-label', 'Reproducir: ' + (texto(ep.titulo) || 'episodio'));
      play.addEventListener('click', function () { alternarReproduccion(ep); });
      row.appendChild(play);

      var body = el('div', 'podcast-episode-body');
      body.appendChild(el('h4', 'podcast-episode-title', texto(ep.titulo) || 'Episodio sin título'));
      if (texto(ep.descripcion)) body.appendChild(el('p', 'podcast-episode-desc', texto(ep.descripcion)));
      if (ep.embedCode) {
        var embedWrap = el('div', 'podcast-embed');
        embedWrap.innerHTML = sanitizeEmbed(ep.embedCode);
        body.appendChild(embedWrap);
      }
      var meta = el('div', 'podcast-episode-meta');
      if (texto(ep.duracion)) meta.appendChild(el('span', 'podcast-dur', '⏱ ' + texto(ep.duracion)));
      if (ep.fecha) meta.appendChild(el('span', 'podcast-dur', '📅 ' + V.fmtDate(ep.fecha)));
      if (puedeGestionar() && !esPublicado(ep)) meta.appendChild(el('span', 'status-pill', 'Borrador'));
      body.appendChild(meta);
      row.appendChild(body);

      var url = urlSegura(ep.audioUrl);
      if (url) {
        // Enlace de escape: sirve cuando el navegador no puede con el archivo
        // (un m4a raro, un servidor que no manda CORS para el reproductor).
        var acts = el('div', 'podcast-episode-actions');
        var open = el('a', 'icon-btn', '↗');
        open.href = url;
        open.target = '_blank';
        open.rel = 'noopener noreferrer';
        open.title = 'Abrir el audio en otra pestaña';
        acts.appendChild(open);
        row.appendChild(acts);
      }

      list.appendChild(row);
    });

    sincronizarBotonesReproduccion();
  }

  /* Un solo <audio> para todo el módulo: al pulsar otro episodio se detiene el
     anterior en lugar de que dos audios se solapen en silencio. */
  function player() {
    var audio = $('podcastAudio');
    if (!audio) return null;
    if (!audio._listo) {
      audio._listo = true;
      audio.addEventListener('play', function () { pintarEstadoReproduccion(true); });
      audio.addEventListener('pause', function () { pintarEstadoReproduccion(false); });
      audio.addEventListener('ended', function () { pintarEstadoReproduccion(false); });
      audio.addEventListener('error', function () {
        if (audio.src) V.toast('No se pudo reproducir este audio. Revisa la URL del episodio.', true);
      });
    }
    return audio;
  }

  /* El botón refleja el estado REAL del reproductor: quien pause con los
     controles del navegador también ve el icono de play en la lista. */
  function pintarEstadoReproduccion(playing) {
    var audio = $('podcastAudio');
    var epId = audio && audio._epId;
    if (!epId) return;
    var filas = document.querySelectorAll('#podcastEpisodes .podcast-episode');
    Array.prototype.forEach.call(filas, function (row) {
      var btn = row.querySelector('.podcast-play');
      if (!btn || btn.getAttribute('data-ep') !== epId) return;
      btn.textContent = playing ? '⏸' : '▶';
      btn.title = playing ? 'Pausar' : 'Reproducir';
      row.classList.toggle('playing', playing);
    });
  }

  function sincronizarBotonesReproduccion() {
    var audio = $('podcastAudio');
    if (!audio) return;
    pintarEstadoReproduccion(!!(audio._epId && !audio.paused));
  }

  function alternarReproduccion(ep) {
    var audio = player();
    if (!audio) return;
    var url = urlSegura(ep.audioUrl);
    if (!url) {
      V.toast('Este episodio no tiene una URL de audio válida.', true);
      return;
    }
    var bar = $('podcastPlayer');
    if (bar) bar.classList.remove('is-hidden');
    var info = $('podcastPlayerInfo');
    if (info) info.textContent = texto(ep.titulo) || 'Episodio';

    if (audio._epId === ep.id && audio.src === url) {
      if (audio.paused) audio.play(); else audio.pause();
      return;
    }
    audio.pause();
    audio.src = url;
    audio._epId = ep.id;
    var p = audio.play();
    pintarEstadoReproduccion(true);
    // El navegador puede rechazar la reproducción si no hubo gesto del usuario:
    // se avisa en lugar de dejar un botón que parece no hacer nada.
    if (p && typeof p.catch === 'function') {
      p.catch(function () { pintarEstadoReproduccion(false); });
    }
  }

  /* ─── SELECCIÓN Y ENLACE DIRECTO ────────────────────────────── */
  function seleccionarColeccion(colId, moverUrl) {
    coleccionActualId = colId || '';
    episodioEditandoId = '';
    renderColecciones();
    renderEpisodios();
    if (coleccionActualId) {
      suscribirEpisodios(coleccionActualId);
      escribirUrl({ podcast: coleccionActualId });
      if (moverUrl) {
        var head = $('podcastEpisodesHead');
        if (head) head.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    } else if (moverUrl) {
      escribirUrl(null);
    }
    if (gestionando) renderAdmin();
  }

  function escribirUrl(params) {
    if (!V.deepLink) return;
    try { V.deepLink.escribirUrl(params); } catch (e) { /* la app navega igual */ }
  }

  function resolverEnlacePendiente() {
    if (!enlacePendiente || !coleccionesCache.length) return;
    var col = coleccionPorId(enlacePendiente.col);
    if (!col) return;
    var pendiente = enlacePendiente;
    // Sin episodio en la URL no queda nada por resolver; con él, la referencia
    // se mantiene hasta que sus datos lleguen (resolverEpisodioEnlazado).
    if (!pendiente.ep) enlacePendiente = null;
    seleccionarColeccion(col.id, false);
    if (enlacePendiente.ep) {
      escribirUrl({ podcast: col.id, episodio: enlacePendiente.ep });
    }
  }

  /* El episodio del enlace puede llegar después que su colección: se espera a
     que la lista exista y entonces se reproduce. Sin esto, ?podcast=x&episodio=y
     abriría la colección correcta pero dejaría al oyente busca el audio a mano. */
  function resolverEpisodioEnlazado() {
    if (!enlacePendiente || !enlacePendiente.ep || !episodiosCache.length) return;
    var ep = episodioPorId(enlacePendiente.ep);
    if (!ep) return;
    enlacePendiente = null;
    // El episodio aún no está sonando, así que alternarReproduccion() arranca
    // la reproducción en lugar de pausar.
    alternarReproduccion(ep);
  }

  // Declarado fuera de onReady a propósito: core consulta el enlace pendiente
  // ANTES de inicializar los módulos, así que el manejador tiene que existir
  // desde que se carga el script.
  function abrirDesdeEnlace(params) {
    if (!params || !params.podcast) return;
    var clave = params.podcast + '|' + (params.episodio || '');
    // Un mismo enlace no se abre dos veces: si el visitante navega por la app y
    // vuelve atrás por la URL, no se le reencaja el módulo encima de lo que
    // está viendo.
    if (enlacesResueltos[clave]) return;
    enlacesResueltos[clave] = true;
    enlacePendiente = { col: params.podcast, ep: params.episodio || '' };
    // El enlace es una intención explícita de abrir podcasts: el core solo
    // garantiza que se ve el shell, así que la navegación la pide este módulo.
    if (typeof V.showPodcasts === 'function') V.showPodcasts();
    resolverEnlacePendiente();
    renderColecciones();
  }
  V.registerDeepLink(['podcast', 'episodio'], abrirDesdeEnlace);

  /* ─── ESCRITURA (gestor · superadmin) ───────────────────────── */
  function guardarColeccion(datos, id) {
    if (!puedeGestionar()) {
      V.toast('Tu rol no permite gestionar los podcasts.', true);
      return Promise.resolve(false);
    }
    if (!V.db) { V.toast('Firestore no disponible.', true); return Promise.resolve(false); }
    if (!texto(datos.titulo)) {
      V.toast('El título de la colección es obligatorio.', true);
      return Promise.resolve(false);
    }
    var payload = {
      titulo: texto(datos.titulo),
      descripcion: texto(datos.descripcion),
      portada: urlSegura(datos.portada),
      categoriaId: texto(datos.categoriaId),
      orden: normOrden(datos.orden),
      publicado: !!datos.publicado,
      embedCode: typeof datos.embedCode === 'string' ? datos.embedCode : '',
      actualizado: new Date().toISOString()
    };
    var ref = id
      ? V.db.collection(COL_COLECCIONES).doc(id)
      : V.db.collection(COL_COLECCIONES).doc();
    return ref.get().then(function (doc) {
      payload.creado = (doc.exists && doc.data().creado) || new Date().toISOString();
      return ref.set(payload, { merge: true });
    }).then(function () {
      V.toast(id ? 'Colección actualizada ✓' : 'Colección creada ✓');
      if (!id) seleccionarColeccion(ref.id, true);
      renderAdmin();
      return true;
    }).catch(function (e) {
      V.toast('No se pudo guardar la colección: ' + e.message, true);
      return false;
    });
  }

  function borrarColeccion(col) {
    if (!puedeGestionar() || !V.db) return;
    if (!confirm('¿Eliminar la colección "' + texto(col.titulo) + '" y todos sus episodios? Esta acción no se puede deshacer.')) return;
    var ref = V.db.collection(COL_COLECCIONES).doc(col.id);
    // Los episodios se borran primero y explícitamente: son la subcolección y
    // no caen solos con el documento padre.
    ref.collection(SUB_EPISODIOS).get().then(function (snap) {
      return Promise.all(snap.docs.map(function (d) { return d.ref.delete(); }));
    }).then(function () { return ref.delete(); })
      .then(function () {
        V.toast('Colección eliminada ✓');
        if (coleccionActualId === col.id) seleccionarColeccion('', true);
      })
      .catch(function (e) { V.toast('No se pudo eliminar: ' + e.message, true); });
  }

  function guardarEpisodio(colId, datos, id) {
    if (!puedeGestionar()) {
      V.toast('Tu rol no permite gestionar los podcasts.', true);
      return Promise.resolve(false);
    }
    if (!V.db) { V.toast('Firestore no disponible.', true); return Promise.resolve(false); }
    if (!colId) {
      V.toast('Elige o crea una colección antes de añadir audios.', true);
      return Promise.resolve(false);
    }
    if (!texto(datos.titulo)) {
      V.toast('El título del episodio es obligatorio.', true);
      return Promise.resolve(false);
    }
    var payload = {
      titulo: texto(datos.titulo),
      descripcion: texto(datos.descripcion),
      audioUrl: urlSegura(datos.audioUrl),
      duracion: texto(datos.duracion),
      orden: normOrden(datos.orden),
      publicado: !!datos.publicado,
      embedCode: typeof datos.embedCode === 'string' ? datos.embedCode : '',
      actualizado: new Date().toISOString()
    };
    var ref = id
      ? V.db.collection(COL_COLECCIONES).doc(colId).collection(SUB_EPISODIOS).doc(id)
      : V.db.collection(COL_COLECCIONES).doc(colId).collection(SUB_EPISODIOS).doc();
    return ref.get().then(function (doc) {
      payload.creado = (doc.exists && doc.data().creado) || new Date().toISOString();
      return ref.set(payload, { merge: true });
    }).then(function () {
      V.toast(id ? 'Episodio actualizado ✓' : 'Episodio añadido ✓');
      episodioEditandoId = '';
      renderAdmin();
      return true;
    }).catch(function (e) {
      V.toast('No se pudo guardar el episodio: ' + e.message, true);
      return false;
    });
  }

  function borrarEpisodio(ep) {
    if (!puedeGestionar() || !V.db) return;
    if (!confirm('¿Eliminar el episodio "' + texto(ep.titulo) + '"?')) return;
    V.db.collection(COL_COLECCIONES).doc(coleccionActualId).collection(SUB_EPISODIOS).doc(ep.id).delete()
      .then(function () {
        V.toast('Episodio eliminado ✓');
        if (episodioEditandoId === ep.id) episodioEditandoId = '';
      })
      .catch(function (e) { V.toast('No se pudo eliminar: ' + e.message, true); });
  }

  /* ─── PANEL DE GESTIÓN ───────────────────────────────────────
     Se construye con el() en vez de vivir en index.html: el módulo
     ocupa un hueco en el HTML y todo el formulario está en un único
     sitio, igual que el del video corporativo en el panel del super
     admin. */
  function campo(rotulo, control, hint, full) {
    var wrap = el('div', 'field' + (full ? ' field-full' : ''));
    var l = el('label', '', rotulo);
    l.htmlFor = control.id;
    wrap.appendChild(l);
    wrap.appendChild(control);
    if (hint) wrap.appendChild(el('p', 'field-hint', hint));
    return wrap;
  }

  function fila() {
    return el('div', 'form-row');
  }

  function input(id, type, value, placeholder) {
    var n = document.createElement('input');
    n.id = id;
    n.type = type || 'text';
    n.className = 'input';
    n.value = value === undefined || value === null ? '' : String(value);
    if (placeholder) n.placeholder = placeholder;
    n.autocomplete = 'off';
    return n;
  }

  function textarea(id, value, placeholder) {
    var n = document.createElement('textarea');
    n.id = id;
    n.className = 'textarea';
    n.rows = 3;
    n.value = value || '';
    if (placeholder) n.placeholder = placeholder;
    return n;
  }

  function check(id, etiqueta, checked) {
    var wrap = el('label', 'cms-check-label');
    var chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.id = id;
    chk.checked = !!checked;
    wrap.appendChild(chk);
    wrap.appendChild(el('span', '', etiqueta));
    return wrap;
  }

  function boton(txt, cls, onClick) {
    var b = el('button', 'btn ' + cls, txt);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function adminCard(titulo, subtitulo, icono) {
    var card = el('div', 'podcast-admin-card');
    var head = el('div', 'podcast-admin-head');
    head.appendChild(el('h3', '', (icono ? icono + ' ' : '') + titulo));
    if (subtitulo) head.appendChild(el('p', '', subtitulo));
    card.appendChild(head);
    return card;
  }

  function renderAdmin() {
    var host = $('podcastAdmin');
    if (!host) return;
    // Doble frontera: el panel se oculta y, además, cada guardado vuelve a
    // comprobar el rol. Lo que de verdad cierra el candado es firestore.rules.
    if (!gestionando || !puedeGestionar()) { host.style.display = 'none'; host.innerHTML = ''; return; }
    host.style.display = '';
    host.innerHTML = '';
    host.appendChild(formCategorias());
    host.appendChild(formColeccion());
    host.appendChild(formEpisodios());
  }

  function formCategorias() {
    var card = adminCard(
      'Categorías',
      'Clasifican las colecciones del catálogo. Son dinámicas: se crean y se borran desde aquí, sin tocar el código.',
      '🏷️'
    );
    var lista = el('div', 'podcast-cat-admin');
    categoriasCache.forEach(function (cat) {
      var row = el('div', 'podcast-cat-admin');
      row.appendChild(el('span', 'status-pill blue', texto(cat.nombre) || 'Sin nombre'));
      row.appendChild(boton('🗑', 'btn btn-outline btn-sm', function () {
        if (!confirm('¿Eliminar la categoría "' + texto(cat.nombre) + '"? Las colecciones que la usan se quedan sin categoría.')) return;
        V.db.collection(COL_CATEGORIAS).doc(cat.id).delete()
          .then(function () { V.toast('Categoría eliminada ✓'); })
          .catch(function (e) { V.toast('No se pudo eliminar: ' + e.message, true); });
      }));
      lista.appendChild(row);
    });
    card.appendChild(lista);

    var nueva = input('podcastCatNombre', 'text', '', 'Nombre de la nueva categoría');
    var alta = el('div', 'podcast-cat-admin');
    alta.appendChild(nueva);
    alta.appendChild(boton('＋ Añadir', 'btn btn-primary btn-sm', function () {
      var nombre = texto(nueva.value);
      if (!nombre) { V.toast('Escribe el nombre de la categoría.', true); return; }
      V.db.collection(COL_CATEGORIAS).add({
        nombre: nombre,
        orden: categoriasCache.length + 1,
        publicado: true,
        creado: new Date().toISOString()
      }).then(function () {
        nueva.value = '';
        V.toast('Categoría creada ✓');
      }).catch(function (e) { V.toast('No se pudo crear: ' + e.message, true); });
    }));
    card.appendChild(alta);
    return card;
  }

  function formColeccion() {
    var col = coleccionPorId(coleccionActualId);
    var card = adminCard(
      col ? 'Editar colección' : 'Nueva colección',
      'Título, descripción, portada y orden. Se guarda en Firestore y la lista se actualiza sin desplegar nada.',
      '📁'
    );

    var inTitulo = input('podcastColTitulo', 'text', col ? texto(col.titulo) : '', 'Ej: La Biblia resumida en audio');
    var selCat = document.createElement('select');
    selCat.id = 'podcastColCategoria';
    selCat.className = 'select';
    var ninguna = document.createElement('option');
    ninguna.value = '';
    ninguna.textContent = '— Sin categoría —';
    selCat.appendChild(ninguna);
    categoriasCache.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c.id;
      o.textContent = texto(c.nombre) || 'Sin nombre';
      selCat.appendChild(o);
    });
    selCat.value = col ? texto(col.categoriaId) : categoriaFiltro;

    var r1 = fila();
    r1.appendChild(campo('Título', inTitulo));
    r1.appendChild(campo('Categoría', selCat));
    card.appendChild(r1);

    var r2 = fila();
    r2.appendChild(campo('Descripción', textarea('podcastColDesc', col ? texto(col.descripcion) : '', 'Breve descripción de la colección'), null, true));
    card.appendChild(r2);

    var r3 = fila();
    r3.appendChild(campo('Portada (URL de imagen)', input('podcastColPortada', 'url', col ? texto(col.portada) : '', 'https://…/portada.jpg (opcional)')));
    r3.appendChild(campo('Orden', input('podcastColOrden', 'number', col ? (col.orden || 0) : 0), 'Menor número, antes en la lista.'));
    card.appendChild(r3);

    var r4 = fila();
    r4.appendChild(campo('Publicación', check('podcastColPublicado', 'Publicado (visible sin iniciar sesión)', col ? esPublicado(col) : true), null, true));
    card.appendChild(r4);

    var r4b = fila();
    r4b.appendChild(campo('Código Embed / Enlace Multimedia Libre', textarea('podcastColEmbed', col && typeof col.embedCode === 'string' ? col.embedCode : '', 'Pega aquí un iframe, código embed o contenido multimedia externo'), 'Se renderizará de forma segura en la vista pública.', true));
    card.appendChild(r4b);

    var acciones = el('div', 'form-actions');
    acciones.appendChild(boton('💾 Guardar colección', 'btn btn-primary', function () {
      guardarColeccion({
        titulo: inTitulo.value,
        descripcion: $('podcastColDesc').value,
        portada: $('podcastColPortada').value,
        categoriaId: selCat.value,
        orden: $('podcastColOrden').value,
        publicado: $('podcastColPublicado').checked,
        embedCode: $('podcastColEmbed') ? $('podcastColEmbed').value : ''
      }, col ? col.id : '');
    }));
    if (col) acciones.appendChild(boton('🗑 Eliminar colección', 'btn btn-danger', function () { borrarColeccion(col); }));
    card.appendChild(acciones);

    // Aviso de por qué el formulario aparece vacío: la diferencia entre
    // "todavía no he creado nada" y "el botón no funciona".
    if (!col) {
      card.appendChild(el('p', 'field-hint', coleccionesCache.length
        ? 'Estás creando una colección nueva. Al guardarla se seleccionará automáticamente y podrás añadirle sus audios.'
        : 'Estás creando la primera colección. Al guardarla se seleccionará automáticamente y podrás añadirle sus audios.'));
    }
    return card;
  }

  function formEpisodios() {
    var col = coleccionPorId(coleccionActualId);
    var card = adminCard(
      'Episodios de «' + ((col && texto(col.titulo)) || 'la colección seleccionada') + '»',
      'Cada episodio es un audio con su URL. Los visitantes sin cuenta pueden escucharlos igual que cualquier cuenta registrada.',
      '🎙️'
    );
    if (!col) {
      card.appendChild(el('p', 'podcast-admin-empty', 'Selecciona una colección en la lista de arriba para gestionar sus episodios.'));
      return card;
    }

    var edicion = episodioEditandoId ? episodioPorId(episodioEditandoId) : null;
    if (!episodioEditandoId) {
      var lista = el('div', 'podcast-episodes');
      episodiosCache.forEach(function (ep) {
        var row = el('div', 'podcast-episode');
        row.appendChild(el('span', 'podcast-play', '🎧'));
        var body = el('div', 'podcast-episode-body');
        body.appendChild(el('h4', 'podcast-episode-title', texto(ep.titulo) || 'Episodio sin título'));
        var meta = el('div', 'podcast-episode-meta');
        if (texto(ep.duracion)) meta.appendChild(el('span', 'podcast-dur', '⏱ ' + texto(ep.duracion)));
        meta.appendChild(el('span', 'podcast-dur', esPublicado(ep) ? 'Publicado' : 'Borrador'));
        body.appendChild(meta);
        row.appendChild(body);
        var acts = el('div', 'podcast-row-actions');
        acts.appendChild(boton('✏️ Editar', 'btn btn-outline btn-sm', function () { editarEpisodio(ep.id); }));
        acts.appendChild(boton('🗑', 'btn btn-outline btn-sm', function () { borrarEpisodio(ep); }));
        row.appendChild(acts);
        lista.appendChild(row);
      });
      if (!episodiosCache.length) {
        card.appendChild(el('p', 'podcast-admin-empty', 'Esta colección todavía no tiene audios.'));
      } else {
        card.appendChild(lista);
      }
    } else {
      card.appendChild(el('p', 'podcast-admin-empty', 'Editando «' + ((edicion && texto(edicion.titulo)) || 'episodio') + '». Guarda los cambios o cancela la edición.'));
    }

    var r1 = fila();
    r1.appendChild(campo('Título', input('podcastEpTitulo', 'text', edicion ? texto(edicion.titulo) : '', 'Título del episodio')));
    r1.appendChild(campo('URL del audio', input('podcastEpUrl', 'url', edicion ? texto(edicion.audioUrl) : '', 'https://…/audio.mp3'), 'Enlace directo al archivo (mp3, m4a, ogg) o a un alojamiento de audio.'));
    card.appendChild(r1);

    var r2 = fila();
    r2.appendChild(campo('Descripción', textarea('podcastEpDesc', edicion ? texto(edicion.descripcion) : '', 'Descripción corta'), null, true));
    card.appendChild(r2);

    var r3 = fila();
    r3.appendChild(campo('Duración', input('podcastEpDuracion', 'text', edicion ? texto(edicion.duracion) : '', '12:30 (opcional)')));
    r3.appendChild(campo('Orden', input('podcastEpOrden', 'number', edicion ? (edicion.orden || 0) : (episodiosCache.length + 1)), 'Menor número, antes en la lista.'));
    card.appendChild(r3);

    var r4 = fila();
    r4.appendChild(campo('Publicación', check('podcastEpPublicado', 'Publicado', edicion ? esPublicado(edicion) : true), null, true));
    card.appendChild(r4);

    var r4b = fila();
    r4b.appendChild(campo('Código Embed / Enlace Multimedia Libre', textarea('podcastEpEmbed', edicion && typeof edicion.embedCode === 'string' ? edicion.embedCode : '', 'Pega aquí un iframe, código embed o reproductor externo'), 'Se renderizará de forma segura en la vista del episodio.', true));
    card.appendChild(r4b);

    var acciones = el('div', 'form-actions');
    acciones.appendChild(boton(edicion ? 'Actualizar episodio' : 'Guardar episodio', 'btn btn-primary', function () {
      guardarEpisodio(col.id, {
        titulo: $('podcastEpTitulo').value,
        descripcion: $('podcastEpDesc').value,
        audioUrl: $('podcastEpUrl').value,
        duracion: $('podcastEpDuracion').value,
        orden: $('podcastEpOrden').value,
        publicado: $('podcastEpPublicado').checked,
        embedCode: $('podcastEpEmbed') ? $('podcastEpEmbed').value : ''
      }, edicion ? edicion.id : '');
    }));
    if (edicion) acciones.appendChild(boton('✖ Cancelar edición', 'btn btn-outline', function () { editarEpisodio(''); }));
    card.appendChild(acciones);
    return card;
  }

  function episodioPorId(id) {
    for (var i = 0; i < episodiosCache.length; i++) {
      if (episodiosCache[i].id === id) return episodiosCache[i];
    }
    return null;
  }

  // Editar un episodio no abre otra pantalla: el mismo formulario se recarga
  // con sus valores, así que el epíteto del botón y el id que se escribe salen
  // de un solo sitio (episodioEditandoId) y no pueden desincronizarse.
  function editarEpisodio(epId) {
    episodioEditandoId = epId || '';
    renderAdmin();
    if (!episodioEditandoId) return;
    var t = $('podcastEpTitulo');
    if (!t) return;
    t.focus();
    t.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /* Vista previa para la portada pública: un solo paso (get, no suscripción)
     porque la landing no necesitaActualizar al segundo y así no mantiene una
     suscripción abierta para alguien que quizá nunca abra el módulo. Comparte
     la misma lectura tolerante del catálogo —publicado en true o ausente— y
     filtra SIEMPRE por publicación, incluso para un gestor: la portada pública
     tiene que enseñar lo mismo que encontrará un visitante, no el borrador que
     el gestor tiene abierto en otra pestaña. */
  function resumenPublico(alTerminar) {
    var avisar = function (lista) {
      try { alTerminar(lista || []); } catch (e) { /* la portada sigue igual */ }
    };
    if (!V.db) { avisar([]); return; }
    var snaps = consultas(V.db.collection(COL_COLECCIONES), false).map(function (q) {
      return q.get().catch(function () { return null; });
    });
    Promise.all(snaps).then(function (res) {
      var map = {};
      res.forEach(function (snap) {
        if (!snap) return;
        snap.forEach(function (d) {
          var data = d.data();
          data.id = d.id;
          map[d.id] = data;
        });
      });
      avisar(Object.keys(map).map(function (id) { return map[id]; })
        .filter(esPublicado).sort(porOrden));
    });
  }

  /* ─── SHOW HOOK ──────────────────────────────────────────────
     showPodcasts() del core solo enciende la vista: el repintado y la
     suscripción de datos viven aquí, igual que onComunidadesShow(). */
  // Sin colección elegida se abre la primera de la lista: entrar al módulo y ver
  // solo una rejilla sin contenido parece un fallo, no un catálogo.
  function abrirPrimeraSiHaceFalta() {
    if (coleccionActualId) return;
    var lista = coleccionesVisibles();
    if (!lista.length) return;
    coleccionActualId = lista[0].id;
    escribirUrl({ podcast: coleccionActualId });
    suscribirEpisodios(coleccionActualId);
  }

  function onShow() {
    actualizarBotonesCabecera();
    if (!V.db) {
      renderColecciones();
      renderEpisodios();
      return;
    }
    // onShow también es el reintento: si una suscripción se cayó por reglas sin
    // desplegar, su hueco quedó libre y aquí se vuelve a abrir.
    suscribirCategorias();
    suscribirColecciones();
    if (coleccionActualId && !episodiosSub) suscribirEpisodios(coleccionActualId);
    abrirPrimeraSiHaceFalta();
    renderCategorias();
    renderColecciones();
    renderEpisodios();
    renderAdmin();
  }

  function actualizarBotonesCabecera() {
    var acciones = $('podcastHeaderActions');
    if (!acciones) return;
    acciones.style.display = puedeGestionar() ? '' : 'none';
    var btnGest = $('btnPodcastGestionar');
    if (btnGest) btnGest.textContent = gestionando ? '👁 Ver catálogo' : '⚙ Gestionar colecciones';
    var sub = $('podcastSub');
    if (sub) {
      sub.textContent = gestionando
        ? 'Modo gestión: crea, edita y organiza las colecciones y sus audios. Los cambios se aplican al instante.'
        : 'Colecciones de audio para escuchar sin registrarte. Elige una colección y reproduce sus episodios.';
    }
  }

  function bindEvents() {
    var btnGest = $('btnPodcastGestionar');
    if (btnGest) btnGest.addEventListener('click', function () {
      gestionando = !gestionando;
      // Cambia el alcance de las suscripciones: para ver los borradores hay que
      // volver a suscribirse, porque la consulta pública no los trae.
      reconstruirSuscripciones();
      actualizarBotonesCabecera();
      renderColecciones();
      renderEpisodios();
      renderAdmin();
      if (!coleccionActualId && coleccionesVisibles().length) {
        coleccionActualId = coleccionesVisibles()[0].id;
        suscribirEpisodios(coleccionActualId);
      }
    });
    var btnNueva = $('btnNuevaColeccion');
    if (btnNueva) btnNueva.addEventListener('click', function () {
      if (!V.db) return;
      gestionando = true;
      actualizarBotonesCabecera();
      // Se limpia también la selección (y con ella la URL): si no, el formulario
      // de "nueva" aparecería sobre la colección anterior y la barra de
      // direcciones seguiría anunciando un ?podcast= que ya no describe la vista.
      seleccionarColeccion('', true);
      renderAdmin();
      var t = $('podcastColTitulo');
      if (t) t.focus();
    });
    var btnVolver = $('podcastVolverTodas');
    if (btnVolver) btnVolver.addEventListener('click', function () { seleccionarColeccion('', true); });
    var btnCopiar = $('podcastCopiarEnlace');
    if (btnCopiar) btnCopiar.addEventListener('click', function () {
      if (!coleccionActualId || !V.deepLink) return;
      copiar(V.deepLink.construirUrl({ podcast: coleccionActualId }));
    });
  }

  function copiar(valor) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(valor)
        .then(function () { V.toast('Enlace de la colección copiado ✓'); })
        .catch(function () { V.toast('No se pudo copiar el enlace', true); });
      return;
    }
    // Sin API de portapapeles (navegador viejo o contexto no seguro) el
    // textarea temporal sigue siendo la vía que funciona en todos.
    var tmp = document.createElement('textarea');
    tmp.value = valor;
    document.body.appendChild(tmp);
    tmp.select();
    try { document.execCommand('copy'); V.toast('Enlace de la colección copiado ✓'); }
    catch (e) { V.toast('No se pudo copiar el enlace', true); }
    document.body.removeChild(tmp);
  }

  /* ─── MÓDULO ────────────────────────────────────────────────── */
  var PodcastsModule = {
    onReady: function () {
      bindEvents();
      onShow();
    }
  };
  V.registerModule(PodcastsModule);
  V.onPodcastsShow = onShow;

  // La identidad puede cambiar después de montado el módulo (el visitante crea
  // su cuenta): las suscripciones se rehacen con el alcance que corresponde.
  var _onSessionRefreshPrev = V.onSessionRefresh;
  V.onSessionRefresh = function () {
    if (typeof _onSessionRefreshPrev === 'function') {
      try { _onSessionRefreshPrev(); } catch (e) { /* noop */ }
    }
    reconstruirSuscripciones();
  };

  var _onModeChangePrev = V.onModeChange;
  V.onModeChange = function (m) {
    if (typeof _onModeChangePrev === 'function') {
      try { _onModeChangePrev(m); } catch (e) { /* noop */ }
    }
    reconstruirSuscripciones();
    actualizarBotonesCabecera();
    renderAdmin();
  };

  /* API mínima para el resto de la app (la ficha de la portada la usa). */
  V.podcasts = {
    COL_CATEGORIAS: COL_CATEGORIAS,
    COL_COLECCIONES: COL_COLECCIONES,
    SUB_EPISODIOS: SUB_EPISODIOS,
    show: function () { if (V.showPodcasts) V.showPodcasts(); },
    seleccionar: seleccionarColeccion,
    lista: coleccionesVisibles,
    resumenPublico: resumenPublico
  };
})();