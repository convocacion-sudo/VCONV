/* ════════════════════════════════════════════════════════════════
   VCONV · Módulo de Cursos — CMS jerárquico estricto
   categorias/{catId} → cursos/{id} → bloques/{id} → lecciones/{id}
   Contenido 100% nativo en Firestore con sincronización en tiempo real.
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var V = window.VCONV;
  if (!V) { console.error('VCONV core not loaded'); return; }

  /* ─── STATE ───────────────────────────────────────────────── */
  var categoriasCache = [];
  var cursosCache = [];
  var progresoCache = {};
  var cursoActualId = null;
  var leccionActual = null;
  var editingId = null;
  var editingCatId = '';
  var editingBloques = [];
  var editorExpandBloque = null;
  var editorExpandLeccion = null;
  var tempSeq = 1;
  var progresoSubscribed = {};
  var cursoCatSubs = {};      // catId → unsubscribe
  var legacyCursoSub = null;  // unsubscribe para cursos raíz legacy
  var categoriasSub = null;   // unsubscribe de la suscripción de categorías
  var authSubsMode = null;    // modo de sesión ('anon'|'registrado') bajo el que se construyeron las suscripciones
  var catalogBound = false;
  var catFilter = 'todas';

  /* ─── HELPERS ─────────────────────────────────────────────── */
  function $(id) { return V.$(id); }
  function el(tag, cls, text) { return V.el(tag, cls, text); }

  function catCol() { return V.db.collection(V.COL_CATEGORIAS); }
  function catRef(catId) { return catCol().doc(catId); }
  function cursoRef(catId, cursoId) { return catRef(catId).collection(V.COL_CURSOS).doc(cursoId); }
  function bloqueRef(catId, cursoId, bloqueId) { return cursoRef(catId, cursoId).collection(V.COL_BLOQUES).doc(bloqueId); }
  function leccionRef(catId, cursoId, bloqueId, leccionId) { return bloqueRef(catId, cursoId, bloqueId).collection(V.COL_LECCIONES).doc(leccionId); }
  // UID autoritativo de la sesión para progreso. Siempre coincide con el
  // request.auth.uid validado en las reglas de Firestore (progreso/{uid}:
  // allow read, write si request.auth.uid == uid). Se delega en la FUENTE
  // ÚNICA central (core/app.js → V.uidSesion) para que nunca haya dos IDs
  // de sesión distintos en la app: cualquier operación de lectura/escritura
  // a Firestore que deba usar la identidad del usuario actual usa este
  // mismo UID. No hay fallback a una variable local desactualizada.      */
  function uidSesion() {
    return V.uidSesion ? V.uidSesion() : '';
  }

  // Error de Firestore por reglas de seguridad (UID distinto al de la sesión,
  // típico durante la migración anónimo → cuenta registrada). Son
  // transitorios: la suscripción se soltó y debe reconstruirse con el UID
  // correcto; no merecen un toast rojo alarmante.
  function esErrorPermisos(e) {
    var code = e && e.code ? e.code : '';
    if (code === 'permission-denied') return true;
    return !!(e && e.message && /missing or insufficient permissions/i.test(e.message));
  }

  function progRef(catId, cursoId) { return cursoRef(catId, cursoId).collection(V.COL_PROGRESO).doc(uidSesion()); }

  // Ruta base de un curso: anidada (categoria) o raíz legacy (sin categoría).
  function cursoBaseRef(curso) {
    if (curso && curso.catId) return cursoRef(curso.catId, curso.id);
    return V.db.collection(V.COL_CURSOS).doc(curso.id);
  }
  function bloqueColFor(curso) {
    return cursoBaseRef(curso).collection(curso.catId ? V.COL_BLOQUES : V.COL_MODULOS);
  }
  function bloqueBaseRef(curso, b) {
    if (curso.catId) return bloqueRef(curso.catId, curso.id, b.id);
    return V.db.collection(V.COL_CURSOS).doc(curso.id).collection(V.COL_MODULOS).doc(b.id);
  }
  function progRefFromCurso(curso) {
    return cursoBaseRef(curso).collection(V.COL_PROGRESO).doc(uidSesion());
  }

  function getCategoriaById(id) {
    for (var i = 0; i < categoriasCache.length; i++) if (categoriasCache[i].id === id) return categoriasCache[i];
    return null;
  }
  function getCourseById(id) {
    for (var i = 0; i < cursosCache.length; i++) if (cursosCache[i].id === id) return cursosCache[i];
    return null;
  }
  function findBloqueById(curso, id) {
    if (!curso || !curso.bloques) return null;
    for (var i = 0; i < curso.bloques.length; i++) if (curso.bloques[i].id === id) return curso.bloques[i];
    return null;
  }

  // Secuencia plana de lecciones (bloques → lecciones) para progresión.
  function flattenSeq(curso) {
    var seq = [];
    (curso.bloques || []).forEach(function (b) {
      (b.lecciones || []).forEach(function (l) {
        if (!l || !l.id) return;
        seq.push({ bloque: b, leccion: l });
      });
    });
    return seq;
  }

  function lessonCount(curso) { return flattenSeq(curso).length; }

  function currentProgress(cursoId) {
    var prog = progresoCache[cursoId] || {};
    return prog.completed || [];
  }

  // Progresión secuencial estricta: primera lección abierta; el resto
  // se desbloquea al completar la anterior (o re-abriendo una ya completada).
  // Visitante (modo local, solo lectura): todas las lecciones de prueba
  // visibles están abiertas; no hay progresión que desbloquear.
  function isLessonUnlocked(seq, completed, i) {
    if (!seq[i] || !seq[i].leccion || seq[i].leccion.id === undefined) return false;
    if (anonMode()) return true;
    if (i <= 0) return true;
    if (completed.indexOf(String(seq[i].leccion.id)) !== -1) return true;
    return completed.indexOf(String(seq[i - 1].leccion.id)) !== -1;
  }

  function pctOf(curso) {
    var prog = progresoCache[curso.id];
    var total = lessonCount(curso);
    if (!prog || !total) return 0;
    var done = (prog.completed || []).length;
    return Math.round((done / total) * 100);
  }

  /* ─── MODO VISITANTE (SESIÓN ANÓNIMA) ───────────────────── */
  // Los anónimos SOLO pueden leer el catálogo general y los bloques/lecciones
  // SIN restricción estricta (prueba gratuita). Las consultas deben embebir
  // los mismos filtros que exigen las reglas de seguridad (o el servidor las
  // rechaza) pero siendo TOLERANTES: si el campo `acceso` falta o tiene
  // variaciones, el contenido se trata como prueba gratuita.
  function anonMode() {
    return V.isAnon === true;
  }
  function sortByOrden(arr) {
    if (!arr || !arr.length) return arr || [];
    return arr.slice().sort(function (a, b) { return (a.orden || 0) - (b.orden || 0); });
  }

  // Restricción estricta de pago/registro: solo 'completo' (y 'pago' legacy)
  // bloquea al visitante. Cualquier otro valor, el valor ausente (undefined /
  // null) o variaciones de texto NO restringen: se muestra como prueba gratuita.
  function esAccesoRestringido(val) {
    if (val === undefined || val === null) return false;
    return /^(completo|pago)$/i.test(String(val).trim());
  }

  function accesoLibre(val) {
    return !esAccesoRestringido(val);
  }

  // Consultas de un SOLO campo para visitantes que no rompen cuando `acceso`
  // está ausente: `!= 'completo'` descarta los documentos sin el campo, así
  // que se une con `== null` (que SÍ recupera campo null/ausente). Dos
  // consultas simples (sin índices compuestos) cuya unión es la totalidad de
  // documentos sin restricción estricta. Para usuarios registrados se usa una
  // única consulta con orden (todo el contenido).
  function anonFreeQueries(col) {
    return [
      col.where('acceso', '!=', 'completo'),
      col.where('acceso', '==', null)
    ];
  }

  // Une documentos de varios QuerySnapshot deduplicando por id y aplicando en
  // cliente la valoración tolerante de `acceso` (solo en modo visitante).
  function docsFromSnaps(snaps, filter) {
    var out = [];
    var seen = {};
    snaps.forEach(function (snap) {
      snap.forEach(function (doc) {
        if (seen[doc.id]) return;
        seen[doc.id] = true;
        var d = doc.data();
        d.id = doc.id;
        if (filter && esAccesoRestringido(d.acceso)) return;
        out.push(d);
      });
    });
    return out;
  }

  // get() combinado: resuelve las consultas tolerantes (anónimo) o la consulta
  // completa ordenada (registrados) y devuelve los documentos ya filtrados.
  function tolerantGet(col) {
    if (!anonMode()) {
      return col.orderBy('orden', 'asc').get().then(function (snap) {
        return docsFromSnaps([snap], false);
      });
    }
    return Promise.all(anonFreeQueries(col).map(function (q) { return q.get(); }))
      .then(function (snaps) { return docsFromSnaps(snaps, true); });
  }

  // Suscripción combinada a las consultas tolerantes: re-emite la unión
  // deduplicada de documentos ante cada cambio. Devuelve la cancelación.
  function subscribeMerged(col, onDocs, onError) {
    var map = {};
    var unsubs = [];
    var qs = anonMode() ? anonFreeQueries(col) : [col.orderBy('orden', 'asc')];
    function emit() {
      var out = [];
      Object.keys(map).forEach(function (id) { out.push(map[id]); });
      onDocs(out);
    }
    qs.forEach(function (q) {
      unsubs.push(q.onSnapshot(function (snap) {
        snap.docChanges().forEach(function (ch) {
          if (ch.type === 'removed') delete map[ch.doc.id];
        });
        snap.forEach(function (d) {
          if (!map[d.id]) {
            var data = d.data();
            data.id = d.id;
            map[d.id] = data;
          }
        });
        emit();
      }, onError));
    });
    return function () {
      unsubs.forEach(function (fn) { try { fn(); } catch (e) {} });
    };
  }

  /* ─── DATA LOADING (árbol bloques/lecciones) ──────────────── */
  function loadBloqueLecciones(curso, bloque) {
    var col = bloqueBaseRef(curso, bloque).collection(V.COL_LECCIONES);
    // Consulta tolerante: no rompe ni descarta si `acceso` falta o varía.
    // Los visitantes obtienen toda lección sin restricción estricta; el resto
    // de usuarios (gestores, administradores, registrados) consulta la totalidad.
    return tolerantGet(col).then(function (lecciones) {
      bloque.lecciones = anonMode() ? sortByOrden(lecciones) : lecciones;
    });
  }

  function loadCursoTree(curso) {
    if (!V.db) return Promise.resolve(curso);
    // El árbol se cachea POR MODO de sesión: si la sesión cambió
    // (anónimo ⇄ registrado) se vuelve a consultar para que los filtros
    // de acceso libre no arrastren contenido oculto a cuentas registradas.
    var mode = anonMode() ? 'anon' : 'registrado';
    if (curso.bloquesLoaded && curso._treeMode === mode) return Promise.resolve(curso);
    curso.bloques = curso.bloques || [];
    curso.bloquesLoaded = false;
    var col = bloqueColFor(curso);
    // TODOS los bloques del curso publicado se cargan en cualquier sesión
    // (visitante, registrado, gestor). Un filtro a nivel de consulta eliminaría
    // bloques cuyo campo `acceso` falte o tenga valores variados; el filtrado
    // de acceso se aplica SOLO a las lecciones individuales (loadBloqueLecciones).
    return col.orderBy('orden', 'asc').get()
      .then(function (bs) {
        var bloques = [];
        var tasks = [];
        bs.forEach(function (bDoc) {
          var b = bDoc.data();
          b.id = bDoc.id;
          b.lecciones = [];
          bloques.push(b);
          // Un fallo puntual al cargar las lecciones de un bloque NO debe
          // borrar todo el árbol: el bloque se conserva aunque quede vacío,
          // evitando que el visitante vea un falso «curso completo».
          tasks.push(loadBloqueLecciones(curso, b).catch(function () { b.lecciones = b.lecciones || []; }));
        });
        return Promise.all(tasks).then(function () {
          curso.bloques = anonMode() ? sortByOrden(bloques) : bloques;
          curso.bloquesLoaded = true;
          curso._treeMode = mode;
          return curso;
        });
      })
      .catch(function () {
        curso.bloques = [];
        curso.bloquesLoaded = true;
        curso._treeMode = mode;
        return curso;
      });
  }

  function ensureCourse(courseId) {
    var curso = getCourseById(courseId);
    if (curso) return loadCursoTree(curso);
    if (!V.db) return Promise.resolve(null);
    // Fallback: raíz legacy o búsqueda dentro de las categorías.
    return V.db.collection(V.COL_CURSOS).doc(courseId).get().then(function (doc) {
      if (doc.exists) {
        var d = doc.data();
        var c = { id: doc.id, catId: null, titulo: d.titulo || '', descripcion: d.descripcion || '', publicado: d.publicado === true, fecha: d.fecha || null, bloques: [], bloquesLoaded: false };
        if (!getCourseById(courseId)) cursosCache.push(c);
        return loadCursoTree(c);
      }
      return null;
    }).then(function (legacy) {
      if (legacy) return legacy;
      return catCol().get().then(function (cats) {
        var tasks = [];
        cats.forEach(function (c) { tasks.push(c.ref.collection(V.COL_CURSOS).doc(courseId).get()); });
        return Promise.all(tasks).then(function (docs) {
          for (var i = 0; i < docs.length; i++) {
            if (docs[i].exists) {
              var d2 = docs[i].data();
              var c2 = { id: courseId, catId: docs[i].ref.parent.parent.id, titulo: d2.titulo || '', descripcion: d2.descripcion || '', publicado: d2.publicado === true, fecha: d2.fecha || null, bloques: [], bloquesLoaded: false };
              if (!getCourseById(courseId)) cursosCache.push(c2);
              return loadCursoTree(c2);
            }
          }
          return null;
        });
      });
    });
  }

  /* ─── CATEGORÍAS ──────────────────────────────────────────── */
  function nextCatOrden() {
    var m = 0;
    categoriasCache.forEach(function (c) { m = Math.max(m, c.orden || 0); });
    return m + 1;
  }

  function renderCategoriasBar() {
    var bar = $('cmsCategoriasBar');
    if (!bar) return;
    bar.innerHTML = '';
    var hasAny = categoriasCache.length || cursosCache.some(function (c) { return !c.catId; });
    if (!hasAny && V.mode === 'estudiante') { bar.style.display = 'none'; return; }
    bar.style.display = '';

    var pills = el('div', 'categorias-pills');
    pills.appendChild(catPill('todas', 'Todas', cursosCache.length));
    categoriasCache.forEach(function (cat) {
      var n = cursosCache.filter(function (c) {
        return c.catId === cat.id && (V.mode !== 'estudiante' || c.publicado !== false);
      }).length;
      pills.appendChild(catPill(cat.id, cat.titulo || 'Sin nombre', n));
    });
    bar.appendChild(pills);

    if (V.mode !== 'estudiante') {
      var addRow = el('div', 'categoria-add-row');
      var toggle = el('button', 'cat-add-toggle', '＋ Nueva categoría');
      toggle.type = 'button';
      toggle.addEventListener('click', function () { startCategoriaEditor(null); });
      addRow.appendChild(toggle);
      bar.appendChild(addRow);
    }
  }

  function catPill(id, label, count) {
    var pill = el('div', 'cat-pill' + (catFilter === id ? ' active' : ''));
    pill.setAttribute('role', 'button');
    pill.setAttribute('tabindex', '0');
    pill.appendChild(el('span', '', label));
    pill.appendChild(el('span', 'cat-count', '(' + count + ')'));
    pill.addEventListener('click', function () {
      if (catFilter !== id) { catFilter = id; renderCatalog(); }
    });

    if (V.mode !== 'estudiante' && id !== 'todas') {
      var acts = el('span', 'cat-pill-actions');
      var ed = el('button', 'cat-pill-action', '✎');
      ed.type = 'button'; ed.title = 'Renombrar';
      ed.addEventListener('click', function (e) { e.stopPropagation(); startCategoriaEditor(getCategoriaById(id)); });
      var del = el('button', 'cat-pill-action danger', '🗑');
      del.type = 'button'; del.title = 'Eliminar';
      del.addEventListener('click', function (e) { e.stopPropagation(); deleteCategoria(id); });
      acts.appendChild(ed);
      acts.appendChild(del);
      pill.appendChild(acts);
    }
    return pill;
  }

  function startCategoriaEditor(cat) {
    var bar = $('cmsCategoriasBar');
    if (!bar) return;
    var row = el('div', 'categoria-add-row');
    var inp = document.createElement('input');
    inp.type = 'text'; inp.className = 'input'; inp.placeholder = 'Nombre de la categoría';
    if (cat) inp.value = cat.titulo || '';
    var save = el('button', 'btn btn-primary btn-sm', cat ? 'Guardar' : 'Crear');
    save.type = 'button';
    save.addEventListener('click', function () {
      var nombre = inp.value.trim();
      if (!nombre) { V.toast('Escribe un nombre.', true); return; }
      if (cat) {
        catRef(cat.id).update({ titulo: nombre })
          .then(function () { V.toast('Categoría guardada ✓'); renderCategoriasBar(); renderEditorCategoriaSelect(); })
          .catch(function (e) { V.toast('Error al guardar: ' + e.message, true); });
      } else {
        catCol().add({ titulo: nombre, orden: nextCatOrden(), fecha: new Date().toISOString() })
          .then(function () { V.toast('Categoría creada ✓'); renderCategoriasBar(); renderCatalog(); renderEditorCategoriaSelect(); })
          .catch(function (e) { V.toast('Error al crear: ' + e.message, true); });
      }
      row.innerHTML = '';
      row.appendChild(el('span', 'cms-empty', '…'));
    });
    var cancel = el('button', 'btn btn-outline btn-sm', 'Cancelar');
    cancel.type = 'button';
    cancel.addEventListener('click', renderCategoriasBar);
    row.appendChild(inp);
    row.appendChild(save);
    row.appendChild(cancel);
    bar.innerHTML = '';
    bar.appendChild(row);
    inp.focus();
    if (cat) inp.select();
  }

  // Recopila operaciones de borrado del subárbol completo de un curso
  // (bloques → lecciones, progreso y el propio curso).
  function collectDeleteOps(curso) {
    return loadCursoTree(curso).then(function () {
      var ops = [];
      (curso.bloques || []).forEach(function (b) {
        if (!b.id) return;
        (b.lecciones || []).forEach(function (l) {
          if (l.id) ops.push(bloqueBaseRef(curso, b).collection(V.COL_LECCIONES).doc(l.id).delete());
        });
        ops.push(bloqueBaseRef(curso, b).delete());
      });
      ops.push(progRefFromCurso(curso).delete());
      ops.push(cursoBaseRef(curso).delete());
      return ops;
    });
  }

  function deleteCategoria(catId) {
    var cat = getCategoriaById(catId);
    var n = cursosCache.filter(function (c) { return c.catId === catId; }).length;
    if (!confirm('¿Eliminar la categoría "' + ((cat && cat.titulo) || '') + '"' + (n ? ' y sus ' + n + ' curso(s)' : '') + '? Esta acción no se puede deshacer.')) return;
    if (catFilter === catId) catFilter = 'todas';
    Promise.all(cursosCache.filter(function (c) { return c.catId === catId; }).map(collectDeleteOps))
      .then(function (opSets) {
        var ops = [catRef(catId).delete()];
        (opSets || []).forEach(function (os) { ops = ops.concat(os); });
        return Promise.all(ops);
      })
      .then(function () { V.toast('Categoría eliminada'); renderCatalog(); renderEditorCategoriaSelect(); })
      .catch(function (e) { V.toast('Error al eliminar: ' + e.message, true); });
  }

  function renderEditorCategoriaSelect() {
    var sel = $('edCategoria');
    if (!sel) return;
    var current = editingCatId || sel.value || '';
    sel.innerHTML = '';
    if (!categoriasCache.length) {
      var o0 = document.createElement('option');
      o0.value = ''; o0.textContent = 'Sin categorías (crea una en el catálogo)';
      sel.appendChild(o0);
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    categoriasCache.forEach(function (cat) {
      var o = document.createElement('option');
      o.value = cat.id; o.textContent = cat.titulo || 'Sin nombre';
      o.selected = (current === cat.id);
      sel.appendChild(o);
    });
  }

  /* ─── CATALOG ─────────────────────────────────────────────── */
  function renderCatalog() {
    var grid = $('coursesGrid');
    var empty = $('emptyCatalog');
    renderCategoriasBar();
    if (!grid) return;
    if (catFilter !== 'todas' && !getCategoriaById(catFilter)) catFilter = 'todas';
    grid.innerHTML = '';
    V.clearFbError();

    var visible = cursosCache.filter(function (c) {
      if (V.mode === 'estudiante' && c.publicado === false) return false;
      if (catFilter !== 'todas' && c.catId !== catFilter) return false;
      return true;
    });
    if (!visible.length) {
      empty.style.display = 'block';
      $('emptyText').textContent = V.mode === 'gestor' ? 'Crea una categoría y tu primer curso para comenzar.' : 'No hay cursos disponibles por ahora.';
      return;
    }
    empty.style.display = 'none';

    var groups = [];
    var orphans = visible.filter(function (c) { return !c.catId; });
    if (orphans.length) groups.push({ titulo: 'Sin categoría', cursos: orphans });
    categoriasCache.forEach(function (cat) {
      var cs = visible.filter(function (c) { return c.catId === cat.id; });
      if (cs.length) groups.push({ titulo: cat.titulo || 'Sin nombre', cursos: cs });
    });

    groups.forEach(function (g) {
      var sec = el('div', 'cat-group');
      var hdr = el('div', 'cat-group-header');
      hdr.appendChild(el('h3', 'cat-group-title', g.titulo));
      hdr.appendChild(el('span', 'cat-group-count', g.cursos.length + (g.cursos.length === 1 ? ' curso' : ' cursos')));
      sec.appendChild(hdr);
      var inner = el('div', 'catalog-grid');
      g.cursos.forEach(function (c) { inner.appendChild(renderCourseCard(c)); });
      sec.appendChild(inner);
      grid.appendChild(sec);
    });
  }

  function renderCourseCard(curso) {
    var card = el('div', 'course-card' + (V.mode === 'estudiante' ? ' card-link' : ''));
    card.setAttribute('data-course-id', curso.id);
    var head = el('div', 'course-card-head');
    head.appendChild(el('h3', 'course-card-title', (curso.publicado === false ? '📄 ' : '') + (curso.titulo || 'Sin título')));
    if (curso.categoria) head.appendChild(el('span', 'status-pill blue', curso.categoria));
    card.appendChild(head);

    var p = el('p', 'course-card-desc', curso.descripcion || '');
    if (!curso.descripcion) p.textContent = 'Sin descripción.';
    card.appendChild(p);

    var meta = el('div', 'course-card-meta');
    var n = lessonCount(curso);
    meta.appendChild(el('span', 'course-card-lessons', n + (n === 1 ? ' lección' : ' lecciones')));
    if (curso.publicado === false) meta.appendChild(el('span', 'course-card-pct', 'Borrador'));
    if (anonMode() && n === 0) meta.appendChild(el('span', 'course-card-pct locked', '🔒 Completo'));
    var pct = pctOf(curso);
    meta.appendChild(el('span', 'course-card-pct' + (pct === 100 ? ' complete' : ''), pct + '%'));
    card.appendChild(meta);

    if (V.mode !== 'estudiante') {
      var actions = el('div', 'course-card-actions');
      var editBtn = el('button', 'btn btn-outline', '✏ Editar');
      editBtn.type = 'button';
      editBtn.setAttribute('data-action', 'edit');
      editBtn.setAttribute('data-course-id', curso.id);
      var delBtn = el('button', 'btn btn-danger', '🗑 Eliminar');
      delBtn.type = 'button';
      delBtn.setAttribute('data-action', 'delete');
      delBtn.setAttribute('data-course-id', curso.id);
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);
      card.appendChild(actions);
    }

    return card;
  }

  function onCatalogClick(e) {
    var actionBtn = e.target.closest ? e.target.closest('[data-action]') : null;
    var node = actionBtn || (e.target.closest ? e.target.closest('[data-course-id]') : null);
    if (!node) return;
    var action = actionBtn ? actionBtn.dataset.action : null;
    var courseId = (actionBtn && actionBtn.dataset.courseId) || node.dataset.courseId;
    if (!courseId) return;
    var curso = getCourseById(courseId);

    if (action === 'delete' && curso) { e.stopPropagation(); deleteCourse(curso); return; }
    if (action === 'edit' && curso) { e.stopPropagation(); openEditor(curso); return; }
    if (curso && !action) openCourse(curso.id);
  }

  function bindCatalogEvents() {
    if (catalogBound) return;
    var grid = $('coursesGrid');
    if (grid) { catalogBound = true; grid.addEventListener('click', onCatalogClick); return; }
    var attempts = (bindCatalogEvents._attempts || 0) + 1;
    bindCatalogEvents._attempts = attempts;
    if (attempts > 5) return;
    setTimeout(function () { bindCatalogEvents(); }, 100);
  }

  /* ─── COURSE VIEW ─────────────────────────────────────────── */
  function openCourse(courseId) {
    cursoActualId = courseId;
    ensureCourse(courseId).then(function (curso) {
      if (!curso) { V.toast('No se encontró el curso.', true); return; }
      $('courseTitle').textContent = curso.titulo || 'Curso';
      $('courseDesc').textContent = curso.descripcion || '';
      $('btnEditCourseCms').style.display = (V.userRole === 'gestor' || V.userRole === 'superadmin') ? '' : 'none';
      // Visitante: el muro de registro solo aparece cuando realmente NO hay
      // ningún bloque/lección con acceso libre o de prueba. Si el curso tiene
      // contenido abierto se renderiza y se avisa del resto con una nota.
      if (anonMode() && curso.bloquesLoaded && lessonCount(curso) === 0) {
        renderLockedCourse(curso);
        V.showView('viewCourse');
        return;
      }
      subscribeCursoContent(curso);
      renderCourseLessons(curso);
      V.showView('viewCourse');
    }).catch(function (e) {
      // Las reglas de Firestore pueden denegar la lectura de un curso
      // completo a un visitante: se muestra el estado bloqueado + CTA.
      if (anonMode() && /permission.denied|permiso|denied/i.test((e && e.message) || '')) {
        var locked = getCourseById(courseId) || { id: courseId, titulo: 'Curso' };
        renderLockedCourse(locked);
        V.showView('viewCourse');
        return;
      }
      V.toast('No se pudo abrir el curso: ' + (e && e.message ? e.message : e), true);
    });
  }

  // Estado «curso completo» para visitantes anónimos.
  function renderLockedCourse(curso) {
    var list = $('lessonList');
    if (!list) return;
    list.innerHTML = '';
    var box = V.emptyState('🔒', 'Curso completo', 'Para acceder a este curso completo necesitas una cuenta registrada. Las lecciones de prueba gratuitas seguirán disponibles.');
    box.classList.add('locked-course');
    var btn = V.el('button', 'btn btn-primary', '🔐 Iniciar sesión o registrarse');
    btn.type = 'button';
    btn.addEventListener('click', function () { V.openAuth('register'); });
    var cta = V.el('div', 'locked-course-cta');
    cta.appendChild(btn);
    box.appendChild(cta);
    list.appendChild(box);
  }

  // Nota no bloqueante para visitantes cuando el curso tiene contenido de
  // prueba visible y el resto requiere cuenta registrada. Sustituye al muro
  // completo cuando existen bloques/lecciones de acceso libre o de prueba.
  function buildPartialHint() {
    var hint = el('div', 'locked-course-hint');
    var txt = el('span', 'locked-course-hint-text',
      '🔓 Este curso contiene más contenido reservado a cuentas registradas; las lecciones de prueba que ves siguen disponibles.');
    var btn = el('button', 'btn btn-outline btn-sm', '🔐 Iniciar sesión o registrarse');
    btn.type = 'button';
    btn.addEventListener('click', function () { V.openAuth('register'); });
    hint.appendChild(txt);
    hint.appendChild(btn);
    return hint;
  }

  // Suscripción en tiempo real del contenido (bloques → lecciones)
  // del curso abierto. Para visitantes usa consultas TOLERANTES combinadas
  // (subscribeMerged) que no descartan documentos por `acceso` ausente o con
  // variaciones; solo excluyen los de restricción estricta ('completo'/'pago').
  function subscribeCursoContent(curso) {
    if (!V.db || !curso.catId) return;
    // Las suscripciones se reconstruyen si cambió el modo de sesión para que
    // el filtro de acceso libre (solo anónimos) no quede fijo y un usuario con
    // cuenta pierda bloques/lecciones de acceso 'completo'.
    var contentMode = anonMode() ? 'anon' : 'registrado';
    if (curso.contentSubbed && curso._contentMode === contentMode) return;
    if (curso._unsubContent) { try { curso._unsubContent(); } catch (e) {} }
    curso.contentSubbed = true;
    curso._contentMode = contentMode;
    var path = cursoBaseRef(curso);
    var unsubLessons = {};
    var unsubs = [];

    function stopLessonSubs() {
      Object.keys(unsubLessons).forEach(function (k) { try { unsubLessons[k](); } catch (e) {} });
      unsubLessons = {};
    }

    function syncContenido() {
      if (cursoActualId === curso.id) {
        var view = $('viewCourse');
        if (view && view.classList.contains('active')) renderCourseLessons(curso);
      }
      renderCatalog();
      updateProgressBar();
    }

    // Bloques: consulta única y completa para toda sesión (sin filtro de
    // `acceso` a nivel de query); el filtrado de acceso solo ocurre en las
    // lecciones (suscripciones con subscribeMerged más abajo).
    var unsubBloques = path.collection(V.COL_BLOQUES).orderBy('orden', 'asc').onSnapshot(function (snap) {
        var bloques = [];
        var seen = {};
        snap.forEach(function (bDoc) {
          var data = bDoc.data();
          var b = { id: bDoc.id, titulo: data.titulo || '', orden: data.orden || 0, fecha: data.fecha || null, lecciones: [] };
          var prev = findBloqueById(curso, b.id);
          if (prev && prev.lecciones) b.lecciones = prev.lecciones;
          seen[b.id] = true;
          bloques.push(b);
        });
        bloques = anonMode() ? sortByOrden(bloques) : bloques;
        Object.keys(unsubLessons).forEach(function (bid) {
          if (!seen[bid]) { try { unsubLessons[bid](); } catch (e) {} delete unsubLessons[bid]; }
        });
        bloques.forEach(function (b) {
          if (!unsubLessons[b.id]) {
            unsubLessons[b.id] = subscribeMerged(bloqueBaseRef(curso, b).collection(V.COL_LECCIONES), function (lessonDocs) {
              var lecciones = [];
              lessonDocs.forEach(function (l) {
                if (anonMode() && esAccesoRestringido(l.acceso)) return;
                lecciones.push(l);
              });
              lecciones = anonMode() ? sortByOrden(lecciones) : lecciones;
              var target = findBloqueById(curso, b.id);
              if (target) target.lecciones = lecciones;
              else b.lecciones = lecciones;
              syncContenido();
            }, function (e) { V.toast('Error al sincronizar lecciones: ' + e.message, true); });
          }
        });
        curso.bloques = bloques;
        curso.bloquesLoaded = true;
        syncContenido();
      }, function (e) { V.toast('Error de conexión a Firestore: ' + e.message, true); });

    unsubs.push(unsubBloques);
    unsubs.push(stopLessonSubs);
    curso._unsubContent = function () {
      unsubs.forEach(function (fn) { try { fn(); } catch (e) {} });
      curso.contentSubbed = false;
      curso._unsubContent = null;
    };
  }

  function renderCourseLessons(curso) {
    var list = $('lessonList');
    if (!list) return;
    list.innerHTML = '';
    var seq = flattenSeq(curso);
    var completed = currentProgress(curso.id);
    if (!seq.length) {
      list.appendChild(V.emptyState('📚', 'Sin contenido', 'Este curso aún no tiene bloques ni lecciones.'));
      return;
    }

    // Visitantes con contenido de prueba: se muestran los bloques/lecciones de
    // acceso libre y se avisa (sin muro) de que el resto es para cuentas
    // registradas. Los cursos 100% abiertos (curso.acceso === 'gratis') no
    // muestran el aviso.
    if (anonMode() && curso.acceso !== 'gratis') {
      list.appendChild(buildPartialHint());
    }

    var idx = 0;
    (curso.bloques || []).forEach(function (b, bi) {
      if (!(b.lecciones || []).length) return;
      var block = el('div', 'bloque-block');
      var hdr = el('div', 'bloque-block-header');
      hdr.appendChild(el('span', 'cms-bloque-num', String(bi + 1)));
      hdr.appendChild(el('span', 'bloque-block-title', b.titulo || ('Bloque ' + (bi + 1))));
      block.appendChild(hdr);

      b.lecciones.forEach(function (lp) {
        if (!lp.id) return;
        var i = idx++;
        var done = completed.indexOf(String(lp.id)) !== -1;
        var unlocked = isLessonUnlocked(seq, completed, i);
        var item = el('div', 'lesson-item' + (done ? ' completed' : '') + (!unlocked ? ' locked' : ''));
        item.appendChild(el('span', 'lesson-num', String(i + 1)));
        var info = el('div', 'lesson-info');
        info.appendChild(el('div', 'lesson-title', lp.titulo || ('Lección ' + (i + 1))));
        if (lp.fecha) info.appendChild(el('div', 'lesson-date', V.fmtDate(lp.fecha)));
        item.appendChild(info);
        item.appendChild(el('span', 'lesson-status-icon', done ? '✅' : (!unlocked ? '🔒' : '▶')));
        item.onclick = function () {
          var current = currentProgress(curso.id);
          if (!isLessonUnlocked(seq, current, i)) return;
          openLesson(curso, seq, i);
        };
        block.appendChild(item);
      });

      list.appendChild(block);
    });
  }

  /* ─── LESSON READER ───────────────────────────────────────── */
  function openLesson(curso, seq, indice) {
    var completed = currentProgress(curso.id);
    if (!isLessonUnlocked(seq, completed, indice)) {
      V.toast('Completa la lección anterior para desbloquear esta.', true);
      return;
    }
    leccionActual = { curso: curso, seq: seq, indice: indice };
    var piece = seq[indice];
    var lp = piece.leccion;
    $('readerLessonMeta').textContent = (curso.titulo || 'Curso') + ' · ' + ((piece.bloque && piece.bloque.titulo) || 'Bloque') + ' · Lección ' + (indice + 1) + ' de ' + seq.length;
    $('readerTitle').textContent = lp.titulo || ('Lección ' + (indice + 1));
    renderContent(lp);
    renderReaderNav(seq, indice, completed);
    V.showView('viewLesson');
  }

  function renderContent(lp) {
    var c = $('readerContent');
    c.innerHTML = '';
    // La media (video de YouTube, video/audio o imagen) va SIEMPRE arriba y
    // destacada, antes del contenido de texto.
    if (lp.media_url && lp.media_tipo && lp.media_tipo !== 'none') {
      c.appendChild(buildMediaPlayer(lp));
    }
    var holder = document.createElement('div');
    holder.className = 'lesson-body lesson-content';
    if (lp.contenido) {
      holder.innerHTML = lp.contenido;
    } else {
      holder.appendChild(el('p', '', 'Sin contenido por ahora.'));
    }
    // Convierte automáticamente las URL de YouTube (youtu.be/ID y
    // youtube.com/watch?v=ID) en reproductores iframe responsivos, cada una
    // con su propio player, como en WordPress.
    embedYouTubeLinks(holder);
    stripLegacyTextColors(holder);
    c.appendChild(holder);
    // Los encabezados sin cerrar se tragan el cuerpo de la lección: se reparan
    // ANTES de medir tamaños, porque el conversor necesita que el padre de
    // cada texto sea el elemento que le corresponde y no un <h1>.
    repairHeadingNesting(holder);
    // Convierte a em las longitudes absolutas que puso el autor (px, pt, in…)
    // para que el texto del contenido también siga la escala de A- / A+. Va
    // tras insertar el nodo porque necesita estilos calculados
    // (getComputedStyle).
    normalizeInlineFontSizes(holder);
    // Blindar elementos de media incrustados en el HTML del contenido y resolver
    // rutas gs:// de Firebase Storage.
    c.querySelectorAll('video,audio').forEach(function (m) {
      secureMedia(m);
      if (/^gs:\/\//.test(m.getAttribute('src'))) {
        resolveMediaUrl(m.getAttribute('src')).then(function (url) {
          if (m.isConnected) m.src = url;
        }).catch(function (err) {
          console.warn('[media:incrustado] no se pudo resolver gs://:', err);
        });
      }
    });
  }

  function secureMedia(m) {
    m.setAttribute('controlsList', 'nodownload noremoteplayback');
    if (m.tagName === 'VIDEO') m.setAttribute('disablePictureInPicture', '');
    m.setAttribute('preload', 'metadata');
    m.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    m.addEventListener('dragstart', function (e) { e.preventDefault(); });
  }

  // Extrae el id de vídeo de enlaces de YouTube (youtu.be, watch?v=, embed/,
  // shorts/, live/). Devuelve null si no es un enlace de YouTube válido.
  function youtubeIdFromUrl(url) {
    if (!url) return null;
    var m = url.match(/^.*(?:youtu\.be\/|v\/|embed\/|shorts\/|live\/|watch\?(?:.*&)?v=)([A-Za-z0-9_-]{11}).*$/);
    return m ? m[1] : null;
  }

  // Contenedor responsivo de vídeo (iframe interactivo) para YouTube.
  function buildYouTubeEmbed(ytId) {
    var wrap = el('div', 'yt-embed');
    var frame = document.createElement('iframe');
    frame.src = 'https://www.youtube-nocookie.com/embed/' + ytId + '?rel=0&modestbranding=1&playsinline=1&color=white';
    frame.title = 'Video de YouTube';
    frame.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen');
    frame.setAttribute('allowfullscreen', '');
    frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    frame.loading = 'lazy';
    wrap.appendChild(frame);
    return wrap;
  }

  // Convierte automáticamente las URL de YouTube dentro del HTML del contenido
  // (texto suelto y enlaces <a>) en reproductores iframe, cada URL con su
  // propio player, exactamente igual que en WordPress. Soporta tanto
  // `youtu.be/ID` como `youtube.com/watch?v=ID` (y v/, embed/, shorts/, live/).
  function embedYouTubeLinks(root) {
    var urlRe = /https?:\/\/[^\s"'<>[\](){}]+/gi;

    // Si un bloque (párrafo, div…) contiene únicamente una URL de YouTube, se
    // sustituye el bloque entero por el reproductor.
    function replaceWholeIfOnlyUrl(node) {
      if (node.nodeType !== 1 || node.children.length) return false;
      var text = node.textContent || '';
      if (!text.trim()) return false;
      var id = youtubeIdFromUrl(text.trim());
      var rest = text.trim().replace(urlRe, '');
      if (id && rest.trim() === '') {
        node.replaceWith(buildYouTubeEmbed(id));
        return true;
      }
      return false;
    }

    // 1) Enlaces <a> cuyo destino sea YouTube.
    var anchors = Array.prototype.slice.call(root.querySelectorAll('a'));
    anchors.forEach(function (a) {
      var href = a.getAttribute('href') || a.href || '';
      var id = youtubeIdFromUrl(a.href || href);
      if (!id) return;
      var embed = buildYouTubeEmbed(id);
      // Si el texto visible del enlace ES la URL, sustituye el enlace; si el
      // enlace tiene texto descriptivo, se conserva y el reproductor se añade
      // justo después.
      if ((a.textContent || '').search(/https?:\/\//i) !== -1) a.replaceWith(embed);
      else a.after(embed);
    });

    // 2) URL de YouTube sueltas dentro del texto plano.
    var nodes = [];
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(function (node) {
      var p = node.parentNode;
      if (!p || !p.tagName) return;
      if (p.tagName === 'A') return; // ya tratado en el paso 1
      if (replaceWholeIfOnlyUrl(p)) return;
      var text = node.nodeValue;
      urlRe.lastIndex = 0;
      var matches = [];
      var m;
      while ((m = urlRe.exec(text))) matches.push(m);
      if (!matches.length) return;
      var frag = document.createDocumentFragment();
      var last = 0;
      matches.forEach(function (mm) {
        var id = youtubeIdFromUrl(mm[0]);
        if (!id) return;
        frag.appendChild(document.createTextNode(text.slice(last, mm.index)));
        frag.appendChild(buildYouTubeEmbed(id));
        last = mm.index + mm[0].length;
      });
      if (last > 0) {
        frag.appendChild(document.createTextNode(text.slice(last)));
        p.replaceChild(frag, node);
      }
    });
  }

  // Detecta enlaces de Spotify (open.spotify.com o spotify:) y devuelve la URL
  // del reproductor embebido oficial, o null si no es un enlace de Spotify.
  function spotifyEmbedUrl(url) {
    if (!url) return null;
    var m = String(url).match(/open\.spotify\.com(?:\/intl-[a-z]+)?\/(?:embed\/)?(track|album|playlist|artist|show|episode)\/([A-Za-z0-9]+)/i);
    if (m) return { src: 'https://open.spotify.com/embed/' + m[1].toLowerCase() + '/' + m[2], type: m[1].toLowerCase() };
    var uri = String(url).match(/^spotify:(track|album|playlist|artist|show|episode):([A-Za-z0-9]+)$/i);
    if (uri) return { src: 'https://open.spotify.com/embed/' + uri[1].toLowerCase() + '/' + uri[2], type: uri[1].toLowerCase() };
    return null;
  }

  function buildMediaPlayer(leccion) {
    var wrap = el('div', 'media-player-wrap');
    var tipo = leccion.media_tipo || 'none';
    var ytId = tipo === 'video' ? youtubeIdFromUrl(leccion.media_url || '') : null;
    var spot = spotifyEmbedUrl(leccion.media_url || '');

    wrap.appendChild(el('span', 'media-badge',
      ytId ? '🎬 YouTube' : (spot ? '🎵 Spotify' : (tipo === 'audio' ? '🔊 Audio' : (tipo === 'image' ? '🖼 Imagen' : '🎬 Video')))));

    // YouTube embebido: iframe interactivo (reproducción, pantalla completa…).
    if (ytId) {
      var frame = document.createElement('iframe');
      frame.src = 'https://www.youtube-nocookie.com/embed/' + ytId + '?rel=0&modestbranding=1&playsinline=1&color=white';
      frame.title = 'Video de YouTube de la lección';
      frame.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen');
      frame.setAttribute('allowfullscreen', '');
      frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
      frame.loading = 'lazy';
      wrap.appendChild(frame);
      return wrap;
    }

    // Spotify embebido: un <audio> nativo no puede reproducir páginas web.
    if (spot) {
      var sf = document.createElement('iframe');
      sf.src = spot.src;
      sf.title = 'Reproductor de Spotify';
      sf.setAttribute('allow', 'encrypted-media');
      sf.setAttribute('allowfullscreen', '');
      sf.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
      sf.loading = 'lazy';
      var spotHeights = { track: 152, episode: 232, show: 232, album: 380, playlist: 380, artist: 380 };
      sf.style.height = (spotHeights[spot.type] || 152) + 'px';
      wrap.className += ' media-player-wrap--spotify';
      wrap.appendChild(sf);
      return wrap;
    }

    if (tipo === 'image') {
      var img = document.createElement('img');
      img.src = leccion.media_url;
      img.alt = 'Imagen de la lección';
      img.loading = 'lazy';
      wrap.appendChild(img);
      return wrap;
    }

    var m = document.createElement(tipo === 'audio' ? 'audio' : 'video');
    m.controls = true;
    m.controlsList = 'nodownload noremoteplayback';
    if (m.tagName === 'VIDEO') { m.disablePictureInPicture = true; m.playsInline = true; }
    var spinner = el('div', 'media-loading');
    spinner.textContent = 'Cargando media\u2026';
    wrap.appendChild(spinner);
    // Los listeners se registran ANTES de fijar el src para no perder el primer
    // evento ('error', 'loadstart', etc.) y poder diagnosticar el 0:00 / 0:00.
    wireMediaLoad(m, wrap);
    secureMedia(m);
    wrap.appendChild(m);
    resolveMediaUrl(leccion.media_url).then(function (url) {
      if (spinner.parentNode) spinner.parentNode.removeChild(spinner);
      m.src = url;
    }, function (err) {
      console.warn('resolveMediaUrl FALLÓ con entrada:', JSON.stringify(leccion.media_url), '| error:', err && err.message);
      if (spinner.parentNode) spinner.parentNode.removeChild(spinner);
      showMediaError(wrap, leccion.media_url, err);
    });
    ['contextmenu', 'dragstart'].forEach(function (ev) { wrap.addEventListener(ev, function (e) { e.preventDefault(); }); });
    return wrap;
  }

  // Convierte rutas gs:// de Firebase Storage en URLs HTTPS de descarga con
  // token. Los enlaces https:// se devuelven tal cual.
  function resolveMediaUrl(url) {
    if (!url) return Promise.reject(new Error('URL de media vacía'));
    if (/^https?:\/\//.test(url)) {
      return Promise.resolve(url);
    }
    if (/^gs:\/\//.test(url) && V.storage) {
      return V.storage.refFromURL(url).getDownloadURL().then(function (dlUrl) {
        return dlUrl;
      }, function (e) {
        console.warn('resolveMediaUrl → getDownloadURL() FALLÓ:', e && e.message);
        throw e;
      });
    }
    return Promise.reject(new Error('URL de media no válida: ' + url));
  }

  function showMediaError(wrap, url, err) {
    var panel = wrap.querySelector('.media-error');
    if (panel) return;
    var box = el('div', 'media-error');
    box.appendChild(el('strong', '', 'No se pudo cargar la media'));
    var hint;
    if (/^gs:\/\//.test(url)) {
      hint = 'La URL es de Firebase Storage (gs://). Comprueba que el archivo existe y el enlace es correcto.';
    } else {
      hint = (err && err.message ? err.message + '. ' : '') +
        'Comprueba que la URL es HTTPS y accesible públicamente.';
    }
    box.appendChild(el('p', '', hint));
    wrap.appendChild(box);
  }

  // Vigila la carga/reproducción de la media: registra en consola cada evento
  // relevante (sobre todo los errores) y muestra un aviso visible si la media
  // no carga. Diagnostica el caso típico del reproductor colgado en 0:00 / 0:00.
  function wireMediaLoad(m, wrap) {
    // preload 'auto' en audio evita que la duración se quede en NaN cuando el
    // servidor no soporta peticiones Range y la metadata nunca llega.
    m.preload = m.tagName === 'AUDIO' ? 'auto' : 'metadata';
    var errCodes = { 1: 'MEDIA_ERR_ABORTED', 2: 'MEDIA_ERR_NETWORK', 3: 'MEDIA_ERR_DECODE', 4: 'MEDIA_ERR_SRC_NOT_SUPPORTED' };

    function step(evt) {
      var dur = isNaN(m.duration) ? 'NaN' : m.duration.toFixed(2) + 's';
      var base = '[media:' + m.tagName.toLowerCase() + '] ' + evt;
      if (evt === 'loadedmetadata' || evt === 'durationchange') console.warn(base + ' duración=' + dur);
      else if (evt === 'error') console.warn(base + ' code=' + (m.error ? m.error.code : 0) +
        ' (' + (m.error ? (errCodes[m.error.code] || 'desconocido') : 'sin detalle') + ')' +
        ' networkState=' + m.networkState + ' readyState=' + m.readyState +
        ' src=' + (m.currentSrc || m.src));
      else console.warn(base);
      if (evt === 'error') showError(true);
      else if (evt === 'loadedmetadata' || evt === 'durationchange' || evt === 'canplay' || evt === 'playing') showError(false);
    }

    ['error', 'abort', 'emptied', 'stalled', 'suspend', 'loadstart', 'loadedmetadata',
      'durationchange', 'canplay', 'canplaythrough', 'playing', 'ended'].forEach(function (evt) {
      m.addEventListener(evt, function () { step(evt); });
    });

    function showError(on) {
      var panel = wrap.querySelector('.media-error');
      if (!on) {
        if (panel) panel.parentNode.removeChild(panel);
        return;
      }
      if (panel) return;
      var url = m.src || '';
      var box = el('div', 'media-error');
      box.appendChild(el('strong', '', 'No se pudo cargar la media'));
      var hint;
      if (/^gs:\/\//.test(url)) {
        hint = 'La URL es de Firebase Storage (gs://). Pega el enlace de descarga HTTPS (con token) en la lección.';
      } else if (m.error && m.error.code === 4) {
        hint = 'El tipo o el enlace no son compatibles con el reproductor. Revisa la URL y el tipo de media.';
      } else {
        hint = 'Comprueba que la URL es HTTPS y accesible públicamente. Detalles en la consola (F12).';
      }
      box.appendChild(el('p', '', hint));
      wrap.appendChild(box);
    }
  }

  function renderReaderNav(seq, indice, completed) {
    var done = completed.indexOf(String(seq[indice].leccion.id)) !== -1;
    var completeLabel = $('completeLabel');
    var btnComplete = $('btnCompleteLesson');
    if (anonMode()) {
      // Visitante (modo local, solo lectura): no hay progreso que guardar.
      btnComplete.textContent = '🔐 Crear cuenta';
      btnComplete.disabled = false;
      completeLabel.textContent = 'Estás como visitante: crea tu cuenta para guardar tu avance.';
      completeLabel.className = 'complete-label';
    } else if (done) {
      btnComplete.textContent = '✓ Completada';
      btnComplete.disabled = true;
      completeLabel.textContent = 'Lección completada';
      completeLabel.className = 'complete-label done';
    } else {
      btnComplete.textContent = '✓ Marcar como completada';
      btnComplete.disabled = false;
      completeLabel.textContent = '';
      completeLabel.className = 'complete-label';
    }
    $('btnPrevLesson').disabled = indice <= 0;
    $('btnNextLesson').disabled = !done || indice >= seq.length - 1;
  }

  /* ─── PROGRESS ────────────────────────────────────────────── */
  function saveProgress(curso, update) {
    if (!V.db) return Promise.resolve();
    // Visitante (modo local): sin sesión no hay UID válido ni permiso de
    // escritura en Firestore (reglas exigen request.auth.uid == uid). No se
    // intenta escribir nada; se avisa para que cree su cuenta.
    if (!uidSesion()) {
      V.toast('Crea tu cuenta para guardar tu progreso.');
      return Promise.resolve();
    }
    return progRefFromCurso(curso).set(update, { merge: true })
      .catch(function (e) { V.toast('No se pudo guardar el progreso: ' + e.message, true); });
  }

  function markLessonComplete() {
    if (!leccionActual) return;
    if (anonMode()) { V.openAuth('register'); return; }
    var curso = leccionActual.curso;
    var lp = leccionActual.seq[leccionActual.indice].leccion;
    var prog = progresoCache[curso.id] || {};
    var completed = (prog.completed || []);
    if (completed.indexOf(String(lp.id)) !== -1) return;
    completed.push(String(lp.id));
    var indice = Math.max(prog.indice || 0, leccionActual.indice + 1);
    saveProgress(curso, { completed: completed, indice: indice }).then(function () {
      V.toast('¡Lección completada! 🎉');
      renderReaderNav(leccionActual.seq, leccionActual.indice, completed);
    });
  }

  function subscribeProgreso(curso) {
    if (!V.db || !curso) return;
    // Sin sesión activa no hay UID válido: suscribirse apuntaría a
    // `progreso/{''}` y el servidor lo denegaría. Se espera a que la
    // identidad de sesión esté lista (V.onSessionRefresh reconstruye).
    if (!uidSesion()) return;
    var courseId = curso.id;
    if (progresoSubscribed[courseId]) return;
    progresoSubscribed[courseId] = true;
    curso._unsubProg = progRefFromCurso(curso).onSnapshot(function (doc) {
      progresoCache[courseId] = doc.exists ? doc.data() : {};
      if (cursoActualId === courseId && $('viewCourse') && $('viewCourse').classList.contains('active')) {
        var c = getCourseById(courseId);
        if (c) renderCourseLessons(c);
      }
      renderCatalog();
      updateProgressBar();
    }, function (e) {
      // Error transitorio de permisos (migración anónimo → cuenta): se suelta
      // la suscripción en silencio; será reconstruida con el UID correcto por
      // V.onSessionRefresh / V.onModeChange. El resto de errores sí se avisa.
      if (esErrorPermisos(e)) {
        if (curso._unsubProg) { try { curso._unsubProg(); } catch (e2) {} curso._unsubProg = null; }
        delete progresoSubscribed[courseId];
        return;
      }
      V.toast('Error al sincronizar el progreso: ' + e.message, true);
    });
  }

  /* ─── CRUD CURSOS ─────────────────────────────────────────── */

  // Sincroniza cursosCache a partir de un snapshot de un categoryId
  // concreto (o null para cursos raíz legacy).
  function syncCoursesFromSnap(snap, catId) {
    // Eliminar cursos previos de esa categoría del cache.
    cursosCache = cursosCache.filter(function (c) { return c.catId !== catId; });
    snap.forEach(function (doc) {
      var d = doc.data();
      d.id = doc.id;
      d.catId = catId;
      d.bloques = [];
      d.bloquesLoaded = false;
      cursosCache.push(d);
    });
    cursosCache.sort(function (a, b) { return (a.fecha || '').localeCompare(b.fecha || ''); });

    var needsTree = cursosCache.filter(function (c) { return !c.bloquesLoaded; });
    Promise.all(needsTree.map(function (c) { return loadCursoTree(c).catch(function () { return c; }); }))
      .then(function () {
        renderCatalog();
        renderEditorCategoriaSelect();
        updateProgressBar();
        if (cursoActualId && $('viewCourse') && $('viewCourse').classList.contains('active')) {
          var curso = getCourseById(cursoActualId);
          if (curso) renderCourseLessons(curso);
        }
      });

    cursosCache.forEach(function (c) {
      if (!progresoSubscribed[c.id]) subscribeProgreso(c);
    });
  }

  // Suscribe los cursos de UNA categoría (ruta conocida y segura).
  function subscribeCursosForCategory(catId) {
    if (cursoCatSubs[catId]) return;
    var col = catRef(catId).collection(V.COL_CURSOS);
    // Visitantes: solo cursos publicados (como exigen las reglas).
    var q = anonMode() ? col.where('publicado', '==', true) : col;
    cursoCatSubs[catId] = q.onSnapshot(function (snap) {
      syncCoursesFromSnap(snap, catId);
    }, function (e) {
      V.toast('Error de conexión a Firestore: ' + e.message, true);
    });
  }

  function unsubscribeCursosForCategory(catId) {
    if (cursoCatSubs[catId]) {
      try { cursoCatSubs[catId](); } catch (e) {}
      delete cursoCatSubs[catId];
    }
  }

  // Suscribe cursos legacy en la raíz (cursos/{id} sin categoría).
  function subscribeLegacyCursos() {
    if (legacyCursoSub) return;
    var q = anonMode() ? V.db.collection(V.COL_CURSOS).where('publicado', '==', true) : V.db.collection(V.COL_CURSOS);
    legacyCursoSub = q.onSnapshot(function (snap) {
      syncCoursesFromSnap(snap, null);
    }, function (e) {
      V.toast('Error de conexión a Firestore: ' + e.message, true);
    });
  }

  // SubscribeCursos: puntos de entrada llamados desde onReady.
  // Los cursos anidados en categorías se suscriben cuando
  // subscribeCategorias detecta cada categoría.
  function subscribeCursos() {
    if (!V.db) return;
    subscribeLegacyCursos();
  }

  function subscribeCategorias() {
    if (!V.db) return;
    if (categoriasSub) return;
    categoriasSub = catCol().orderBy('orden', 'asc').onSnapshot(function (snap) {
      var newCatIds = {};
      categoriasCache = [];
      snap.forEach(function (doc) {
        var d = doc.data();
        d.id = doc.id;
        categoriasCache.push(d);
        newCatIds[d.id] = true;
      });
      // Suscribir cursos de categorías nuevas.
      categoriasCache.forEach(function (cat) { subscribeCursosForCategory(cat.id); });
      // Dar de baja suscripciones de categorías borradas.
      Object.keys(cursoCatSubs).forEach(function (catId) {
        if (!newCatIds[catId]) {
          unsubscribeCursosForCategory(catId);
          cursosCache = cursosCache.filter(function (c) { return c.catId !== catId; });
        }
      });
      renderCatalog();
      renderEditorCategoriaSelect();
    }, function (e) {
      V.toast('Error de conexión a Firestore: ' + e.message, true);
    });
  }

  function deleteCourse(curso) {
    if (!confirm('¿Eliminar el curso "' + (curso.titulo || '') + '" y todo su contenido? Esta acción no se puede deshacer.')) return;
    collectDeleteOps(curso)
      .then(function (ops) { return Promise.all(ops); })
      .then(function () { V.toast('Curso eliminado'); })
      .catch(function (e) { V.toast('Error al eliminar: ' + e.message, true); });
  }

  // Mueve un curso de categoría copiando el subárbol completo
  // (bloques → lecciones, progreso) a la nueva ruta y borrando la antigua.
  function moveCourseToCategory(curso, newCatId) {
    if (!curso || ((curso.catId || '') === newCatId)) return Promise.resolve();
    return loadCursoTree(curso).then(function () {
      var newRef = cursoRef(newCatId, curso.id);
      var ops = [];
      ops.push(newRef.set({
        titulo: curso.titulo || '',
        descripcion: curso.descripcion || '',
        publicado: curso.publicado === true,
        acceso: curso.acceso || 'completo',
        fecha: curso.fecha || new Date().toISOString(),
        catId: newCatId,
        categoryId: newCatId
      }));
      (curso.bloques || []).forEach(function (b) {
        if (!b.id) return;
        ops.push(bloqueRef(newCatId, curso.id, b.id).set({
          titulo: b.titulo || '',
          orden: b.orden || 0,
          fecha: b.fecha || new Date().toISOString()
        }));
        (b.lecciones || []).forEach(function (l) {
          if (!l.id) return;
          ops.push(leccionRef(newCatId, curso.id, b.id, l.id).set({
            titulo: l.titulo || '',
            contenido: l.contenido || '',
            media_url: l.media_url || '',
            media_tipo: l.media_tipo || 'none',
            orden: l.orden || 0,
            fecha: l.fecha || new Date().toISOString()
          }));
        });
      });
      return cursoBaseRef(curso).collection(V.COL_PROGRESO).get().then(function (ps) {
        ps.forEach(function (pDoc) { ops.push(newRef.collection(V.COL_PROGRESO).doc(pDoc.id).set(pDoc.data())); });
      }).then(function () {
        return collectDeleteOps(curso);
      }).then(function (delOps) {
        return Promise.all(ops.concat(delOps));
      }).then(function () {
        curso.catId = newCatId;
        if (curso._unsubProg) { try { curso._unsubProg(); } catch (e) {} delete progresoSubscribed[curso.id]; }
        if (curso._unsubContent) { try { curso._unsubContent(); } catch (e) {} }
        subscribeProgreso(curso);
        V.toast('Curso movido a la categoría ✓');
      });
    });
  }

  /* ─── CMS EDITOR ──────────────────────────────────────────── */
  function editsBaseRef() {
    if (!editingId) return null;
    // La ruta real del curso la determina el objeto en cache (curso.catId),
    // no el select del editor. Así las escrituras de bloques/lecciones siempre
    // coinciden con lo que leen el catálogo, el visor y loadCursoTree.
    var curso = getCourseById(editingId);
    var catId = (curso && curso.catId) || editingCatId;
    if (catId) return cursoRef(catId, editingId);
    return V.db.collection(V.COL_CURSOS).doc(editingId);
  }
  function editingBlockCol() {
    var base = editsBaseRef();
    if (!base) return null;
    var curso = getCourseById(editingId);
    var catId = (curso && curso.catId) || editingCatId;
    return base.collection(catId ? V.COL_BLOQUES : V.COL_MODULOS);
  }
  function editingBlockRef(bid) { return editingBlockCol().doc(bid); }
  function editingLessonRef(bid, lid) { return editingBlockRef(bid).collection(V.COL_LECCIONES).doc(lid); }

  function ensureEditorTempIds() {
    editingBloques.forEach(function (b) {
      if (!b.tempId) b.tempId = 'b' + (tempSeq++);
      (b.lecciones || []).forEach(function (l) {
        if (!l.tempId) l.tempId = 'l' + (tempSeq++);
      });
    });
  }

  function openEditor(curso) {
    editingId = curso ? curso.id : null;
    editingCatId = curso ? (curso.catId || curso.categoryId || '') : (categoriasCache.length ? categoriasCache[0].id : '');
    editingBloques = curso ? (curso.bloques || []) : [];
    ensureEditorTempIds();
    editorExpandBloque = null;
    editorExpandLeccion = null;
    if (curso) {
      $('editorHeading').textContent = 'Editar: ' + (curso.titulo || '');
      $('courseTitle').textContent = curso.titulo || '';
      $('edTitle').value = curso.titulo || '';
      $('edDesc').value = curso.descripcion || '';
      $('edPublicado').checked = curso.publicado === true;
      $('edAcceso').value = curso.acceso || 'completo';
      if (!curso.bloquesLoaded) refreshEditorFromDb();
    } else {
      $('editorHeading').textContent = 'Nuevo Curso';
      $('courseTitle').textContent = 'Nuevo Curso';
      $('edTitle').value = '';
      $('edDesc').value = '';
      $('edPublicado').checked = true;
      $('edAcceso').value = 'completo';
    }
    renderEditorCategoriaSelect();
    renderEditorBloques();
    V.showView('viewEditor');
  }

  function refreshEditorFromDb() {
    if (!editingId || !V.db) return;
    ensureCourse(editingId).then(function (curso) {
      editingBloques = curso ? (curso.bloques || []) : [];
      ensureEditorTempIds();
      renderEditorBloques();
    });
  }

  function syncEditorForms() {
    editingBloques.forEach(function (b) {
      var bi = $('cmt_' + b.tempId);
      if (bi) b.titulo = bi.value;
      var ba = $('cmacc_' + b.tempId);
      if (ba) b.acceso = ba.value;
      (b.lecciones || []).forEach(function (l) {
        var li = $('clt_' + l.tempId), lc = $('clc_' + l.tempId), lm = $('clm_' + l.tempId), lt = $('cltipo_' + l.tempId), la = $('clacc_' + l.tempId);
        if (li) l.titulo = li.value;
        if (lc) l.contenido = lc.innerHTML;
        if (lm) l.media_url = lm.value;
        if (lt) l.media_tipo = lt.value;
        if (la) l.acceso = la.value;
      });
    });
  }

  function renderEditorBloques() {
    syncEditorForms();
    var wrap = $('cmsBloqueList');
    if (!wrap) return;
    wrap.innerHTML = '';
    if (!editingBloques.length) {
      wrap.appendChild(el('div', 'cms-empty', 'Aún no hay bloques. Usa el botón "＋ Añadir bloque" para estructurar el curso.'));
      return;
    }
    editingBloques.forEach(function (b, bi) { wrap.appendChild(renderBloqueCard(b, bi)); });
  }

  function iconBtn(label, extraCls, onClick) {
    var b = el('button', 'cms-icon-btn' + (extraCls ? ' ' + extraCls : ''));
    b.type = 'button';
    b.textContent = label;
    b.title = label;
    b.addEventListener('click', onClick);
    return b;
  }

  function renderBloqueCard(b, bi) {
    var card = el('div', 'cms-bloque');

    var head = el('div', 'cms-bloque-head');
    head.appendChild(el('span', 'cms-bloque-num', String(bi + 1)));
    head.appendChild(el('span', 'cms-bloque-title', b.titulo || ('Bloque ' + (bi + 1))));
    var headActs = el('div', 'cms-lesson-actions');
    headActs.appendChild(iconBtn('✏', null, function () { editorExpandBloque = editorExpandBloque === b.tempId ? null : b.tempId; editorExpandLeccion = null; renderEditorBloques(); }));
    headActs.appendChild(iconBtn('↑', null, function () { moveBloque(b, -1); }));
    headActs.appendChild(iconBtn('↓', null, function () { moveBloque(b, 1); }));
    headActs.appendChild(iconBtn('🗑', 'danger', function () { deleteBloque(b); }));
    head.appendChild(headActs);
    card.appendChild(head);

    var list = el('div', 'cms-lessons');
    (b.lecciones || []).forEach(function (l, li) { list.appendChild(renderLessonRow(b, l, li)); });

    var expandedLesson = null;
    (b.lecciones || []).forEach(function (l) { if (l.tempId === editorExpandLeccion) expandedLesson = l; });
    if (expandedLesson) list.appendChild(renderLessonForm(b, expandedLesson));
    if (editorExpandBloque === b.tempId) {
      list.appendChild(renderBloqueForm(b));
    } else {
      var btnAdd = el('button', 'cms-add-lesson', '＋ Añadir lección');
      btnAdd.type = 'button';
      btnAdd.addEventListener('click', function () { addLesson(b); });
      list.appendChild(btnAdd);
    }
    card.appendChild(list);
    return card;
  }

  function renderLessonRow(b, l, li) {
    var row = el('div', 'cms-lesson-row');
    row.appendChild(el('span', 'cms-lesson-order', String(li + 1)));
    row.appendChild(el('span', 'cms-lesson-name' + (l.titulo ? '' : ' empty'), l.titulo || 'Lección sin título'));
    var acts = el('div', 'cms-lesson-actions');
    acts.appendChild(iconBtn('✏', null, function () { editorExpandBloque = null; editorExpandLeccion = editorExpandLeccion === l.tempId ? null : l.tempId; renderEditorBloques(); }));
    acts.appendChild(iconBtn('↑', null, function () { moveLesson(b, l, -1); }));
    acts.appendChild(iconBtn('↓', null, function () { moveLesson(b, l, 1); }));
    acts.appendChild(iconBtn('🗑', 'danger', function () { deleteLesson(b, l); }));
    row.appendChild(acts);
    return row;
  }

  function renderBloqueForm(b) {
    var form = el('div', 'cms-lesson-form');
    var fieldTitulo = el('div', 'field');
    fieldTitulo.appendChild(el('label', '', 'Título del bloque'));
    var inp = document.createElement('input');
    inp.type = 'text'; inp.id = 'cmt_' + b.tempId; inp.className = 'input';
    inp.value = b.titulo || '';
    fieldTitulo.appendChild(inp);
    form.appendChild(fieldTitulo);

    var fieldAcc = el('div', 'field');
    fieldAcc.appendChild(el('label', '', 'Acceso del bloque (módulo)'));
    var selAcc = document.createElement('select');
    selAcc.id = 'cmacc_' + b.tempId; selAcc.className = 'select';
    [['gratis', 'Abierto · visible en catálogo y lecciones de prueba'], ['completo', 'Avanzado · oculto para visitantes']].forEach(function (opt) {
      var o = document.createElement('option');
      o.value = opt[0]; o.textContent = opt[1];
      o.selected = (b.acceso || 'gratis') === opt[0];
      selAcc.appendChild(o);
    });
    fieldAcc.appendChild(selAcc);
    form.appendChild(fieldAcc);

    var acts = el('div', 'cms-form-actions');
    var save = el('button', 'btn btn-primary btn-sm', 'Guardar bloque');
    save.type = 'button';
    save.addEventListener('click', function () { saveBloqueForm(b); });
    var cancel = el('button', 'btn btn-outline btn-sm', 'Cancelar');
    cancel.type = 'button';
    cancel.addEventListener('click', function () { editorExpandBloque = null; renderEditorBloques(); });
    acts.appendChild(save);
    acts.appendChild(cancel);
    form.appendChild(acts);
    return form;
  }

  function cleanEditorHtml(html) {
    if (!html) return '';
    var div = document.createElement('div');
    div.innerHTML = html;
    var empties = div.querySelectorAll('b, i, u, span, font');
    Array.prototype.forEach.call(empties, function (n) {
      if (!n.textContent && !n.querySelector('img, iframe, br')) n.remove();
    });
    return div.innerHTML;
  }

  function normalizeHexColor(v) {
    if (!v) return '';
    v = String(v).trim();
    var m = /^#([0-9a-fA-F]{6})$/.exec(v);
    if (m) return '#' + m[1].toLowerCase();
    m = /^#([0-9a-fA-F]{3})$/.exec(v);
    if (m) {
      var r = m[1].toLowerCase();
      return '#' + r.charAt(0) + r.charAt(0) + r.charAt(1) + r.charAt(1) + r.charAt(2) + r.charAt(2);
    }
    return '';
  }

  var PASTE_KEEP_TAGS = { B: 1, STRONG: 1, I: 1, EM: 1, U: 1, S: 1, STRIKE: 1, P: 1, DIV: 1, BR: 1, UL: 1, OL: 1, LI: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, BLOCKQUOTE: 1, A: 1, SPAN: 1 };
  var PASTE_STRIP_TAGS = { SCRIPT: 1, STYLE: 1, META: 1, LINK: 1, TITLE: 1, XML: 1, IFRAME: 1, FORM: 1, INPUT: 1, BUTTON: 1, SELECT: 1, OPTION: 1, TEXTAREA: 1, APPLET: 1, OBJECT: 1, EMBED: 1, VIDEO: 1, AUDIO: 1, CANVAS: 1, SVG: 1, MATH: 1, IMG: 1 };

  var CMS_PALETTE = [
    ['#e74c3c', 'Rojo'], ['#e91e63', 'Rosa'], ['#9c27b0', 'Púrpura'], ['#673ab7', 'Violeta'],
    ['#3f51b5', 'Índigo'], ['#2196f3', 'Azul'], ['#00bcd4', 'Cian'], ['#009688', 'Verde azulado'],
    ['#4caf50', 'Verde'], ['#8bc34a', 'Verde claro'], ['#ffeb3b', 'Amarillo'], ['#ff9800', 'Naranja'],
    ['#ff5722', 'Naranja intenso'], ['#795548', 'Marrón'], ['#607d8b', 'Gris azulado'], ['#9e9e9e', 'Gris'],
    ['#212121', 'Negro'], ['#f5f5f5', 'Blanco']
  ];

  function isNeutralColor(val) {
    if (!val) return true;
    var v = String(val).trim().toLowerCase().replace(/\s+/g, ' ');
    if (v === '' || v === 'auto' || v === 'initial' || v === 'inherit' || v === 'currentcolor' || v === 'transparent' || v === 'windowtext' || v === 'activeborder' || v === 'black') return true;
    if (v === '#000' || v === '#000000' || v === '#0f172a' || v === '#f1f5f9' || v === '#0c0c0c' || v === '#1f2937' || v === '#ffffff' || v === 'white') return true;
    if (/^rgb\(\s*0\s*,\s*0\s*,\s*0\s*\)$/.test(v) || /^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*1\s*\)$/.test(v)) return true;
    return false;
  }

  function sanitizePasteStyle(styleText) {
    if (!styleText) return '';
    var allowed = { color: 1, 'background-color': 1, 'font-family': 1, 'font-size': 1, 'font-weight': 1, 'font-style': 1, 'text-decoration': 1, 'text-align': 1 };
    return styleText.split(';').map(function (kv) {
      var idx = kv.indexOf(':');
      if (idx === -1) return '';
      var prop = kv.slice(0, idx).trim().toLowerCase();
      var val = kv.slice(idx + 1).trim();
      if (!allowed[prop] || /url\s*\(|expression|javascript:/i.test(val)) return '';
      if ((prop === 'color' || prop === 'background-color') && isNeutralColor(val)) return '';
      return prop + ':' + val.replace(/!important/gi, '');
    }).filter(Boolean).join('; ');
  }

  function cleanPastedHtml(html) {
    if (!html) return '';
    var doc;
    try { doc = new DOMParser().parseFromString(html, 'text/html'); }
    catch (e) { return ''; }
    var body = doc.body;

    var walker = doc.createTreeWalker(body, NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_ELEMENT, null, false);
    var junk = [], n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 8) { junk.push(n); continue; }
      var tag = (n.nodeName || '').toUpperCase();
      if (tag.indexOf(':') !== -1) { junk.push(n); continue; }
      if (PASTE_STRIP_TAGS[tag]) junk.push(n);
    }
    junk.forEach(function (el) { if (el.parentNode) el.parentNode.removeChild(el); });

    var els = body.querySelectorAll('*');
    Array.prototype.forEach.call(els, function (el) {
      var tag = (el.nodeName || '').toUpperCase();
      if (tag === 'FONT' || tag === 'TABLE' || tag === 'TR' || tag === 'TD' || tag === 'TH' || tag === 'THEAD' || tag === 'TBODY' || tag === 'TFOOT' || tag === 'CAPTION' || tag === 'COL' || tag === 'COLGROUP') {
        while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
        if (el.parentNode) el.parentNode.removeChild(el);
        return;
      }
      if (tag === 'SPAN') {
        var st = sanitizePasteStyle(el.getAttribute('style'));
        if (!st) {
          while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
          if (el.parentNode) el.parentNode.removeChild(el);
          return;
        }
        el.setAttribute('style', st);
        el.removeAttribute('class');
        return;
      }
      if (tag === 'A') {
        var href = el.getAttribute('href') || '';
        if (/^(https?:|mailto:|#|\/)/i.test(href)) el.setAttribute('href', href);
        else {
          while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
          if (el.parentNode) el.parentNode.removeChild(el);
          return;
        }
        el.removeAttribute('class');
        return;
      }
      var attrs = Array.prototype.slice.call(el.attributes);
      attrs.forEach(function (a) { el.removeAttribute(a.name); });
    });

    Array.prototype.forEach.call(body.getElementsByTagName('strong'), function (el) {
      var b = doc.createElement('b');
      while (el.firstChild) b.appendChild(el.firstChild);
      if (el.parentNode) el.parentNode.replaceChild(b, el);
    });
    Array.prototype.forEach.call(body.getElementsByTagName('em'), function (el) {
      var i = doc.createElement('i');
      while (el.firstChild) i.appendChild(el.firstChild);
      if (el.parentNode) el.parentNode.replaceChild(i, el);
    });

    return cleanEditorHtml(body.innerHTML);
  }

  function stripNonPaletteColors(styleText, allowPaletteColor) {
    if (!styleText) return '';
    return styleText.split(';').map(function (decl) {
      var idx = decl.indexOf(':');
      if (idx === -1) return decl.trim();
      var prop = decl.slice(0, idx).trim().toLowerCase();
      var val = decl.slice(idx + 1).trim();
      if (prop === 'color' || prop === '-webkit-text-fill-color' || prop === 'text-decoration-color') {
        if (!allowPaletteColor) return '';
        return isNeutralColor(val) ? '' : decl.trim();
      }
      return decl.trim();
    }).filter(Boolean).join('; ');
  }

  function stripLegacyTextColors(root) {
    if (!root) return;
    var els = root.querySelectorAll('*');
    Array.prototype.forEach.call(els, function (el) {
      var tag = (el.nodeName || '').toUpperCase();
      el.removeAttribute('class');
      var allowPalette = tag === 'SPAN';
      if (tag === 'FONT') {
        if (el.getAttribute('color')) el.removeAttribute('color');
        var fs = el.getAttribute('style');
        if (fs) el.setAttribute('style', stripNonPaletteColors(fs, false));
        return;
      }
      var style = el.getAttribute('style');
      if (!style) return;
      var clean = stripNonPaletteColors(style, allowPalette);
      if (clean) el.setAttribute('style', clean);
      else el.removeAttribute('style');
      if (tag === 'SPAN' && !clean) {
        while (el.firstChild) el.parentNode.insertBefore(el.firstChild, el);
        if (el.parentNode) el.parentNode.removeChild(el);
      }
    });
  }

  /* Los tamaños de letra que fija el autor en el contenido llegan como
     longitudes ABSOLUTAS en el style inline. No solo px: el contenido real
     viene pegado desde Word y trae "font-size:13.0pt", y otras fuentes usan
     in/cm/mm/pc. Un valor absoluto ignora la escala que aplican los botones
     A- / A+, de modo que ese texto se queda congelado mientras el resto de la
     lección cambia: los botones parecen no hacer nada.

     Se convierten a em RELATIVOS al tamaño del padre: se conserva la
     jerarquía que eligió el autor y el texto pasa a seguir la escala. La
     conversión mide al padre SIN la escala aplicada (dividiendo por
     --font-scale), así que el resultado no depende del ajuste que el
     usuario tenga activo en ese momento.

     Solo actúa en el lector: lo guardado en Firestore conserva las unidades
     del autor y el editor sigue mostrando los tamaños tal como se escriben. */
  var ABS_PX = { px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4 };

  function normalizeInlineFontSizes(root) {
    if (!root) return;
    var scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--font-scale'));
    if (!scale || !isFinite(scale) || scale <= 0) scale = 1;
    var els = root.querySelectorAll('[style*="font-size"]');
    Array.prototype.forEach.call(els, function (el) {
      var style = el.getAttribute('style');
      if (!style) return;
      // px, pt, pc, in, cm o mm. Los em/rem/% ya son relativos: se dejan.
      var m = style.match(/font-size\s*:\s*([0-9]*\.?[0-9]+)\s*(px|pt|pc|in|cm|mm)\b/i);
      if (!m) return;
      var px = parseFloat(m[1]) * ABS_PX[m[2].toLowerCase()];
      if (!px || !isFinite(px) || px <= 0) return;
      var parentPx = el.parentNode ? parseFloat(getComputedStyle(el.parentNode).fontSize) : 0;
      var basePx = parentPx / scale;
      if (!basePx || !isFinite(basePx) || basePx <= 0) return;
      el.setAttribute('style', style.replace(m[0], 'font-size: ' + (px / basePx).toFixed(3) + 'em'));
    });
  }

  /* El contenido real trae HTML mal cerrado: hay <h1> sin cerrar, y el
     parser del navegador mete dentro del encabezado TODO lo que venga
     después (párrafos, listas, tablas). Como .lesson-content h1 fija su
     tamaño, el cuerpo entero de la lección quedaba encerrado en un
     encabezado de tamaño fijo: los botones A- / A+ cambiaban la escala pero
     el texto que se leía no se movía.

     Aquí se sacan los bloques de nivel de bloque que hayan quedado dentro de
     un encabezado y se colocan justo después de él, conservando el texto
     propio del título. Solo actúa si de verdad hay bloques dentro: un
     encabezado bien formado con un <span> (lo normal) no se toca. */
  var BLOQUES = {
    P: 1, DIV: 1, UL: 1, OL: 1, LI: 1, TABLE: 1, THEAD: 1, TBODY: 1, TR: 1,
    TD: 1, TH: 1, BLOCKQUOTE: 1, PRE: 1, SECTION: 1, ARTICLE: 1, FIGURE: 1,
    FIGCAPTION: 1, HR: 1, DL: 1, DT: 1, DD: 1
  };

  function repairHeadingNesting(root) {
    if (!root) return;
    var hs = root.querySelectorAll('h1, h2, h3, h4, h5, h6');
    Array.prototype.forEach.call(hs, function (h) {
      var padre = h.parentNode;
      if (!padre) return;
      var movibles = [];
      Array.prototype.forEach.call(h.children, function (c) {
        if (BLOQUES[(c.nodeName || '').toUpperCase()]) movibles.push(c);
      });
      if (!movibles.length) return;
      // h.nextSibling no cambia: cada inserción cae justo detrás del título.
      movibles.forEach(function (c) { padre.insertBefore(c, h.nextSibling); });
    });
  }

  function escapeHtmlText(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function plainTextToHtml(text) {
    var lines = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    var out = [];
    lines.forEach(function (line) {
      out.push(line === '' ? '<div><br></div>' : '<div>' + escapeHtmlText(line) + '</div>');
    });
    return out.join('');
  }

  function attachPasteCleaner(ta) {
    ta.addEventListener('paste', function (e) {
      var cb = e.clipboardData || window.clipboardData;
      if (!cb) return;
      e.preventDefault();
      var html = cb.getData('text/html');
      if (html) {
        var clean = cleanPastedHtml(html);
        if (clean) {
          ta.focus();
          document.execCommand('insertHTML', false, clean);
          return;
        }
      }
      var text = cb.getData('text/plain');
      if (text !== '' && text != null) {
        ta.focus();
        document.execCommand('insertHTML', false, plainTextToHtml(text));
      }
    });
  }

  function buildRichToolbar(ta) {
    var bar = el('div', 'cms-richbar');
    var savedRange = null;
    ta.addEventListener('focusout', function () {
      var sel = window.getSelection && window.getSelection();
      if (sel && sel.rangeCount) {
        var r = sel.getRangeAt(0);
        if (ta.contains(r.commonAncestorContainer)) savedRange = r.cloneRange();
      }
    });
    function run(cmd, val) {
      ta.focus();
      var sel = window.getSelection && window.getSelection();
      if (sel && savedRange) {
        sel.removeAllRanges(); sel.addRange(savedRange); savedRange = null;
      }
      document.execCommand(cmd, false, val || null);
      ta.focus();
    }
    function tBtn(label, cls, title, cmd, val) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'cms-rich-btn' + (cls ? ' ' + cls : ''); b.title = title;
      b.innerHTML = label;
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('click', function () { run(cmd, val); });
      bar.appendChild(b);
      return b;
    }
    function richSel(title, placeholder, options, cmd, width) {
      var s = document.createElement('select');
      s.className = 'cms-rich-sel'; s.title = title; s.style.maxWidth = (width || 150) + 'px';
      var ph = document.createElement('option'); ph.value = ''; ph.textContent = placeholder; s.appendChild(ph);
      options.forEach(function (o) {
        var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; s.appendChild(op);
      });
      s.addEventListener('change', function () {
        if (s.value) { run(cmd, s.value); s.value = ''; }
      });
      bar.appendChild(s);
      return s;
    }

    try { document.execCommand('styleWithCSS', false, true); } catch (e) { /* algunos navegadores no lo soportan */ }

    tBtn('<b>B</b>', 'cms-rich-btn-b', 'Negrita', 'bold');
    tBtn('<i>I</i>', 'cms-rich-btn-i', 'Cursiva', 'italic');
    tBtn('<u>U</u>', 'cms-rich-btn-u', 'Subrayado', 'underline');

    tBtn('←', '', 'Alinear a la izquierda', 'justifyLeft');
    tBtn('↔', '', 'Centrar', 'justifyCenter');
    tBtn('→', '', 'Alinear a la derecha', 'justifyRight');
    tBtn('☰', '', 'Justificar', 'justifyFull');

    richSel('Tamaño de letra', 'Tamaño',
      [['1', '12 px'], ['2', '14 px'], ['3', '16 px'], ['4', '18 px'], ['5', '24 px'], ['6', '32 px'], ['7', '48 px']],
      'fontSize', 96);

    var colorWrap = document.createElement('button');
    colorWrap.type = 'button'; colorWrap.className = 'cms-rich-color'; colorWrap.title = 'Color de letra';
    var dot = document.createElement('i'); dot.className = 'cms-rich-dot'; dot.style.background = '#e53935';
    colorWrap.appendChild(dot);
    var chevron = document.createElement('i'); chevron.className = 'cms-rich-caret';
    colorWrap.appendChild(chevron);

    var savedSelRange = null;
    var palette = CMS_PALETTE;
    var popup = el('div', 'cms-color-popup');

    function saveEditorRange() {
      var sel = window.getSelection && window.getSelection();
      if (!sel || !sel.rangeCount) return false;
      try {
        var r = sel.getRangeAt(0);
        var node = r.commonAncestorContainer;
        if (node === ta || ta.contains(node)) {
          savedSelRange = r.cloneRange();
          return true;
        }
      } catch (e) { /* rango no válido */ }
      return false;
    }
    function blockAncestor(node) {
      var BLOCKS = { P: 1, DIV: 1, BLOCKQUOTE: 1, LI: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1 };
      var el = node && node.nodeType === 3 ? node.parentNode : node;
      while (el && el !== ta) {
        var tag = el.nodeName ? el.nodeName.toUpperCase() : '';
        if (BLOCKS[tag]) return el;
        el = el.parentNode;
      }
      return ta;
    }
    function applyColorToRange(range, hex) {
      var sel = window.getSelection && window.getSelection();
      if (!sel) return;
      if (!range || range.collapsed) {
        ta.focus();
        try { document.execCommand('styleWithCSS', false, true); } catch (e) { /* noop */ }
        document.execCommand('foreColor', false, hex);
        ta.focus();
        return;
      }
      sel.removeAllRanges();
      sel.addRange(range);
      if (blockAncestor(range.startContainer) === blockAncestor(range.endContainer)) {
        try {
          var span = document.createElement('span');
          span.style.color = hex;
          var frag = range.extractContents();
          span.appendChild(frag);
          range.insertNode(span);
          sel.removeAllRanges();
          var nr = document.createRange();
          nr.selectNodeContents(span);
          sel.addRange(nr);
        } catch (e) {
          sel.removeAllRanges();
          sel.addRange(range);
          try { document.execCommand('styleWithCSS', false, true); } catch (e2) { /* noop */ }
          document.execCommand('foreColor', false, hex);
        }
      } else {
        try { document.execCommand('styleWithCSS', false, true); } catch (e) { /* noop */ }
        document.execCommand('foreColor', false, hex);
      }
      void ta.offsetWidth;
      ta.focus();
    }
    function openPopup() { popup.style.display = 'grid'; }
    function closePopup() { popup.style.display = 'none'; }
    function pickColor(hex) {
      if (!hex) return;
      dot.style.background = hex;
      var range = savedSelRange;
      savedSelRange = null;
      applyColorToRange(range, hex);
      closePopup();
    }
    palette.forEach(function (c) {
      var sw = document.createElement('button');
      sw.type = 'button'; sw.className = 'cms-color-swatch'; sw.title = c[1];
      sw.style.background = c[0]; sw.dataset.hex = c[0];
      sw.addEventListener('mousedown', function (e) { e.preventDefault(); });
      sw.addEventListener('click', function () { pickColor(sw.dataset.hex); });
      popup.appendChild(sw);
    });
    popup.style.display = 'none';
    colorWrap.addEventListener('mousedown', function (e) { e.preventDefault(); });
    colorWrap.addEventListener('click', function () {
      saveEditorRange();
      if (popup.style.display === 'none') openPopup(); else closePopup();
    });
    document.addEventListener('mousedown', function (e) {
      if (!colorWrap.contains(e.target) && !popup.contains(e.target)) closePopup();
    });
    bar.appendChild(colorWrap);
    bar.appendChild(popup);
    return bar;
  }

  function renderLessonForm(b, l) {
    var form = el('div', 'cms-lesson-form');
    var id = l.tempId;

    var fTitulo = el('div', 'field');
    fTitulo.appendChild(el('label', '', 'Título de la lección'));
    var inp = document.createElement('input');
    inp.type = 'text'; inp.id = 'clt_' + id; inp.className = 'input'; inp.value = l.titulo || '';
    fTitulo.appendChild(inp);
    form.appendChild(fTitulo);

    var fContenido = el('div', 'field');
    fContenido.appendChild(el('label', '', 'Contenido'));
    var ta = document.createElement('div');
    ta.id = 'clc_' + id; ta.className = 'cms-editor'; ta.contentEditable = 'true';
    ta.dataset.placeholder = 'Escribe aquí el contenido de la lección. Selecciona texto y usa la barra para darle formato…';
    ta.innerHTML = l.contenido || '';
    attachPasteCleaner(ta);
    var richBox = el('div', 'cms-richbox');
    richBox.appendChild(buildRichToolbar(ta));
    richBox.appendChild(ta);
    fContenido.appendChild(richBox);
    form.appendChild(fContenido);

    var mediaRow = el('div', 'cms-form-row');
    var fMedia = el('div', 'field');
    fMedia.appendChild(el('label', '', 'URL de media (video/audio/imagen)'));
    var inpMedia = document.createElement('input');
    inpMedia.type = 'text'; inpMedia.id = 'clm_' + id; inpMedia.className = 'input'; inpMedia.value = l.media_url || '';
    fMedia.appendChild(inpMedia);
    mediaRow.appendChild(fMedia);

    var fTipo = el('div', 'field');
    fTipo.appendChild(el('label', '', 'Tipo'));
    var sel = document.createElement('select');
    sel.id = 'cltipo_' + id; sel.className = 'select';
    [['none', '— Sin media'], ['video', '🎬 Video'], ['audio', '🔊 Audio'], ['image', '🖼 Imagen']].forEach(function (opt) {
      var o = document.createElement('option');
      o.value = opt[0]; o.textContent = opt[1]; o.selected = (l.media_tipo || 'none') === opt[0];
      sel.appendChild(o);
    });
    fTipo.appendChild(sel);
    mediaRow.appendChild(fTipo);
    form.appendChild(mediaRow);

    var fAcceso = el('div', 'field');
    fAcceso.appendChild(el('label', '', 'Acceso de la lección'));
    var sellAcc = document.createElement('select');
    sellAcc.id = 'clacc_' + id; sellAcc.className = 'select';
    [['completo', 'Completo · solo cuentas registradas'], ['prueba', 'Prueba gratuita · visible para visitantes']].forEach(function (opt) {
      var o = document.createElement('option');
      o.value = opt[0]; o.textContent = opt[1];
      // 'gratis' (legacy) también es acceso libre: se muestra como "prueba".
      o.selected = ((l.acceso || 'completo') === opt[0]) || (opt[0] === 'prueba' && l.acceso === 'gratis');
      sellAcc.appendChild(o);
    });
    fAcceso.appendChild(sellAcc);
    fAcceso.appendChild(el('p', 'field-hint', 'Solo las lecciones de acceso libre o de prueba gratuita (prueba/gratis) son accesibles para visitantes anónimos.'));
    form.appendChild(fAcceso);

    var acts = el('div', 'cms-form-actions');
    var save = el('button', 'btn btn-primary btn-sm', 'Guardar lección');
    save.type = 'button';
    save.addEventListener('click', function () { saveLessonForm(b, l); });
    var cancel = el('button', 'btn btn-outline btn-sm', 'Cancelar');
    cancel.type = 'button';
    cancel.addEventListener('click', function () { editorExpandLeccion = null; renderEditorBloques(); });
    acts.appendChild(save);
    acts.appendChild(cancel);
    form.appendChild(acts);
    return form;
  }

  function saveMetadata() {
    var titulo = $('edTitle').value.trim();
    if (!titulo) { V.toast('El título del curso es obligatorio.', true); return Promise.resolve(null); }
    var sel = $('edCategoria');
    var catId = (sel && sel.value) || editingCatId || '';
    if (!catId) { V.toast('Primero crea una categoría desde el catálogo.', true); return Promise.resolve(null); }
    // Fija la categoría destino antes de la operación asíncrona para que los
    // guards de bloques/lecciones apunten ya a la ruta correcta.
    editingCatId = catId;
    var curso = editingId ? getCourseById(editingId) : null;
    var data = { titulo: titulo, descripcion: $('edDesc').value.trim(), publicado: $('edPublicado').checked, acceso: (($('edAcceso') && $('edAcceso').value) === 'gratis' ? 'gratis' : 'completo'), fecha: new Date().toISOString(), catId: catId, categoryId: catId };

    var p;
    if (editingId && curso && catId && curso.catId !== catId) {
      // Cambio de categoría → mover el subárbol completo.
      p = moveCourseToCategory(curso, catId).then(function () { return editingId; });
    } else if (editingId) {
      p = cursoBaseRef({ id: editingId, catId: curso ? curso.catId : catId }).set(data, { merge: true });
    } else {
      p = catRef(catId).collection(V.COL_CURSOS).add(data);
    }
    return p.then(function (ref) {
      editingCatId = catId;
      if (!editingId) {
        editingId = ref.id;
        $('editorHeading').textContent = 'Editar: ' + titulo;
        $('courseTitle').textContent = titulo;
      }
      V.toast('Datos del curso guardados ✓');
      return editingId;
    }).catch(function (e) {
      V.toast('Error al guardar los datos: ' + e.message, true);
      return null;
    });
  }

  function addBloque() {
    if (!editingId) { V.toast('Guarda primero los datos del curso.', true); return; }
    editingBloques.push({ id: null, tempId: 'b' + (tempSeq++), titulo: '', lecciones: [], acceso: 'gratis', orden: editingBloques.length + 1 });
    editorExpandBloque = editingBloques[editingBloques.length - 1].tempId;
    editorExpandLeccion = null;
    renderEditorBloques();
  }

  function saveBloqueForm(b) {
    var inp = $('cmt_' + b.tempId);
    b.titulo = (inp ? inp.value : '').trim();
    if (!b.titulo) { V.toast('El título del bloque es obligatorio.', true); return; }
    if (!editingId) { V.toast('Guarda primero los datos del curso.', true); return; }
    var baSel = $('cmacc_' + b.tempId);
    if (baSel) b.acceso = baSel.value;
    var data = { titulo: b.titulo, acceso: b.acceso === 'completo' ? 'completo' : 'gratis', orden: editingBloques.indexOf(b) + 1, fecha: new Date().toISOString() };
    // Upsert seguro: set con merge. Si el documento del bloque aún no
    // existe (p. ej. se creó en memoria sin persistir) lo crea; si existe,
    // actualiza solo los campos indicados. Un update() estricto lanzaría
    // "No document to update".
    var p = b.id ? editingBlockRef(b.id).set(data, { merge: true }) : editingBlockCol().add(data).then(function (ref) { b.id = ref.id; });
    p.then(function () {
      V.toast('Bloque guardado ✓');
      editorExpandBloque = null;
      renderEditorBloques();
    }).catch(function (e) { V.toast('Error al guardar el bloque: ' + e.message, true); });
  }

  function addLesson(b) {
    if (!b.id) { V.toast('Guarda primero el bloque.', true); return; }
    var l = { id: null, tempId: 'l' + (tempSeq++), titulo: '', contenido: '', media_url: '', media_tipo: 'none', acceso: 'completo', orden: b.lecciones.length + 1 };
    b.lecciones.push(l);
    editorExpandLeccion = l.tempId;
    renderEditorBloques();
  }

  function saveLessonForm(b, l) {
    var id = l.tempId;
    l.titulo = ($('clt_' + id) ? $('clt_' + id).value : l.titulo).trim();
    l.contenido = $('clc_' + id) ? cleanEditorHtml($('clc_' + id).innerHTML) : l.contenido;
    l.media_url = $('clm_' + id) ? $('clm_' + id).value.trim() : l.media_url;
    l.media_tipo = $('cltipo_' + id) ? $('cltipo_' + id).value : l.media_tipo;
    // El <select> de acceso es la fuente de verdad: se captura su valor
    // exacto ('prueba' | 'completo') en el momento de guardar.
    var laSel = $('clacc_' + id);
    if (laSel) l.acceso = laSel.value;
    if (!l.titulo) { V.toast('El título de la lección es obligatorio.', true); return; }
    if (!editingId || !b.id) { V.toast('Guarda primero el curso y el bloque.', true); return; }
    l.orden = b.lecciones.indexOf(l) + 1;
    // Se persiste el valor tal cual; solo 'completo' bloquea a los visitantes
    // ('prueba'/'gratis' quedan visibles para anónimos, sin reset por defecto).
    var data = { titulo: l.titulo, contenido: l.contenido, media_url: l.media_url, media_tipo: l.media_tipo, acceso: l.acceso === 'completo' ? 'completo' : l.acceso, orden: l.orden, fecha: new Date().toISOString() };
    var p = l.id ? editingLessonRef(b.id, l.id).update(data) : editingBlockRef(b.id).collection(V.COL_LECCIONES).add(data).then(function (ref) { l.id = ref.id; });
    p.then(function () {
      V.toast('Lección guardada ✓');
      editorExpandLeccion = null;
      renderEditorBloques();
    }).catch(function (e) { V.toast('Error al guardar la lección: ' + e.message, true); });
  }

  function moveBloque(b, dir) {
    var i = editingBloques.indexOf(b);
    var j = i + dir;
    if (j < 0 || j >= editingBloques.length) return;
    editingBloques.splice(i, 1);
    editingBloques.splice(j, 0, b);
    persistBloqueOrders();
    renderEditorBloques();
  }

  function moveLesson(b, l, dir) {
    var arr = b.lecciones;
    var i = arr.indexOf(l);
    var j = i + dir;
    if (j < 0 || j >= arr.length) return;
    arr.splice(i, 1);
    arr.splice(j, 0, l);
    persistLessonOrders(b);
    renderEditorBloques();
  }

  function persistBloqueOrders() {
    if (!editingId) return;
    editingBloques.forEach(function (b, i) {
      if (b.id) editingBlockRef(b.id).update({ orden: i + 1 }).catch(function () {});
    });
  }

  function persistLessonOrders(b) {
    if (!editingId || !b.id) return;
    (b.lecciones || []).forEach(function (l, i) {
      if (l.id) editingLessonRef(b.id, l.id).update({ orden: i + 1 }).catch(function () {});
    });
  }

  function deleteBloque(b) {
    var lessonsN = (b.lecciones || []).length;
    if (b.id && !confirm('¿Eliminar el bloque "' + (b.titulo || '') + '"' + (lessonsN ? (' con sus ' + lessonsN + ' lecciones') : '') + '? Esta acción no se puede deshacer.')) return;
    var i = editingBloques.indexOf(b);
    if (i === -1) return;
    if (b.id && editingId) {
      var ops = [];
      (b.lecciones || []).forEach(function (l) { if (l.id) ops.push(editingLessonRef(b.id, l.id).delete()); });
      ops.push(editingBlockRef(b.id).delete());
      Promise.all(ops).then(function () { V.toast('Bloque eliminado'); });
    }
    editingBloques.splice(i, 1);
    persistBloqueOrders();
    renderEditorBloques();
  }

  function deleteLesson(b, l) {
    if (l.id && !confirm('¿Eliminar la lección "' + (l.titulo || '') + '"? Esta acción no se puede deshacer.')) return;
    var i = b.lecciones.indexOf(l);
    if (i === -1) return;
    if (l.id && editingId && b.id) { editingLessonRef(b.id, l.id).delete().catch(function () {}); }
    b.lecciones.splice(i, 1);
    persistLessonOrders(b);
    renderEditorBloques();
  }

  function viewCourseFromEditor() {
    saveMetadata().then(function (id) {
      if (!id) return null;
      return ensureCourse(id).then(function () { openCourse(id); });
    });
  }

  /* ─── PROGRESS BAR ────────────────────────────────────────── */
  function updateProgressBar() {
    if (V.mode !== 'estudiante') return;
    var total = 0, doneAll = 0;
    cursosCache.forEach(function (c) {
      var n = lessonCount(c);
      var prog = progresoCache[c.id] || {};
      var d = (prog.completed || []).length;
      total += n;
      doneAll += Math.min(d, n);
    });
    var pct = total ? Math.round((doneAll / total) * 100) : 0;
    $('progressText').textContent = doneAll + ' de ' + total + ' lecciones completadas';
    $('progressPct').textContent = pct + '%';
    $('progressFill').style.width = pct + '%';
  }

  /* ─── NAVIGATION ──────────────────────────────────────────── */
  function prevLesson() {
    if (!leccionActual || leccionActual.indice <= 0) return;
    openLesson(leccionActual.curso, leccionActual.seq, leccionActual.indice - 1);
  }
  function nextLesson() {
    if (!leccionActual || leccionActual.indice >= leccionActual.seq.length - 1) return;
    openLesson(leccionActual.curso, leccionActual.seq, leccionActual.indice + 1);
  }

  /* ─── MODULE INTERFACE ────────────────────────────────────── */
  var CursosModule = {
    onReady: function () {
      $('btnAddBloque').addEventListener('click', addBloque);
      $('btnSaveMetadata').addEventListener('click', function () { saveMetadata(); });
      $('btnViewCourse').addEventListener('click', viewCourseFromEditor);
      $('btnEditCourseCms').addEventListener('click', function () {
        var curso = getCourseById(cursoActualId);
        if (curso) openEditor(curso);
      });
      $('btnCompleteLesson').addEventListener('click', markLessonComplete);
      $('btnPrevLesson').addEventListener('click', prevLesson);
      $('btnNextLesson').addEventListener('click', nextLesson);
      if ($('edCategoria')) $('edCategoria').addEventListener('change', function () { editingCatId = $('edCategoria').value; });
      bindCatalogEvents();
      subscribeCategorias();
      subscribeCursos();
    }
  };

  V.onNewCourse = function () { openEditor(null); };

  // Reconstruye las suscripciones a Firestore bajo la identidad de sesión
  // ACTUAL. Devuelve true si la identidad cambió y se reconstruyó. Es clave
  // que corra en cuanto el UID de la sesión cambia (V.onSessionRefresh) y
  // también desde el cambio de modo (V.onModeChange): si se espera al arranque
  // de la app (ensureUserDoc + startApp), las suscripciones de progreso del
  // UID ANTERIOR siguen vivas en el intervalo y Firestore las deniega porque
  // request.auth.uid ya es el usuario nuevo ('Missing or insufficient
  // permissions' → toast rojo al hacer login).
  function rebuildSuscripciones() {
    if (!V.db) return false;
    var currentMode = anonMode() ? 'anon' : 'registrado';
    // Sesión anónima ⇄ registrada: se reconstruyen las consultas de cursos y
    // se invalidan los árboles cacheados para que las cuentas registradas
    // vuelvan a ver la totalidad de bloques y lecciones (sin filtro de prueba).
    if (currentMode === authSubsMode) return false;
    authSubsMode = currentMode;
    if (categoriasSub) { try { categoriasSub(); } catch (e) {} categoriasSub = null; }
    Object.keys(cursoCatSubs).forEach(unsubscribeCursosForCategory);
    if (legacyCursoSub) { try { legacyCursoSub(); } catch (e) {} legacyCursoSub = null; }
    cursosCache.forEach(function (c) {
      c.bloquesLoaded = false;
      c._treeMode = null;
      if (c._unsubContent) { try { c._unsubContent(); } catch (e) {} }
      if (c._unsubProg) { try { c._unsubProg(); } catch (e) {} }
      delete progresoSubscribed[c.id];
    });
    categoriasCache = [];
    cursosCache = [];
    subscribeCategorias();
    subscribeCursos();
    if (cursoActualId) {
      ensureCourse(cursoActualId).then(function (curso) {
        if (curso && cursoActualId === curso.id) {
          subscribeCursoContent(curso);
          renderCourseLessons(curso);
        }
      });
    }
    return true;
  }

  // La identidad de sesión YA cambió (login, registro, fusión o restauración
  // de sesión al cargar): se reconstruyen las suscripciones de inmediato, SIN
  // esperar a startApp. Lo invoca core/app.js desde onAuthStateChanged justo
  // antes de leer el perfil en Firestore.
  V.onSessionRefresh = function () {
    rebuildSuscripciones();
  };

  V.onModeChange = function (m) {
    rebuildSuscripciones();
    if (m !== 'admin') renderCatalog();
  };

  V.registerModule(CursosModule);
})();