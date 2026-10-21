/* ════════════════════════════════════════════════════════════════
   VCONV · Editor de texto enriquecido (compartido)
   Un editor pequeño y seguro para los textos con formato de la
   plataforma:

     · negrita, cursiva y subrayado;
     · tamaño de letra (12 → 32 px);
     · color de letra (paleta fija);
     · quitar formato.

   Todo lo que sale del editor pasa por `sanitize()`: una lista blanca de
   etiquetas y atributos. El HTML se guarda en Firestore y se pinta con
   innerHTML en la portada, así que el saneado NO es opcional: sin él, un
   <script> o un onclick acabarían ejecutándose en el navegador de cada
   visitante.

   El editor del CMS de cursos (modules/cursos/cursos.js) tiene su propia
   implementación, más completa (A-/A+, escala de fuente, pegado desde
   Word). Este módulo es el que usan las pantallas nuevas; la migración
   del CMS a este queda pendiente.
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var V = window.VCONV;
  if (!V) { console.error('VCONV core not loaded'); return; }

  /* ─── LISTA BLANCA ──────────────────────────────────────────── */
  var ETIQUETAS = {
    B: 1, STRONG: 1, I: 1, EM: 1, U: 1, S: 1, STRIKE: 1, SPAN: 1, BR: 1,
    P: 1, DIV: 1, UL: 1, OL: 1, LI: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1,
    H6: 1, BLOCKQUOTE: 1, A: 1, FONT: 1
  };
  // Etiquetas que se borran enteras (con su contenido): aquí no hay nada
  // legítimo que conservar.
  var PROHIBIDAS = {
    SCRIPT: 1, STYLE: 1, META: 1, LINK: 1, TITLE: 1, IFRAME: 1, OBJECT: 1,
    EMBED: 1, VIDEO: 1, AUDIO: 1, CANVAS: 1, SVG: 1, MATH: 1, IMG: 1,
    FORM: 1, INPUT: 1, BUTTON: 1, SELECT: 1, TEXTAREA: 1, APPLET: 1,
    TEMPLATE: 1, NOSCRIPT: 1, BASE: 1
  };
  // Propiedades de style que sobreviven dentro de un <span>.
  var PROPS_STYLE = ['color', 'font-size', 'font-weight', 'font-style', 'text-decoration'];

  var PALETA = [
    '#111827', '#374151', '#6b7280', '#b91c1c', '#ea580c', '#d97706',
    '#16a34a', '#0d9488', '#2563eb', '#7c3aed', '#db2777', '#f9fafb'
  ];

  var TAMANOS = [
    ['12px', '12 px'], ['14px', '14 px'], ['16px', '16 px'], ['18px', '18 px'],
    ['20px', '20 px'], ['24px', '24 px'], ['32px', '32 px']
  ];

  function el(tag, cls, texto) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (texto !== undefined && texto !== null) e.textContent = texto;
    return e;
  }

  function escapeHtml(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function colorValido(v) {
    var s = String(v || '').trim();
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s)) return s;
    if (/^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/i.test(s)) return s;
    return '';
  }

  function tamanoValido(v) {
    var s = String(v || '').trim().toLowerCase();
    if (/^\d{1,3}(px|em|rem|%)$/.test(s)) return s;
    return '';
  }

  /* Filtra el style de un <span>: solo sobreviven las propiedades de la
     lista blanca y, de cada una, solo los valores con forma conocida. */
  function limpiarStyle(bruto) {
    var out = [];
    String(bruto || '').split(';').forEach(function (decl) {
      var i = decl.indexOf(':');
      if (i === -1) return;
      var prop = decl.slice(0, i).trim().toLowerCase();
      var val = decl.slice(i + 1).trim();
      if (PROPS_STYLE.indexOf(prop) === -1) return;
      if (prop === 'color') {
        var c = colorValido(val);
        if (c) out.push('color:' + c);
        return;
      }
      if (prop === 'font-size') {
        var t = tamanoValido(val);
        if (t) out.push('font-size:' + t);
        return;
      }
      if (prop === 'font-weight') {
        if (/^(bold|bolder|[5-9]00)$/i.test(val)) out.push('font-weight:' + val.toLowerCase());
        return;
      }
      if (prop === 'font-style') {
        if (/^(italic|oblique)$/i.test(val)) out.push('font-style:' + val.toLowerCase());
        return;
      }
      if (prop === 'text-decoration') {
        if (/^(underline|line-through|none)$/i.test(val)) out.push('text-decoration:' + val.toLowerCase());
      }
    });
    return out.join('; ');
  }

  /* Convierte el <font> legacy (que genera execCommand) en un <span> con
     estilo, para que el saneado pueda aplicarle la lista blanca. */
  function normalizarFont(node) {
    var span = document.createElement('span');
    var estilo = '';
    var color = node.getAttribute('color');
    if (color) {
      var c = colorValido(color);
      if (c) estilo += 'color:' + c + ';';
    }
    var face = node.getAttribute('face');
    if (face) {
      // La tipografía no está en la lista blanca: se descarta.
      face = null;
    }
    var st = node.getAttribute('style');
    if (st) estilo += limpiarStyle(st) + (estilo && limpiarStyle(st) ? ';' : '');
    if (estilo) span.setAttribute('style', estilo.replace(/;+$/, ''));
    while (node.firstChild) span.appendChild(node.firstChild);
    if (node.parentNode) node.parentNode.replaceChild(span, node);
    return span;
  }

  function limpiarNodo(node) {
    var hijos = Array.prototype.slice.call(node.childNodes);
    hijos.forEach(function (hijo) {
      if (hijo.nodeType === 3) return; // texto: se conserva tal cual
      if (hijo.nodeType !== 1) { node.removeChild(hijo); return; }
      var tag = (hijo.tagName || '').toUpperCase();
      if (PROHIBIDAS[tag]) { node.removeChild(hijo); return; }
      if (tag === 'FONT') {
        var span = normalizarFont(hijo);
        limpiarNodo(span);
        return;
      }
      if (!ETIQUETAS[tag]) {
        // Etiqueta desconocida: se desenvuelve (se queda su texto) para no
        // perder contenido, pero se le quitan los atributos.
        while (hijo.firstChild) node.insertBefore(hijo.firstChild, hijo);
        node.removeChild(hijo);
        return;
      }
      limpiarAtributos(hijo);
      limpiarNodo(hijo);
    });
  }

  function limpiarAtributos(node) {
    var tag = (node.tagName || '').toUpperCase();
    if (tag === 'A') {
      var href = node.getAttribute('href') || '';
      var ok = /^(https?:\/\/|mailto:)/i.test(href.trim());
      if (!ok) node.removeAttribute('href');
      else node.setAttribute('href', href.trim());
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
    if (tag === 'SPAN') {
      var estilo = limpiarStyle(node.getAttribute('style'));
      if (estilo) node.setAttribute('style', estilo);
      else node.removeAttribute('style');
    }
    // Cualquier otro atributo (incluidos los on*) se elimina.
    Array.prototype.slice.call(node.attributes || []).forEach(function (a) {
      var n = (a.name || '').toLowerCase();
      if (tag === 'A' && (n === 'href' || n === 'target' || n === 'rel')) return;
      node.removeAttribute(a.name);
    });
  }

  /* ─── SANEADO ───────────────────────────────────────────────── */
  function sanitize(html) {
    var bruto = html === undefined || html === null ? '' : String(html);
    if (!bruto.trim()) return '';
    if (typeof DOMParser === 'undefined') return escapeHtml(bruto);
    try {
      var doc = new DOMParser().parseFromString('<div id="rt-raiz">' + bruto + '</div>', 'text/html');
      var raiz = doc.getElementById('rt-raiz');
      if (!raiz) return escapeHtml(bruto);
      limpiarNodo(raiz);
      return raiz.innerHTML;
    } catch (e) {
      console.warn('[richtext] no se pudo sanear el HTML:', e && e.message);
      return escapeHtml(bruto);
    }
  }

  /* ─── SELECCIÓN ─────────────────────────────────────────────── */
  function guardarSeleccion(ta) {
    var sel = window.getSelection ? window.getSelection() : null;
    if (!sel || !sel.rangeCount) return null;
    var r = sel.getRangeAt(0);
    if (!ta.contains(r.commonAncestorContainer)) return null;
    var copia = r.cloneRange();
    return copia;
  }

  function restaurarSeleccion(ta, rango) {
    if (!rango) return false;
    var sel = window.getSelection ? window.getSelection() : null;
    if (!sel) return false;
    ta.focus();
    sel.removeAllRanges();
    sel.addRange(rango);
    return true;
  }

  /* Envuelve lo seleccionado en un <span> con el estilo indicado. Si el
     rango cruza varios nodos, se extrae su contenido y se vuelve a
     insertar dentro del span (surroundContents fallaría en ese caso). */
  function envolverConEstilo(ta, estilo, rango) {
    var sel = window.getSelection ? window.getSelection() : null;
    if (!sel || !sel.rangeCount) return false;
    var r = rango || sel.getRangeAt(0);
    if (!ta.contains(r.commonAncestorContainer)) return false;
    if (r.collapsed) return false;
    var span = document.createElement('span');
    span.setAttribute('style', estilo);
    try {
      r.surroundContents(span);
    } catch (e) {
      var frag = r.extractContents();
      span.appendChild(frag);
      r.insertNode(span);
    }
    ta.focus();
    return true;
  }

  /* ─── BARRA DE HERRAMIENTAS ─────────────────────────────────── */
  function construirBarra(ta) {
    var bar = el('div', 'rt-bar');
    var rango = null;

    ta.addEventListener('focusout', function () {
      rango = guardarSeleccion(ta);
    });

    function ejecutar(cmd) {
      ta.focus();
      if (rango) { restaurarSeleccion(ta, rango); rango = null; }
      try { document.execCommand(cmd, false, null); } catch (e) { /* navegador sin soporte */ }
      ta.focus();
    }

    function boton(etiqueta, titulo, clase, fn) {
      var b = el('button', 'rt-btn' + (clase ? ' ' + clase : ''), etiqueta);
      b.type = 'button';
      b.title = titulo;
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('click', function (e) { e.preventDefault(); fn(e); });
      bar.appendChild(b);
      return b;
    }

    try { document.execCommand('styleWithCSS', false, true); } catch (e) { /* no soportado */ }

    boton('B', 'Negrita', 'rt-b', function () { ejecutar('bold'); });
    boton('I', 'Cursiva', 'rt-i', function () { ejecutar('italic'); });
    boton('U', 'Subrayado', 'rt-u', function () { ejecutar('underline'); });

    // Tamaño de letra
    var selTam = document.createElement('select');
    selTam.className = 'rt-sel';
    selTam.title = 'Tamaño de letra';
    var ph = document.createElement('option');
    ph.value = '';
    ph.textContent = 'Tamaño';
    selTam.appendChild(ph);
    TAMANOS.forEach(function (t) {
      var o = document.createElement('option');
      o.value = t[0];
      o.textContent = t[1];
      selTam.appendChild(o);
    });
    selTam.addEventListener('change', function () {
      if (!selTam.value) return;
      rango = guardarSeleccion(ta) || rango;
      envolverConEstilo(ta, 'font-size:' + selTam.value, rango);
      rango = null;
      selTam.value = '';
    });
    bar.appendChild(selTam);

    // Color de letra
    var wrapColor = el('span', 'rt-color');
    var btnColor = el('button', 'rt-btn rt-color-btn', '');
    btnColor.type = 'button';
    btnColor.title = 'Color de letra';
    var punto = el('i', 'rt-color-dot');
    punto.style.background = PALETA[0];
    btnColor.appendChild(punto);
    wrapColor.appendChild(btnColor);

    var popup = el('div', 'rt-color-popup');
    PALETA.forEach(function (hex) {
      var sw = el('button', 'rt-swatch', '');
      sw.type = 'button';
      sw.title = hex;
      sw.style.background = hex;
      sw.addEventListener('mousedown', function (e) { e.preventDefault(); });
      sw.addEventListener('click', function () {
        rango = guardarSeleccion(ta) || rango;
        envolverConEstilo(ta, 'color:' + hex, rango);
        rango = null;
        punto.style.background = hex;
        popup.style.display = 'none';
      });
      popup.appendChild(sw);
    });
    wrapColor.appendChild(popup);

    btnColor.addEventListener('mousedown', function (e) { e.preventDefault(); });
    btnColor.addEventListener('click', function (e) {
      e.preventDefault();
      rango = guardarSeleccion(ta) || rango;
      popup.style.display = popup.style.display === 'none' ? 'flex' : 'none';
    });
    document.addEventListener('mousedown', function (e) {
      if (!wrapColor.contains(e.target)) popup.style.display = 'none';
    });
    bar.appendChild(wrapColor);

    boton('⌫', 'Quitar formato', '', function () { ejecutar('removeFormat'); });

    return bar;
  }

  /* ─── PEGADO ────────────────────────────────────────────────── */
  function vigilarPegado(ta) {
    ta.addEventListener('paste', function (e) {
      var cb = e.clipboardData || window.clipboardData;
      if (!cb) return;
      e.preventDefault();
      var texto = cb.getData('text/plain');
      if (texto === '' || texto === null) return;
      ta.focus();
      try {
        document.execCommand('insertText', false, texto);
      } catch (err) {
        ta.textContent = (ta.textContent || '') + texto;
      }
    });
  }

  /* ─── API ───────────────────────────────────────────────────── */
  function crear(host, opts) {
    opts = opts || {};
    host.innerHTML = '';
    var box = el('div', 'rt-box');
    var ta = el('div', 'rt-editor');
    ta.contentEditable = 'true';
    ta.setAttribute('data-placeholder', opts.placeholder || 'Escribe aquí…');
    ta.setAttribute('role', 'textbox');
    ta.setAttribute('aria-multiline', 'true');
    if (opts.id) ta.id = opts.id;

    box.appendChild(construirBarra(ta));
    box.appendChild(ta);
    host.appendChild(box);
    vigilarPegado(ta);

    return {
      editor: ta,
      toolbar: box.querySelector ? box.querySelector('.rt-bar') : null,
      getHtml: function () { return sanitize(ta.innerHTML); },
      getTexto: function () { return ta.textContent || ''; },
      setHtml: function (html) { ta.innerHTML = sanitize(html); },
      focus: function () { ta.focus(); }
    };
  }

  V.richtext = {
    PALETA: PALETA,
    TAMANOS: TAMANOS,
    crear: crear,
    sanitize: sanitize,
    escapeHtml: escapeHtml
  };
})();
