/* ════════════════════════════════════════════════════════════════
   VCONV · Formularios dinámicos
   La estructura de los formularios de REGISTRO y de PERFIL se guarda en
   `config/formulario` y la aplica este módulo en tiempo de ejecución.

   Cada campo tiene uno de los cuatro estados:

     · OBLIGATORIO → aparece y hay que llenarlo.
     · VISIBLE     → aparece, pero es opcional.
     · OCULTO      → no aparece en el formulario; el dato ya guardado se
                     conserva.
     · ELIMINADO   → no aparece en el formulario y además se borra el
                     dato guardado.

   El panel de Configuración (pestaña "Campos de formularios") edita
   esta estructura; este módulo la aplica. Así el control y la aplicación
   nunca pueden divergir: no hay una segunda lista de campos escondida
   en el código.
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var V = window.VCONV;
  if (!V) { console.error('VCONV core not loaded'); return; }

  var CONFIG_COLLECTION = 'config';
  var DOC_FORMULARIO = 'formulario';

  var ESTADOS = [
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

  // Tipo de campo → tipo de input del DOM.
  var TIPO_INPUT = {
    texto: 'text', area: 'textarea', numero: 'number', email: 'email',
    telefono: 'tel', fecha: 'date', booleano: 'checkbox', seleccion: 'select'
  };

  function clonar(v) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(clonar);
    var out = {};
    Object.keys(v).forEach(function (k) { out[k] = clonar(v[k]); });
    return out;
  }

  function $(id) { return V.$ ? V.$(id) : document.getElementById(id); }

  /* ─── ESQUEMA POR DEFECTO ──────────────────────────────────────
     Los campos que ya existen en la aplicación. El id del campo es
     también la clave con la que se guarda en el documento del usuario
     (para el perfil), y `domId` es el elemento del formulario al que
     se aplica el estado. */
  function esquemaPorDefecto() {
    return {
      version: 1,
      forms: {
        registro: {
          id: 'registro',
          nombre: 'Registro de cuenta',
          campos: [
            { id: 'nombre', etiqueta: 'Nombre', tipo: 'texto', placeholder: 'Tu nombre', domId: 'regName', estado: 'obligatorio', opciones: [] },
            { id: 'correo', etiqueta: 'Correo electrónico', tipo: 'email', placeholder: 'tucorreo@ejemplo.com', domId: 'regEmail', estado: 'obligatorio', opciones: [] },
            { id: 'contrasena', etiqueta: 'Contraseña', tipo: 'password', placeholder: 'Mínimo 6 caracteres', domId: 'regPassword', estado: 'obligatorio', opciones: [] },
            { id: 'referido', etiqueta: 'Código de referido (opcional)', tipo: 'texto', placeholder: 'Ej: VC-ABC123', domId: 'regReferido', estado: 'visible', opciones: [] }
          ]
        },
        perfil: {
          id: 'perfil',
          nombre: 'Perfil de usuario',
          campos: [
            { id: 'nombre', etiqueta: 'Nombre', tipo: 'texto', placeholder: '', domId: 'crmNombre', estado: 'obligatorio', opciones: [] },
            { id: 'apellido', etiqueta: 'Apellido', tipo: 'texto', placeholder: '', domId: 'crmApellido', estado: 'visible', opciones: [] },
            { id: 'documento', etiqueta: 'Documento', tipo: 'texto', placeholder: 'Ej: 1234567890', domId: 'crmDocumento', estado: 'visible', opciones: [] },
            { id: 'telefono', etiqueta: 'Teléfono', tipo: 'texto', placeholder: 'Ej: 300 123 4567', domId: 'crmTelefono', estado: 'visible', opciones: [] },
            { id: 'sexo', etiqueta: 'Sexo', tipo: 'seleccion', placeholder: '', domId: 'crmSexo', estado: 'visible', opciones: [] },
            { id: 'rangoEdad', etiqueta: 'Rango de edad', tipo: 'seleccion', placeholder: '', domId: 'crmRangoEdad', estado: 'visible', opciones: [] },
            { id: 'estadoCivil', etiqueta: 'Estado civil', tipo: 'seleccion', placeholder: '', domId: 'crmEstadoCivil', estado: 'visible', opciones: [] },
            { id: 'departamento', etiqueta: 'Departamento', tipo: 'seleccion', placeholder: '', domId: 'crmDepartamento', estado: 'visible', opciones: [] },
            { id: 'ciudad', etiqueta: 'Ciudad', tipo: 'seleccion', placeholder: '', domId: 'crmCiudad', estado: 'visible', opciones: [] },
            { id: 'barrio', etiqueta: 'Barrio', tipo: 'seleccion', placeholder: '', domId: 'crmBarrio', estado: 'visible', opciones: [] },
            { id: 'perfil', etiqueta: 'Perfil', tipo: 'seleccion', placeholder: '', domId: 'crmPerfil', estado: 'visible', opciones: [] },
            { id: 'profesion', etiqueta: 'Profesión', tipo: 'seleccion', placeholder: '', domId: 'crmProfesion', estado: 'visible', opciones: [] },
            { id: 'oficio', etiqueta: 'Oficio', tipo: 'seleccion', placeholder: '', domId: 'crmOficio', estado: 'visible', opciones: [] },
            { id: 'banco', etiqueta: 'Banco', tipo: 'seleccion', placeholder: '', domId: 'crmBanco', estado: 'visible', opciones: [] },
            { id: 'numeroCuenta', etiqueta: 'Número de cuenta', tipo: 'texto', placeholder: '', domId: 'crmNumeroCuenta', estado: 'visible', opciones: [] },
            { id: 'notas', etiqueta: 'Notas internas', tipo: 'area', placeholder: '', domId: 'crmNotas', estado: 'visible', opciones: [] }
          ]
        }
      }
    };
  }

  var esquemaActual = esquemaPorDefecto();
  var cargado = false;

  function normalizarEsquema(bruto) {
    var base = esquemaPorDefecto();
    if (!bruto || typeof bruto !== 'object') return base;
    var forms = bruto.forms && typeof bruto.forms === 'object' ? bruto.forms : null;
    if (!forms) return base;

    /* Los campos por defecto NUNCA se quedan sin gestionar: si un campo del
       HTML no aparece en el esquema guardado, se conserva con su estado
       inicial. Si se quedara fuera, su control seguiría visible en el
       formulario (el módulo solo oculta lo que conoce) y el administrador
       creería haberlo quitado cuando no es así. */
    function tiene(objeto, clave) {
      return Object.prototype.hasOwnProperty.call(objeto, clave);
    }

    Object.keys(forms).forEach(function (fid) {
      var f = forms[fid];
      if (!f || !Array.isArray(f.campos)) return;
      var porDefecto = base.forms[fid] || {};
      var porId = {};

      (porDefecto.campos || []).forEach(function (c) {
        porId[c.id] = clonar(c);
      });

      f.campos.forEach(function (c) {
        var id = String(c.id || '');
        if (!id) return;
        var prev = tiene(porId, id) ? porId[id] : null;
        porId[id] = {
          id: id,
          etiqueta: c.etiqueta || (prev && prev.etiqueta) || id,
          tipo: c.tipo || (prev && prev.tipo) || 'texto',
          placeholder: c.placeholder !== undefined ? c.placeholder : ((prev && prev.placeholder) || ''),
          domId: c.domId !== undefined ? c.domId : ((prev && prev.domId) || ''),
          estado: esEstadoValido(c.estado) ? c.estado : ((prev && prev.estado) || 'visible'),
          opciones: Array.isArray(c.opciones) ? c.opciones : ((prev && prev.opciones) || [])
        };
      });

      base.forms[fid] = {
        id: fid,
        nombre: f.nombre || porDefecto.nombre || fid,
        campos: Object.keys(porId).map(function (k) { return porId[k]; })
      };
    });
    return base;
  }

  function esEstadoValido(e) {
    return ESTADOS.some(function (x) { return x[0] === e; });
  }

  /* ─── LECTURA / ESCRITURA ────────────────────────────────────── */
  function cargar() {
    if (!V.db) { cargado = true; esquemaActual = esquemaPorDefecto(); aplicarTodo(); return Promise.resolve(esquemaActual); }
    return V.db.collection(CONFIG_COLLECTION).doc(DOC_FORMULARIO).get()
      .then(function (doc) {
        var data = (doc && doc.exists) ? (doc.data() || {}) : {};
        esquemaActual = normalizarEsquema(data);
        cargado = true;
        aplicarTodo();
        return esquemaActual;
      })
      .catch(function (e) {
        console.warn('[formulario] no se pudo leer config/formulario:', e && e.message);
        esquemaActual = esquemaPorDefecto();
        cargado = true;
        aplicarTodo();
        return esquemaActual;
      });
  }

  function esquema() { return esquemaActual; }

  function camposDe(formId) {
    var f = esquemaActual.forms && esquemaActual.forms[formId];
    return f && Array.isArray(f.campos) ? f.campos : [];
  }

  function estadoDe(formId, campoId) {
    var c = camposDe(formId).filter(function (x) { return x.id === campoId; })[0];
    return c ? c.estado : 'visible';
  }

  function esVisibleEnFormulario(campo) {
    return campo.estado === 'visible' || campo.estado === 'obligatorio';
  }

  /* ─── APLICACIÓN EN EL DOM ────────────────────────────────────── */
  function contenedorDe(elemento) {
    if (!elemento) return null;
    if (typeof elemento.closest === 'function') {
      var c = elemento.closest('.field, .form-block, .set-field');
      if (c) return c;
    }
    return elemento.parentElement;
  }

  function etiquetaDe(form, campo) {
    if (!campo.domId) return null;
    var label = form.querySelector('label[for="' + campo.domId + '"]');
    if (!label) return null;
    return label;
  }

  /* Prefijo del id de los controles CREADOS por el módulo (los campos que
     el superadmin añade desde Configuración). Los campos que ya existen
     en el HTML usan su propio id (`domId`). El prefijo depende del
     formulario para que un campo con el mismo id en Registro y en Perfil
     no se pise. */
  function prefijoDe(formId) {
    return formId === 'perfil' ? 'crm_' : 'reg_';
  }

  /* Crea el control de un campo que no existía en el HTML (los campos
     añadidos desde Configuración). Se inserta antes del botón de envío. */
  function crearControl(form, campo, antesDe, prefijo) {
    var wrap = document.createElement('div');
    wrap.className = 'field';
    wrap.setAttribute('data-campo-formulario', campo.id);

    var idCtrl = (prefijo || 'reg_') + campo.id;
    var label = document.createElement('label');
    label.setAttribute('for', idCtrl);
    label.textContent = campo.etiqueta || campo.id;
    wrap.appendChild(label);

    var tipo = TIPO_INPUT[campo.tipo] || 'text';
    var control;
    if (tipo === 'textarea') {
      control = document.createElement('textarea');
      control.className = 'textarea';
      control.rows = 3;
    } else if (tipo === 'select') {
      control = document.createElement('select');
      control.className = 'select';
      var vacio = document.createElement('option');
      vacio.value = '';
      vacio.textContent = 'Selecciona…';
      control.appendChild(vacio);
      (campo.opciones || []).forEach(function (o) {
        var op = document.createElement('option');
        op.value = o;
        op.textContent = o;
        control.appendChild(op);
      });
    } else {
      control = document.createElement('input');
      control.type = tipo;
      control.className = 'input';
      if (campo.tipo === 'booleano') control.className = 'input checkbox';
    }
    control.id = idCtrl;
    control.setAttribute('data-campo-formulario', campo.id);
    if (campo.placeholder) control.placeholder = campo.placeholder;
    wrap.appendChild(control);

    if (antesDe && antesDe.parentNode) antesDe.parentNode.insertBefore(wrap, antesDe);
    else form.appendChild(wrap);
    return control;
  }

  /* Aplica los estados de los campos de un formulario a sus controles. */
  function aplicarEnFormulario(formId, form, opciones) {
    if (!form) return;
    opciones = opciones || {};
    var campos = camposDe(formId);
    var ancla = opciones.ancla || null;
    var prefijo = prefijoDe(formId);

    campos.forEach(function (campo) {
      var control = null;
      if (campo.domId) control = $(campo.domId);
      if (!control) control = crearControl(form, campo, ancla, prefijo);
      if (!control) return;

      var cont = contenedorDe(control);
      var visible = esVisibleEnFormulario(campo);

      if (cont) cont.style.display = visible ? '' : 'none';
      control.disabled = !visible;
      control.setAttribute('data-estado-formulario', campo.estado);
      control.required = campo.estado === 'obligatorio';
      if (campo.placeholder && control.tagName !== 'SELECT') control.placeholder = campo.placeholder;

      var label = etiquetaDe(form, campo);
      if (label && campo.etiqueta) label.textContent = campo.etiqueta;
    });
  }

  function aplicarRegistro() {
    var form = $('registerForm');
    if (!form) return;
    var ancla = $('btnRegister');
    aplicarEnFormulario('registro', form, { ancla: ancla });
  }

  function aplicarPerfil() {
    var form = $('crmForm');
    if (!form) return;
    var ancla = $('crmFormSave');
    aplicarEnFormulario('perfil', form, { ancla: ancla });
  }

  function aplicarTodo() {
    try { aplicarRegistro(); } catch (e) { /* el formulario puede no existir aún */ }
    try { aplicarPerfil(); } catch (e) { /* el CRM puede no estar en el DOM */ }
  }

  /* ─── VALORES Y VALIDACIÓN ────────────────────────────────────── */
  function valorDe(control) {
    if (!control) return '';
    if (control.type === 'checkbox') return control.checked ? '1' : '';
    return String(control.value || '').trim();
  }

  /* Valores de los campos que SÍ aparecen en el formulario. */
  function valores(formId) {
    var out = {};
    var prefijo = prefijoDe(formId);
    camposDe(formId).forEach(function (campo) {
      if (!esVisibleEnFormulario(campo)) return;
      var control = campo.domId ? $(campo.domId) : $(prefijo + campo.id);
      out[campo.id] = valorDe(control);
    });
    return out;
  }

  function valoresRegistro() { return valores('registro'); }
  function valoresPerfil() { return valores('perfil'); }

  /* Ids de los campos marcados como ELIMINADO: su dato debe desaparecer
     del documento al guardar. */
  function eliminados(formId) {
    return camposDe(formId)
      .filter(function (c) { return c.estado === 'eliminado'; })
      .map(function (c) { return c.id; });
  }

  function esEmailValido(v) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
  }

  /* Valida el formulario de registro con la estructura vigente.
     Devuelve { ok:true } o { ok:false, mensaje:'…' }. */
  function validarRegistro() {
    var campos = camposDe('registro');
    var prefijo = prefijoDe('registro');
    for (var i = 0; i < campos.length; i++) {
      var campo = campos[i];
      if (!esVisibleEnFormulario(campo)) continue;
      var control = campo.domId ? $(campo.domId) : $(prefijo + campo.id);
      var v = valorDe(control);
      if (campo.estado === 'obligatorio' && !v) {
        return { ok: false, mensaje: 'Completa «' + (campo.etiqueta || campo.id) + '».' };
      }
      if (campo.tipo === 'email' && v && !esEmailValido(v)) {
        return { ok: false, mensaje: 'El correo de «' + (campo.etiqueta || campo.id) + '» no es válido.' };
      }
    }
    return { ok: true };
  }

  /* ─── API ─────────────────────────────────────────────────────── */
  V.formulario = {
    ESTADOS: ESTADOS,
    TIPOS_CAMPO: TIPOS_CAMPO,
    DOC: DOC_FORMULARIO,
    COLECCION: CONFIG_COLLECTION,
    cargar: cargar,
    esquema: esquema,
    normalizar: normalizarEsquema,
    esquemaPorDefecto: esquemaPorDefecto,
    camposDe: camposDe,
    estadoDe: estadoDe,
    esVisibleEnFormulario: esVisibleEnFormulario,
    aplicarRegistro: aplicarRegistro,
    aplicarPerfil: aplicarPerfil,
    aplicarTodo: aplicarTodo,
    valores: valores,
    valoresRegistro: valoresRegistro,
    valoresPerfil: valoresPerfil,
    eliminados: eliminados,
    prefijoDe: prefijoDe,
    validarRegistro: validarRegistro,
    estaCargado: function () { return cargado; }
  };

  // El núcleo llama a este hook al abrir la pantalla de autenticación: por
  // si el superadmin cambió la estructura mientras la sesión estaba abierta.
  V.onFormularioShow = function () { aplicarTodo(); };
})();
