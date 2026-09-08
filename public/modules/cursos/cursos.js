/* ════════════════════════════════════════════════════════════════
   VCONV · Módulo de Cursos — Catálogo, Editor, Visor, Progreso
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var V = window.VCONV;
  if (!V) { console.error('VCONV core not loaded'); return; }

  var WP_API = 'https://vconv.vidaconvocacion.com/wp-json/wp/v2/posts';

  /* ─── STATE ───────────────────────────────────────────────── */
  var cursosCache = [];
  var progresoCache = {};
  var wpPosts = [];
  var wpPostsLoaded = false;
  var wpContentCache = {};
  var cursoActualId = null;
  var leccionActual = null;
  var editingId = null;
  var draftLecciones = [];
  var progresoSubscribed = {};
  var catalogBound = false;

  /* ─── HELPERS ─────────────────────────────────────────────── */
  function $(id) { return V.$(id); }
  function el(tag, cls, text) { return V.el(tag, cls, text); }

  function courseField(curso, keys, dflt) {
    if (!curso) return dflt;
    for (var i = 0; i < keys.length; i++) {
      if (curso[keys[i]] !== undefined && curso[keys[i]] !== null) return curso[keys[i]];
    }
    return dflt;
  }

  // Desbloqueo único y coherente para el listado, el clic y el visor:
  // la primera lección siempre está abierta; cualquier lección ya completada
  // puede re-abrirse libremente; y cada lección siguiente solo se desbloquea
  // cuando la anterior esté completada (progresión secuencial estricta).
  function isLessonUnlocked(lecciones, completed, i) {
    if (!lecciones || !lecciones[i] || lecciones[i].id === undefined) return false;
    if (i <= 0) return true;
    if (completed.indexOf(String(lecciones[i].id)) !== -1) return true;
    return completed.indexOf(String(lecciones[i - 1].id)) !== -1;
  }

  function currentProgress(cursoId) {
    var prog = progresoCache[cursoId] || {};
    return prog.completed || [];
  }

  function pctOf(curso) {
    var prog = progresoCache[curso.id];
    if (!prog || !curso.lecciones || curso.lecciones.length === 0) return 0;
    var done = (prog.completed || []).length;
    return Math.round((done / curso.lecciones.length) * 100);
  }

  /* ─── CATALOG ─────────────────────────────────────────────── */
  function renderCatalog() {
    var grid = $('coursesGrid');
    var empty = $('emptyCatalog');
    if (!grid) return;
    grid.innerHTML = '';
    V.clearFbError();

    if (!cursosCache.length) {
      empty.style.display = 'block';
      $('emptyText').textContent = V.mode === 'gestor' ? 'Crea tu primer curso para comenzar.' : 'No hay cursos disponibles por ahora.';
      return;
    }
    empty.style.display = 'none';

    cursosCache.forEach(function (curso) {
      var card = el('div', 'course-card' + (V.mode === 'estudiante' ? ' card-link' : ''));
      card.setAttribute('data-course-id', curso.id);
      card.appendChild(el('h3', 'course-card-title', curso.titulo || 'Sin título'));

      var p = el('p', 'course-card-desc', curso.descripcion || '');
      if (!curso.descripcion) p.textContent = 'Sin descripción.';
      card.appendChild(p);

      var meta = el('div', 'course-card-meta');
      var n = (curso.lecciones || []).length;
      meta.appendChild(el('span', 'course-card-lessons', n + (n === 1 ? ' lección' : ' lecciones')));
      var pct = pctOf(curso);
      meta.appendChild(el('span', 'course-card-pct' + (pct === 100 ? ' complete' : ''), pct + '%'));
      card.appendChild(meta);

      if (V.mode === 'gestor') {
        var actions = el('div', 'course-card-actions');
        var editBtn = el('button', 'btn btn-outline', '✏ Editar');
        editBtn.setAttribute('data-action', 'edit');
        editBtn.setAttribute('data-course-id', curso.id);
        var delBtn = el('button', 'btn btn-danger', '🗑 Eliminar');
        delBtn.setAttribute('data-action', 'delete');
        delBtn.setAttribute('data-course-id', curso.id);
        actions.appendChild(editBtn);
        actions.appendChild(delBtn);
        card.appendChild(actions);
      }

      grid.appendChild(card);
    });
  }

  function onCatalogClick(e) {
    var actionBtn = e.target.closest ? e.target.closest('[data-action]') : null;
    var node = actionBtn || (e.target.closest ? e.target.closest('[data-course-id]') : null);
    if (!node) return;
    var action = actionBtn ? actionBtn.dataset.action : null;
    var courseId = (actionBtn && actionBtn.dataset.courseId) || node.dataset.courseId;
    if (!courseId) return;
    var curso = cursosCache.filter(function (c) { return c.id === courseId; })[0];

    if (action === 'delete' && curso) { e.stopPropagation(); deleteCourse(curso); return; }
    if (action === 'edit' && curso) { e.stopPropagation(); openEditor(curso); return; }
    if (V.mode === 'estudiante' && curso && !action) openCourse(curso.id);
  }

  function bindCatalogEvents() {
    if (catalogBound) return;
    var grid = $('coursesGrid');
    if (grid) { catalogBound = true; grid.addEventListener('click', onCatalogClick); return; }
    // El grid suele existir; reintentar un máximo de veces para no crear un bucle infinito.
    var attempts = (bindCatalogEvents._attempts || 0) + 1;
    bindCatalogEvents._attempts = attempts;
    if (attempts > 5) return;
    document.addEventListener('DOMContentLoaded', function () { bindCatalogEvents(); });
    setTimeout(function () { bindCatalogEvents(); }, 100);
  }

  /* ─── COURSE VIEWS ────────────────────────────────────────── */
  function openCourse(cursoId) {
    cursoActualId = cursoId;
    var curso = cursosCache.filter(function (c) { return c.id === cursoId; })[0];
    if (!curso) return;
    $('courseTitle').textContent = curso.titulo || 'Curso';
    $('courseDesc').textContent = curso.descripcion || '';
    renderLessonList(curso);
    V.showView('viewCourse');
  }

  function renderLessonList(curso) {
    var list = $('lessonList');
    list.innerHTML = '';
    var lecciones = curso.lecciones || [];
    var prog = progresoCache[curso.id] || {};
    var completed = prog.completed || [];

    if (!lecciones.length) {
      list.appendChild(V.emptyState('📄', 'Sin lecciones', 'Este curso aún no tiene lecciones asociadas.'));
      return;
    }

    lecciones.forEach(function (lp, i) {
      if (!lp || !lp.id) return;
      var done = completed.indexOf(String(lp.id)) !== -1;
      var unlocked = isLessonUnlocked(lecciones, completed, i);
      var item = el('div', 'lesson-item' + (done ? ' completed' : '') + (!unlocked ? ' locked' : ''));
      item.appendChild(el('span', 'lesson-num', String(i + 1)));
      var info = el('div', 'lesson-info');
      info.appendChild(el('div', 'lesson-title', lp.titulo || ('Lección ' + (i + 1))));
      if (lp.fecha) info.appendChild(el('div', 'lesson-date', V.fmtDate(lp.fecha)));
      item.appendChild(info);
      item.appendChild(el('span', 'lesson-status-icon', done ? '✅' : (!unlocked ? '🔒' : '▶')));
      item.onclick = function () {
        // Re-evalúa el desbloqueo con el progreso actual para evitar bloqueos falsos.
        var current = currentProgress(curso.id);
        if (!isLessonUnlocked(lecciones, current, i)) return;
        openLesson(curso, lecciones, i);
      };
      list.appendChild(item);
    });
  }

  /* ─── LESSON READER ───────────────────────────────────────── */
  function openLesson(curso, lecciones, indice) {
    var completed = currentProgress(curso.id);
    if (!isLessonUnlocked(lecciones, completed, indice)) {
      V.toast('Completa la lección anterior para desbloquear esta.', true);
      return;
    }
    leccionActual = { curso: curso, lecciones: lecciones, indice: indice };
    var lp = lecciones[indice];
    $('readerLessonMeta').textContent = (curso.titulo || 'Curso') + ' · Lección ' + (indice + 1) + ' de ' + lecciones.length;
    $('readerTitle').textContent = lp.titulo || ('Lección ' + (indice + 1).toString());
    renderContent(lp);
    renderReaderNav(lecciones, indice, completed);
    V.showView('viewLesson');
  }

  function renderContent(lp) {
    var c = $('readerContent');
    c.innerHTML = '';
    c.appendChild(el('p', '', 'Cargando lección desde WordPress…'));
    if (lp.contenido) { renderContentHtml(c, lp.contenido, lp.media_url, lp.media_tipo); return; }
    fetchWpPost(lp.id).then(function (post) {
      renderContentHtml(c, post.contenido, post.media_url, post.media_tipo);
    }).catch(function (e) {
      c.innerHTML = '';
      c.appendChild(V.emptyState('⚠️', 'No se pudo cargar la lección', (e && e.message) || 'Error al conectar con WordPress.'));
    });
  }

  function renderContentHtml(c, contenido, mediaUrl, mediaTipo) {
    c.innerHTML = '';
    if (contenido) {
      var holder = document.createElement('div');
      holder.innerHTML = contenido;
      holder.querySelectorAll('video[src],audio[src]').forEach(function (m) { secureMedia(m); });
      c.appendChild(holder);
    } else {
      c.appendChild(el('p', '', 'Sin contenido por ahora.'));
    }
    if (mediaUrl) injectSecurePlayer({ url: mediaUrl, tipo: mediaTipo || 'video' });
    c.querySelectorAll('video,audio').forEach(function (m) { secureMedia(m); });
  }

  function fetchWpPost(id) {
    if (wpContentCache[id]) return Promise.resolve(wpContentCache[id]);
    return fetch(WP_API + '/' + encodeURIComponent(id))
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (p) {
        var media = extractMediaFromPost(p);
        var data = { titulo: (p.title && p.title.rendered) || '', contenido: (p.content && p.content.rendered) || '', media_url: media.url, media_tipo: media.tipo };
        wpContentCache[id] = data;
        return data;
      });
  }

  function extractMediaFromPost(p) {
    var html = (p.content && p.content.rendered) || '';
    var m = /<video[^>]+src=["']([^"']+)["']/i.exec(html) ||
           /<audio[^>]+src=["']([^"']+)["']/i.exec(html) ||
           /<img[^>]+src=["']([^"']+)["']/i.exec(html);
    if (m) {
      var inner = html.slice(m.index, m.index + m[0].length);
      var tipo = /<video/i.test(inner) ? 'video' : (/<audio/i.test(inner) ? 'audio' : 'image');
      return { url: m[1], tipo: tipo };
    }
    return { url: null, tipo: null };
  }

  function secureMedia(m) {
    m.setAttribute('controlsList', 'nodownload noremoteplayback');
    if (m.tagName === 'VIDEO') m.setAttribute('disablePictureInPicture', '');
    m.setAttribute('preload', 'metadata');
    m.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    m.addEventListener('dragstart', function (e) { e.preventDefault(); });
  }

  function injectSecurePlayer(media) {
    var wrap = el('div', 'media-player-wrap');
    wrap.appendChild(el('span', 'media-badge', media.tipo === 'audio' ? '🔊 Audio' : '🎬 Video'));
    var m = document.createElement(media.tipo === 'audio' ? 'audio' : 'video');
    m.controls = true;
    m.controlsList = 'nodownload noremoteplayback';
    if (m.tagName === 'VIDEO') { m.disablePictureInPicture = true; m.playsInline = true; }
    m.preload = 'metadata';
    m.src = media.url;
    secureMedia(m);
    wrap.appendChild(m);
    ['contextmenu', 'dragstart'].forEach(function (ev) { wrap.addEventListener(ev, function (e) { e.preventDefault(); }); });
    $('readerContent').appendChild(wrap);
  }

  function renderReaderNav(lecciones, indice, completed) {
    var done = completed.indexOf(String(lecciones[indice].id)) !== -1;
    var completeLabel = $('completeLabel');
    var btnComplete = $('btnCompleteLesson');
    if (done) {
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
    // Solo permite avanzar tras completar la lección actual (progresión estricta).
    $('btnNextLesson').disabled = !done || indice >= lecciones.length - 1;
  }

  /* ─── PROGRESS ────────────────────────────────────────────── */
  function saveProgress(cursoId, update) {
    if (!V.db) return Promise.resolve();
    return V.db.collection(V.COL_CURSOS).doc(cursoId).collection(V.COL_PROGRESO).doc(V.userId).set(update, { merge: true })
      .catch(function (e) { V.toast('No se pudo guardar el progreso: ' + e.message, true); });
  }

  function markLessonComplete() {
    if (!leccionActual) return;
    var curso = leccionActual.curso;
    var lp = leccionActual.lecciones[leccionActual.indice];
    var prog = progresoCache[curso.id] || {};
    var completed = (prog.completed || []);
    if (completed.indexOf(String(lp.id)) !== -1) return;
    completed.push(String(lp.id));
    var indice = Math.max(prog.indice || 0, leccionActual.indice + 1);
    saveProgress(curso.id, { completed: completed, indice: indice }).then(function () {
      V.toast('¡Lección completada! 🎉');
      renderReaderNav(leccionActual.lecciones, leccionActual.indice, completed);
    });
  }

  function subscribeProgreso(cursoId) {
    if (!V.db) return;
    V.db.collection(V.COL_CURSOS).doc(cursoId).collection(V.COL_PROGRESO).doc(V.userId)
      .onSnapshot(function (doc) {
        progresoCache[cursoId] = doc.exists ? doc.data() : {};
        if (cursoActualId === cursoId && $('viewCourse') && $('viewCourse').classList.contains('active')) {
          var curso = cursosCache.filter(function (c) { return c.id === cursoId; })[0];
          if (curso) renderLessonList(curso);
        }
        renderCatalog();
        updateProgressBar();
      }, function (e) {
        V.toast('Error al sincronizar el progreso: ' + e.message, true);
      });
  }

  /* ─── CRUD CURSOS ─────────────────────────────────────────── */
  function subscribeCursos() {
    if (!V.db) return;
    V.db.collection(V.COL_CURSOS).onSnapshot(function (snap) {
      cursosCache = [];
      snap.forEach(function (doc) { var d = doc.data(); d.id = doc.id; cursosCache.push(d); });
      cursosCache.sort(function (a, b) { return (a.fecha || '').localeCompare(b.fecha || ''); });
      renderCatalog();
      updateProgressBar();
      cursosCache.forEach(function (c) {
        if (!progresoSubscribed[c.id]) { progresoSubscribed[c.id] = true; subscribeProgreso(c.id); }
      });
    }, function (e) {
      V.toast('Error de conexión a Firestore: ' + e.message, true);
    });
  }

  function openEditor(curso) {
    editingId = curso ? curso.id : null;
    draftLecciones = curso ? (curso.lecciones || []) : [];
    $('editorHeading').textContent = curso ? 'Editar: ' + (curso.titulo || '') : 'Nuevo Curso';
    $('edTitle').value = courseField(curso, ['titulo', 'title'], '');
    $('edDesc').value = courseField(curso, ['descripcion', 'description', 'desc'], '');
    if (wpPostsLoaded) {
      renderLessonPicker(draftLecciones);
    } else {
      var picker = $('lessonPickerList');
      if (picker) {
        picker.innerHTML = '';
        var es = V.emptyState('📥', '', 'Pulsa "＋ Añadir / seleccionar lecciones" para cargar los artículos de WordPress.');
        es.style.padding = '1.5rem 1rem';
        picker.appendChild(es);
      }
    }
    V.showView('viewEditor');
  }

  function fetchWpPosts() {
    return fetch(WP_API)
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) {
        wpPosts = (data || []).map(function (p) { return { id: String(p.id), titulo: (p.title && p.title.rendered) || 'Sin título', fecha: p.date || null }; });
        wpPostsLoaded = true;
        return wpPosts;
      })
      .catch(function () { wpPosts = []; wpPostsLoaded = false; throw new Error('Error al conectar con WordPress'); });
  }

  function renderLessonPicker(selectedRefs) {
    var container = $('lessonPickerList');
    if (!container) return;
    container.innerHTML = '';
    var selectedIds = (selectedRefs || []).map(function (s) { return String(s.id); });
    if (!wpPosts.length) {
      var es = V.emptyState('📄', 'No hay artículos disponibles', 'Publica entradas en WordPress para asociarlas al curso.');
      es.style.padding = '1.5rem 1rem';
      container.appendChild(es);
      return;
    }
    wpPosts.forEach(function (p) {
      var isSel = selectedIds.indexOf(p.id) !== -1;
      var item = el('label', 'picker-item' + (isSel ? ' selected' : ''));
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.value = p.id; cb.checked = isSel;
      cb.onchange = function () { item.classList.toggle('selected', cb.checked); syncDraftFromCheckboxes(); };
      item.appendChild(cb);
      var info = el('div', 'picker-info');
      info.appendChild(el('span', 'picker-title', p.titulo));
      info.appendChild(el('span', 'picker-id', 'ID #' + p.id));
      item.appendChild(info);
      container.appendChild(item);
    });
  }

  function syncDraftFromCheckboxes() {
    var container = $('lessonPickerList');
    if (!container) return;
    var inputs = container.querySelectorAll('input[type=checkbox]');
    if (!inputs.length) return;
    draftLecciones = [];
    inputs.forEach(function (cb) {
      if (!cb.checked) return;
      var post = wpPosts.filter(function (p) { return p.id === cb.value; })[0];
      if (post) draftLecciones.push({ id: post.id, titulo: post.titulo, fecha: post.fecha });
    });
  }

  function addLesson() {
    var btn = $('btnAddLesson');
    btn.disabled = true;
    btn.textContent = '⏳ Cargando…';
    var load = wpPostsLoaded ? Promise.resolve(wpPosts) : fetchWpPosts();
    load.then(function () { renderLessonPicker(draftLecciones); })
      .catch(function (e) {
        var container = $('lessonPickerList');
        if (container) { container.innerHTML = ''; container.appendChild(V.emptyState('⚠️', 'Error al conectar', (e.message) + ' — revisa ' + WP_API)); }
      })
      .finally(function () { btn.disabled = false; btn.textContent = '＋ Añadir / seleccionar lecciones'; });
  }

  function saveCourse() {
    var titulo = $('edTitle').value.trim();
    var desc = $('edDesc').value.trim();
    if (!titulo) { V.toast('El título es obligatorio.', true); return; }
    syncDraftFromCheckboxes();
    var lecciones = draftLecciones.map(function (l) {
      return { id: String(l.id), titulo: l.titulo || '', fecha: l.fecha || null };
    }).filter(function (l) { return l.id; });
    var data = { titulo: titulo, descripcion: desc, lecciones: lecciones, fecha: new Date().toISOString() };

    var ref = V.db.collection(V.COL_CURSOS);
    var write = editingId ? ref.doc(editingId).set(data, { merge: true }) : ref.add(data);
    write.then(function () {
      V.toast((editingId ? 'Curso actualizado ✓' : 'Curso creado ✓') + (lecciones.length === 0 ? ' — sin lecciones' : ''));
      V.showView('viewCatalog');
    }).catch(function (e) { V.toast('Error al guardar: ' + e.message, true); });
  }

  function deleteCourse(curso) {
    if (!confirm('¿Eliminar el curso "' + (curso.titulo || '') + '"? Esta acción no se puede deshacer.')) return;
    V.db.collection(V.COL_CURSOS).doc(curso.id).delete()
      .then(function () { V.toast('Curso eliminado'); })
      .catch(function (e) { V.toast('Error al eliminar: ' + e.message, true); });
  }

  /* ─── PROGRESS BAR ────────────────────────────────────────── */
  function updateProgressBar() {
    if (V.mode !== 'estudiante') return;
    var total = 0, doneAll = 0;
    cursosCache.forEach(function (c) {
      var n = (c.lecciones || []).length;
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
    openLesson(leccionActual.curso, leccionActual.lecciones, leccionActual.indice - 1);
  }
  function nextLesson() {
    if (!leccionActual || leccionActual.indice >= leccionActual.lecciones.length - 1) return;
    openLesson(leccionActual.curso, leccionActual.lecciones, leccionActual.indice + 1);
  }

  /* ─── MODULE INTERFACE ────────────────────────────────────── */
  var CursosModule = {
    onReady: function () {
      $('btnAddLesson').addEventListener('click', addLesson);
      $('btnSaveCourse').addEventListener('click', saveCourse);
      $('btnCompleteLesson').addEventListener('click', markLessonComplete);
      $('btnPrevLesson').addEventListener('click', prevLesson);
      $('btnNextLesson').addEventListener('click', nextLesson);
      bindCatalogEvents();
      subscribeCursos();
    }
  };

  V.onNewCourse = function () { openEditor(null); };

  V.onModeChange = function (m) {
    if (m !== 'admin') renderCatalog();
  };

  V.registerModule(CursosModule);
})();
