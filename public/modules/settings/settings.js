/* ════════════════════════════════════════════════════════════════
   VCONV · Módulo de Configuración
   Panel único de los ajustes de la plataforma. Cada pestaña escribe en
   su documento de la colección `config` y el resto de la aplicación lo
   lee desde ahí:

     Portal / Home      → config/portal.copy   (el copy de la portada)
     Identidad y marca  → config/identidad
     Formularios        → config/formularios    (esquema + catálogo)
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
    { id: 'identidad', label: 'Identidad y marca', icon: '🎨', roles: ['superadmin'], render: renderIdentidad },
    { id: 'formularios', label: 'Formularios', icon: '📝', roles: ['superadmin'], render: renderFormularios },
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
        return guardarDoc('portal', { copy: nuevo }).then(function () {
          toast('Contenido de la portada guardado ✓');
        });
      });
    }).catch(function (e) {
      container.innerHTML = '';
      container.appendChild(el('p', 'set-error', 'No se pudo cargar la portada: ' + (e && e.message ? e.message : e)));
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

  /* ─── PESTAÑA · FORMULARIOS ────────────────────────────────── */
  /* Un formulario es una lista de campos del CATÁLOGO COMPARTIDO. El
     catálogo vive en config/formularios.campos y los formularios en
     config/formularios.formularios: un campo nuevo se define una vez y
     se reutiliza en todos los formularios que lo necesiten. */
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

  function renderFormularios(container) {
    container.appendChild(el('p', 'set-loading', 'Cargando formularios…'));
    leerDoc('formularios').then(function (doc) {
      container.innerHTML = '';
      var estado = {
        campos: Array.isArray(doc.campos) ? clonar(doc.campos) : [],
        formularios: Array.isArray(doc.formularios) ? clonar(doc.formularios) : [],
        selCampo: null,
        selFormulario: null
      };

      var notice = el('div', 'set-notice');
      notice.appendChild(el('span', 'set-notice-ico', 'ℹ️'));
      notice.appendChild(notaHTML('El <strong>catálogo de campos</strong> se define una vez y se reutiliza; cada <strong>formulario</strong> elige de él los campos que necesita. Se guarda en <code>config/formularios</code>.'));
      container.appendChild(notice);

      // ── Formularios ──
      var bodyForm = grupo(container, 'Formularios', 'Cada formulario reúne campos del catálogo compartido.', '📄');
      var listaForm = el('div', 'set-sublista');
      bodyForm.appendChild(listaForm);
      var editorForm = el('div', 'set-editor');
      bodyForm.appendChild(editorForm);

      // ── Catálogo de campos ──
      var bodyCat = grupo(container, 'Catálogo de campos', 'Los campos disponibles para cualquier formulario.', '🧱');
      var listaCat = el('div', 'set-sublista');
      bodyCat.appendChild(listaCat);
      var editorCat = el('div', 'set-editor');
      bodyCat.appendChild(editorCat);

      function pintarFormularios() {
        listaForm.innerHTML = '';
        if (!estado.formularios.length) {
          listaForm.appendChild(el('p', 'set-vacio', 'Todavía no hay formularios.'));
        }
        estado.formularios.forEach(function (f, i) {
          var item = el('div', 'set-item' + (estado.selFormulario === i ? ' is-active' : ''));
          var head = el('div', 'set-item-head');
          head.appendChild(el('span', 'set-item-title', (f.activo === false ? '⏸️ ' : '✅ ') + (f.nombre || 'Sin nombre')));
          var acc = el('div', 'set-item-acc');
          boton(acc, '✏️', 'btn-outline btn-sm', function () { estado.selFormulario = i; pintarFormularios(); }).title = 'Editar';
          boton(acc, '✕', 'btn-outline btn-sm', function () {
            estado.formularios.splice(i, 1);
            estado.selFormulario = null;
            pintarFormularios();
          }).title = 'Eliminar';
          head.appendChild(acc);
          item.appendChild(head);
          item.appendChild(el('p', 'set-item-sub', (f.descripcion || '') + ' · ' + (f.campos || []).length + ' campo(s)'));
          listaForm.appendChild(item);
        });
        boton(listaForm, '➕ Nuevo formulario', 'btn-outline btn-sm', function () {
          estado.formularios.push({ id: 'form_' + Date.now(), nombre: 'Formulario nuevo', descripcion: '', activo: true, campos: [] });
          estado.selFormulario = estado.formularios.length - 1;
          pintarFormularios();
        });
        pintarEditorFormulario();
      }

      function pintarEditorFormulario() {
        editorForm.innerHTML = '';
        var f = estado.formularios[estado.selFormulario];
        if (!f) {
          editorForm.appendChild(el('p', 'set-vacio', 'Elige un formulario para editarlo.'));
          return;
        }
        var grid = el('div', 'set-grid');
        var inNombre = campo(grid, 'Nombre', f.nombre);
        var inId = campo(grid, 'Identificador', f.id, { placeholder: 'inscripcion_comunidad' });
        var inDesc = campo(grid, 'Descripción', f.descripcion, { tipo: 'area', ancho: 'full' });
        editorForm.appendChild(grid);
        var swActivo = interruptor(editorForm, 'Formulario activo', f.activo !== false);

        editorForm.appendChild(el('h4', 'set-subhead', 'Campos del formulario'));
        var lista = el('div', 'set-checklist');
        if (!estado.campos.length) {
          lista.appendChild(el('p', 'set-vacio', 'Primero crea campos en el catálogo de abajo.'));
        }
        estado.campos.forEach(function (c, ci) {
          var row = el('label', 'set-check');
          var cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = (f.campos || []).indexOf(c.id) !== -1;
          cb.addEventListener('change', function () {
            f.campos = f.campos || [];
            var pos = f.campos.indexOf(c.id);
            if (cb.checked && pos === -1) f.campos.push(c.id);
            if (!cb.checked && pos !== -1) f.campos.splice(pos, 1);
          });
          row.appendChild(cb);
          row.appendChild(el('span', 'set-check-label', (c.etiqueta || c.id) + ' · ' + c.tipo));
          lista.appendChild(row);
        });
        editorForm.appendChild(lista);

        boton(editorForm, '✔ Aplicar al formulario', 'btn-outline btn-sm', function () {
          f.nombre = inNombre.value;
          f.id = inId.value || slug(inNombre.value) || f.id;
          f.descripcion = inDesc.value;
          f.activo = swActivo.checked;
          pintarFormularios();
          toast('Cambios aplicados al formulario. Pulsa «Guardar cambios» para escribirlos.');
        });
      }

      function pintarCatalogo() {
        listaCat.innerHTML = '';
        if (!estado.campos.length) {
          listaCat.appendChild(el('p', 'set-vacio', 'El catálogo está vacío.'));
        }
        estado.campos.forEach(function (c, i) {
          var item = el('div', 'set-item' + (estado.selCampo === i ? ' is-active' : ''));
          var head = el('div', 'set-item-head');
          head.appendChild(el('span', 'set-item-title', (c.etiqueta || c.id) + ' · ' + c.tipo));
          var acc = el('div', 'set-item-acc');
          boton(acc, '✏️', 'btn-outline btn-sm', function () { estado.selCampo = i; pintarCatalogo(); }).title = 'Editar';
          boton(acc, '✕', 'btn-outline btn-sm', function () {
            estado.campos.splice(i, 1);
            estado.selCampo = null;
            // El campo desaparece también de los formularios que lo usaban:
            // si no, quedarían referencias colgadas a un id inexistente.
            estado.formularios.forEach(function (f) {
              if (!f.campos) return;
              var pos = f.campos.indexOf(c.id);
              if (pos !== -1) f.campos.splice(pos, 1);
            });
            pintarCatalogo();
          }).title = 'Eliminar';
          head.appendChild(acc);
          item.appendChild(head);
          listaCat.appendChild(item);
        });
        boton(listaCat, '➕ Nuevo campo', 'btn-outline btn-sm', function () {
          estado.campos.push({ id: 'campo_' + Date.now(), etiqueta: 'Campo nuevo', tipo: 'texto', opciones: [], requerido: false });
          estado.selCampo = estado.campos.length - 1;
          pintarCatalogo();
        });
        pintarEditorCampo();
      }

      function pintarEditorCampo() {
        editorCat.innerHTML = '';
        var c = estado.campos[estado.selCampo];
        if (!c) {
          editorCat.appendChild(el('p', 'set-vacio', 'Elige un campo para editarlo.'));
          return;
        }
        var grid = el('div', 'set-grid');
        var inEtiqueta = campo(grid, 'Etiqueta', c.etiqueta);
        var inId = campo(grid, 'Identificador', c.id);
        var inTipo = selector(grid, 'Tipo', c.tipo, TIPOS_CAMPO);
        var inReq = el('div', 'set-field');
        inReq.appendChild(el('label', 'set-label', 'Obligatorio'));
        var cbReq = document.createElement('input');
        cbReq.type = 'checkbox';
        cbReq.className = 'input';
        cbReq.checked = !!c.requerido;
        inReq.appendChild(cbReq);
        grid.appendChild(inReq);
        editorCat.appendChild(grid);
        var inOpc = listaTexto(editorCat, 'Opciones (solo para "Lista de opciones")', c.opciones || [], 'Opción 1\nOpción 2', 'Una opción por línea.');
        editorCat.appendChild(el('div', 'set-hint', 'Las opciones solo se usan cuando el tipo es "Lista de opciones".'));

        boton(editorCat, '✔ Aplicar al campo', 'btn-outline btn-sm', function () {
          c.etiqueta = inEtiqueta.value;
          c.id = inId.value || slug(inEtiqueta.value) || c.id;
          c.tipo = inTipo.value;
          c.requerido = cbReq.checked;
          c.opciones = inOpc.valor();
          pintarCatalogo();
          toast('Cambios aplicados al campo. Pulsa «Guardar cambios» para escribirlos.');
        });
      }

      pintarFormularios();
      pintarCatalogo();

      botonGuardar(container, function () {
        return guardarDoc('formularios', {
          campos: estado.campos.map(function (c) {
            return { id: c.id, etiqueta: c.etiqueta, tipo: c.tipo, opciones: c.opciones || [], requerido: !!c.requerido };
          }),
          formularios: estado.formularios.map(function (f) {
            return { id: f.id, nombre: f.nombre, descripcion: f.descripcion || '', activo: f.activo !== false, campos: f.campos || [] };
          })
        }).then(function () {
          toast('Formularios guardados ✓');
        });
      });
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
