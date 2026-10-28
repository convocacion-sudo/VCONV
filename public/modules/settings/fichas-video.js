/* ════════════════════════════════════════════════════════════════
   VCONV · Bloque de vídeo del editor de fichas (independiente)

   Selector MANUAL de plataforma + una única entrada para el enlace o
   el embed. No hay autodetección: si no se elige plataforma, el vídeo
   no se puede guardar ni previsualizar.

   API: V.fichasVideo.bloque(parent, { plataforma, url }, galeria)
        V.fichasVideo.normalizar(plataforma, raw) → URL limpia o ''
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var V = window.VCONV;
  if (!V) { console.error('VCONV core not loaded'); return; }
  if (!V.video) { console.error('VCONV video core not loaded'); return; }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function acortar(url) {
    return url.length > 58 ? url.slice(0, 55) + '…' : url;
  }

  function bloque(parent, actual, galeria) {
    actual = actual || {};
    var block = el('div', 'set-video-block');

    var head = el('div', 'set-video-head');
    var titles = el('div', 'set-video-head-text');
    titles.appendChild(el('h4', 'set-video-title', 'Vídeo de la ficha'));
    titles.appendChild(el('p', 'set-help', 'Opcional. Elige la plataforma y pega su enlace o embed; no se adivina automáticamente.'));
    head.appendChild(titles);
    block.appendChild(head);

    var body = el('div', 'set-video-body');
    var preview = el('div', 'set-video-preview');
    body.appendChild(preview);

    var fields = el('div', 'set-video-fields');

    var platformField = el('div', 'set-field');
    platformField.appendChild(el('label', 'set-label', 'Plataforma'));
    var select = document.createElement('select');
    select.className = 'select set-video-platform';
    var none = document.createElement('option');
    none.value = '';
    none.textContent = 'Selecciona una plataforma…';
    select.appendChild(none);
    V.video.plataformas().forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.label;
      select.appendChild(opt);
    });
    select.value = V.video.normalizarPlataforma(actual.plataforma);
    platformField.appendChild(select);
    fields.appendChild(platformField);

    var urlField = el('div', 'set-field');
    urlField.appendChild(el('label', 'set-label', 'Enlace o código embed'));
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'input';
    input.value = actual.url || '';
    input.autocomplete = 'off';
    input.spellcheck = false;
    urlField.appendChild(input);
    var hint = el('p', 'set-help');
    urlField.appendChild(hint);
    var status = el('p', 'set-video-status');
    urlField.appendChild(status);
    fields.appendChild(urlField);

    body.appendChild(fields);
    block.appendChild(body);

    var btnQuitar = el('button', 'btn-outline btn-sm', '✕ Quitar');
    btnQuitar.type = 'button';
    btnQuitar.addEventListener('click', function () {
      select.value = '';
      input.value = '';
      pintar();
      select.focus();
    });
    head.appendChild(btnQuitar);

    if (galeria && galeria.length) {
      var gallery = el('div', 'set-video-gallery');
      gallery.appendChild(el('p', 'set-label', 'Vídeos ya usados en otras fichas'));
      var chips = el('div', 'set-video-chips');
      galeria.forEach(function (item) {
        var id = V.video.normalizarPlataforma(item && item.plataforma);
        var url = id ? V.video.normalizar(id, item.url) : '';
        if (!url) return;
        var chip = el('button', 'set-video-chip');
        chip.type = 'button';
        chip.title = V.video.etiqueta(id) + ' · ' + item.url;
        chip.appendChild(el('span', 'set-video-chip-label', '🎬 ' + V.video.etiqueta(id)));
        chip.appendChild(el('small', 'set-video-chip-url', acortar(item.url)));
        chip.addEventListener('click', function () {
          select.value = id;
          input.value = item.url;
          pintar();
          input.focus();
        });
        chips.appendChild(chip);
      });
      if (chips.childNodes.length) {
        gallery.appendChild(chips);
        block.appendChild(gallery);
      }
    }

    function actualizarPista() {
      var def = V.video.plataformaDe(select.value);
      input.placeholder = def ? def.placeholder : 'Elige primero una plataforma';
      hint.textContent = def
        ? def.ayuda
        : 'Selecciona la plataforma del vídeo para activar el enlace.';
    }

    function pintar() {
      var id = V.video.normalizarPlataforma(select.value);
      var raw = String(input.value || '').trim();
      preview.className = 'set-video-preview';
      preview.innerHTML = '';
      status.className = 'set-video-status';
      status.textContent = '';
      btnQuitar.disabled = !id && !raw;
      actualizarPista();

      if (!id && !raw) {
        preview.classList.add('is-empty');
        preview.appendChild(el('span', 'set-video-empty', '🎬 Sin vídeo seleccionado'));
        return;
      }
      if (!id) {
        preview.classList.add('is-empty');
        preview.appendChild(el('span', 'set-video-empty', 'Selecciona una plataforma'));
        status.textContent = 'Elige la plataforma antes de pegar el enlace.';
        status.classList.add('is-error');
        return;
      }
      if (!raw) {
        preview.classList.add('is-empty');
        preview.appendChild(el('span', 'set-video-empty', 'Pega el enlace de ' + V.video.etiqueta(id)));
        return;
      }

      var url = V.video.normalizar(id, raw);
      if (!url) {
        preview.classList.add('is-error');
        preview.appendChild(el('p', 'field-hint is-warn', 'Enlace no válido para ' + V.video.etiqueta(id) + '.'));
        status.textContent = 'Revisa el enlace de ' + V.video.etiqueta(id) + ': no se ha podido preparar el reproductor.';
        status.classList.add('is-error');
        return;
      }

      V.video.montar(preview, id, url, {
        alt: 'Vista previa del vídeo',
        clase: 'set-video-preview-el'
      });
      status.textContent = '✓ ' + V.video.etiqueta(id) + ' · se mostrará en la tarjeta publicada.';
      status.classList.add('is-ok');
    }

    var timer = null;
    function programar() {
      clearTimeout(timer);
      timer = setTimeout(pintar, 450);
    }

    select.addEventListener('change', pintar);
    input.addEventListener('input', programar);
    input.addEventListener('change', pintar);
    input.addEventListener('blur', pintar);
    pintar();
    parent.appendChild(block);

    return { select: select, input: input, pintar: pintar };
  }

  function normalizar(plataforma, raw) {
    return V.video ? V.video.normalizar(plataforma, raw) : '';
  }

  function normalizarPlataforma(raw) {
    return V.video ? V.video.normalizarPlataforma(raw) : '';
  }

  V.fichasVideo = {
    bloque: bloque,
    normalizar: normalizar,
    normalizarPlataforma: normalizarPlataforma
  };
})();
