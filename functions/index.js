/* ════════════════════════════════════════════════════════════════
   VCONV · Cloud Functions — Eliminación raíz de cuentas

   eliminarUsuario ({ uid }): borra de forma completa la cuenta de un
   usuario. El SDK web NO puede eliminar la cuenta de Autenticación de
   otro usuario: solo una Cloud Function con el Admin SDK tiene ese
   privilegio. Al ejecutarse con credenciales de administrador, las
   reglas de Firestore quedan en bypass (Admin SDK).

   Limpieza de raíz:
     1. Cuenta en Firebase Authentication (libera de verdad el correo;
        auth/user-not-found se tolera: el correo ya estaba libre).
     2. Documento usuarios/{uid}.
     3. Mapeo referidos/{referralCode} para que el código quede reusable.
     4. Re-parentado de referidos directos (usuarios con sponsorId == uid):
        se les asigna el patrocinador del usuario eliminado (o se borra el
        campo si no tenía), evitando eslabones rotos en la red MLM.
     5. Progreso del usuario en las dos rutas de curso (legacy y anidada).
     6. Membresías de comunidades (comunidad_miembros con userId == uid).
     7. Registros de finanzas del usuario: transacciones que creó,
        comisiones liquidadas a su favor y pagos recibidos.
   ════════════════════════════════════════════════════════════════ */

const { onCall } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/logger');
const admin = require('firebase-admin');

admin.initializeApp();

const db = admin.firestore();
const auth = admin.auth();
const FV = admin.firestore.FieldValue;

const COL_USUARIOS = 'usuarios';
const COL_REFERIDOS = 'referidos';
const COL_CATEGORIAS = 'categorias';
const COL_CURSOS = 'cursos';
const COL_PROGRESO = 'progreso';
const COL_COMUNIDAD_MIEMBROS = 'comunidad_miembros';
const COL_FINANC_TRANS = 'finanzas_transacciones';
const COL_FINANC_COMIS = 'finanzas_comisiones';
const COL_FINANC_PAGOS = 'finanzas_pagos';

const TAM_MAX_LOTE = 450;

// Divide un lote grande de borrados en commits de <= TAM_MAX_LOTE.
async function borrarDocs(listaRefs) {
  const lista = listaRefs.filter(Boolean);
  for (let i = 0; i < lista.length; i += TAM_MAX_LOTE) {
    const lote = db.batch();
    lista.slice(i, i + TAM_MAX_LOTE).forEach(function (ref) {
      lote.delete(ref);
    });
    await lote.commit();
  }
}

// Progreso del usuario en ambas rutas: cursos/{id}/progreso y
// categorias/{cat}/cursos/{id}/progreso.
async function borrarProgresoDe(uid) {
  const tareas = [];

  const cursosLegacy = await db.collection(COL_CURSOS).listDocuments();
  cursosLegacy.forEach(function (cRef) {
    tareas.push(cRef.collection(COL_PROGRESO).doc(uid).delete().catch(function () {}));
  });

  const categorias = await db.collection(COL_CATEGORIAS).listDocuments();
  for (const catRef of categorias) {
    const cursos = await catRef.collection(COL_CURSOS).listDocuments();
    cursos.forEach(function (cRef) {
      tareas.push(cRef.collection(COL_PROGRESO).doc(uid).delete().catch(function () {}));
    });
  }

  await Promise.all(tareas);
}

// Borra documentos cuya propiedad userId apunte al usuario eliminado.
async function borrarPorUserId(coleccion, uid) {
  const snap = await db.collection(coleccion).where('userId', '==', uid).get();
  const refs = [];
  snap.forEach(function (doc) { refs.push(doc.ref); });
  await borrarDocs(refs);
}

exports.eliminarUsuario = onCall({ region: 'us-central1' }, async function (request) {
  const uid = request.data && request.data.uid;
  if (!uid || typeof uid !== 'string') {
    return { ok: false, error: 'uid-invalido' };
  }

  const caller = request.auth;
  if (!caller) {
    return { ok: false, error: 'no-autenticado' };
  }
  if (caller.uid === uid) {
    return { ok: false, error: 'no-te-puedes-eliminar' };
  }

  // Solo un superadmin (validado contra su propio documento) borra cuentas.
  const perfilAdmin = await db.collection(COL_USUARIOS).doc(caller.uid).get();
  if (!perfilAdmin.exists || perfilAdmin.data().rol !== 'superadmin') {
    return { ok: false, error: 'permiso-denegado' };
  }

  // Datos del objetivo antes de cualquier borrado (referralCode, sponsorId).
  const refObjetivo = db.collection(COL_USUARIOS).doc(uid);
  const docObjetivo = await refObjetivo.get();
  const datos = docObjetivo.exists ? docObjetivo.data() : {};

  try {
    // 1) Cuenta de Firebase Authentication: libera de verdad el correo.
    await auth.deleteUser(uid);
  } catch (err) {
    if (err && err.code !== 'auth/user-not-found') {
      logger.error('Fallo al borrar cuenta de auth', err);
      return { ok: false, error: 'error-auth', detalle: String(err.message || err) };
    }
    // user-not-found: la cuenta de auth ya no existía; el correo está libre.
  }

  // 2) Mapeo de código de referido → deja el código disponible.
  if (datos.referralCode) {
    await db.collection(COL_REFERIDOS).doc(String(datos.referralCode)).delete()
      .catch(function () {});
  }

  // 3) Re-parentado de la red directa: los referidos de nivel 1 pasan al
  //    patrocinador del usuario eliminado (o quedan sin patrocinador).
  const directos = await db.collection(COL_USUARIOS).where('sponsorId', '==', uid).get();
  if (!directos.empty) {
    const nuevoSponsor = datos.sponsorId || FV.delete();
    const refs = [];
    directos.forEach(function (doc) { refs.push(doc.ref); });
    for (let i = 0; i < refs.length; i += TAM_MAX_LOTE) {
      const lote = db.batch();
      refs.slice(i, i + TAM_MAX_LOTE).forEach(function (ref) {
        lote.update(ref, { sponsorId: nuevoSponsor });
      });
      await lote.commit();
    }
  }

  // 4) Documento principal de registro.
  await refObjetivo.delete();

  // 5) Progreso en cursos (legacy y anidado).
  await borrarProgresoDe(uid);

  // 6) Membresías de comunidades.
  await borrarPorUserId(COL_COMUNIDAD_MIEMBROS, uid);

  // 7) Registros de finanzas ligados al usuario.
  await Promise.all([
    borrarPorUserId(COL_FINANC_TRANS, uid),
    borrarPorUserId(COL_FINANC_COMIS, uid),
    borrarPorUserId(COL_FINANC_PAGOS, uid)
  ]);

  logger.info('Cuenta eliminada de raíz', { uid, adminUid: caller.uid });
  return { ok: true };
});