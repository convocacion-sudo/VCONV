/* ════════════════════════════════════════════════════════════════
   VCONV · Módulo de Configuración
   Panel único de los ajustes de la plataforma. Cada pestaña escribe en
   su documento de la colección `config` y el resto de la aplicación lo
   lee desde ahí:

      Portal / Home      → config/portal.copy   (el copy de la portada)
      Fichas del Home    → fichas/{id}          (las tarjetas de la portada)
      Identidad y marca  → config/identidad
      Campos de formularios → config/formulario  (estructura de Registro y
                           Perfil, con 4 estados por campo)
      Roles y módulos    → (solo lectura: el permiso real vive en el
                           código y en firestore.rules)
      Finanzas y MLM     → config/finanzas       (+ config/mlm, sincronizado)
      Datos operativos   → finanzas_cuentas      (contable + superadmin)

   REGLAS DE LA FASE 1
   · El superadmin edita todas las pestañas.
   · El rol 'contable' solo entra a "Datos operativos" (cuentas
     bancarias y transacciones). Los interruptores y los porcentajes son
     EXCLUSIVOS del superadmin, y firestore.rules lo impone igual
     (config/finanzas solo se escribe con isAdmin()).
   · Nada de controles falsos: lo que se ve guarda de verdad, y lo que
     no se puede guardar desde aquí no aparece. Todo lo que se guarda se
     aplica al instante, sin desplegar.

   La lógica de negocio no se duplica aquí: el módulo llama a las APIs
   que ya tienen los demás módulos (V.finanzas, V.mlm) y a la colección
   `config`, de modo que el panel y la aplicación nunca pueden divergir.
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var V = window.VCONV;
  if (!V) { console.error('VCONV core not loaded'); return; }

  var CONFIG_COLLECTION = 'config';
  var BASE_CONTENT_PATH = '/data/content.json';
  var TAB_KEY = 'vconv_settings_tab';

  function $(id) { return V.$ ? V.$(id) : document.getElementById(id); }
  function el(tag, cls, text) { return V.el(tag, cls, text); }
  function esSuper() { return typeof V.tieneRol === 'function' ? V.tieneRol('superadmin') : V.userRole === 'superadmin'; }
  function esContable() { return typeof V.tieneRol === 'function' ? V.tieneRol('contable') : false; }
  function toast(msg, error) { if (typeof V.toast === 'function') V.toast(msg, error); }

  /* Aviso con marcado (etiquetas <code>, <strong>). El texto es fijo del
     propio módulo, nunca dato del usuario: por eso aquí sí se usa
     innerHTML y en el resto de la interfaz se usa textContent. */
  function notaHTML(html) {
    var d = el('div');
    d.innerHTML = html;
    return d;
  }

  /* ─── PESTAÑAS ──────────────────────────────────────────────── */
  var TABS = [
    { id: 'portal', label: 'Portal / Home', icon: '🏠', roles: ['superadmin'], render: renderPortal },
    { id: 'fichas', label: 'Fichas del Home', icon: '🗂️', roles: ['superadmin'], render: renderFichas },
    { id: 'identidad', label: 'Identidad y marca', icon: '🎨', roles: ['superadmin'], render: renderIdentidad },
    { id: 'campos', label: 'Campos de formularios', icon: '📝', roles: ['superadmin'], render: renderCampos },
    { id: 'roles', label: 'Roles y módulos', icon: '🔑', roles: ['superadmin'], render: renderRoles },
    { id: 'finanzas', label: 'Finanzas y MLM', icon: '💰', roles: ['superadmin'], render: renderFinanzas },
    { id: 'operativos', label: 'Datos operativos', icon: '🏦', roles: ['superadmin', 'contable'], render: renderOperativos }
  ];

  var tabActual = null;

  /* ─── UTILIDADES DE FIRESTORE ──────────────────────────────── */
  function leerDoc(id) {
    if (!V.db) return Promise.resolve({});
    return V.db.collection(CONFIG_COLLECTION).doc(id).get()
      .then(function (doc) { return (doc && doc.exists) ? (doc.data() || {}) : {}; })
      .catch(function (e) {
        console.warn('[settings] no se pudo leer config/' + id + ':', e && e.message);
        return {};
      });
  }

  function guardarDoc(id, data) {
    if (!V.db) return Promise.reject(new Error('Firestore no disponible.'));
    return V.db.collection(CONFIG_COLLECTION).doc(id).set(data, { merge: true });
  }

  function cargarBaseContent() {
    return fetch(BASE_CONTENT_PATH)
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .catch(function () { return { portal: { hero: {}, sections: {} }, blocks: [], contact: {}, footer: {} }; });
  }

  function leerPorRuta(obj, path) {
    var cur = obj;
    for (var i = 0; i < path.length; i++) {
      if (!cur || typeof cur !== 'object') return undefined;
      cur = cur[path[i]];
    }
    return cur;
  }

  function escribirPorRuta(obj, path, valor) {
    var cur = obj;
    for (var i = 0; i < path.length - 1; i++) {
      var k = path[i];
      if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
      cur = cur[k];
    }
    cur[path[path.length - 1]] = valor;
    return obj;
  }

  function clonar(v) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(clonar);
    var out = {};
    Object.keys(v).forEach(function (k) { out[k] = clonar(v[k]); });
    return out;
  }

  /* ─── CONSTRUCTOR DE FORMULARIOS ───────────────────────────── */
  function grupo(parent, titulo, descripcion, icono) {
    var card = el('section', 'set-card');
    if (icono) {
      var head = el('div', 'set-card-head');
      head.appendChild(el('span', 'icon-chip sm', icono));
      var hh = el('div');
      hh.appendChild(el('h3', '', titulo));
      if (descripcion) hh.appendChild(el('p', '', descripcion));
      head.appendChild(hh);
      card.appendChild(head);
    } else {
      var h3 = el('h3', 'set-card-title', titulo);
      card.appendChild(h3);
      if (descripcion) card.appendChild(el('p', 'set-card-desc', descripcion));
    }
    var body = el('div', 'set-card-body');
    card.appendChild(body);
    parent.appendChild(card);
    return body;
  }

  function campo(parent, etiqueta, valor, opts) {
    opts = opts || {};
    var wrap = el('div', 'set-field' + (opts.ancho === 'full' ? ' full' : ''));
    if (etiqueta) wrap.appendChild(el('label', 'set-label', etiqueta));
    var input;
    if (opts.tipo === 'area') {
      input = document.createElement('textarea');
      input.className = 'input set-textarea';
      input.rows = opts.filas || 3;
    } else {
      input = document.createElement('input');
      input.type = opts.tipo || 'text';
      input.className = 'input' + (opts.tipo === 'color' ? ' set-color' : '');
    }
    input.value = (valor === undefined || valor === null) ? '' : String(valor);
    if (opts.placeholder) input.placeholder = opts.placeholder;
    if (opts.min !== undefined) input.min = opts.min;
    if (opts.max !== undefined) input.max = opts.max;
    if (opts.step !== undefined) input.step = opts.step;
    wrap.appendChild(input);
    if (opts.ayuda) wrap.appendChild(el('p', 'set-help', opts.ayuda));
    parent.appendChild(wrap);
    return input;
  }

  function selector(parent, etiqueta, valor, opciones, opts) {
    opts = opts || {};
    var wrap = el('div', 'set-field' + (opts.ancho === 'full' ? ' full' : ''));
    if (etiqueta) wrap.appendChild(el('label', 'set-label', etiqueta));
    var sel = document.createElement('select');
    sel.className = 'select';
    opciones.forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o[0];
      opt.textContent = o[1];
      sel.appendChild(opt);
    });
    sel.value = (valor === undefined || valor === null) ? '' : String(valor);
    wrap.appendChild(sel);
    if (opts.ayuda) wrap.appendChild(el('p', 'set-help', opts.ayuda));
    parent.appendChild(wrap);
    return sel;
  }

  function interruptor(parent, etiqueta, valor, ayuda) {
    var wrap = el('label', 'set-switch');
    var input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!valor;
    wrap.appendChild(input);
    wrap.appendChild(el('span', 'set-switch-slider', ''));
    var txt = el('span', 'set-switch-text', etiqueta);
    wrap.appendChild(txt);
    if (ayuda) wrap.appendChild(el('span', 'set-help', ayuda));
    parent.appendChild(wrap);
    return input;
  }

  function boton(parent, texto, clase, onClick) {
    var b = el('button', 'btn ' + (clase || 'btn-outline'), texto);
    b.type = 'button';
    if (onClick) b.addEventListener('click', onClick);
    parent.appendChild(b);
    return b;
  }

  function botonGuardar(parent, onClick) {
    var wrap = el('div', 'set-actions');
    var b = el('button', 'btn btn-primary', '💾 Guardar cambios');
    b.type = 'button';
    b.addEventListener('click', function () {
      b.disabled = true;
      var original = b.textContent;
      b.textContent = '⏳ Guardando…';
      Promise.resolve(onClick()).then(function () {
        b.disabled = false;
        b.textContent = original;
      }).catch(function (e) {
        b.disabled = false;
        b.textContent = original;
        toast('Error al guardar: ' + (e && e.message ? e.message : e), true);
      });
    });
    wrap.appendChild(b);
    parent.appendChild(wrap);
    return b;
  }

  function listaTexto(parent, etiqueta, valores, placeholder, ayuda) {
    // Editor de una lista de textos (menú de la portada, asuntos del
    // formulario de contacto). Una línea por elemento.
    var wrap = el('div', 'set-field full');
    wrap.appendChild(el('label', 'set-label', etiqueta));
    var ta = document.createElement('textarea');
    ta.className = 'input set-textarea';
    ta.rows = 4;
    ta.value = (valores || []).join('\n');
    if (placeholder) ta.placeholder = placeholder;
    wrap.appendChild(ta);
    if (ayuda) wrap.appendChild(el('p', 'set-help', ayuda));
    parent.appendChild(wrap);
    return {
      control: ta,
      valor: function () {
        return ta.value.split('\n')
          .map(function (s) { return s.trim(); })
          .filter(function (s) { return s.length > 0; });
      }
    };
  }

  /* ─── PESTAÑA · PORTAL / HOME ──────────────────────────────── */
  /* El copy de la portada vive en config/portal.copy y tiene la MISMA
     forma que public/data/content.json: el archivo local sigue siendo
     la base y lo guardado en Firestore se fusiona encima (V.mergeProfundo).
     Así el contenido se edita sin desplegar y, si el documento se borra,
     la portada vuelve al contenido local sin romperse. */
  var CAMPOS_PORTAL = [
    {
      titulo: 'Marca y navegación', icono: '🏷️', descripcion: 'El nombre de la marca y las entradas del menú público.',
      items: [
        { path: ['portal', 'brand'], label: 'Nombre de la marca', placeholder: 'VCONV' },
        { path: ['portal', 'nav'], tipo: 'lista', label: 'Menú público', placeholder: 'Inicio\nPilares\nContacto', ayuda: 'Una entrada por línea. Se usan como enlaces del menú de la portada.' }
      ]
    },
    {
      titulo: 'Hero (bloque principal)', icono: '✨', descripcion: 'Lo primero que ve el visitante.',
      items: [
        { path: ['portal', 'hero', 'badge'], label: 'Antetítulo', placeholder: 'Plataforma de formación y acompañamiento' },
        { path: ['portal', 'hero', 'title'], label: 'Título', placeholder: 'Crece en lo personal, lo espiritual y lo comunitario' },
        { path: ['portal', 'hero', 'subtitle'], label: 'Subtítulo', tipo: 'area' },
        { path: ['portal', 'hero', 'ctaPrimary'], label: 'Botón principal (texto)' },
        { path: ['portal', 'hero', 'ctaPrimaryTarget'], label: 'Botón principal (destino)', tipo: 'select', opciones: [['register', 'Registro'], ['login', 'Iniciar sesión'], ['blocks', 'Pilares'], ['courses', 'Cursos']] },
        { path: ['portal', 'hero', 'ctaSecondary'], label: 'Botón secundario (texto)' },
        { path: ['portal', 'hero', 'ctaSecondaryTarget'], label: 'Botón secundario (destino)', tipo: 'select', opciones: [['blocks', 'Pilares'], ['courses', 'Cursos'], ['register', 'Registro'], ['contact', 'Contacto']] },
        { path: ['portal', 'hero', 'ctaCourses'], label: 'Botón de cursos', placeholder: '📚 Ver cursos gratuitos' }
      ]
    },
    {
      titulo: 'Secciones', icono: '🧩', descripcion: 'Encabezados de cada bloque de la portada.',
      items: [
        { path: ['portal', 'sections', 'courses', 'eyebrow'], label: 'Cursos · antetítulo' },
        { path: ['portal', 'sections', 'courses', 'title'], label: 'Cursos · título' },
        { path: ['portal', 'sections', 'courses', 'subtitle'], label: 'Cursos · subtítulo', tipo: 'area' },
        { path: ['portal', 'sections', 'podcasts', 'eyebrow'], label: 'Podcasts · antetítulo' },
        { path: ['portal', 'sections', 'podcasts', 'title'], label: 'Podcasts · título' },
        { path: ['portal', 'sections', 'podcasts', 'subtitle'], label: 'Podcasts · subtítulo', tipo: 'area' },
        { path: ['portal', 'sections', 'podcasts', 'cta'], label: 'Podcasts · botón' },
        { path: ['portal', 'sections', 'tienda', 'eyebrow'], label: 'Tienda · antetítulo' },
        { path: ['portal', 'sections', 'tienda', 'title'], label: 'Tienda · título' },
        { path: ['portal', 'sections', 'tienda', 'subtitle'], label: 'Tienda · subtítulo', tipo: 'area' },
        { path: ['portal', 'sections', 'tienda', 'cta'], label: 'Tienda · botón' },
        { path: ['portal', 'sections', 'blocks', 'eyebrow'], label: 'Pilares · antetítulo' },
        { path: ['portal', 'sections', 'blocks', 'title'], label: 'Pilares · título' },
        { path: ['portal', 'sections', 'blocks', 'subtitle'], label: 'Pilares · subtítulo', tipo: 'area' },
        { path: ['portal', 'sections', 'fichas', 'eyebrow'], label: 'Fichas · antetítulo' },
        { path: ['portal', 'sections', 'fichas', 'title'], label: 'Fichas · título' },
        { path: ['portal', 'sections', 'fichas', 'subtitle'], label: 'Fichas · subtítulo', tipo: 'area' },
        { path: ['portal', 'sections', 'contact', 'eyebrow'], label: 'Contacto · antetítulo' },
        { path: ['portal', 'sections', 'contact', 'title'], label: 'Contacto · título' },
        { path: ['portal', 'sections', 'contact', 'subtitle'], label: 'Contacto · subtítulo', tipo: 'area' }
      ]
    },
    {
      titulo: 'Formulario de contacto', icono: '✉️', descripcion: 'Etiquetas, textosAyuda y asunto predeterminado.',
      items: [
        { path: ['contact', 'labels', 'nombre'], label: 'Etiqueta · nombre' },
        { path: ['contact', 'labels', 'email'], label: 'Etiqueta · correo' },
        { path: ['contact', 'labels', 'asunto'], label: 'Etiqueta · asunto' },
        { path: ['contact', 'labels', 'mensaje'], label: 'Etiqueta · mensaje' },
        { path: ['contact', 'labels', 'submit'], label: 'Etiqueta · botón' },
        { path: ['contact', 'placeholders', 'nombre'], label: 'Ayuda · nombre' },
        { path: ['contact', 'placeholders', 'email'], label: 'Ayuda · correo' },
        { path: ['contact', 'placeholders', 'mensaje'], label: 'Ayuda · mensaje' },
        { path: ['contact', 'asuntos'], tipo: 'lista', label: 'Asuntos disponibles', placeholder: 'Información general\nOtro', ayuda: 'Una línea por asunto.' },
        { path: ['contact', 'successMessage'], label: 'Mensaje de éxito' }
      ]
    },
    {
      titulo: 'Pie de página', icono: '🔻',
      items: [
        { path: ['footer', 'text'], label: 'Texto del pie', tipo: 'area' },
        { path: ['footer', 'copyright'], label: 'Copyright' }
      ]
    }
  ];

  function renderPortal(container) {
    container.appendChild(el('p', 'set-loading', 'Cargando el contenido de la portada…'));

    Promise.all([leerDoc('portal'), cargarBaseContent()]).then(function (r) {
      var doc = r[0] || {};
      var base = r[1] || {};
      var copyGuardado = (doc.copy && typeof doc.copy === 'object') ? doc.copy : {};
      // Lo que ve el visitante ahora mismo: la base local con el copy
      // guardado encima. El formulario se abre sobre ese valor, no sobre
      // el archivo, para no editar algo que ya no se muestra.
      var efectivo = V.mergeProfundo ? V.mergeProfundo(base, copyGuardado) : base;

      container.innerHTML = '';
      var notice = el('div', 'set-notice');
      notice.appendChild(el('span', 'set-notice-ico', 'ℹ️'));
      notice.appendChild(notaHTML('Estos textos se guardan en <code>config/portal.copy</code> y pasan a ser la fuente de la portada: <code>public/data/content.json</code> queda solo como semilla inicial. La sección de video se edita en el Panel del Super Admin.'));
      container.appendChild(notice);

      var controles = [];

      /* ─── AJUSTES GENERALES · MODO MANTENIMIENTO ────────────────
         El estado del modo mantenimiento NO va dentro de `copy`: es un
         dato de OPERACIÓN, no un texto de la landing. Se guarda en la
         clave `mantenimiento` del MISMO documento `config/portal`, que ya
         es legible sin sesión (regla esPublico() en firestore.rules) y
         que solo puede escribir el superadmin (isAdmin()).

         Lo aplica core/mantenimiento.js: con el interruptor encendido, los
         visitantes y los estudiantes ven la pantalla de aviso, mientras
         que el superadmin y el contable siguen dentro para poder probar y
         operar la plataforma. */
      var cfgMant = (doc.mantenimiento && typeof doc.mantenimiento === 'object') ? doc.mantenimiento : {};
      var MENSAJE_MANT_POR_DEFECTO = 'Estamos realizando mejoras en la plataforma. Vuelve en breve.';
      var cuerpoMant = grupo(container, 'Ajustes generales', 'Estado de la plataforma para el público.', '⚙️');
      var swMant = interruptor(cuerpoMant, 'Activar Modo Mantenimiento', cfgMant.activo === true,
        'Mientras esté activo, los visitantes y los estudiantes encontrarán una pantalla de aviso en lugar de la aplicación. El superadmin y el contable siguen entrando con normalidad para probarla.');
      var inMensajeMant = campo(cuerpoMant, 'Mensaje de mantenimiento', cfgMant.mensaje || MENSAJE_MANT_POR_DEFECTO, { tipo: 'area' });

      CAMPOS_PORTAL.forEach(function (g) {
        var body = grupo(container, g.titulo, g.descripcion, g.icono);
        g.items.forEach(function (it) {
          var valor = leerPorRuta(efectivo, it.path);
          if (it.tipo === 'lista') {
            var l = listaTexto(body, it.label, Array.isArray(valor) ? valor : [], it.placeholder, it.ayuda);
            controles.push({ path: it.path, tipo: 'lista', leer: l.valor });
            return;
          }
          if (it.tipo === 'select') {
            var sel = selector(body, it.label, valor, it.opciones);
            controles.push({ path: it.path, tipo: 'texto', leer: function (c) { return c.value; }, control: sel });
            return;
          }
          var inp = campo(body, it.label, valor, { tipo: it.tipo, placeholder: it.placeholder });
          controles.push({ path: it.path, tipo: 'texto', leer: function (c) { return c.value; }, control: inp });
        });
      });

      // Los pilares (bloques) son una lista de tarjetas: se editan uno a
      // uno, con sus propios controles.
      var cuerpoBloques = grupo(container, 'Pilares (bloques)', 'Los seis frentes de trabajo que se muestran en la portada.', '🌱');
      var editorBloques = el('div', 'set-sublista');
      cuerpoBloques.appendChild(editorBloques);
      var bloques = Array.isArray(efectivo.blocks) ? clonar(efectivo.blocks) : [];

      function pintarBloques() {
        editorBloques.innerHTML = '';
        bloques.forEach(function (b, i) {
          var card = el('div', 'set-item');
          var head = el('div', 'set-item-head');
          head.appendChild(el('span', 'set-item-title', (b.icon || '✦') + ' ' + (b.title || 'Sin título')));
          var acc = el('div', 'set-item-acc');
          var btnUp = boton(acc, '↑', 'btn-outline btn-sm', function () {
            if (i === 0) return;
            var tmp = bloques[i - 1]; bloques[i - 1] = bloques[i]; bloques[i] = tmp;
            pintarBloques();
          });
          var btnDown = boton(acc, '↓', 'btn-outline btn-sm', function () {
            if (i >= bloques.length - 1) return;
            var tmp = bloques[i + 1]; bloques[i + 1] = bloques[i]; bloques[i] = tmp;
            pintarBloques();
          });
          var btnDel = boton(acc, '✕', 'btn-outline btn-sm', function () {
            bloques.splice(i, 1);
            pintarBloques();
          });
          btnUp.title = 'Subir'; btnDown.title = 'Bajar'; btnDel.title = 'Eliminar';
          head.appendChild(acc);
          card.appendChild(head);
          var grid = el('div', 'set-grid');
          var iconInp = campo(grid, 'Icono', b.icon, { placeholder: '🌱' });
          var accentInp = selector(grid, 'Color', b.accent, [['green', 'Verde'], ['blue', 'Azul'], ['teal', 'Turquesa'], ['amber', 'Ámbar'], ['rose', 'Rosa'], ['indigo', 'Índigo']]);
          var titleInp = campo(grid, 'Título', b.title);
          var highInp = campo(grid, 'Destacado', b.highlight);
          var textInp = campo(grid, 'Texto', b.text, { tipo: 'area', ancho: 'full' });
          card.appendChild(grid);
          editorBloques.appendChild(card);
          b._refs = { icon: iconInp, accent: accentInp, title: titleInp, highlight: highInp, text: textInp };
        });
        boton(editorBloques, '➕ Añadir pilar', 'btn-outline btn-sm', function () {
          bloques.push({ icon: '✦', accent: 'blue', title: '', text: '', highlight: '' });
          pintarBloques();
        });
      }
      pintarBloques();

      botonGuardar(container, function () {
        var nuevo = clonar(copyGuardado);
        controles.forEach(function (c) {
          var valor = c.tipo === 'lista' ? c.leer() : c.leer(c.control);
          escribirPorRuta(nuevo, c.path, valor);
        });
        nuevo.blocks = bloques.map(function (b) {
          var r = b._refs || {};
          return {
            icon: r.icon ? r.icon.value : (b.icon || ''),
            accent: r.accent ? r.accent.value : (b.accent || 'blue'),
            title: r.title ? r.title.value : (b.title || ''),
            text: r.text ? r.text.value : (b.text || ''),
            highlight: r.highlight ? r.highlight.value : (b.highlight || '')
          };
        });
        var mant = {
          activo: swMant.checked === true,
          mensaje: String(inMensajeMant.value || '').trim() || MENSAJE_MANT_POR_DEFECTO
        };
        return guardarDoc('portal', { copy: nuevo, mantenimiento: mant }).then(function () {
          // Se aplica en esta misma sesión (y en las demás, por la escucha en
          // vivo de core/mantenimiento.js) sin tener que recargar.
          if (V.mantenimiento && typeof V.mantenimiento.guardar === 'function') {
            V.mantenimiento.guardar(mant);
          }
          toast('Contenido de la portada guardado ✓' + (mant.activo ? ' · Modo mantenimiento ACTIVADO' : ''));
        });
      });
    }).catch(function (e) {
      container.innerHTML = '';
      container.appendChild(el('p', 'set-error', 'No se pudo cargar la portada: ' + (e && e.message ? e.message : e)));
    });
  }

  /* ─── PESTAÑA · FICHAS DEL HOME ─────────────────────────────── */
  /* Las fichas son las tarjetas de la portada. Cada una puede llevar un
     texto enriquecido y un medio (imagen o vídeo), y se publica o se deja
     en borrador. Viven en la colección `fichas` (un documento por ficha)
     y no en el copy de la portada: así se pueden ordenar, publicar y
     borrar sin tocar los textos de las secciones. */
  var COL_FICHAS = 'fichas';

  function ordenarFichas(a, b) {
    var oa = Number(a.orden);
    var ob = Number(b.orden);
    if (!isFinite(oa)) oa = 9999;
    if (!isFinite(ob)) ob = 9999;
    if (oa !== ob) return oa - ob;
    return String(a.titulo || '').localeCompare(String(b.titulo || ''));
  }

  function leerFichas() {
    if (!V.db) return Promise.resolve([]);
    return V.db.collection(COL_FICHAS).get().then(function (snap) {
      var out = [];
      snap.forEach(function (doc) {
        var data = doc.data() || {};
        data.id = doc.id;
        out.push(data);
      });
      out.sort(ordenarFichas);
      return out;
    }).catch(function (e) {
      console.warn('[settings] no se pudieron leer las fichas:', e && e.message);
      return [];
    });
  }

  function medioDe(ficha) {
    // Dos formas de llegar al mismo medio: el documento guardado en Firestore
    // (campos planos mediaTipo/mediaUrl/mediaFuente) y el objeto del editor
    // en memoria (medio: { tipo, url, fuente }). Se cubren las dos para que
    // el medio no se pierda al guardar.
    if (ficha && ficha.medio) {
      return {
        tipo: ficha.medio.tipo || 'ninguna',
        url: ficha.medio.url || '',
        fuente: ficha.medio.fuente || 'auto'
      };
    }
    return {
      tipo: ficha.mediaTipo || 'ninguna',
      url: ficha.mediaUrl || '',
      fuente: ficha.mediaFuente || 'auto'
    };
  }

  function guardarFicha(ficha) {
    if (!V.db) return Promise.reject(new Error('Firestore no disponible.'));
    var ref = V.db.collection(COL_FICHAS).doc(ficha.id);
    var medio = V.multimedia ? V.multimedia.normalizarMedio(medioDe(ficha)) : { tipo: 'ninguna', url: '', fuente: 'auto' };
    var ahora = new Date().toISOString();
    var data = {
      titulo: String(ficha.titulo || '').trim(),
      subtitulo: String(ficha.subtitulo || '').trim(),
      icono: String(ficha.icono || '').trim(),
      texto: String(ficha.texto || ''),
      mediaTipo: medio.tipo,
      mediaUrl: medio.url,
      mediaFuente: medio.fuente,
      publicado: !!ficha.publicado,
      orden: Number(ficha.orden) || 0,
      actualizado: ahora
    };
    if (!ficha.creado) data.creado = ahora;
    return ref.set(data, { merge: true }).then(function () { return data; });
  }

  function eliminarFicha(id) {
    if (!V.db || !id) return Promise.reject(new Error('Ficha no válida.'));
    return V.db.collection(COL_FICHAS).doc(id).delete();
  }

  /* ─── SELECTOR MULTIMEDIA ──────────────────────────────────────
     Elige una imagen o un vídeo. Sigue el patrón del módulo de Tiendas
     (una URL validada + el tipo de fuente) y usa el clasificador de
     core/multimedia.js, que es el MISMO que usa la portada para el
     vídeo corporativo: lo que se ve aquí es lo que se verá allí. */
  function abrirSelectorMedio(opciones, alElegir) {
    opciones = opciones || {};
    var actual = opciones.actual || { tipo: 'ninguna', url: '', fuente: 'auto' };
    var galeria = opciones.galeria || [];

    var overlay = el('div', 'set-modal-overlay');
    var card = el('div', 'set-modal');

    var head = el('div', 'set-modal-head');
    head.appendChild(el('h3', '', '🖼️ Selector de medios'));
    var cerrar = el('button', 'set-modal-x', '✕');
    cerrar.type = 'button';
    cerrar.title = 'Cerrar';
    cerrar.addEventListener('click', function () { overlay.remove(); });
    head.appendChild(cerrar);
    card.appendChild(head);

    var cuerpo = el('div', 'set-modal-body');
    card.appendChild(cuerpo);

    // Pestañas: imagen o vídeo.
    var tipoSel = el('div', 'set-tabs-mini');
    var btnImg = el('button', 'set-tab-mini', '🖼️ Imagen');
    var btnVid = el('button', 'set-tab-mini', '🎬 Vídeo');
    btnImg.type = 'button';
    btnVid.type = 'button';
    tipoSel.appendChild(btnImg);
    tipoSel.appendChild(btnVid);
    cuerpo.appendChild(tipoSel);

    var fieldUrl = el('div', 'set-field full');
    fieldUrl.appendChild(el('label', 'set-label', 'URL del medio'));
    var inUrl = document.createElement('input');
    inUrl.type = 'url';
    inUrl.className = 'input';
    inUrl.placeholder = 'https://…';
    fieldUrl.appendChild(inUrl);
    cuerpo.appendChild(fieldUrl);

    var fieldFuente = el('div', 'set-field full');
    fieldFuente.appendChild(el('label', 'set-label', 'Tipo de fuente (vídeo)'));
    var selFuente = document.createElement('select');
    selFuente.className = 'select';
    (V.multimedia ? V.multimedia.TIPOS_VIDEO : [['auto', 'Detectar automáticamente']]).forEach(function (t) {
      var o = document.createElement('option');
      o.value = t[0];
      o.textContent = t[1];
      selFuente.appendChild(o);
    });
    fieldFuente.appendChild(selFuente);
    var ayudaFuente = el('p', 'set-help', 'YouTube, Google Drive y Vimeo se reescriben a su forma de incrustación; el resto se reproduce tal cual.');
    fieldFuente.appendChild(ayudaFuente);
    cuerpo.appendChild(fieldFuente);

    var preview = el('div', 'set-media-preview');
    cuerpo.appendChild(preview);

    // Galería: los medios que ya usan las otras fichas.
    if (galeria.length) {
      var boxGal = el('div', 'set-field full');
      boxGal.appendChild(el('label', 'set-label', 'Medios ya usados en las fichas'));
      var gal = el('div', 'set-galeria');
      galeria.forEach(function (m) {
        var b = el('button', 'set-gal-item');
        b.type = 'button';
        b.title = m.url;
        if (m.tipo === 'imagen') {
          var img = document.createElement('img');
          img.src = m.url;
          img.alt = '';
          img.loading = 'lazy';
          b.appendChild(img);
        } else {
          b.appendChild(el('span', 'set-gal-ico', '🎬'));
        }
        b.addEventListener('click', function () {
          inUrl.value = m.url;
          if (m.tipo === 'imagen') setTipo('imagen'); else setTipo('video');
          refrescar();
        });
        gal.appendChild(b);
      });
      boxGal.appendChild(gal);
      cuerpo.appendChild(boxGal);
    }

    var pie = el('div', 'set-modal-foot');
    var btnCancelar = el('button', 'btn btn-outline', 'Cancelar');
    btnCancelar.type = 'button';
    btnCancelar.addEventListener('click', function () { overlay.remove(); });
    var btnUsar = el('button', 'btn btn-primary', 'Usar este medio');
    btnUsar.type = 'button';
    btnUsar.addEventListener('click', function () {
      var url = String(inUrl.value || '').trim();
      var medio = { tipo: tipoActual, url: url, fuente: selFuente.value };
      if (V.multimedia) medio = V.multimedia.normalizarMedio(medio);
      overlay.remove();
      alElegir(medio);
    });
    pie.appendChild(btnCancelar);
    pie.appendChild(btnUsar);
    card.appendChild(pie);

    var tipoActual = actual.tipo === 'imagen' || actual.tipo === 'video' ? actual.tipo : 'imagen';

    function setTipo(t) {
      tipoActual = t;
      btnImg.classList.toggle('is-active', t === 'imagen');
      btnVid.classList.toggle('is-active', t === 'video');
      fieldFuente.style.display = t === 'video' ? '' : 'none';
      inUrl.placeholder = t === 'imagen'
        ? 'https://…/foto.jpg'
        : 'https://www.youtube.com/watch?v=… · https://…/video.mp4';
      refrescar();
    }

    function refrescar() {
      var url = String(inUrl.value || '').trim();
      if (!url) {
        preview.innerHTML = '';
        preview.appendChild(el('p', 'set-help', 'Sin URL no hay medio que mostrar.'));
        return;
      }
      if (V.multimedia) {
        V.multimedia.montarMedio(preview, { tipo: tipoActual, url: url, fuente: selFuente.value }, { clase: 'set-media-img' });
      } else {
        preview.textContent = url;
      }
    }

    btnImg.addEventListener('click', function () { setTipo('imagen'); });
    btnVid.addEventListener('click', function () { setTipo('video'); });
    inUrl.addEventListener('input', refrescar);
    selFuente.addEventListener('change', refrescar);

    inUrl.value = actual.url || '';
    selFuente.value = actual.fuente || 'auto';
    setTipo(tipoActual);

    overlay.appendChild(card);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
    inUrl.focus();
  }

  function renderFichas(container) {
    container.appendChild(el('p', 'set-loading', 'Cargando las fichas…'));
    leerFichas().then(function (fichas) {
      container.innerHTML = '';

      var notice = el('div', 'set-notice');
      notice.appendChild(el('span', 'set-notice-ico', '🗂️'));
      notice.appendChild(notaHTML('Las fichas se guardan en la colección <code>fichas</code> y aparecen en la portada. Solo se muestran las <strong>publicadas</strong>: las borradores se pueden dejar a medias sin que el visitante las vea. El texto admite formato (negrita, cursiva, color y tamaño) y cada ficha puede llevar una imagen o un vídeo.'));
      container.appendChild(notice);

      var sel = fichas.length ? 0 : -1;

      var cuerpo = grupo(container, 'Fichas de la portada', 'Ordena, publica y edita cada tarjeta.', '🗂️');
      var lista = el('div', 'set-sublista');
      cuerpo.appendChild(lista);
      var editor = el('div', 'set-editor');
      cuerpo.appendChild(editor);

      function pintarLista() {
        lista.innerHTML = '';
        if (!fichas.length) {
          lista.appendChild(el('p', 'set-vacio', 'Todavía no hay fichas. Crea la primera con «➕ Nueva ficha».'));
        }
        fichas.forEach(function (f, i) {
          var item = el('div', 'set-item' + (sel === i ? ' is-active' : ''));
          var head = el('div', 'set-item-head');
          head.appendChild(el('span', 'set-item-title', (f.icono || '✦') + ' ' + (f.titulo || 'Sin título')));
          var acc = el('div', 'set-item-acc');
          boton(acc, '↑', 'btn-outline btn-sm', function () {
            if (i === 0) return;
            var t = fichas[i - 1]; fichas[i - 1] = fichas[i]; fichas[i] = t;
            pintarLista(); pintarEditor();
          }).title = 'Subir';
          boton(acc, '↓', 'btn-outline btn-sm', function () {
            if (i >= fichas.length - 1) return;
            var t = fichas[i + 1]; fichas[i + 1] = fichas[i]; fichas[i] = t;
            pintarLista(); pintarEditor();
          }).title = 'Bajar';
          boton(acc, '✏️', 'btn-outline btn-sm', function () { sel = i; pintarLista(); pintarEditor(); }).title = 'Editar';
          boton(acc, '✕', 'btn-outline btn-sm', function () {
            if (!window.confirm('¿Eliminar la ficha "' + (f.titulo || 'sin título') + '"?')) return;
            eliminarFicha(f.id).then(function () {
              fichas.splice(i, 1);
              if (sel >= fichas.length) sel = fichas.length - 1;
              pintarLista(); pintarEditor();
              toast('Ficha eliminada ✓');
            }).catch(function (e) { toast('No se pudo eliminar: ' + (e && e.message ? e.message : e), true); });
          }).title = 'Eliminar';
          head.appendChild(acc);
          item.appendChild(head);
          var sub = el('p', 'set-item-sub');
          sub.textContent = (f.publicado ? '🟢 Publicado' : '⚪ Borrador') + ' · orden ' + (Number(f.orden) || 0);
          item.appendChild(sub);
          lista.appendChild(item);
        });
        boton(lista, '➕ Nueva ficha', 'btn-outline btn-sm', function () {
          sel = -1;
          pintarLista();
          pintarEditor();
        });
      }

      function pintarEditor() {
        editor.innerHTML = '';
        var f = (sel >= 0 && sel < fichas.length) ? fichas[sel] : null;
        var nueva = !f;

        var refs = {};
        var grid = el('div', 'set-grid');
        refs.titulo = campo(grid, 'Título', f ? f.titulo : '', { placeholder: 'Crecimiento personal y espiritual' });
        refs.subtitulo = campo(grid, 'Subtítulo', f ? f.subtitulo : '', { placeholder: 'Una frase corta' });
        refs.icono = campo(grid, 'Icono (emoji)', f ? f.icono : '✦', { placeholder: '🌱' });
        editor.appendChild(grid);

        // Texto enriquecido
        editor.appendChild(el('h4', 'set-subhead', 'Texto de la ficha'));
        var hostTexto = el('div', 'set-field full');
        editor.appendChild(hostTexto);
        var rt = null;
        if (V.richtext && typeof V.richtext.crear === 'function') {
          rt = V.richtext.crear(hostTexto, { placeholder: 'Escribe el texto de la ficha…' });
          if (f && f.texto) rt.setHtml(f.texto);
        } else {
          var ta = document.createElement('textarea');
          ta.className = 'input set-textarea';
          ta.rows = 5;
          ta.value = f && f.texto ? String(f.texto).replace(/<[^>]*>/g, '') : '';
          hostTexto.appendChild(ta);
          rt = { getHtml: function () { return ta.value; } };
        }

        // Medio
        editor.appendChild(el('h4', 'set-subhead', 'Medio asociado'));
        var medioActual = f ? medioDe(f) : { tipo: 'ninguna', url: '', fuente: 'auto' };
        var filaMedio = el('div', 'set-row');
        var infoMedio = el('div', 'set-row-title');
        filaMedio.appendChild(infoMedio);
        var accMedio = el('div', 'set-item-acc');
        var btnCambiar = boton(accMedio, '🎨 Seleccionar medio', 'btn-outline btn-sm', function () {
          var galeria = [];
          fichas.forEach(function (otra) {
            var m = medioDe(otra);
            if (m.url && m.tipo !== 'ninguna' && galeria.every(function (g) { return g.url !== m.url; })) {
              galeria.push({ tipo: m.tipo, url: m.url });
            }
          });
          abrirSelectorMedio({ actual: medioActual, galeria: galeria }, function (nuevo) {
            medioActual = nuevo;
            pintarEditor();
          });
        });
        var btnQuitar = boton(accMedio, '✕ Quitar', 'btn-outline btn-sm', function () {
          medioActual = { tipo: 'ninguna', url: '', fuente: 'auto' };
          pintarEditor();
        });
        filaMedio.appendChild(accMedio);
        editor.appendChild(filaMedio);
        var preview = el('div', 'set-media-preview');
        editor.appendChild(preview);
        function pintarPreview() {
          if (medioActual.tipo === 'ninguna' || !medioActual.url) {
            infoMedio.textContent = 'Sin medio (solo texto).';
            preview.innerHTML = '';
            return;
          }
          infoMedio.textContent = (medioActual.tipo === 'imagen' ? 'Imagen' : 'Vídeo') + ' · ' + medioActual.url;
          if (V.multimedia) V.multimedia.montarMedio(preview, medioActual, { clase: 'set-media-img' });
        }
        pintarPreview();

        var sw = interruptor(editor, 'Publicada (visible en la portada)', f ? f.publicado !== false : false);
        sw.checked = f ? f.publicado !== false : false;

        var ordenInp = campo(editor, 'Orden', f ? (Number(f.orden) || 0) : (fichas.length ? (Number(fichas[fichas.length - 1].orden) || 0) + 1 : 0), { tipo: 'number', min: 0, step: 1 });

        var acciones = el('div', 'set-actions');
        var btnGuardar = el('button', 'btn btn-primary', nueva ? '➕ Crear ficha' : '💾 Guardar ficha');
        btnGuardar.type = 'button';
        btnGuardar.addEventListener('click', function () {
          var datos = {
            id: f ? f.id : 'ficha_' + Date.now(),
            titulo: refs.titulo.value,
            subtitulo: refs.subtitulo.value,
            icono: refs.icono.value,
            texto: rt.getHtml(),
            medio: medioActual,
            publicado: sw.checked,
            orden: Number(ordenInp.value) || 0,
            creado: f ? f.creado : null
          };
          if (!datos.titulo.trim()) { toast('La ficha necesita un título.', true); return; }
          btnGuardar.disabled = true;
          var original = btnGuardar.textContent;
          btnGuardar.textContent = '⏳ Guardando…';
          guardarFicha(datos).then(function () {
            return leerFichas();
          }).then(function (lista2) {
            fichas.length = 0;
            lista2.forEach(function (x) { fichas.push(x); });
            sel = Math.max(0, fichas.findIndex(function (x) { return x.id === datos.id; }));
            pintarLista(); pintarEditor();
            toast('Ficha guardada ✓');
          }).catch(function (e) {
            toast('No se pudo guardar la ficha: ' + (e && e.message ? e.message : e), true);
          }).then(function () {
            btnGuardar.disabled = false;
            btnGuardar.textContent = original;
          });
        });
        acciones.appendChild(btnGuardar);
        if (f) {
          var btnEliminar = el('button', 'btn btn-outline', '🗑 Eliminar');
          btnEliminar.type = 'button';
          btnEliminar.addEventListener('click', function () {
            if (!window.confirm('¿Eliminar la ficha "' + (f.titulo || 'sin título') + '"?')) return;
            eliminarFicha(f.id).then(function () {
              fichas.splice(sel, 1);
              if (sel >= fichas.length) sel = fichas.length - 1;
              pintarLista(); pintarEditor();
              toast('Ficha eliminada ✓');
            }).catch(function (e) { toast('No se pudo eliminar: ' + (e && e.message ? e.message : e), true); });
          });
          acciones.appendChild(btnEliminar);
        }
        editor.appendChild(acciones);
      }

      pintarLista();
      pintarEditor();
    }).catch(function (e) {
      container.innerHTML = '';
      container.appendChild(el('p', 'set-error', 'No se pudieron cargar las fichas: ' + (e && e.message ? e.message : e)));
    });
  }

  /* ─── PESTAÑA · IDENTIDAD Y MARCA ──────────────────────────── */
  var CAMPOS_IDENTIDAD = [
    { key: 'nombre', label: 'Nombre de la plataforma', placeholder: 'Vida en Convocación' },
    { key: 'lema', label: 'Lema', placeholder: 'Formar, acompañar y transformar' },
    { key: 'logoUrl', label: 'URL del logo', placeholder: '/logo.png' },
    { key: 'email', label: 'Correo de contacto', tipo: 'email' },
    { key: 'telefono', label: 'Teléfono / WhatsApp' },
    { key: 'direccion', label: 'Dirección' },
    { key: 'ciudad', label: 'Ciudad' },
    { key: 'pais', label: 'País' },
    { key: 'colorPrimario', label: 'Color primario', tipo: 'color' },
    { key: 'colorAcento', label: 'Color de acento', tipo: 'color' },
    { key: 'facebook', label: 'Facebook', placeholder: 'https://facebook.com/…' },
    { key: 'instagram', label: 'Instagram', placeholder: 'https://instagram.com/…' },
    { key: 'youtube', label: 'YouTube', placeholder: 'https://youtube.com/@…' },
    { key: 'whatsapp', label: 'WhatsApp (wa.me)', placeholder: '573001234567' },
    { key: 'textoLegal', label: 'Texto legal (pie de página)', tipo: 'area' }
  ];

  function renderIdentidad(container) {
    container.appendChild(el('p', 'set-loading', 'Cargando identidad…'));
    leerDoc('identidad').then(function (doc) {
      container.innerHTML = '';
      var notice = el('div', 'set-notice');
      notice.appendChild(el('span', 'set-notice-ico', 'ℹ️'));
      notice.appendChild(notaHTML('Estos datos se guardan en <code>config/identidad</code>. Se muestran en la portada y en los pie de página.'));
      container.appendChild(notice);

      var body = grupo(container, 'Identidad de la plataforma', 'Nombre, contacto y presencia en redes.', '🎨');
      var grid = el('div', 'set-grid');
      var refs = {};
      CAMPOS_IDENTIDAD.forEach(function (c) {
        var inp = campo(grid, c.label, doc[c.key], { tipo: c.tipo, placeholder: c.placeholder });
        refs[c.key] = inp;
      });
      body.appendChild(grid);

      botonGuardar(container, function () {
        var data = {};
        Object.keys(refs).forEach(function (k) { data[k] = refs[k].value; });
        return guardarDoc('identidad', data).then(function () {
          toast('Identidad guardada ✓');
        });
      });
    });
  }

  /* ─── PESTAÑA · CAMPOS DE FORMULARIOS ───────────────────────── */
  /* La estructura de los formularios de REGISTRO y de PERFIL se guarda
     en `config/formulario` y la aplica core/formulario.js en tiempo de
     ejecución. Cada campo tiene uno de los cuatro estados:
     obligatorio, visible (opcional), oculto o eliminado.

     OJO: aquí no se guarda una lista de campos "para el futuro": lo que
     se guarda es exactamente lo que el formulario aplica. Si un campo
     se marca como obligatorio, el registro lo exige de verdad. */
  var ESTADOS_CAMPO = [
    ['obligatorio', 'Obligatorio'],
    ['visible', 'Visible (opcional)'],
    ['oculto', 'Oculto'],
    ['eliminado', 'Eliminado']
  ];

  var TIPOS_CAMPO = [
    ['texto', 'Texto'],
    ['area', 'Texto largo'],
    ['numero', 'Número'],
    ['email', 'Correo'],
    ['telefono', 'Teléfono'],
    ['fecha', 'Fecha'],
    ['booleano', 'Casilla de verificación'],
    ['seleccion', 'Lista de opciones']
  ];

  function slug(texto) {
    return String(texto || '')
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40);
  }

  /* Convierte la estructura anterior (catálogo + formularios) al formato
     nuevo de estados, para no dejar datos en el aire si alguien ya
     había configurado algo en la pestaña antigua. */
  function migrarEsquemaLegacy(legacy) {
    var base = (V.formulario && typeof V.formulario.esquemaPorDefecto === 'function')
      ? V.formulario.esquemaPorDefecto() : null;
    if (!base || !legacy || !Array.isArray(legacy.formularios)) return null;
    var catalogo = Array.isArray(legacy.campos) ? legacy.campos : [];
    var out = { version: 1, forms: {} };
    legacy.formularios.forEach(function (f) {
      var fid = f.id;
      if (!fid) return;
      var destino = base.forms[fid] ? fid : null;
      if (!destino) {
        out.forms[fid] = { id: fid, nombre: f.nombre || fid, campos: [] };
        destino = fid;
      }
      var porDefecto = (base.forms[destino] && base.forms[destino].campos) || [];
      var lista = out.forms[destino] ? out.forms[destino].campos : porDefecto;
      (f.campos || []).forEach(function (cid) {
        var c = catalogo.filter(function (x) { return x.id === cid; })[0];
        if (!c) return;
        var dom = porDefecto.filter(function (x) { return x.id === c.id; })[0];
        lista.push({
          id: c.id,
          etiqueta: c.etiqueta || c.id,
          tipo: c.tipo || 'texto',
          placeholder: '',
          domId: dom ? dom.domId : '',
          estado: c.requerido ? 'obligatorio' : 'visible',
          opciones: c.opciones || []
        });
      });
    });
    Object.keys(base.forms).forEach(function (fid) {
      if (!out.forms[fid]) out.forms[fid] = base.forms[fid];
    });
    return out;
  }

  function renderCampos(container) {
    container.appendChild(el('p', 'set-loading', 'Cargando la estructura de formularios…'));
    Promise.all([leerDoc('formulario'), leerDoc('formularios')]).then(function (r) {
      var doc = r[0] || {};
      var legacy = r[1] || {};
      var migrada = false;

      var esquema;
      if (doc.forms && (V.formulario && typeof V.formulario.normalizar === 'function')) {
        esquema = V.formulario.normalizar(doc);
      } else if (doc.forms) {
        esquema = doc.forms;
      } else {
        var desdeLegacy = migrarEsquemaLegacy(legacy);
        if (desdeLegacy) { esquema = desdeLegacy; migrada = true; }
        else if (V.formulario && typeof V.formulario.esquemaPorDefecto === 'function') esquema = V.formulario.esquemaPorDefecto();
        else esquema = { version: 1, forms: {} };
      }

      container.innerHTML = '';
      var notice = el('div', 'set-notice');
      notice.appendChild(el('span', 'set-notice-ico', '📝'));
      notice.appendChild(notaHTML('Cada campo del formulario de <strong>Registro</strong> y de <strong>Perfil</strong> tiene un estado: <strong>Obligatorio</strong>, <strong>Visible (opcional)</strong>, <strong>Oculto</strong> (no aparece, pero el dato guardado se conserva) o <strong>Eliminado</strong> (no aparece y además se borra el dato). Se guarda en <code>config/formulario</code> y la aplicación lo aplica al instante.'));
      container.appendChild(notice);
      if (migrada) {
        var avMigr = el('div', 'set-notice');
        avMigr.appendChild(el('span', 'set-notice-ico', '♻️'));
        avMigr.appendChild(notaHTML('Se encontró una estructura anterior en <code>config/formularios</code>: se ha trasladado a <code>config/formulario</code> con los nuevos estados. Pulsa «Guardar cambios» para confirmar la migración.'));
        container.appendChild(avMigr);
      }

      var refs = {};
      Object.keys(esquema.forms || {}).forEach(function (fid) {
        var f = esquema.forms[fid];
        var body = grupo(container, f.nombre || fid, 'Campos de este formulario.', fid === 'registro' ? '📝' : (fid === 'perfil' ? '👤' : '📄'));
        var lista = el('div', 'set-sublista');
        body.appendChild(lista);
        var resumen = el('p', 'set-help');
        body.appendChild(resumen);

        var campos = f.campos || [];
        refs[fid] = campos;

        function pintarResumen() {
          var n = { obligatorio: 0, visible: 0, oculto: 0, eliminado: 0 };
          campos.forEach(function (c) { if (n[c.estado] === undefined) n[c.estado] = 0; n[c.estado]++; });
          resumen.textContent = n.obligatorio + ' obligatorios · ' + n.visible + ' opcionales · ' + n.oculto + ' ocultos · ' + n.eliminado + ' eliminados.';
        }

        function pintarCampos() {
          lista.innerHTML = '';
          if (!campos.length) {
            lista.appendChild(el('p', 'set-vacio', 'Este formulario no tiene campos.'));
          }
          campos.forEach(function (c, i) {
            var fila = el('div', 'set-campo-row' + (c.estado === 'eliminado' ? ' is-eliminado' : ''));
            var selEstado = selector(fila, '', c.estado, ESTADOS_CAMPO);
            selEstado.classList.add('set-campo-estado');
            selEstado.addEventListener('change', function () { c.estado = selEstado.value; pintarResumen(); });

            var inEtiqueta = campo(fila, '', c.etiqueta);
            inEtiqueta.classList.add('set-campo-etiqueta');
            inEtiqueta.addEventListener('input', function () { c.etiqueta = inEtiqueta.value; });

            var selTipo = selector(fila, '', c.tipo, TIPOS_CAMPO);
            selTipo.classList.add('set-campo-tipo');
            selTipo.addEventListener('change', function () { c.tipo = selTipo.value; });

            var inPh = campo(fila, '', c.placeholder);
            inPh.classList.add('set-campo-ph');
            inPh.addEventListener('input', function () { c.placeholder = inPh.value; });

            var acc = el('div', 'set-item-acc');
            boton(acc, '↑', 'btn-outline btn-sm', function () {
              if (i === 0) return;
              var t = campos[i - 1]; campos[i - 1] = campos[i]; campos[i] = t;
              pintarCampos();
            }).title = 'Subir';
            boton(acc, '↓', 'btn-outline btn-sm', function () {
              if (i >= campos.length - 1) return;
              var t = campos[i + 1]; campos[i + 1] = campos[i]; campos[i] = t;
              pintarCampos();
            }).title = 'Bajar';
            boton(acc, '✕', 'btn-outline btn-sm', function () {
              // No se borra el campo del esquema: se marca como ELIMINADO.
              // Así el control del formulario se oculta y su dato se borra
              // al guardar (un campo quitado de la lista dejaría su
              // control visible en el formulario y su dato guardado).
              c.estado = 'eliminado';
              pintarCampos();
            }).title = 'Marcar como eliminado (oculta el campo y borra su dato)';
            fila.appendChild(acc);
            lista.appendChild(fila);
          });
          boton(lista, '➕ Añadir campo', 'btn-outline btn-sm', function () {
            campos.push({ id: 'campo_' + Date.now(), etiqueta: 'Campo nuevo', tipo: 'texto', placeholder: '', domId: '', estado: 'visible', opciones: [] });
            pintarCampos();
          });
          pintarResumen();
        }

        pintarCampos();
      });

      botonGuardar(container, function () {
        var forms = {};
        Object.keys(refs).forEach(function (fid) {
          var f = (esquema.forms && esquema.forms[fid]) || { id: fid, nombre: fid };
          forms[fid] = {
            id: fid,
            nombre: f.nombre || fid,
            campos: (refs[fid] || []).map(function (c) {
              return {
                id: c.id,
                etiqueta: c.etiqueta || c.id,
                tipo: c.tipo || 'texto',
                placeholder: c.placeholder || '',
                domId: c.domId || '',
                estado: c.estado || 'visible',
                opciones: c.opciones || []
              };
            })
          };
        });
        return guardarDoc('formulario', {
          version: 1,
          actualizado: new Date().toISOString(),
          forms: forms
        }).then(function () {
          if (V.formulario && typeof V.formulario.cargar === 'function') return V.formulario.cargar();
        }).then(function () {
          toast('Estructura de formularios guardada ✓');
        });
      });
    }).catch(function (e) {
      container.innerHTML = '';
      container.appendChild(el('p', 'set-error', 'No se pudo cargar la estructura de formularios: ' + (e && e.message ? e.message : e)));
    });
  }

  /* ─── PESTAÑA · ROLES Y MÓDULOS ────────────────────────────── */
  /* Esta pestaña es de LECTURA a propósito: los permisos de acceso los
     decide el código (core/app.js) y los hace cumplir firestore.rules.
     Editarlos desde aquí sin tocar las reglas sería un control falso:
     el botón guardaría, pero el servidor seguiría denegando. Por eso se
     muestra el estado REAL y de dónde sale. */
  var MODULOS = [
    { label: 'Escritorio', acceso: function () { return true; } },
    { label: 'Mis Cursos', acceso: function () { return true; } },
    { label: 'Comunidades', acceso: function () { return true; } },
    { label: 'Podcasts', acceso: function () { return true; } },
    { label: 'Tienda', acceso: function () { return true; } },
    { label: 'Gestión de Usuarios', acceso: function () { return esSuper(); } },
    { label: 'Finanzas', acceso: function () { return typeof V.puedeVerFinanzas === 'function' ? V.puedeVerFinanzas() : esSuper(); } },
    { label: 'Reportes Financieros', acceso: function () { return typeof V.puedeVerFinanzas === 'function' ? V.puedeVerFinanzas() : esSuper(); } },
    { label: 'Red MLM', acceso: function () { return typeof V.puedeVerRedMlm === 'function' ? V.puedeVerRedMlm() : esSuper(); } },
    { label: 'Panel Super Admin', acceso: function () { return esSuper(); } },
    { label: 'Configuración', acceso: function () { return typeof V.puedeVerConfiguraciones === 'function' ? V.puedeVerConfiguraciones() : esSuper(); } }
  ];

  function renderRoles(container) {
    container.innerHTML = '';
    var notice = el('div', 'set-notice');
    notice.appendChild(el('span', 'set-notice-ico', '🔒'));
    notice.appendChild(notaHTML('Los permisos de acceso NO se editan aquí: los define <code>core/app.js</code> (qué ve cada rol) y los hace cumplir <code>firestore.rules</code> (qué puede escribir cada rol). Esta tabla muestra el estado real.'));
    container.appendChild(notice);

    var catalogo = (V.ROLES_CATALOG) ? V.ROLES_CATALOG : {};
    var body = grupo(container, 'Catálogo de roles', 'Fuente única: <code>core/app.js</code> → <code>V.ROLES_CATALOG</code>.', '🔑');
    var tabla = el('div', 'set-table');
    Object.keys(catalogo).forEach(function (id) {
      var m = catalogo[id];
      var row = el('div', 'set-row');
      row.appendChild(el('div', 'set-row-title', (m.icon || '') + ' ' + (m.label || id)));
      row.appendChild(el('div', 'set-row-sub', m.desc || ''));
      row.appendChild(el('span', 'set-badge ' + (m.grupo === 'base' ? 'base' : 'fasea'), m.grupo === 'base' ? 'Principal' : 'Combinable'));
      tabla.appendChild(row);
    });
    body.appendChild(tabla);

    var bodyMod = grupo(container, 'Acceso por módulo', 'Qué rol entra a cada módulo de la aplicación.', '🧭');
    var tablaMod = el('div', 'set-table');
    MODULOS.forEach(function (m) {
      var row = el('div', 'set-row');
      row.appendChild(el('div', 'set-row-title', m.label));
      var puede = m.acceso();
      row.appendChild(el('span', 'set-badge ' + (puede ? 'ok' : 'no'), puede ? 'Permitido' : 'Restringido'));
      tablaMod.appendChild(row);
    });
    bodyMod.appendChild(tablaMod);
    bodyMod.appendChild(el('p', 'set-help', 'La columna indica si el ROL ACTUAL de la sesión entra al módulo. La matriz completa por rol se aplica en el código.'));
  }

  /* ─── PESTAÑA · FINANZAS Y MLM ─────────────────────────────── */
  /* El guardado NO se hace aquí a mano: se llama a V.finanzas.guardarConfig,
     que es la misma ruta que usa el panel del módulo de Finanzas, y que
     además sincroniza config/mlm. Así los porcentajes no pueden quedar
     escritos solo en un documento. */
  function renderFinanzas(container) {
    if (!V.finanzas || typeof V.finanzas.getConfig !== 'function') {
      container.appendChild(el('p', 'set-error', 'El módulo de Finanzas no está disponible.'));
      return;
    }
    container.appendChild(el('p', 'set-loading', 'Cargando configuración financiera…'));
    V.finanzas.getConfig().then(function (cfg) {
      container.innerHTML = '';
      var notice = el('div', 'set-notice');
      notice.appendChild(el('span', 'set-notice-ico', '💰'));
      notice.appendChild(notaHTML('El interruptor maestro y los porcentajes son <strong>exclusivos del superadmin</strong>: así lo pide el modelo de roles y así lo hace cumplir <code>firestore.rules</code> (<code>config/finanzas</code> solo se escribe con <code>isAdmin()</code>).'));
      container.appendChild(notice);

      var body = grupo(container, 'Parámetros de distribución', 'Se aplican al instante al motor de comisiones y a los reportes.', '📈');

      var sw = interruptor(body, 'Módulo de finanzas activo', cfg.finanzasEnabled);
      var grid = el('div', 'set-grid');
      var pcts = {};
      for (var n = 1; n <= 5; n++) {
        pcts[n] = campo(grid, 'Comisión nivel ' + n + ' (%)', Number(cfg.porcentajes[n]) || 0, { tipo: 'number', min: 0, max: 100, step: 1 });
      }
      var inCaja = campo(grid, 'Caja Mayor / Fondo Estructura (%)', cfg.porcentajeCaja, { tipo: 'number', min: 0, max: 100, step: 1 });
      var inCoord = campo(grid, 'Comisión del coordinador (%)', cfg.porcentajeCoordinador, { tipo: 'number', min: 0, max: 100, step: 1 });
      body.appendChild(grid);
      var nota = el('p', 'set-help', '');
      body.appendChild(nota);
      function actualizarNota() {
        var total = 0;
        for (var i = 1; i <= 5; i++) total += Number(pcts[i].value) || 0;
        nota.textContent = 'Bolsa total de comisiones: ' + total + '% → Caja Mayor automática: ' + Math.max(0, 100 - total) + '%.';
        nota.className = 'set-help' + (total > 100 ? ' es-error' : '');
      }
      Object.keys(pcts).forEach(function (k) { pcts[k].addEventListener('input', actualizarNota); });
      actualizarNota();

      // Categorías
      var bodyCat = grupo(container, 'Categorías de aporte', 'Las que puede elegir un usuario al registrar un aporte.', '🏷️');
      var listaCat = el('div', 'set-sublista');
      bodyCat.appendChild(listaCat);
      var cats = (cfg.categorias || []).map(function (c) {
        return { id: c.id, nombre: c.nombre, tipo: c.tipo, activa: c.activa !== false };
      });
      function pintarCategorias() {
        listaCat.innerHTML = '';
        cats.forEach(function (c, i) {
          var item = el('div', 'set-item');
          var head = el('div', 'set-item-head');
          head.appendChild(el('span', 'set-item-title', (c.activa ? '✅ ' : '⏸️ ') + c.nombre));
          var acc = el('div', 'set-item-acc');
          boton(acc, '✕', 'btn-outline btn-sm', function () { cats.splice(i, 1); pintarCategorias(); }).title = 'Eliminar';
          head.appendChild(acc);
          item.appendChild(head);
          item.appendChild(el('p', 'set-item-sub', c.tipo + ' · ' + c.id));
          listaCat.appendChild(item);
        });
        boton(listaCat, '➕ Nueva categoría', 'btn-outline btn-sm', function () {
          cats.push({ id: 'categoria_' + Date.now(), nombre: 'Nueva categoría', tipo: 'personal', activa: true });
          pintarCategorias();
        });
      }
      pintarCategorias();

      botonGuardar(container, function () {
        var porcentajes = {};
        for (var i = 1; i <= 5; i++) porcentajes[i] = Number(pcts[i].value) || 0;
        return V.finanzas.guardarConfig({
          finanzasEnabled: sw.checked,
          porcentajeCoordinador: inCoord.value,
          porcentajes: porcentajes,
          porcentajeCaja: inCaja.value,
          categorias: cats
        }).then(function () {
          toast('Configuración de Finanzas guardada ✓');
        });
      });
    }).catch(function (e) {
      container.innerHTML = '';
      container.appendChild(el('p', 'set-error', 'No se pudo cargar la configuración: ' + (e && e.message ? e.message : e)));
    });
  }

  /* ─── PESTAÑA · DATOS OPERATIVOS ──────────────────────────── */
  /* Única pestaña a la que entra el rol 'contable': aquí NO hay
     interruptores ni porcentajes (eso es del superadmin), solo los datos
     con los que se opera: las cuentas bancarias y el resumen de
     transacciones. */
  function renderOperativos(container) {
    container.innerHTML = '';
    var notice = el('div', 'set-notice');
    notice.appendChild(el('span', 'set-notice-ico', '🏦'));
    notice.appendChild(notaHTML(esSuper()
      ? 'Cuentas bancarias y resumen de transacciones. Los parámetros del módulo (interruptores y porcentajes) están en la pestaña <strong>Finanzas y MLM</strong>.'
      : 'Administras las cuentas bancarias y consultas el resumen de transacciones. Los parámetros del módulo (interruptores y porcentajes) los edita el superadmin.'));
    container.appendChild(notice);

    var bodyCuentas = grupo(container, 'Cuentas bancarias y billeteras', 'Dónde se registran los aportes y los pagos.', '🏦');
    var lista = el('div', 'set-sublista');
    bodyCuentas.appendChild(lista);

    var cuerpoForm = el('div', 'set-inline-form');
    var inBanco = campo(cuerpoForm, 'Banco o billetera', '', { placeholder: 'Bancolombia Ahorros' });
    var inNumero = campo(cuerpoForm, 'Número', '', { placeholder: '0000 0000 0000' });
    var btnAdd = boton(cuerpoForm, '➕ Añadir cuenta', 'btn-primary btn-sm', function () {
      if (!V.finanzas || typeof V.finanzas.crearCuenta !== 'function') return;
      V.finanzas.crearCuenta({ banco: inBanco.value, numero: inNumero.value })
        .then(function () {
          inBanco.value = ''; inNumero.value = '';
          toast('Cuenta añadida ✓');
          pintarCuentas();
        })
        .catch(function (e) { toast(e && e.message ? e.message : 'No se pudo añadir la cuenta.', true); });
    });
    bodyCuentas.appendChild(cuerpoForm);

    function pintarCuentas() {
      lista.innerHTML = '';
      if (!V.finanzas || typeof V.finanzas.loadCuentas !== 'function') {
        lista.appendChild(el('p', 'set-vacio', 'El módulo de Finanzas no está disponible.'));
        return;
      }
      V.finanzas.loadCuentas(true).then(function (cuentas) {
        if (!cuentas.length) {
          lista.appendChild(el('p', 'set-vacio', 'Todavía no hay cuentas registradas.'));
          return;
        }
        cuentas.forEach(function (c) {
          var item = el('div', 'set-item');
          var head = el('div', 'set-item-head');
          head.appendChild(el('span', 'set-item-title', c.banco));
          var acc = el('div', 'set-item-acc');
          boton(acc, '✏️', 'btn-outline btn-sm', function () {
            var nuevoBanco = window.prompt('Banco o billetera', c.banco);
            if (nuevoBanco === null) return;
            var nuevoNumero = window.prompt('Número de cuenta', c.numero);
            if (nuevoNumero === null) return;
            V.finanzas.editarCuenta(c.id, { banco: nuevoBanco, numero: nuevoNumero })
              .then(function () { toast('Cuenta actualizada ✓'); pintarCuentas(); })
              .catch(function (e) { toast(e && e.message ? e.message : 'No se pudo actualizar.', true); });
          }).title = 'Editar';
          boton(acc, '✕', 'btn-outline btn-sm', function () {
            if (!window.confirm('¿Eliminar la cuenta "' + c.banco + '"?')) return;
            V.finanzas.eliminarCuenta(c.id)
              .then(function () { toast('Cuenta eliminada ✓'); pintarCuentas(); })
              .catch(function (e) { toast(e && e.message ? e.message : 'No se pudo eliminar.', true); });
          }).title = 'Eliminar';
          head.appendChild(acc);
          item.appendChild(head);
          item.appendChild(el('p', 'set-item-sub', 'N.º ' + c.numero));
          lista.appendChild(item);
        });
      });
    }
    pintarCuentas();

    // Resumen de transacciones (solo lectura).
    var bodyTx = grupo(container, 'Resumen de transacciones', 'Totales del módulo. El detalle se edita en el módulo de Finanzas.', '📊');
    var resumen = el('div', 'set-grid');
    bodyTx.appendChild(resumen);
    if (V.finanzas && typeof V.finanzas.todasTransacciones === 'function') {
      V.finanzas.todasTransacciones().then(function (txs) {
        var total = 0;
        var porEstado = {};
        (txs || []).forEach(function (t) {
          total += Number(t.monto) || 0;
          var e = t.estado || 'sin estado';
          porEstado[e] = (porEstado[e] || 0) + 1;
        });
        resumen.innerHTML = '';
        var c1 = el('div', 'set-stat');
        c1.appendChild(el('span', 'set-stat-value', String(txs.length)));
        c1.appendChild(el('span', 'set-stat-label', 'transacciones'));
        var c2 = el('div', 'set-stat');
        c2.appendChild(el('span', 'set-stat-value', '$' + total.toLocaleString('es-CO')));
        c2.appendChild(el('span', 'set-stat-label', 'monto total'));
        var c3 = el('div', 'set-stat');
        c3.appendChild(el('span', 'set-stat-value', String(Object.keys(porEstado).length)));
        c3.appendChild(el('span', 'set-stat-label', 'estados'));
        resumen.appendChild(c1);
        resumen.appendChild(c2);
        resumen.appendChild(c3);
      });
    } else {
      resumen.appendChild(el('p', 'set-vacio', 'El módulo de Finanzas no está disponible.'));
    }
  }

  /* ─── PESTAÑAS · ANDamiaje ────────────────────────────────── */
  function tabsPermitidas() {
    return TABS.filter(function (t) {
      if (t.roles.indexOf('superadmin') !== -1 && esSuper()) return true;
      if (t.roles.indexOf('contable') !== -1 && esContable()) return true;
      return false;
    });
  }

  function render() {
    var tabs = tabsPermitidas();
    var panel = $('settingsPanel');
    var bar = $('settingsTabs');
    var banner = $('settingsBanner');
    var pill = $('settingsRolPill');
    var sub = $('settingsSubtitle');
    if (!panel || !bar) return;

    if (pill) {
      pill.textContent = esSuper() ? 'Superadmin' : (esContable() ? 'Contable' : '');
      pill.className = 'status-pill ' + (esSuper() ? 'gold' : 'purple');
    }
    if (sub) {
      sub.textContent = esSuper()
        ? 'Todos los ajustes de la plataforma, en un solo lugar. Se aplican al instante, sin desplegar.'
        : 'Ajustes del módulo de finanzas que te corresponden.';
    }
    if (banner) {
      banner.innerHTML = '';
      banner.style.display = '';
      var ico = el('span', 'set-notice-ico', esSuper() ? '🔐' : '🧮');
      var txt = el('div');
      if (esSuper()) {
        txt.innerHTML = 'Acceso total. Puedes editar todas las secciones de configuración.';
      } else {
        txt.innerHTML = 'Acceso de <strong>contable</strong>: solo la pestaña <strong>Datos operativos</strong> (cuentas bancarias y transacciones). Los interruptores y los porcentajes de la red los edita el superadmin.';
      }
      banner.appendChild(ico);
      banner.appendChild(txt);
      banner.className = 'set-notice';
    }

    bar.innerHTML = '';
    tabs.forEach(function (t) {
      var b = el('button', 'set-tab', t.icon + ' ' + t.label);
      b.type = 'button';
      b.setAttribute('data-tab', t.id);
      b.addEventListener('click', function () { activar(t.id); });
      bar.appendChild(b);
    });

    var guardada = null;
    try { guardada = localStorage.getItem(TAB_KEY); } catch (e) { guardada = null; }
    var existe = false;
    tabs.forEach(function (t) { if (t.id === guardada) existe = true; });
    activar(existe ? guardada : tabs[0].id);
  }

  function activar(id) {
    var tabs = tabsPermitidas();
    var tab = null;
    tabs.forEach(function (t) { if (t.id === id) tab = t; });
    if (!tab) return;
    tabActual = id;
    try { localStorage.setItem(TAB_KEY, id); } catch (e) { /* sin memoria */ }

    var bar = $('settingsTabs');
    if (bar) {
      Array.prototype.forEach.call(bar.children, function (b) {
        b.classList.toggle('is-active', b.getAttribute('data-tab') === id);
      });
    }
    var panel = $('settingsPanel');
    if (!panel) return;
    panel.innerHTML = '';
    try {
      tab.render(panel);
    } catch (e) {
      panel.appendChild(el('p', 'set-error', 'No se pudo abrir esta pestaña: ' + (e && e.message ? e.message : e)));
    }
  }

  function mostrar() {
    render();
  }

  /* ─── API PÚBLICA ──────────────────────────────────────────── */
  V.settings = {
    TABS: TABS,
    render: render,
    mostrar: mostrar,
    tabActual: function () { return tabActual; },
    mergeProfundo: V.mergeProfundo
  };

  // El núcleo llama a este hook al abrir la vista.
  V.onConfiguracionesShow = function () {
    render();
  };
})();
