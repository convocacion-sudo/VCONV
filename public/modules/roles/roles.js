/* ═══════════════════════════════════════════════════════════════
   MÓDULO DE ROLES (Fase A · multi-rol)
   ───────────────────────────────────────────────────────────────
   Este módulo es el dueño de TRES cosas:

   1) EL CATÁLOGO DE ROLES. La plataforma pasó de un rol único
      (`rol`) a un CONJUNTO de roles (`roles`): una persona puede ser
      al mismo tiempo estudiante, coordinador de comunidad y contable.
      El conjunto efectivo es la UNIÓN del rol principal heredado y
      del arreglo `roles` (ver V.normalizarRoles en core/app.js).

   2) EL ÍNDICE DE RED (`camino`). Cada documento usuarios/{uid}
      guarda `camino`: el arreglo de sus ancestros de patrocinio, DEL
      MÁS CERCANO AL MÁS LEJANO. Ese campo es lo que permite que un
      coordinador lea SU red con UNA sola consulta
      (where('camino','array-contains',uid)) en vez de encadenar
      consultas nivel por nivel, que el motor de reglas no puede
      probar. El campo NO es declarativo del cliente: firestore.rules
      lo valida contra la cadena REAL de patrocinio (caminoCoherente),
      así que nadie puede inventarse un árbol.

   3) LA VISTA JERÁRQUICA DEL COORDINADOR. Cuatro niveles exactos:
      Nivel 1 (directos), Nivel 2, Nivel 3 y Nivel 4. La constante
      MAX_NIVELES_COORDINADOR es la ÚNICA fuente de esa profundidad
      (y coincide con el máximo de 4 entradas que acepta el campo
      `camino` en las reglas). La profundidad de las COMISIONES MLM
      (N1–N5) es otra cosa y sigue en su propio módulo (mlm.js).
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var V = window.VCONV;
  if (!V) return;

  /* ─── PROFUNDIDAD DE LA RED DEL COORDINADOR ──────────────────
     EXACTAMENTE 4 niveles: Nivel 1 = referidos directos, y de ahí
     hasta el Nivel 4. Coincide con MAX_CAMINO (el máximo de entradas
     del campo `camino` que valida firestore.rules): con 4 ancestros
     guardados, el coordinador alcanza exactamente 4 niveles hacia
     abajo. Si se cambiara una de las dos, la red se cortaría o
     desbordaría el índice. */
  var MAX_NIVELES_COORDINADOR = 4;
  var MAX_CAMINO = MAX_NIVELES_COORDINADOR;

  /* ─── CATÁLOGO DE ROLES ─────────────────────────────────────
     Los roles heredados (estudiante, avanzado, gestor, superadmin)
     son el "rol principal" y siguen siendo los que lee el código
     antiguo. Los de Fase A son adicionales y se combinan entre sí. */
  var ROLES_BASE = {
    estudiante: { label: 'Estudiante', icon: '🎓', color: 'blue', grupo: 'base', desc: 'Acceso al contenido de la plataforma.' },
    avanzado: { label: 'Avanzado', icon: '📈', color: 'green', grupo: 'base', desc: 'Solo lectura sobre los datos financieros de su propia red.' },
    gestor: { label: 'Gestor', icon: '🛠️', color: 'gold', grupo: 'base', desc: 'Gestiona el contenido del CMS (cursos, podcasts, tienda).' },
    superadmin: { label: 'Superadmin', icon: '🔐', color: 'gold', grupo: 'base', desc: 'Acceso total: usuarios, contenido, finanzas, red global y configuración.' }
  };
  // Roles de Fase A (los que se combinan con los heredados).
  var ROLES_FASE_A = {
    superadmin: { label: 'Superadmin', icon: '🔐', color: 'gold', desc: 'Acceso total: usuarios, contenido, finanzas, red global y configuración.' },
    cursos_pago: { label: 'Cursos de pago', icon: '💎', color: 'blue', desc: 'Acceso al contenido y a los cursos prémium de la plataforma.' },
    coordinador_comunidad: { label: 'Coordinador de comunidad', icon: '🌐', color: 'green', desc: 'Consulta la red MLM jerárquica (4 niveles) de los usuarios de su red.' },
    comptable: { label: 'Contable', icon: '🧮', color: 'purple', desc: 'Acceso exclusivo a los reportes financieros y al módulo de finanzas.' }
  };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function $(id) { return V.$ ? V.$(id) : document.getElementById(id); }

  /* ─── NORMALIZACIÓN DE ROLES ───────────────────────────────
     Un documento puede venir de tres formas: solo `rol` (legacy),
     solo `roles` (nuevo) o los dos. El conjunto efectivo es siempre
     la unión, sin duplicados y sin valores basura. */
  function rolesDe(doc) {
    if (V.normalizarRoles) return V.normalizarRoles(doc || {});
    var out = [];
    var data = doc || {};
    if (Object.prototype.toString.call(data.roles) === '[object Array]') {
      data.roles.forEach(function (r) {
        if (typeof r === 'string' && r && out.indexOf(r) === -1) out.push(r);
      });
    }
    if (typeof data.rol === 'string' && data.rol && out.indexOf(data.rol) === -1) out.push(data.rol);
    return out;
  }

  // Etiqueta legible de un rol (con respaldo al propio identificador).
  function etiquetaRol(r) {
    var meta = ROLES_FASE_A[r] || ROLES_BASE[r];
    return meta ? meta.label : r;
  }

  /* Rol PRINCIPAL a partir del conjunto: es el que leen el código
     heredado y el que se guarda en `rol`. Se deriva del conjunto para
     que `rol` y `roles` nunca discrepen. */
  function derivarRolPrincipal(roles) {
    var set = roles || [];
    if (set.indexOf('superadmin') !== -1) return 'superadmin';
    if (set.indexOf('gestor') !== -1) return 'gestor';
    if (set.indexOf('avanzado') !== -1) return 'avanzado';
    return 'estudiante';
  }

  // Normaliza el conjunto que se guarda en el documento: sin
  // duplicados, sin valores vacíos y siempre con el rol principal
  // dentro (para que `rol` y `roles` digan lo mismo).
  function conjuntoNormalizado(roles) {
    var out = [];
    (roles || []).forEach(function (r) {
      if (typeof r === 'string' && r && out.indexOf(r) === -1) out.push(r);
    });
    var principal = derivarRolPrincipal(out);
    if (out.indexOf(principal) === -1) out.unshift(principal);
    return out;
  }

  /* ═══ ÍNDICE DE RED: EL CAMPO `camino` ═══════════════════════
     calcularCamino(uid) devuelve el arreglo de ancestros (máximo 4)
     subiendo por la cadena REAL de sponsorId. Dos detalles:
       - los documentos legacy guardan a veces un CÓDIGO de referido
         en lugar del UID; se resuelve con la colección `referidos`,
       - se corta el recorrido si un ciclo aparece en la cadena. */
  function calcularCamino(uid) {
    var camino = [];
    var vistos = {};
    var col = V.db ? V.db.collection(V.COL_USUARIOS) : null;
    var refCol = V.db ? V.db.collection('referidos') : null;
    if (!col || !uid) return Promise.resolve(camino);

    // Sube un eslabón: lee el documento del último ancestro y añade SU
    // patrocinador. `vistos` corta los ciclos (un sponsorId que se
    // repite) y el tope de MAX_CAMINO fija la longitud del índice.
    function siguiente() {
      if (camino.length >= MAX_CAMINO) return Promise.resolve(camino);
      var actual = camino[camino.length - 1];
      if (!actual) return Promise.resolve(camino);
      return col.doc(actual).get().then(function (doc) {
        if (!doc.exists) {
          // Puede ser un CÓDIGO de referido legacy: se busca su mapeo.
          if (!refCol) return camino;
          return refCol.doc(actual).get().then(function (rdoc) {
            if (!rdoc.exists) return camino;
            var owner = String((rdoc.data() || {}).userId || '');
            if (!owner || vistos[owner]) return camino;
            vistos[owner] = true;
            camino.push(owner);
            return siguiente();
          }).catch(function () { return camino; });
        }
        var sp = String((doc.data() || {}).sponsorId || '');
        if (!sp || vistos[sp]) return camino;
        vistos[sp] = true;
        camino.push(sp);
        return siguiente();
      }).catch(function () { return camino; });
    }

    // El primer eslabón es el patrocinador DIRECTO del usuario.
    return col.doc(String(uid)).get().then(function (doc) {
      if (!doc.exists) return camino;
      var sp = String((doc.data() || {}).sponsorId || '');
      if (!sp || vistos[sp]) return camino;
      vistos[sp] = true;
      camino.push(sp);
      return siguiente();
    }).catch(function () { return camino; });
  }

  function mismoCamino(a, b) {
    if (Object.prototype.toString.call(a) !== '[object Array]') return false;
    if (Object.prototype.toString.call(b) !== '[object Array]') return false;
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /* asegurarCamino(uid): calcula el camino y lo guarda si cambió.
     Lo puede escribir el propio usuario (auto-reparación) o el
     administrador (CRM). firestore.rules valida que el camino sea
     coherente con la cadena real, así que un camino inventado es
     rechazado por el servidor. */
  function asegurarCamino(uid, forzar) {
    if (!V.db || !uid) return Promise.resolve(null);
    var ref = V.db.collection(V.COL_USUARIOS).doc(uid);
    return calcularCamino(uid).then(function (camino) {
      return ref.get().then(function (doc) {
        if (!doc.exists) return null;
        var actual = (doc.data() || {}).camino;
        if (!forzar && mismoCamino(actual, camino)) return camino;
        return ref.update({ camino: camino })
          .then(function () { return camino; })
          .catch(function () { return camino; });
      });
    }).catch(function () { return null; });
  }

  /* reconstruirIndice(onProgress): el superadmin recalcula el
     `camino` de TODOS los usuarios. Es la operación de mantenimiento
     del índice (por ejemplo después de una importación masiva o de
     cambiar patrocinios en lote). */
  function reconstruirIndice(onProgress) {
    if (!V.db) return Promise.resolve(0);
    var col = V.db.collection(V.COL_USUARIOS);
    return col.get().then(function (snap) {
      var docs = [];
      snap.forEach(function (doc) { docs.push({ id: doc.id, data: doc.data() || {} }); });
      var total = docs.length;
      var i = 0;
      var cambios = 0;
      var LOTE = 5;

      function lote() {
        if (i >= docs.length) return Promise.resolve(cambios);
        var tanda = docs.slice(i, i + LOTE);
        i += tanda.length;
        return Promise.all(tanda.map(function (d) {
          return calcularCamino(d.id).then(function (camino) {
            if (mismoCamino(d.data.camino, camino)) return null;
            return col.doc(d.id).update({ camino: camino })
              .then(function () { cambios++; })
              .catch(function () { return null; });
          });
        })).then(function () {
          if (onProgress) onProgress(Math.min(i, total), total);
          return lote();
        });
      }
      return lote();
    }).then(function (n) { return n; })
      .catch(function () { return 0; });
  }

  /* ═══ RED JERÁRQUICA DEL COORDINADOR (4 NIVELES) ════════════
     Vía principal: UNA consulta con array-contains sobre `camino`.
     El nivel de cada miembro es la posición de la raíz dentro de su
     `camino` + 1 (así, camino = [raíz] → Nivel 1).

     Respaldo: si esa consulta es rechazada (por ejemplo, si el
     índice `camino` de ese usuario aún no se ha reconstruido), se
     recorre la red nivel por nivel con where('sponsorId','==',uid),
     que el motor de reglas sí puede probar. Es más lento (una
     consulta por padre), pero devuelve lo mismo. */
  function filaDe(doc, d, nivel) {
    return {
      uid: doc.id,
      nivel: nivel,
      nombre: ((d.nombre || '') + ' ' + (d.apellido || '')).trim() || (d.email || 'Usuario'),
      email: d.email || '',
      estado: d.estado || 'Activo',
      rol: d.rol || 'estudiante',
      roles: rolesDe(d),
      sponsorId: d.sponsorId || '',
      creado: d.creado || d.createdAt || '',
      telefono: d.telefono || ''
    };
  }

  function redPorSponsor(rootUid, max) {
    var col = V.db.collection(V.COL_USUARIOS);
    var niveles = [];
    var i;
    for (i = 1; i <= max; i++) niveles.push({ nivel: i, miembros: [] });
    var vistos = {};
    var pendientes = [String(rootUid)];
    var completados = 0;

    function paso() {
      if (!pendientes.length || completados >= max) return Promise.resolve(niveles);
      var actual = completados; // índice (0-based) del nivel que se llena
      var promesas = pendientes.map(function (uidPadre) {
        return col.where('sponsorId', '==', uidPadre).get()
          .then(function (snap) {
            var filas = [];
            snap.forEach(function (doc) {
              if (vistos[doc.id]) return;
              vistos[doc.id] = true;
              var d = doc.data() || {};
              filas.push(filaDe(doc, d, actual + 1));
            });
            return filas;
          })
          .catch(function () { return []; });
      });
      return Promise.all(promesas).then(function (lotes) {
        var filas = [];
        lotes.forEach(function (l) { filas = filas.concat(l); });
        niveles[actual].miembros = filas;
        completados++;
        pendientes = filas.map(function (f) { return f.uid; });
        return paso();
      });
    }
    return paso().then(function () { return niveles; });
  }

  function redJerarquica(rootUid, maxNivel) {
    var uid = String(rootUid || V.userId || '');
    var max = Math.max(1, Math.min(MAX_NIVELES_COORDINADOR, Number(maxNivel) || MAX_NIVELES_COORDINADOR));
    if (!V.db || !uid) return Promise.resolve({ niveles: [], fuente: 'none' });
    var col = V.db.collection(V.COL_USUARIOS);
    var niveles = [];
    var i;
    for (i = 1; i <= max; i++) niveles.push({ nivel: i, miembros: [] });

    return col.where('camino', 'array-contains', uid).get().then(function (snap) {
      snap.forEach(function (doc) {
        var d = doc.data() || {};
        var camino = Object.prototype.toString.call(d.camino) === '[object Array]' ? d.camino : [];
        var pos = camino.indexOf(uid);
        if (pos === -1) return;
        var nivel = pos + 1;
        if (nivel > max) return;
        niveles[nivel - 1].miembros.push(filaDe(doc, d, nivel));
      });
      return { niveles: niveles, fuente: 'camino' };
    }).catch(function () {
      // Respaldo por patrocinio directo.
      return redPorSponsor(uid, max).then(function (niv) {
        return { niveles: niv, fuente: 'sponsorId' };
      });
    });
  }

  /* ═══ VISTA JERÁRQUICA (UI) ═════════════════════════════════
     Pinta la red del coordinador en 4 niveles: una ficha de resumen
     arriba y una tarjeta por nivel con sus miembros. */
  function renderResumen(container, res, raiz) {
    container.innerHTML = '';
    var total = 0;
    var activos = 0;
    res.niveles.forEach(function (n) {
      total += n.miembros.length;
      n.miembros.forEach(function (m) { if (m.estado === 'Activo') activos++; });
    });

    var card = el('div', 'red-coord-metricas');
    function metrica(valor, etiqueta, color) {
      var c = el('div', 'red-coord-metrica');
      if (color) c.classList.add('is-' + color);
      c.appendChild(el('span', 'red-coord-metrica-valor', String(valor)));
      c.appendChild(el('span', 'red-coord-metrica-label', etiqueta));
      return c;
    }
    card.appendChild(metrica(total, 'Total en la red', 'blue'));
    card.appendChild(metrica(activos, 'Activos', 'green'));
    res.niveles.forEach(function (n) {
      card.appendChild(metrica(n.miembros.length, 'Nivel ' + n.nivel, 'gold'));
    });
    container.appendChild(card);

    var nota = el('p', 'red-coord-nota');
    nota.textContent = res.fuente === 'sponsorId'
      ? 'Lectura por patrocinio directo (respaldo): el índice `camino` de esta red aún no está reconstruido. Pide al administrador ejecutar «Reconstruir índice de red» en el panel de usuarios.'
      : 'Profundidad de la vista: 4 niveles (Nivel 1 = referidos directos).';
    container.appendChild(nota);
  }

  function renderNivel(n) {
    var card = el('div', 'red-coord-nivel');
    var head = el('div', 'red-coord-nivel-head');
    head.appendChild(el('span', 'red-coord-nivel-badge', 'Nivel ' + n.nivel));
    head.appendChild(el('h3', 'red-coord-nivel-title',
      n.nivel === 1 ? 'Referidos directos' : 'Nivel ' + n.nivel));
    head.appendChild(el('span', 'red-coord-nivel-count', n.miembros.length + (n.miembros.length === 1 ? ' persona' : ' personas')));
    card.appendChild(head);

    if (!n.miembros.length) {
      card.appendChild(el('p', 'red-coord-vacio', 'Sin miembros en este nivel.'));
      return card;
    }

    var table = el('div', 'red-coord-tabla');
    n.miembros.forEach(function (m) {
      var row = el('div', 'red-coord-fila');
      var info = el('div', 'red-coord-fila-info');
      info.appendChild(el('span', 'red-coord-fila-nombre', m.nombre));
      if (m.email) info.appendChild(el('span', 'red-coord-fila-email', m.email));
      row.appendChild(info);

      var tags = el('div', 'red-coord-fila-tags');
      (m.roles || []).forEach(function (r) {
        var t = el('span', 'red-coord-tag', etiquetaRol(r));
        tags.appendChild(t);
      });
      var estado = el('span', 'red-coord-estado ' + (m.estado === 'Activo' ? 'ok' : 'off'), m.estado);
      tags.appendChild(estado);
      row.appendChild(tags);
      table.appendChild(row);
    });
    card.appendChild(table);
    return card;
  }

  function renderRedCoordinador() {
    var resumen = $('redCoordinadorResumen');
    var body = $('redCoordinadorBody');
    if (!resumen || !body) return;
    resumen.innerHTML = '';
    body.innerHTML = '';

    var cargando = el('div', 'red-coord-cargando', 'Cargando tu red…');
    body.appendChild(cargando);

    var raiz = V.userId;
    redJerarquica(raiz, MAX_NIVELES_COORDINADOR).then(function (res) {
      body.innerHTML = '';
      renderResumen(resumen, res, raiz);
      res.niveles.forEach(function (n) { body.appendChild(renderNivel(n)); });
    }).catch(function (e) {
      body.innerHTML = '';
      body.appendChild(el('p', 'red-coord-vacio', 'No se pudo cargar la red: ' + (e && e.message ? e.message : e)));
    });
  }

  /* ═══ EXPORTACIÓN ═════════════════════════════════════════════ */
  V.roles = {
    ROLES_BASE: ROLES_BASE,
    ROLES_FASE_A: ROLES_FASE_A,
    MAX_NIVELES_COORDINADOR: MAX_NIVELES_COORDINADOR,
    MAX_CAMINO: MAX_CAMINO,
    rolesDe: rolesDe,
    etiquetaRol: etiquetaRol,
    derivarRolPrincipal: derivarRolPrincipal,
    conjuntoNormalizado: conjuntoNormalizado,
    calcularCamino: calcularCamino,
    asegurarCamino: asegurarCamino,
    reconstruirIndice: reconstruirIndice,
    redJerarquica: redJerarquica,
    renderRedCoordinador: renderRedCoordinador
  };

  // El núcleo llama a este hook al abrir la vista del coordinador.
  V.onRedCoordinadorShow = function () {
    renderRedCoordinador();
  };

  // Botón de recarga de la vista.
  document.addEventListener('DOMContentLoaded', function () {
    var btn = $('btnRedCoordinadorRefresh');
    if (btn) btn.addEventListener('click', function () { renderRedCoordinador(); });
  });
})();
