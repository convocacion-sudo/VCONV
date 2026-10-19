/* ════════════════════════════════════════════════════════════════
   VCONV · Módulo Tienda Consolidada — Marketplace
   ────────────────────────────────────────────────────────────────
   Módulo PÚBLICO (Nivel 1): el catálogo de productos se lista SIN
   iniciar sesión. Quien llega sin cuenta (V.isAnon) ve las fichas de
   producto, el % de comisión y los datos de contacto del vendedor
   (WhatsApp / red social), pero no puede publicar nada.

   Panel "Mi tienda" (solo cuentas registradas): cada vendedor
   gestiona SU catálogo. Las categorías son dinámicas y las
   administra canManage() (gestor/superadmin).

   Todo el contenido vive en Firestore, sin tocar el código:
     tienda_categorias/{catId}    → clasificación del catálogo
     tienda_productos/{prodId}    → cada producto (con su comisión)
     tienda_vendedores/{uid}      → perfil público del vendedor

   El candado real está en firestore.rules: lectura abierta a
   cualquier identidad, y escritura del dueño (o superadmin). La
   comprobación de rol de este archivo solo evita el intento y
   explica el motivo, igual que en el resto de módulos del panel.
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var V = window.VCONV;
  if (!V) { console.error('VCONV core not loaded'); return; }

  var COL_CATEGORIAS = 'tienda_categorias';
  var COL_PRODUCTOS = 'tienda_productos';
  var COL_VENDEDORES = 'tienda_vendedores';

  /* ─── ESTADO ────────────────────────────────────────────────
     Las suscripciones viven fuera del DOM: la vista se redibuja en
     cada navegación y una suscripción atada a un nodo se quedaría
     escuchando una pantalla que ya no existe. */
  var categoriasCache = [];
  var productosCache = [];
  var categoriasSub = null;
  var productosSub = null;
  var perfilVendedor = null;
  var categoriaFiltro = '';
  var productoActualId = '';
  var productoEditandoId = '';
  var gestionando = false;
  // Enlace directo pendiente (?producto=…): llega antes que los datos,
  // así que se resuelve cuando el producto ya está cargado.
  var enlacePendiente = null;
  var enlacesResueltos = {};

  function $(id) { return V.$(id); }
  function el(tag, cls, text) { return V.el(tag, cls, text); }

  /* ─── HELPERS ──────────────────────────────────────────────── */
  function texto(v) { return typeof v === 'string' ? v.trim() : ''; }

  // Misma tolerancia que esVisiblePublico() en firestore.rules: sin campo
  // cuenta como publicado y solo un false explícito esconde el documento.
  function esPublicado(d) {
    return !d || d.publicado !== false;
  }

  function uidActual() {
    if (typeof V.uidSesion === 'function') return V.uidSesion();
    return V.userId || '';
  }

  function haySesion() {
    return !V.isAnon && !!uidActual();
  }

  function puedeCategorias() {
    return typeof V.canManage === 'function' ? !!V.canManage() : false;
  }

  function esMio(p) {
    return haySesion() && p && p.vendedorId === uidActual();
  }

  // Puede editar/borrar el producto: su dueño o el superadmin/gestor.
  function puedoEditar(p) {
    return !!p && (esMio(p) || puedeCategorias());
  }

  // Orden estable: `orden` numérico primero y, a igualdad, el título.
  function porOrden(a, b) {
    var oa = typeof a.orden === 'number' ? a.orden : Number.MAX_SAFE_INTEGER;
    var ob = typeof b.orden === 'number' ? b.orden : Number.MAX_SAFE_INTEGER;
    if (oa !== ob) return oa - ob;
    return texto(a.titulo).localeCompare(texto(b.titulo), 'es');
  }

  function porNombre(a, b) {
    var oa = typeof a.orden === 'number' ? a.orden : Number.MAX_SAFE_INTEGER;
    var ob = typeof b.orden === 'number' ? b.orden : Number.MAX_SAFE_INTEGER;
    if (oa !== ob) return oa - ob;
    return texto(a.nombre).localeCompare(texto(b.nombre), 'es');
  }

  function normOrden(v) {
    var n = parseInt(v, 10);
    return isFinite(n) ? n : 0;
  }

  // Porcentaje de comisión acotado a [0, 100].
  function normPct(v) {
    var n = parseFloat(v);
    if (!isFinite(n)) return 0;
    return Math.max(0, Math.min(100, Math.round(n * 100) / 100));
  }

  // Solo http(s): el campo lo escribe alguien con el panel en la mano y un
  // javascript: ahí acabaría siendo el href de un enlace.
  function urlSegura(raw) {
    var u = texto(raw);
    if (!u) return '';
    if (/^https?:\/\//i.test(u)) return u;
    if (/^[\w.-]+\.[a-z]{2,}\//i.test(u)) return 'https://' + u;
    return '';
  }

  // Teléfono en dígitos para el enlace de WhatsApp (wa.me exige solo dígitos).
  function soloDigitos(v) {
    return String(v == null ? '' : v).replace(/[^\d]/g, '');
  }

  function indiceDeProducto(id) {
    for (var i = 0; i < productosCache.length; i++) {
      if (productosCache[i].id === id) return i;
    }
    return -1;
  }

  function productoPorId(id) {
    var i = indiceDeProducto(id);
    return i === -1 ? null : productosCache[i];
  }

  function categoriaPorId(id) {
    for (var i = 0; i < categoriasCache.length; i++) {
      if (categoriasCache[i].id === id) return categoriasCache[i];
    }
    return null;
  }

  /* ─── FIRESTORE ────────────────────────────────────────────── */
  /* Consultas de un SOLO campo. `!= false` no sirve: en una consulta descarta
     los documentos sin el campo. Se unen las mitades publicadas (true y null) y,
     según quién mira:
       - quien gestiona categorías (canManage) ve TODOS los borradores;
       - el vendedor registrado suma SUS productos en cualquier estado (la
         regla de Firestore deja leerlos por vendedorId aunque estén en borrador);
       - el visitante solo recibe lo publicado. */
  function consultas(col, conBorradores, ownerId) {
    var qs = [
      col.where('publicado', '==', true),
      col.where('publicado', '==', null)
    ];
    if (conBorradores) qs.push(col.where('publicado', '==', false));
    if (ownerId) qs.push(col.where('vendedorId', '==', ownerId));
    return qs;
  }

  /* Suscripción combinada: lleva un mapa por id y re-emite la unión deduplicada
     en cada cambio. Si una pata falla (403 por reglas sin desplegar, red caída)
     se suelta SOLO esa pata y, cuando ya no queda ninguna viva, se avisa con
     onError para liberar el hueco y reintentar después. */
  function subscribeUnion(col, onDocs, conBorradores, ownerId, onError, cmp) {
    var map = {};
    var unsubs = [];
    var qs = consultas(col, conBorradores, ownerId);
    var orden = cmp || porOrden;
    function emit() {
      onDocs(Object.keys(map).map(function (id) { return map[id]; }).sort(orden));
    }
    qs.forEach(function (q, i) {
      var propia = q.onSnapshot(function (snap) {
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
        console.warn('[tienda] no se pudo leer ' + col.id + ': ' + (err && err.message));
        try { propia(); } catch (e) { /* ya dada de baja */ }
        unsubs[i] = null;
        if (!unsubs.some(function (fn) { return !!fn; })) {
          unsubs = [];
          if (typeof onError === 'function') onError();
        }
      });
      unsubs[i] = propia;
    });
    return function () {
      unsubs.forEach(function (fn) { if (fn) { try { fn(); } catch (e) { /* noop */ } } });
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
      puedeCategorias(),
      '',
      function () { categoriasSub = null; },
      porNombre
    );
  }

  function suscribirProductos() {
    if (!V.db || productosSub) return;
    productosSub = subscribeUnion(
      V.db.collection(COL_PRODUCTOS),
      function (docs) {
        productosCache = docs;
        resolverEnlacePendiente();
        renderProductos();
        renderDetalle();
        if (gestionando) renderAdmin();
      },
      puedeCategorias(),
      haySesion() ? uidActual() : '',
      function () { productosSub = null; }
    );
  }

  // Reconstruye las suscripciones bajo la identidad ACTUAL (login, registro,
  // salida): en un cambio de identidad, el alcance de las consultas cambia
  // (borradores propios) y la suscripción vieja dejaría la vista desfasada.
  function reconstruirSuscripciones() {
    baja(categoriasSub); categoriasSub = null;
    baja(productosSub); productosSub = null;
    if (!V.db) return;
    suscribirCategorias();
    suscribirProductos();
  }

  /* Lo que ve el visitante: todo menos los borradores ajenos. El vendedor ve
     siempre los suyos (aunque estén en borrador) y quien gestiona los ve todos. */
  function visibles(lista) {
    if (puedeCategorias()) return lista;
    return lista.filter(function (p) { return esPublicado(p) || esMio(p); });
  }

  /* ─── CATÁLOGO ─────────────────────────────────────────────── */
  function renderCategorias() {
    var bar = $('tiendaCategoriasBar');
    if (!bar) return;
    bar.innerHTML = '';
    if (!categoriasCache.length) return;

    var todas = el('button', 'tienda-cat' + (categoriaFiltro === '' ? ' active' : ''), 'Todas');
    todas.type = 'button';
    todas.addEventListener('click', function () {
      categoriaFiltro = '';
      renderCategorias();
      renderProductos();
    });
    bar.appendChild(todas);

    categoriasCache.forEach(function (cat) {
      if (!esPublicado(cat) && !puedeCategorias()) return;
      var b = el('button', 'tienda-cat' + (categoriaFiltro === cat.id ? ' active' : ''), texto(cat.nombre) || 'Sin nombre');
      b.type = 'button';
      b.addEventListener('click', function () {
        categoriaFiltro = (categoriaFiltro === cat.id) ? '' : cat.id;
        renderCategorias();
        renderProductos();
      });
      bar.appendChild(b);
    });
  }

  function productosVisibles() {
    var lista = visibles(productosCache);
    if (categoriaFiltro) {
      lista = lista.filter(function (p) { return p.categoriaId === categoriaFiltro; });
    }
    return lista;
  }

  function imagenPrincipal(p) {
    var img = urlSegura(p && p.imagen);
    if (!img && p && Array.isArray(p.imagenes)) {
      for (var i = 0; i < p.imagenes.length; i++) {
        img = urlSegura(p.imagenes[i]);
        if (img) break;
      }
    }
    return img;
  }

  function precioTexto(p) {
    var precio = texto(p && p.precio);
    if (!precio) return '';
    var moneda = texto(p && p.moneda);
    return (moneda ? moneda + ' ' : '') + precio;
  }

  function renderProductos() {
    var grid = $('tiendaGrid');
    if (!grid) return;
    grid.innerHTML = '';
    var lista = productosVisibles();

    if (!lista.length) {
      grid.appendChild(V.emptyState(
        '🛒',
        'Todavía no hay productos',
        (puedeCategorias() || haySesion())
          ? 'Publica el primer producto desde "Mi tienda" y aparecerá aquí al instante.'
          : 'Pronto los vendedores de la comunidad publicarán sus productos. Vuelve pronto.'
      ));
      return;
    }

    lista.forEach(function (p) {
      var card = el('button', 'tienda-card' + (p.id === productoActualId ? ' active' : ''));
      card.type = 'button';

      var imgUrl = imagenPrincipal(p);
      if (imgUrl) {
        var img = document.createElement('img');
        img.className = 'tienda-thumb';
        img.loading = 'lazy';
        img.alt = '';
        img.src = imgUrl;
        img.addEventListener('error', function () {
          if (img.parentNode) img.parentNode.replaceChild(el('div', 'tienda-thumb-fallback', '🛍️'), img);
        });
        card.appendChild(img);
      } else {
        card.appendChild(el('div', 'tienda-thumb-fallback', '🛍️'));
      }

      var body = el('div', 'tienda-card-body');
      var head = el('div', 'tienda-card-head');
      head.appendChild(el('h3', 'tienda-card-title', texto(p.titulo) || 'Producto sin título'));
      body.appendChild(head);

      var cat = categoriaPorId(p.categoriaId);
      body.appendChild(el('span', 'tienda-card-cat', cat ? texto(cat.nombre) : 'Sin categoría'));

      if (texto(p.descripcion)) body.appendChild(el('p', 'tienda-card-desc', texto(p.descripcion)));

      var precio = precioTexto(p);
      if (precio) body.appendChild(el('div', 'tienda-price', precio));

      var foot = el('div', 'tienda-card-foot');
      foot.appendChild(el('span', 'tienda-comision', '💠 ' + normPct(p.comisionPct) + '% comisión'));
      if (!esPublicado(p)) foot.appendChild(el('span', 'status-pill', 'Borrador'));
      body.appendChild(foot);

      var vendedor = texto(p.vendedorNombre);
      if (vendedor) body.appendChild(el('span', 'tienda-vendedor', 'Vendedor: ' + vendedor));

      card.appendChild(body);
      card.addEventListener('click', function () { abrirDetalle(p.id, true); });
      grid.appendChild(card);
    });
  }

  /* ─── FICHA DE PRODUCTO ────────────────────────────────────── */
  function whatsappLink(p) {
    var num = soloDigitos(p && p.whatsapp);
    if (!num) return '';
    var msg = 'Hola' + (texto(p && p.vendedorNombre) ? ' ' + texto(p.vendedorNombre) : '') +
      ', me interesa el producto «' + (texto(p && p.titulo) || '') + '» que vi en la Tienda VCONV.';
    return 'https://wa.me/' + num + '?text=' + encodeURIComponent(msg);
  }

  function buildGallery(p) {
    var wrap = el('div', 'tienda-gallery');
    var urls = [];
    var principal = urlSegura(p.imagen);
    if (principal) urls.push(principal);
    if (Array.isArray(p.imagenes)) {
      p.imagenes.forEach(function (u) {
        var s = urlSegura(u);
        if (s && urls.indexOf(s) === -1) urls.push(s);
      });
    }

    var main;
    if (urls.length) {
      main = document.createElement('img');
      main.className = 'tienda-gallery-main';
      main.alt = '';
      main.src = urls[0];
      main.addEventListener('error', function () {
        if (main.parentNode) main.parentNode.replaceChild(el('div', 'tienda-gallery-main-fallback', '🛍️'), main);
      });
    } else {
      main = el('div', 'tienda-gallery-main-fallback', '🛍️');
    }
    wrap.appendChild(main);

    if (urls.length > 1) {
      var thumbs = el('div', 'tienda-gallery-thumbs');
      urls.forEach(function (u, i) {
        var t = document.createElement('img');
        t.src = u;
        t.alt = '';
        t.loading = 'lazy';
        if (i === 0) t.className = 'active';
        t.addEventListener('click', function () {
          if (main.tagName === 'IMG') main.src = u;
          Array.prototype.forEach.call(thumbs.children, function (c) { c.classList.remove('active'); });
          t.classList.add('active');
        });
        thumbs.appendChild(t);
      });
      wrap.appendChild(thumbs);
    }
    return wrap;
  }

  function renderDetalle() {
    var host = $('tiendaDetail');
    if (!host) return;
    var p = productoActualId ? productoPorId(productoActualId) : null;
    if (!p) { host.style.display = 'none'; host.innerHTML = ''; return; }

    host.style.display = '';
    host.innerHTML = '';

    var head = el('div', 'tienda-detail-head');
    var back = el('button', 'btn btn-outline btn-sm', '← Volver al catálogo');
    back.type = 'button';
    back.addEventListener('click', function () { abrirDetalle('', false); });
    head.appendChild(back);
    var headActs = el('div', 'section-header-acciones');
    if (V.deepLink) {
      var copiarBtn = el('button', 'btn btn-outline btn-sm', '🔗 Copiar enlace');
      copiarBtn.type = 'button';
      copiarBtn.addEventListener('click', function () { copiar(V.deepLink.construirUrl({ producto: p.id })); });
      headActs.appendChild(copiarBtn);
    }
    if (puedoEditar(p)) {
      var editBtn = el('button', 'btn btn-outline btn-sm', '✏ Editar');
      editBtn.type = 'button';
      editBtn.addEventListener('click', function () {
        editarProducto(p.id);
        var t = $('tiendaProdTitulo');
        if (t) { t.focus(); t.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      });
      headActs.appendChild(editBtn);
    }
    if (headActs.children.length) head.appendChild(headActs);
    host.appendChild(head);

    var grid = el('div', 'tienda-detail-grid');
    grid.appendChild(buildGallery(p));

    var info = el('div', 'tienda-detail-info');
    var cat = categoriaPorId(p.categoriaId);
    info.appendChild(el('h2', 'tienda-detail-title', texto(p.titulo) || 'Producto sin título'));
    var meta = el('div', 'tienda-detail-meta');
    meta.appendChild(el('span', 'status-pill', cat ? texto(cat.nombre) : 'Sin categoría'));
    meta.appendChild(el('span', 'tienda-comision', '💠 ' + normPct(p.comisionPct) + '% comisión'));
    if (!esPublicado(p)) meta.appendChild(el('span', 'status-pill', 'Borrador'));
    info.appendChild(meta);

    var precio = precioTexto(p);
    if (precio) info.appendChild(el('div', 'tienda-detail-price', precio));

    if (texto(p.descripcion)) info.appendChild(el('p', 'tienda-detail-desc', texto(p.descripcion)));

    var box = el('div', 'tienda-seller-box');
    box.appendChild(el('h4', '', '🧑 Vendedor'));
    box.appendChild(el('p', '', texto(p.vendedorNombre) || 'Vendedor de la comunidad'));

    var acts = el('div', 'tienda-detail-actions');
    var wa = whatsappLink(p);
    if (wa) {
      var waBtn = el('a', 'btn btn-success', '💬 Comprar por WhatsApp');
      waBtn.href = wa;
      waBtn.target = '_blank';
      waBtn.rel = 'noopener noreferrer';
      acts.appendChild(waBtn);
    } else {
      acts.appendChild(el('span', 'tienda-detail-empty', 'El vendedor no indicó un número de WhatsApp.'));
    }
    var red = urlSegura(p.redSocial);
    if (red) {
      var redBtn = el('a', 'btn btn-outline', '🔗 ' + (texto(p.redSocialNombre) || 'Ver red social'));
      redBtn.href = red;
      redBtn.target = '_blank';
      redBtn.rel = 'noopener noreferrer';
      acts.appendChild(redBtn);
    }
    box.appendChild(acts);
    info.appendChild(box);

    grid.appendChild(info);
    host.appendChild(grid);
  }

  function abrirDetalle(id, mover) {
    productoActualId = id || '';
    renderProductos();
    renderDetalle();
    if (productoActualId) {
      escribirUrl({ producto: productoActualId });
      if (mover) {
        var detail = $('tiendaDetail');
        if (detail) detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    } else {
      escribirUrl(null);
    }
  }

  function escribirUrl(params) {
    if (!V.deepLink) return;
    try { V.deepLink.escribirUrl(params); } catch (e) { /* la app navega igual */ }
  }

  /* ─── ENLACE DIRECTO ───────────────────────────────────────── */
  function resolverEnlacePendiente() {
    if (!enlacePendiente || !productosCache.length) return;
    var p = productoPorId(enlacePendiente.producto);
    if (!p) return;
    enlacePendiente = null;
    abrirDetalle(p.id, false);
  }

  // Declarado fuera de onReady a propósito: core consulta el enlace pendiente
  // ANTES de inicializar los módulos, así que el manejador tiene que existir
  // desde que se carga el script.
  function abrirDesdeEnlace(params) {
    if (!params || !params.producto) return;
    if (enlacesResueltos[params.producto]) return;
    enlacesResueltos[params.producto] = true;
    enlacePendiente = { producto: params.producto };
    if (typeof V.showTienda === 'function') V.showTienda();
    resolverEnlacePendiente();
    renderProductos();
  }
  V.registerDeepLink(['producto'], abrirDesdeEnlace);

  /* ─── ESCRITURA (vendedor · superadmin) ────────────────────── */
  function guardarProducto(datos, id) {
    if (!haySesion() && !puedeCategorias()) {
      V.toast('Inicia sesión para publicar productos.', true);
      return Promise.resolve(false);
    }
    if (!V.db) { V.toast('Firestore no disponible.', true); return Promise.resolve(false); }
    if (!texto(datos.titulo)) {
      V.toast('El título del producto es obligatorio.', true);
      return Promise.resolve(false);
    }

    var existente = id ? productoPorId(id) : null;
    if (id && existente && !puedoEditar(existente)) {
      V.toast('No puedes editar un producto que no es tuyo.', true);
      return Promise.resolve(false);
    }
    var propietario = existente && existente.vendedorId ? existente.vendedorId : uidActual();
    if (!propietario) { V.toast('No se pudo identificar tu cuenta.', true); return Promise.resolve(false); }

    var galeria = [];
    String(datos.imagenes || '').split('\n').forEach(function (linea) {
      var u = urlSegura(linea);
      if (u && galeria.indexOf(u) === -1) galeria.push(u);
    });

    var payload = {
      titulo: texto(datos.titulo),
      descripcion: texto(datos.descripcion),
      precio: texto(datos.precio),
      moneda: texto(datos.moneda) || 'COP',
      imagen: urlSegura(datos.imagen),
      imagenes: galeria,
      categoriaId: texto(datos.categoriaId),
      comisionPct: normPct(datos.comisionPct),
      vendedorId: propietario,
      vendedorNombre: texto(datos.vendedorNombre),
      whatsapp: soloDigitos(datos.whatsapp),
      redSocial: urlSegura(datos.redSocial),
      redSocialNombre: texto(datos.redSocialNombre),
      orden: normOrden(datos.orden),
      publicado: !!datos.publicado,
      actualizado: new Date().toISOString()
    };

    var ref = id
      ? V.db.collection(COL_PRODUCTOS).doc(id)
      : V.db.collection(COL_PRODUCTOS).doc();
    return ref.get().then(function (doc) {
      payload.creado = (doc.exists && doc.data().creado) || new Date().toISOString();
      return ref.set(payload, { merge: true });
    }).then(function () {
      V.toast(id ? 'Producto actualizado ✓' : 'Producto publicado ✓');
      productoEditandoId = '';
      if (!id) abrirDetalle(ref.id, false);
      if (gestionando) renderAdmin();
      return true;
    }).catch(function (e) {
      V.toast('No se pudo guardar el producto: ' + e.message, true);
      return false;
    });
  }

  function borrarProducto(p) {
    if (!puedoEditar(p) || !V.db) return;
    if (!confirm('¿Eliminar el producto "' + texto(p.titulo) + '"? Esta acción no se puede deshacer.')) return;
    V.db.collection(COL_PRODUCTOS).doc(p.id).delete()
      .then(function () {
        V.toast('Producto eliminado ✓');
        if (productoEditandoId === p.id) productoEditandoId = '';
        if (productoActualId === p.id) abrirDetalle('', false);
      })
      .catch(function (e) { V.toast('No se pudo eliminar: ' + e.message, true); });
  }

  function guardarPerfilVendedor(datos, btn) {
    if (!haySesion()) { V.toast('Inicia sesión para guardar tu perfil de vendedor.', true); return; }
    if (!V.db) { V.toast('Firestore no disponible.', true); return; }
    var uid = uidActual();
    var payload = {
      nombre: texto(datos.nombre),
      tiendaNombre: texto(datos.tiendaNombre),
      whatsapp: soloDigitos(datos.whatsapp),
      redSocial: urlSegura(datos.redSocial),
      redSocialNombre: texto(datos.redSocialNombre),
      publicado: true,
      actualizado: new Date().toISOString()
    };
    if (btn) { btn.disabled = true; btn._t = btn.textContent; btn.textContent = '⏳ Guardando…'; }
    V.db.collection(COL_VENDEDORES).doc(uid).get().then(function (doc) {
      payload.creado = (doc.exists && doc.data().creado) || new Date().toISOString();
      return V.db.collection(COL_VENDEDORES).doc(uid).set(payload, { merge: true });
    }).then(function () {
      perfilVendedor = payload;
      V.toast('Perfil de vendedor guardado ✓');
      renderAdmin();
    }).catch(function (e) {
      V.toast('No se pudo guardar el perfil: ' + e.message, true);
    }).then(function () {
      if (btn) { btn.disabled = false; btn.textContent = btn._t || btn.textContent; }
    });
  }

  function cargarPerfilVendedor(cb) {
    if (!V.db || !haySesion()) { perfilVendedor = null; if (cb) cb(); return; }
    V.db.collection(COL_VENDEDORES).doc(uidActual()).get()
      .then(function (doc) {
        perfilVendedor = doc.exists ? doc.data() : null;
        if (cb) cb();
      })
      .catch(function () { perfilVendedor = null; if (cb) cb(); });
  }

  /* ─── PANEL "MI TIENDA" ──────────────────────────────────────
     Se construye con el() en vez de vivir en index.html: el módulo ocupa un
     hueco en el HTML y todo el formulario está en un único sitio. */
  function campo(rotulo, control, hint, full) {
    var wrap = el('div', 'field' + (full ? ' field-full' : ''));
    var l = el('label', '', rotulo);
    l.htmlFor = control.id;
    wrap.appendChild(l);
    wrap.appendChild(control);
    if (hint) wrap.appendChild(el('p', 'field-hint', hint));
    return wrap;
  }

  function fila() { return el('div', 'form-row'); }

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

  function textarea(id, value, placeholder, rows) {
    var n = document.createElement('textarea');
    n.id = id;
    n.className = 'textarea';
    n.rows = rows || 3;
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
    var card = el('div', 'tienda-admin-card');
    var head = el('div', 'tienda-admin-head');
    head.appendChild(el('h3', '', (icono ? icono + ' ' : '') + titulo));
    if (subtitulo) head.appendChild(el('p', '', subtitulo));
    card.appendChild(head);
    return card;
  }

  function renderAdmin() {
    var host = $('tiendaAdmin');
    if (!host) return;
    if (!gestionando) { host.style.display = 'none'; host.innerHTML = ''; return; }
    host.style.display = '';
    host.innerHTML = '';
    if (!haySesion() && !puedeCategorias()) {
      host.appendChild(el('p', 'tienda-admin-empty', 'Inicia sesión para gestionar tu tienda.'));
      return;
    }
    host.appendChild(formPerfil());
    host.appendChild(formProducto());
    host.appendChild(formMisProductos());
    if (puedeCategorias()) host.appendChild(formCategorias());
  }

  function formPerfil() {
    var card = adminCard(
      'Mi perfil de vendedor',
      'Estos datos se copian en cada producto nuevo y son los que ve el comprador para contactarte.',
      '🧑'
    );
    var perfil = perfilVendedor || {};
    var r1 = fila();
    r1.appendChild(campo('Nombre o marca', input('tiendaPerfilNombre', 'text', texto(perfil.nombre), 'Ej: María Pérez · Tejidos MP')));
    r1.appendChild(campo('WhatsApp', input('tiendaPerfilWhatsapp', 'tel', texto(perfil.whatsapp), 'Ej: 573001234567')));
    card.appendChild(r1);

    var r2 = fila();
    r2.appendChild(campo('Red social (URL)', input('tiendaPerfilRed', 'url', texto(perfil.redSocial), 'https://instagram.com/tutienda (opcional)')));
    r2.appendChild(campo('Nombre de la red', input('tiendaPerfilRedNombre', 'text', texto(perfil.redSocialNombre), 'Instagram, Facebook, TikTok…')));
    card.appendChild(r2);

    var acciones = el('div', 'form-actions');
    var btn = boton('💾 Guardar perfil', 'btn btn-primary', function () {
      guardarPerfilVendedor({
        nombre: $('tiendaPerfilNombre').value,
        tiendaNombre: $('tiendaPerfilNombre').value,
        whatsapp: $('tiendaPerfilWhatsapp').value,
        redSocial: $('tiendaPerfilRed').value,
        redSocialNombre: $('tiendaPerfilRedNombre').value
      }, btn);
    });
    acciones.appendChild(btn);
    card.appendChild(acciones);
    return card;
  }

  function formProducto() {
    var edicion = productoEditandoId ? productoPorId(productoEditandoId) : null;
    var card = adminCard(
      edicion ? 'Editar producto' : 'Nuevo producto',
      'Título, precio, comisión y datos de contacto. La galería acepta una URL de imagen por línea.',
      '📦'
    );

    var perfil = perfilVendedor || {};
    var vendedorNombre = edicion ? texto(edicion.vendedorNombre) : (texto(perfil.nombre) || '');
    var whatsapp = edicion ? texto(edicion.whatsapp) : texto(perfil.whatsapp);
    var redSocial = edicion ? texto(edicion.redSocial) : texto(perfil.redSocial);
    var redNombre = edicion ? texto(edicion.redSocialNombre) : texto(perfil.redSocialNombre);

    var r1 = fila();
    r1.appendChild(campo('Título', input('tiendaProdTitulo', 'text', edicion ? texto(edicion.titulo) : '', 'Ej: Canasta artesanal de mimbre')));
    var selCat = document.createElement('select');
    selCat.id = 'tiendaProdCategoria';
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
    selCat.value = edicion ? texto(edicion.categoriaId) : categoriaFiltro;
    r1.appendChild(campo('Categoría', selCat));
    card.appendChild(r1);

    var r2 = fila();
    r2.appendChild(campo('Descripción', textarea('tiendaProdDesc', edicion ? texto(edicion.descripcion) : '', 'Describe el producto, materiales, tallas, etc.'), null, true));
    card.appendChild(r2);

    var r3 = fila();
    r3.appendChild(campo('Precio', input('tiendaProdPrecio', 'text', edicion ? texto(edicion.precio) : '', 'Ej: 45.000')));
    r3.appendChild(campo('Moneda', input('tiendaProdMoneda', 'text', edicion ? texto(edicion.moneda) : 'COP', 'COP')));
    r3.appendChild(campo('% Comisión', input('tiendaProdComision', 'number', edicion ? normPct(edicion.comisionPct) : 0), 'Porcentaje que se lleva quien refiere el producto.'));
    card.appendChild(r3);

    var r4 = fila();
    r4.appendChild(campo('Imagen principal (URL)', input('tiendaProdImagen', 'url', edicion ? texto(edicion.imagen) : '', 'https://…/foto.jpg (opcional)')));
    r4.appendChild(campo('Orden', input('tiendaProdOrden', 'number', edicion ? (edicion.orden || 0) : (productosCache.length + 1)), 'Menor número, antes en el catálogo.'));
    card.appendChild(r4);

    var galeriaVal = '';
    if (edicion && Array.isArray(edicion.imagenes)) galeriaVal = edicion.imagenes.join('\n');
    var r5 = fila();
    r5.appendChild(campo('Galería (URLs, una por línea)', textarea('tiendaProdGaleria', galeriaVal, 'https://…/foto2.jpg\nhttps://…/foto3.jpg'), 'La imagen principal se toma de la primera URL válida.', true));
    card.appendChild(r5);

    var r6 = fila();
    r6.appendChild(campo('WhatsApp de contacto', input('tiendaProdWhatsapp', 'tel', whatsapp, 'Ej: 573001234567')));
    r6.appendChild(campo('Nombre del vendedor', input('tiendaProdVendedor', 'text', vendedorNombre, 'Ej: María Pérez')));
    card.appendChild(r6);

    var r7 = fila();
    r7.appendChild(campo('Red social (URL)', input('tiendaProdRed', 'url', redSocial, 'https://instagram.com/… (opcional)')));
    r7.appendChild(campo('Nombre de la red', input('tiendaProdRedNombre', 'text', redNombre, 'Instagram, Facebook, TikTok…')));
    card.appendChild(r7);

    var r8 = fila();
    r8.appendChild(campo('Publicación', check('tiendaProdPublicado', 'Publicado (visible en el catálogo público)', edicion ? esPublicado(edicion) : true), null, true));
    card.appendChild(r8);

    var acciones = el('div', 'form-actions');
    acciones.appendChild(boton(edicion ? 'Actualizar producto' : '💾 Publicar producto', 'btn btn-primary', function () {
      guardarProducto({
        titulo: $('tiendaProdTitulo').value,
        descripcion: $('tiendaProdDesc').value,
        precio: $('tiendaProdPrecio').value,
        moneda: $('tiendaProdMoneda').value,
        comisionPct: $('tiendaProdComision').value,
        imagen: $('tiendaProdImagen').value,
        imagenes: $('tiendaProdGaleria').value,
        categoriaId: selCat.value,
        orden: $('tiendaProdOrden').value,
        whatsapp: $('tiendaProdWhatsapp').value,
        vendedorNombre: $('tiendaProdVendedor').value,
        redSocial: $('tiendaProdRed').value,
        redSocialNombre: $('tiendaProdRedNombre').value,
        publicado: $('tiendaProdPublicado').checked
      }, edicion ? edicion.id : '');
    }));
    if (edicion) {
      acciones.appendChild(boton('🗑 Eliminar producto', 'btn btn-danger', function () { borrarProducto(edicion); }));
      acciones.appendChild(boton('✖ Cancelar edición', 'btn btn-outline', function () { editarProducto(''); }));
    }
    card.appendChild(acciones);

    if (!edicion) {
      card.appendChild(el('p', 'field-hint', 'Al publicar el producto se abrirá su ficha para que compruebes cómo lo verá un comprador.'));
    }
    return card;
  }

  function formMisProductos() {
    var card = adminCard(
      'Mis productos',
      'Los productos que ya has publicado con esta cuenta, incluidos los borradores.',
      '🗂️'
    );
    var mios = productosCache.filter(function (p) { return esMio(p); });
    if (!mios.length) {
      card.appendChild(el('p', 'tienda-admin-empty', 'Todavía no has publicado ningún producto. Usa el formulario de arriba para crear el primero.'));
      return card;
    }
    var lista = el('div', 'tienda-mis-productos');
    mios.forEach(function (p) {
      var row = el('div', 'tienda-mini');
      var imgUrl = imagenPrincipal(p);
      if (imgUrl) {
        var img = document.createElement('img');
        img.src = imgUrl;
        img.alt = '';
        img.loading = 'lazy';
        img.addEventListener('error', function () {
          if (img.parentNode) img.parentNode.replaceChild(el('div', 'tienda-mini-fallback', '🛍️'), img);
        });
        row.appendChild(img);
      } else {
        row.appendChild(el('div', 'tienda-mini-fallback', '🛍️'));
      }
      var body = el('div', 'tienda-mini-body');
      body.appendChild(el('h4', '', texto(p.titulo) || 'Producto sin título'));
      var meta = el('div', 'tienda-mini-meta');
      var precio = precioTexto(p);
      if (precio) meta.appendChild(el('span', '', precio));
      meta.appendChild(el('span', '', '💠 ' + normPct(p.comisionPct) + '%'));
      meta.appendChild(el('span', '', esPublicado(p) ? 'Publicado' : 'Borrador'));
      body.appendChild(meta);
      row.appendChild(body);
      var acts = el('div', 'tienda-row-actions');
      acts.appendChild(boton('✏️', 'btn btn-outline btn-sm', function () { editarProducto(p.id); }));
      acts.appendChild(boton('🗑', 'btn btn-outline btn-sm', function () { borrarProducto(p); }));
      row.appendChild(acts);
      row.addEventListener('click', function (ev) {
        if (ev.target.closest && ev.target.closest('.btn')) return;
        abrirDetalle(p.id, true);
      });
      lista.appendChild(row);
    });
    card.appendChild(lista);
    return card;
  }

  function formCategorias() {
    var card = adminCard(
      'Categorías',
      'Clasifican los productos del catálogo. Son dinámicas: se crean y se borran desde aquí, sin tocar el código.',
      '🏷️'
    );
    var lista = el('div', 'tienda-cat-admin');
    categoriasCache.forEach(function (cat) {
      var row = el('div', 'tienda-cat-admin');
      row.appendChild(el('span', 'status-pill blue', texto(cat.nombre) || 'Sin nombre'));
      row.appendChild(boton('🗑', 'btn btn-outline btn-sm', function () {
        if (!confirm('¿Eliminar la categoría "' + texto(cat.nombre) + '"? Los productos que la usan se quedan sin categoría.')) return;
        V.db.collection(COL_CATEGORIAS).doc(cat.id).delete()
          .then(function () { V.toast('Categoría eliminada ✓'); })
          .catch(function (e) { V.toast('No se pudo eliminar: ' + e.message, true); });
      }));
      lista.appendChild(row);
    });
    card.appendChild(lista);

    var nueva = input('tiendaCatNombre', 'text', '', 'Nombre de la nueva categoría');
    var alta = el('div', 'tienda-cat-admin');
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

  function editarProducto(prodId) {
    productoEditandoId = prodId || '';
    gestionando = true;
    actualizarBotonesCabecera();
    renderAdmin();
    if (!productoEditandoId) return;
    var t = $('tiendaProdTitulo');
    if (!t) return;
    t.focus();
    t.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /* ─── RESUMEN PARA LA PORTADA PÚBLICA ────────────────────────
     Un solo paso (get, no suscripción): la landing no necesita refrescarse al
     segundo y no mantiene una escucha abierta por una cifra decorativa. Filtra
     SIEMPRE por publicación, aunque quien mire sea gestor: la portada pública
     debe enseñar lo mismo que verá un visitante. */
  function resumenPublico(alTerminar) {
    var avisar = function (lista) {
      try { alTerminar(lista || []); } catch (e) { /* la portada sigue igual */ }
    };
    if (!V.db) { avisar([]); return; }
    var snaps = consultas(V.db.collection(COL_PRODUCTOS), false, '').map(function (q) {
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
     showTienda() del core solo enciende la vista: el repintado y la
     suscripción de datos viven aquí, igual que onPodcastsShow(). */
  function onShow() {
    actualizarBotonesCabecera();
    if (!haySesion()) { perfilVendedor = null; }
    else if (!perfilVendedor) cargarPerfilVendedor(function () { if (gestionando) renderAdmin(); });
    if (!V.db) {
      renderProductos();
      renderDetalle();
      return;
    }
    // onShow también es el reintento: si una suscripción se cayó por reglas sin
    // desplegar, su hueco quedó libre y aquí se vuelve a abrir.
    suscribirCategorias();
    suscribirProductos();
    renderCategorias();
    renderProductos();
    renderDetalle();
    renderAdmin();
  }

  function actualizarBotonesCabecera() {
    var acciones = $('tiendaHeaderActions');
    if (acciones) acciones.style.display = '';
    var btnGest = $('btnTiendaGestionar');
    if (btnGest) {
      btnGest.style.display = haySesion() ? '' : 'none';
      btnGest.textContent = gestionando ? '👁 Ver catálogo' : '⚙ Mi tienda';
    }
    var btnNuevo = $('btnNuevoProducto');
    if (btnNuevo) btnNuevo.style.display = haySesion() ? '' : 'none';
    var sub = $('tiendaSub');
    if (sub) {
      sub.textContent = gestionando
        ? 'Mi tienda: publica y edita tus productos, tu comisión y tus datos de contacto.'
        : 'Productos de vendedores de la comunidad con comisión directa. Toca un producto para ver su ficha y contactar.';
    }
  }

  function bindEvents() {
    var btnGest = $('btnTiendaGestionar');
    if (btnGest) btnGest.addEventListener('click', function () {
      if (!haySesion()) { if (V.openAuth) V.openAuth('login'); return; }
      gestionando = !gestionando;
      actualizarBotonesCabecera();
      if (gestionando && !perfilVendedor) cargarPerfilVendedor(function () { renderAdmin(); });
      renderAdmin();
      if (gestionando) {
        var admin = $('tiendaAdmin');
        if (admin) admin.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
    var btnNuevo = $('btnNuevoProducto');
    if (btnNuevo) btnNuevo.addEventListener('click', function () {
      if (!haySesion()) { if (V.openAuth) V.openAuth('login'); return; }
      if (!V.db) return;
      gestionando = true;
      productoEditandoId = '';
      actualizarBotonesCabecera();
      renderAdmin();
      var run = function () {
        var t = $('tiendaProdTitulo');
        if (t) { t.focus(); t.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      };
      if (!perfilVendedor) cargarPerfilVendedor(function () { renderAdmin(); run(); });
      else run();
    });
  }

  function copiar(valor) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(valor)
        .then(function () { V.toast('Enlace del producto copiado ✓'); })
        .catch(function () { V.toast('No se pudo copiar el enlace', true); });
      return;
    }
    var tmp = document.createElement('textarea');
    tmp.value = valor;
    document.body.appendChild(tmp);
    tmp.select();
    try { document.execCommand('copy'); V.toast('Enlace del producto copiado ✓'); }
    catch (e) { V.toast('No se pudo copiar el enlace', true); }
    document.body.removeChild(tmp);
  }

  /* ─── MÓDULO ────────────────────────────────────────────────── */
  V.registerModule({
    onReady: function () {
      bindEvents();
      onShow();
    }
  });
  V.onTiendaShow = onShow;

  // La identidad puede cambiar después de montado el módulo (el visitante crea
  // su cuenta): las suscripciones se rehacen con el alcance que corresponde.
  var _onSessionRefreshPrev = V.onSessionRefresh;
  V.onSessionRefresh = function () {
    if (typeof _onSessionRefreshPrev === 'function') {
      try { _onSessionRefreshPrev(); } catch (e) { /* noop */ }
    }
    reconstruirSuscripciones();
    if (!haySesion()) perfilVendedor = null;
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
  V.tienda = {
    COL_CATEGORIAS: COL_CATEGORIAS,
    COL_PRODUCTOS: COL_PRODUCTOS,
    COL_VENDEDORES: COL_VENDEDORES,
    show: function () { if (V.showTienda) V.showTienda(); },
    abrirProducto: abrirDetalle,
    lista: productosVisibles,
    resumenPublico: resumenPublico
  };
})();
