/* ChatGPT Thread Reader — one owner for discovery, playback, and the floating panel. */
(() => {
  'use strict';
  if (window.__THREAD_READER_INSTALLED__) return;
  window.__THREAD_READER_INSTALLED__ = true;

  const DEMO = window.__THREAD_READER_DEMO__ === true;
  const OPEN_KEY = 'thread-reader:visible';
  const DEFAULTS = Object.freeze({mode: 'extension', rate: 1.0, autoNext: true});
  const SPEAKABLE = 'h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,th,td';
  const state = {
    ...DEFAULTS, open: false, items: [], index: -1, playing: false, paused: false,
    activeElement: null, segments: [], segmentIndex: 0, generation: 0,
    nativeTurn: null, nativePlaying: false, restartOnPlay: false, refreshTimer: null
  };

  const root = document.createElement('section');
  root.id = 'thread-reader-root';
  root.setAttribute('aria-label', 'ChatGPT Thread Reader');
  root.hidden = true;
  root.innerHTML = `
    <div class="tr-header" id="tr-drag-handle">
      <div class="tr-brand"><span class="tr-dot" aria-hidden="true"></span><strong>Thread Reader</strong></div>
      <button class="tr-close" data-action="close" aria-label="Hide reader" title="Hide reader">×</button>
    </div>
    <div class="tr-body">
      <div class="tr-position"><span data-field="position">— / —</span><span class="tr-active-label" data-field="activity">Ready</span></div>
      <p class="tr-current-excerpt" data-field="excerpt" aria-live="polite">Find a response to begin.</p>
      <div class="tr-transport" role="group" aria-label="Reading controls">
        <button data-action="previous" title="Previous response" aria-label="Previous response"><span aria-hidden="true">⏮</span><small>Previous</small></button>
        <button data-action="play" title="Play or resume" aria-label="Play"><span aria-hidden="true">▶</span><small>Play</small></button>
        <button data-action="pause" title="Pause" aria-label="Pause"><span aria-hidden="true">Ⅱ</span><small>Pause</small></button>
        <button data-action="next" title="Next response" aria-label="Next response"><span aria-hidden="true">⏭</span><small>Next</small></button>
      </div>
      <div class="tr-settings">
        <label class="tr-label" for="tr-mode">Audio source</label>
        <select id="tr-mode" data-setting="mode">
          <option value="extension">Extension voice · adjustable</option>
          <option value="native">ChatGPT Read Aloud · experimental</option>
        </select>
        <div class="tr-speed-head"><label class="tr-label" for="tr-rate">Speed</label><output data-field="rate">1.0×</output></div>
        <input id="tr-rate" data-setting="rate" type="range" min="0.6" max="2" step="0.1" value="1" aria-label="Playback speed">
        <label class="tr-autonext"><input data-setting="autoNext" type="checkbox" checked> Continue to next response</label>
      </div>
      <p class="tr-status" data-field="status" role="status" aria-live="polite">Choose a response, then press Play.</p>
      <div class="tr-footer"><button data-action="refresh" title="Find current responses">↻ Refresh responses</button><span>ChatGPT responses</span></div>
    </div>`;
  // The page-owned launcher is the fallback activation path: it is available
  // whenever the matched content script is installed, even if the toolbar
  // service worker or Chrome keyboard command does not run.
  const launcher = document.createElement('button');
  launcher.id = 'thread-reader-launcher';
  launcher.type = 'button';
  launcher.textContent = 'Reader';
  launcher.setAttribute('aria-label', 'Show ChatGPT Thread Reader');
  launcher.setAttribute('aria-controls', 'thread-reader-root');
  document.body.append(root, launcher);

  const $ = selector => root.querySelector(selector);
  const statusEl = $('[data-field="status"]');
  function status(message) { statusEl.textContent = message; }
  function persist(key, value) {
    if (DEMO || !globalThis.chrome?.storage?.local) return;
    chrome.storage.local.set({[key]: value});
  }
  function setOpen(open) {
    state.open = Boolean(open);
    root.hidden = !state.open;
    launcher.hidden = state.open;
    launcher.setAttribute('aria-expanded', String(state.open));
    try { sessionStorage.setItem(OPEN_KEY, String(state.open)); } catch (_) { /* storage disabled */ }
    if (state.open) refresh(true);
    else stop(true);
  }

  launcher.addEventListener('click', () => setOpen(true));

  // A single response model for legacy ChatGPT and the newer Chat/Work shell.
  // The new UI may omit both data-message-author-role and article wrappers.
  const ASSISTANT_MARKERS = [
    '[data-message-author-role="assistant"]',
    '[data-message-role="assistant"]',
    '[data-role="assistant"]',
    '[data-message-author="assistant"]',
    '[data-content-search-unit-key$=":assistant"]',
    '[data-chatgpt-search-unit-key$=":assistant"]',
    '[data-markdown-text-style="assistant-message"]'
  ].join(',');
  const RESPONSE_CONTENT = '[data-markdown-text-style="assistant-message"], [data-testid="message-content"], .markdown, .prose, [class*="markdown"], [class*="MarkdownRoot"]';
  const TURN_CONTAINERS = '[data-turn-key], [data-testid^="conversation-turn"], [data-content-search-turn-key], article[data-turn-id], article';

  function getResponses() {
    const turns = [];
    const seen = new Set();
    const conversation = document.querySelector('main') || document;
    for (const marker of conversation.querySelectorAll(ASSISTANT_MARKERS)) {
      if (root.contains(marker) || launcher.contains(marker)) continue;
      // Only assistant-authorized markers are permitted. Never read the user
      // bubble, sidebar or composer by falling back to broad page text.
      const turn = marker.closest(TURN_CONTAINERS) || marker;
      if (seen.has(turn)) continue;
      const body = marker.matches(RESPONSE_CONTENT)
        ? marker
        : marker.querySelector(RESPONSE_CONTENT) || marker;
      if (!meaningfulText(body)) continue;
      seen.add(turn);
      turns.push({turn, body, message: marker});
    }
    return turns;
  }

  function removeHighlight() {
    if (state.activeElement?.isConnected) state.activeElement.removeAttribute('data-thread-reader-speaking');
    state.activeElement = null;
    document.querySelectorAll('[data-thread-reader-current]').forEach(el => el.removeAttribute('data-thread-reader-current'));
  }
  function updatePosition(scroll = false) {
    state.items.forEach((item, i) => {
      if (i === state.index) item.turn.setAttribute('data-thread-reader-current', 'true');
      else item.turn.removeAttribute('data-thread-reader-current');
    });
    $('[data-field="position"]').textContent = state.index < 0 ? `0 / ${state.items.length}` : `${state.index + 1} / ${state.items.length}`;
    const current = state.items[state.index];
    $('[data-field="excerpt"]').textContent = current
      ? (meaningfulText(current.body).slice(0, 150) || 'No readable text')
      : 'No assistant response selected.';
    $('[data-action="previous"]').disabled = state.index <= 0;
    $('[data-action="next"]').disabled = state.index < 0 || state.index >= state.items.length - 1;
    $('[data-action="play"]').disabled = state.index < 0;
    $('[data-action="pause"]').disabled = !state.playing || state.paused;
    $('[data-field="activity"]').textContent = state.paused ? 'Paused' : state.playing ? 'Reading' : 'Ready';
    if (scroll && state.items[state.index]) state.items[state.index].turn.scrollIntoView({block: 'start', behavior: 'smooth'});
  }

  function refresh(keepSelection = true) {
    const selected = keepSelection ? state.items[state.index] : null;
    const oldIndex = state.index;
    state.items = getResponses();
    const same = selected && state.items.findIndex(item => item.turn === selected.turn);
    if (state.items.length === 0) state.index = -1;
    else if (same !== null && same !== undefined && same >= 0) state.index = same;
    else if (oldIndex >= 0) state.index = Math.min(oldIndex, state.items.length - 1);
    else {
      // Start at the response the reader is already looking at, not at the
      // beginning of a long conversation whenever the panel opens.
      const focalY = window.innerHeight * 0.35;
      let closest = Infinity;
      state.index = 0;
      state.items.forEach((item, index) => {
        const rect = item.turn.getBoundingClientRect();
        const distance = rect.bottom < 0 ? Math.abs(rect.bottom - focalY) :
          rect.top > window.innerHeight ? Math.abs(rect.top - focalY) :
          Math.abs(Math.max(rect.top, 0) - focalY);
        if (distance < closest) { closest = distance; state.index = index; }
      });
    }
    if (state.playing && selected && state.items[state.index]?.turn !== selected.turn) stop(true);
    updatePosition(false);
    if (state.items.length === 0) status('No assistant responses detected. ChatGPT may be loading or using an unsupported layout.');
  }

  function meaningfulText(element) {
    return (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
  }
  function splitText(text, maxLength = 230) {
    const sentences = text.match(/[^.!?]+(?:[.!?]+|$)/g) || [text];
    const chunks = [];
    let buffer = '';
    for (const sentence of sentences) {
      const words = sentence.trim().split(/\s+/).filter(Boolean);
      for (const word of words) {
        if (buffer && `${buffer} ${word}`.length > maxLength) {
          chunks.push(buffer); buffer = '';
        }
        if (word.length > maxLength) {
          if (buffer) { chunks.push(buffer); buffer = ''; }
          for (let p = 0; p < word.length; p += maxLength) chunks.push(word.slice(p, p + maxLength));
        } else buffer = buffer ? `${buffer} ${word}` : word;
      }
    }
    if (buffer) chunks.push(buffer);
    return chunks;
  }
  function segmentsFor(body) {
    const blocks = [...body.querySelectorAll(SPEAKABLE)].filter(el =>
      !el.closest('button,[role="toolbar"],[aria-hidden="true"],script,style') &&
      !el.querySelector(SPEAKABLE) && meaningfulText(el)
    );
    const sources = blocks.length ? blocks : [body];
    return sources.flatMap(element => splitText(meaningfulText(element)).map(text => ({element, text})));
  }
  function keepInView(element) {
    const rect = element.getBoundingClientRect();
    const panelRect = root.getBoundingClientRect();
    const overlapsHorizontally = rect.left < panelRect.right && rect.right > panelRect.left;
    const panelCoversBottom = overlapsHorizontally && panelRect.top > window.innerHeight * 0.4;
    const safeTop = 80;
    const safeBottom = panelCoversBottom ? panelRect.top - 16 : window.innerHeight - 72;
    // Starting near the top leaves the most text visible even on phones with
    // a bottom-docked controller. scrollIntoView handles ChatGPT scroll panes.
    if (rect.top < safeTop || rect.top > safeBottom || rect.bottom > safeBottom) {
      element.scrollIntoView({block: 'start', behavior: 'smooth'});
    }
  }
  function highlight(element) {
    if (state.activeElement !== element) {
      if (state.activeElement?.isConnected) state.activeElement.removeAttribute('data-thread-reader-speaking');
      element.setAttribute('data-thread-reader-speaking', 'true');
      state.activeElement = element;
    }
    keepInView(element);
  }

  function stop(silent = false) {
    state.generation++;
    let stopped = true;
    if (state.mode === 'extension') window.speechSynthesis?.cancel();
    if (state.mode === 'native' && state.nativePlaying) stopped = nativeStop();
    state.playing = false; state.paused = false; state.restartOnPlay = false; state.segments = []; state.segmentIndex = 0;
    removeHighlight(); updatePosition(false);
    if (!silent) status(stopped ? 'Stopped. Press Play to read this response.' :
      'Could not stop ChatGPT audio automatically. Stop it in ChatGPT before playing another response.');
    return stopped;
  }
  function select(index, read = false) {
    if (index < 0 || index >= state.items.length) return;
    const stopped = stop(true);
    state.index = index;
    updatePosition(true);
    status(`Response ${index + 1} selected.`);
    if (read && stopped) play();
    else if (read && !stopped) status('Stop ChatGPT audio in its controls before reading another response.');
  }

  function speakSegment(generation) {
    if (generation !== state.generation || !state.playing || state.paused) return;
    if (state.segmentIndex >= state.segments.length) {
      state.playing = false; removeHighlight(); updatePosition(false);
      if (state.autoNext && state.index < state.items.length - 1) {
        select(state.index + 1, true);
      } else status('Finished reading.');
      return;
    }
    const segment = state.segments[state.segmentIndex];
    highlight(segment.element);
    const utterance = new SpeechSynthesisUtterance(segment.text);
    utterance.rate = state.rate;
    utterance.lang = document.documentElement.lang || navigator.language || 'en-US';
    utterance.onend = () => {
      if (generation !== state.generation) return;
      state.segmentIndex += 1;
      speakSegment(generation);
    };
    utterance.onerror = event => {
      if (generation !== state.generation) return;
      state.playing = false; state.paused = false;
      removeHighlight(); updatePosition(false);
      status(`Speech could not play (${event.error || 'voice unavailable'}). Try another Chrome voice.`);
    };
    window.speechSynthesis.speak(utterance);
    status(`Reading response ${state.index + 1} of ${state.items.length}.`);
  }
  function startExtension() {
    if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
      status('This browser does not support speech synthesis.'); return;
    }
    if (state.playing && state.paused) {
      state.paused = false;
      if (state.restartOnPlay) {
        state.restartOnPlay = false;
        speakSegment(state.generation);
      } else window.speechSynthesis.resume();
      updatePosition(false); status('Resumed.'); return;
    }
    if (state.playing) return;
    state.segments = segmentsFor(state.items[state.index].body);
    if (!state.segments.length) { status('This response has no readable text.'); return; }
    state.playing = true; state.paused = false; state.segmentIndex = 0;
    state.generation++;
    const generation = state.generation;
    window.speechSynthesis.cancel();
    updatePosition(false);
    speakSegment(generation);
  }
  function pause() {
    if (!state.playing || state.paused) return;
    if (state.mode === 'native') {
      const target = findControl(state.nativeTurn, /^(pause|pause audio|pause read aloud)$/i);
      if (!target) { status('ChatGPT Pause not available here. Switch to Extension voice for reliable pause and speed.'); return; }
      target.click();
    } else window.speechSynthesis.pause();
    state.paused = true; updatePosition(false); status('Paused.');
  }

  function findControl(scope, expression) {
    if (!scope) return null;
    return [...scope.querySelectorAll('button,[role="button"],[role="menuitem"]')].find(el => {
      const name = (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('data-testid') || el.textContent || '').trim();
      return expression.test(name);
    }) || null;
  }
  function nativeStop() {
    const stopButton = findControl(state.nativeTurn, /^(stop|stop audio|stop reading|stop read aloud)$/i) ||
      findControl(document, /^(stop read aloud|stop audio)$/i);
    if (!stopButton) return false;
    stopButton.click();
    state.nativePlaying = false;
    state.nativeTurn = null;
    return true;
  }
  async function startNative() {
    const item = state.items[state.index];
    const generation = ++state.generation;
    const resume = findControl(item.turn, /^(resume|resume audio|resume read aloud|play audio)$/i);
    if (resume && state.paused) {
      resume.click(); state.paused = false; state.playing = true;
      updatePosition(false); status('Resumed ChatGPT Read Aloud.'); return;
    }
    let control = findControl(item.turn, /^(read aloud|read aloud response|listen|listen to response)$/i);
    if (!control) {
      const menu = findControl(item.turn, /^(more|more actions|more options|open menu)$/i);
      if (menu) {
        menu.click();
        for (let tryCount = 0; tryCount < 10 && !control; tryCount++) {
          await new Promise(resolve => setTimeout(resolve, 90));
          if (generation !== state.generation) return;
          control = findControl(document, /^(read aloud|read aloud response|listen|listen to response)$/i);
        }
      }
    }
    if (generation !== state.generation) return;
    if (!control) {
      status('ChatGPT Read Aloud was not found. Use Extension voice, or update this extension if ChatGPT changed its controls.');
      return;
    }
    control.click();
    state.nativeTurn = item.turn;
    state.nativePlaying = true; state.playing = true; state.paused = false;
    updatePosition(false);
    status('ChatGPT Read Aloud started. Speed and automatic completion are unavailable in this mode.');
  }
  function play() {
    if (state.index < 0) return;
    if (state.mode === 'native') {
      if (state.playing && !state.paused) return;
      void startNative(); return;
    }
    startExtension();
  }
  function setMode(mode) {
    if (mode !== 'extension' && mode !== 'native') return;
    stop(true);
    state.mode = mode;
    persist('threadReader:mode', mode);
    $('[data-setting="mode"]').value = mode;
    $('[data-setting="rate"]').disabled = mode === 'native';
    status(mode === 'native' ? 'ChatGPT control mode: availability depends on ChatGPT’s page buttons.' : 'Extension voice: speed, pause, and auto-advance enabled.');
  }
  function setRate(value) {
    state.rate = Math.round(Math.max(0.6, Math.min(2, Number(value) || 1)) * 10) / 10;
    $('[data-setting="rate"]').value = String(state.rate);
    $('[data-field="rate"]').textContent = `${state.rate.toFixed(1)}×`;
    persist('threadReader:rate', state.rate);
    if (state.mode === 'extension' && state.playing) {
      const wasPaused = state.paused;
      state.generation++;
      window.speechSynthesis.cancel();
      state.paused = wasPaused;
      state.restartOnPlay = wasPaused;
      if (!wasPaused) speakSegment(state.generation);
      else status('Speed saved. Play will restart the current passage at the new speed.');
    }
  }

  root.addEventListener('click', event => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'close') setOpen(false);
    if (action === 'play') play();
    if (action === 'pause') pause();
    if (action === 'previous') select(state.index - 1, state.playing && !state.paused);
    if (action === 'next') select(state.index + 1, state.playing && !state.paused);
    if (action === 'refresh') { refresh(true); status(`${state.items.length} assistant responses found.`); }
  });
  $('[data-setting="mode"]').addEventListener('change', event => setMode(event.target.value));
  $('[data-setting="rate"]').addEventListener('input', event => setRate(event.target.value));
  $('[data-setting="autoNext"]').addEventListener('change', event => {
    state.autoNext = event.target.checked;
    persist('threadReader:autoNext', state.autoNext);
  });

  // Desktop drag is limited to the existing panel, never the ChatGPT conversation.
  const handle = $('#tr-drag-handle');
  let drag = null;
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('button') || matchMedia('(max-width: 600px)').matches) return;
    drag = {id: event.pointerId, x: event.clientX, y: event.clientY, left: root.getBoundingClientRect().left, top: root.getBoundingClientRect().top};
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    const rect = root.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - rect.width - 8, drag.left + event.clientX - drag.x));
    const top = Math.max(8, Math.min(window.innerHeight - 120, drag.top + event.clientY - drag.y));
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;
    root.style.right = 'auto'; root.style.bottom = 'auto';
  });
  const endDrag = () => { drag = null; };
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);

  // Observe ChatGPT SPA changes, but ignore mutations owned by this panel.
  const observer = new MutationObserver(mutations => {
    if (!state.open) return;
    if (!mutations.some(mutation => !root.contains(mutation.target))) return;
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(() => refresh(true), 200);
  });
  observer.observe(document.body, {subtree: true, childList: true});

  if (globalThis.chrome?.runtime?.onMessage && !DEMO) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === 'THREAD_READER_TOGGLE') setOpen(!state.open);
      else if (message?.type === 'THREAD_READER_SHOW') setOpen(true);
      else return false;
      sendResponse({ok: true, open: state.open, responses: state.items.length});
      return false;
    });
  }
  if (DEMO) {
    setOpen(true);
    window.__THREAD_READER_TEST__ = {state, refresh, select, play, pause, stop, setRate, setMode, setOpen, segmentsFor};
  } else {
    try { if (sessionStorage.getItem(OPEN_KEY) === 'true') setOpen(true); } catch (_) { /* ignore */ }
    chrome.storage?.local?.get(['threadReader:mode', 'threadReader:rate', 'threadReader:autoNext'], values => {
      if (values['threadReader:mode']) setMode(values['threadReader:mode']);
      if (values['threadReader:rate']) setRate(values['threadReader:rate']);
      if (typeof values['threadReader:autoNext'] === 'boolean') {
        state.autoNext = values['threadReader:autoNext'];
        $('[data-setting="autoNext"]').checked = state.autoNext;
      }
    });
  }
})();
