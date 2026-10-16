(function () {
  const STORAGE_KEY = 'a11yWidgetSettings';

  const defaultSettings = {
    contrast: false,
    invert: false,
    grayscale: false,
    blueFilter: false,
    removeImages: false,
    fontSize: 0,
    underlineLinks: false,
    readableFont: false,
    pauseAnimations: false,
    bigCursor: false,
  };

  let settings = loadSettings();
  let speaking = false;
  let currentLanguage = 'de';
  let translating = false;
  let translationRun = 0;
  let textNodesCache = null;

  function loadSettings() {
    try {
      return Object.assign(
        {},
        defaultSettings,
        JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}
      );
    } catch {
      return Object.assign({}, defaultSettings);
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      return;
    }
  }

  function applySettings() {
    const root = document.documentElement;

    root.classList.toggle('a11y-contrast', settings.contrast);
    root.classList.toggle('a11y-invert', settings.invert);
    root.classList.toggle('a11y-grayscale', settings.grayscale);
    root.classList.toggle('a11y-remove-images', settings.removeImages);
    root.classList.toggle('a11y-underline-links', settings.underlineLinks);
    root.classList.toggle('a11y-readable-font', settings.readableFont);
    root.classList.toggle('a11y-pause-animations', settings.pauseAnimations);
    root.classList.toggle('a11y-big-cursor', settings.bigCursor);
    root.style.setProperty(
      '--a11y-font-scale',
      String(1 + settings.fontSize * 0.1)
    );

    const blueFilter = document.getElementById('a11y-blue-filter');
    if (blueFilter) {
      blueFilter.hidden = !settings.blueFilter;
    }
  }

  function resetSettings() {
    translationRun += 1;
    translating = false;

    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }

    speaking = false;
    updateReadButton();

    settings = Object.assign({}, defaultSettings);
    saveSettings();
    applySettings();
    restoreOriginal();
    syncControls();
    updateLanguageButtons();
    hideTranslationProgress();
  }

  function readPage() {
    if (!('speechSynthesis' in window)) {
      alert('Vorlesen wird von diesem Browser nicht unterstützt.');
      return;
    }

    if (speaking) {
      window.speechSynthesis.cancel();
      speaking = false;
      updateReadButton();
      return;
    }

    const main = document.querySelector('#main-content, main, body');
    const utterance = new SpeechSynthesisUtterance(main.innerText);
    utterance.lang = currentLanguage === 'de'
      ? (document.documentElement.lang || 'de-DE')
      : currentLanguage;

    utterance.onend = () => {
      speaking = false;
      updateReadButton();
    };

    utterance.onerror = () => {
      speaking = false;
      updateReadButton();
    };

    window.speechSynthesis.speak(utterance);
    speaking = true;
    updateReadButton();
  }

  function updateReadButton() {
    const button = document.getElementById('a11y-read-toggle');

    if (button) {
      button.classList.toggle('active', speaking);
      button.setAttribute('aria-pressed', String(speaking));
    }
  }

  function collectTextNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue.trim()) {
          return NodeFilter.FILTER_REJECT;
        }

        const parent = node.parentElement;
        const tag = parent && parent.tagName;

        if (!tag || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(tag)) {
          return NodeFilter.FILTER_REJECT;
        }

        if (parent.closest('#a11y-panel, #a11y-toggle, #a11y-blue-filter')) {
          return NodeFilter.FILTER_REJECT;
        }

        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const nodes = [];
    let node;

    while ((node = walker.nextNode())) {
      nodes.push(node);
    }

    return nodes;
  }

  function ensureTextNodesCache() {
    if (!textNodesCache) {
      textNodesCache = collectTextNodes(document.body).map((node) => ({
        node,
        original: node.nodeValue,
      }));
    }
  }

  function restoreOriginal() {
    if (textNodesCache) {
      textNodesCache.forEach(({ node, original }) => {
        if (node.isConnected) {
          node.nodeValue = original;
        }
      });
    }

    currentLanguage = 'de';
  }

  function setTranslationProgress(label, percent, run) {
    if (run !== undefined && run !== translationRun) {
      return;
    }

    const container = document.getElementById('a11y-progress');
    const text = document.getElementById('a11y-progress-text');
    const value = document.getElementById('a11y-progress-value');
    const bar = document.getElementById('a11y-progress-bar');

    if (!container || !text || !value || !bar) {
      return;
    }

    const progress = Math.max(0, Math.min(100, Math.round(percent)));

    container.hidden = false;
    text.textContent = label;
    value.textContent = `${progress}%`;
    bar.value = progress;
  }

  function hideTranslationProgress() {
    const container = document.getElementById('a11y-progress');

    if (container) {
      container.hidden = true;
    }
  }

  async function translateViaBuiltInApi(targetLang, run) {
    const options = {
      sourceLanguage: 'de',
      targetLanguage: targetLang,
    };

    setTranslationProgress('Übersetzungsmodell wird geprüft', 0, run);

    const availability = await self.Translator.availability(options);

    if (availability === 'unavailable') {
      throw new Error('Diese Sprachkombination ist nicht verfügbar.');
    }

    if (availability === 'downloadable' || availability === 'downloading') {
      setTranslationProgress('Übersetzungsmodell wird heruntergeladen', 0, run);
    }

    const translator = await self.Translator.create({
      ...options,
      monitor(monitor) {
        monitor.addEventListener('downloadprogress', (event) => {
          setTranslationProgress(
            'Übersetzungsmodell wird heruntergeladen',
            event.loaded * 100,
            run
          );
        });
      },
    });

    try {
      const total = Math.max(textNodesCache.length, 1);

      for (let index = 0; index < textNodesCache.length; index += 1) {
        if (run !== translationRun) {
          return;
        }

        const item = textNodesCache[index];

        if (item.node.isConnected) {
          const translatedText = await translator.translate(item.original);

          if (run !== translationRun) {
            return;
          }

          item.node.nodeValue = translatedText;
        }

        setTranslationProgress(
          'Seite wird übersetzt',
          ((index + 1) / total) * 100,
          run
        );
      }

      setTranslationProgress('Übersetzung abgeschlossen', 100, run);
    } finally {
      if (typeof translator.destroy === 'function') {
        translator.destroy();
      }
    }
  }

  async function translateTo(targetLang) {
    if (targetLang === 'de') {
      translationRun += 1;
      translating = false;
      restoreOriginal();
      updateLanguageButtons();
      hideTranslationProgress();
      return;
    }

    if (translating || targetLang === currentLanguage) {
      return;
    }

    ensureTextNodesCache();
    restoreOriginal();

    const run = ++translationRun;
    translating = true;
    updateLanguageButtons(true);
    setTranslationProgress('Übersetzung wird vorbereitet', 0, run);

    try {
      if (!('Translator' in self)) {
        throw new Error('Die Translator API wird von diesem Browser nicht unterstützt.');
      }

      await translateViaBuiltInApi(targetLang, run);

      if (run === translationRun) {
        currentLanguage = targetLang;
      }
    } catch (error) {
      if (run === translationRun) {
        console.error('Übersetzung mit der Translator API fehlgeschlagen:', error);
        restoreOriginal();
        alert('Die Übersetzung ist in diesem Browser derzeit nicht verfügbar.');
      }
    } finally {
      if (run === translationRun) {
        translating = false;
        updateLanguageButtons();
        hideTranslationProgress();
      }
    }
  }

  function updateLanguageButtons(loading) {
    document.querySelectorAll('[data-lang]').forEach((button) => {
      const isActive = button.dataset.lang === currentLanguage;

      button.classList.toggle('active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
      button.disabled = Boolean(loading);
    });
  }

  const icons = {
    access: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><circle cx="12" cy="4" r="2"/><path d="M12 7c-4 0-7 1-7 3v2h4v9h2v-6h2v6h2v-9h4V10c0-2-3-3-7-3z"/></svg>',
    contrast: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2a10 10 0 100 20V2z"/><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
    invert: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10V2z"/></svg>',
    grayscale: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5c-1.7-4.4-6-7.5-11-7.5zm0 12.5a5 5 0 110-10 5 5 0 010 10z"/></svg>',
    blueFilter: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 2v16a8 8 0 010-16z"/></svg>',
    removeImages: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="M21 15l-5-5-8 8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 3l18 18" stroke="currentColor" stroke-width="2"/></svg>',
    link: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M3.9 12a4 4 0 014-4h3v1.5h-3a2.5 2.5 0 000 5h3V16h-3a4 4 0 01-4-4zm5-.75h6.2v1.5H8.9v-1.5zM14 8h3a4 4 0 010 8h-3v-1.5h3a2.5 2.5 0 000-5h-3V8z"/></svg>',
    font: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M9.93 13.5h4.14L12 7.98zM11 4h2l5.5 16h-2.2l-1.4-4h-6.8l-1.4 4H4.5L10 4h1z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></svg>',
    cursor: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M4 2l14 7-6 2-2 6-6-15z"/></svg>',
    volume: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M5 9v6h4l5 5V4l-5 5H5zm11.5 3a4.5 4.5 0 00-2.5-4v8a4.5 4.5 0 002.5-4z"/></svg>',
    flagDE: '<svg viewBox="0 0 30 20" width="24" height="16"><rect width="30" height="20" fill="#000"/><rect y="6.67" width="30" height="6.67" fill="#D00"/><rect y="13.33" width="30" height="6.67" fill="#FFCE00"/></svg>',
    flagEN: '<svg viewBox="0 0 30 20" width="24" height="16"><rect width="30" height="20" fill="#00247d"/><path d="M0 0L30 20M30 0L0 20" stroke="#fff" stroke-width="3"/><path d="M0 0L30 20M30 0L0 20" stroke="#cf142b" stroke-width="1.5"/><path d="M15 0V20M0 10H30" stroke="#fff" stroke-width="5"/><path d="M15 0V20M0 10H30" stroke="#cf142b" stroke-width="2.5"/></svg>',
    flagFR: '<svg viewBox="0 0 30 20" width="24" height="16"><rect width="10" height="20" fill="#0055A4"/><rect x="10" width="10" height="20" fill="#fff"/><rect x="20" width="10" height="20" fill="#EF4135"/></svg>',
  };

  function optionButton(key, iconSvg, label) {
    return `
      <button type="button" class="a11y-option" data-setting="${key}" aria-pressed="false">
        ${iconSvg}
        <span>${label}</span>
      </button>`;
  }

  function languageButton(lang, flagSvg, label) {
    return `
      <button
        type="button"
        class="a11y-languages__btn"
        data-lang="${lang}"
        aria-label="${label}"
        aria-pressed="false"
        title="${label}"
      >
        ${flagSvg}
      </button>`;
  }

  function buildWidget() {
    if (document.getElementById('a11y-toggle')) {
      return;
    }

    const toggle = document.createElement('button');
    toggle.id = 'a11y-toggle';
    toggle.type = 'button';
    toggle.setAttribute('aria-label', 'Barrierefreiheit-Einstellungen öffnen');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', 'a11y-panel');
    toggle.innerHTML = icons.access;

    const blueFilter = document.createElement('div');
    blueFilter.id = 'a11y-blue-filter';
    blueFilter.setAttribute('aria-hidden', 'true');

    const panel = document.createElement('div');
    panel.id = 'a11y-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Barrierefreiheit-Einstellungen');
    panel.hidden = true;

    panel.innerHTML = `
      <h2 class="a11y-title">Barrierefreiheit</h2>
      <div class="a11y-grid">
        ${optionButton('contrast', icons.contrast, 'Kontrast erhöhen')}
        ${optionButton('invert', icons.invert, 'Farben invertieren')}
        ${optionButton('grayscale', icons.grayscale, 'Graustufen')}
        ${optionButton('blueFilter', icons.blueFilter, 'Blaufilter aktivieren')}
        ${optionButton('removeImages', icons.removeImages, 'Bilder entfernen')}
        ${optionButton('underlineLinks', icons.link, 'Links unterstreichen')}
        ${optionButton('readableFont', icons.font, 'Lesbare Schrift')}
        ${optionButton('pauseAnimations', icons.pause, 'Animationen stoppen')}
        ${optionButton('bigCursor', icons.cursor, 'Großer Cursor')}
        <button type="button" id="a11y-read-toggle" class="a11y-option" aria-pressed="false">
          ${icons.volume}
          <span>Vorlesen</span>
        </button>
      </div>
      <div class="a11y-fontsize">
        <span class="a11y-fontsize__label">Textgröße</span>
        <div class="a11y-fontsize__controls">
          <button type="button" id="a11y-font-minus" class="a11y-fontsize__btn" aria-label="Schrift verkleinern">A−</button>
          <span id="a11y-font-value" class="a11y-fontsize__value" aria-live="polite">100%</span>
          <button type="button" id="a11y-font-plus" class="a11y-fontsize__btn" aria-label="Schrift vergrößern">A+</button>
        </div>
      </div>
      <div class="a11y-languages">
        <span class="a11y-languages__label">Sprache</span>
        <div class="a11y-languages__controls">
          ${languageButton('de', icons.flagDE, 'Deutsch')}
          ${languageButton('en', icons.flagEN, 'Englisch')}
          ${languageButton('fr', icons.flagFR, 'Französisch')}
        </div>
      </div>
      <div id="a11y-progress" class="a11y-progress" role="status" aria-live="polite" hidden>
        <div class="a11y-progress__label">
          <span id="a11y-progress-text">Übersetzung wird vorbereitet</span>
          <span id="a11y-progress-value">0%</span>
        </div>
        <progress id="a11y-progress-bar" max="100" value="0" aria-label="Übersetzungsfortschritt"></progress>
      </div>
      <button type="button" id="a11y-reset">Zurücksetzen</button>
    `;

    document.documentElement.append(blueFilter, toggle, panel);

    toggle.addEventListener('click', () => {
      const isOpen = !panel.hidden;
      panel.hidden = isOpen;
      toggle.setAttribute('aria-expanded', String(!isOpen));
      toggle.setAttribute(
        'aria-label',
        isOpen
          ? 'Barrierefreiheit-Einstellungen öffnen'
          : 'Barrierefreiheit-Einstellungen schließen'
      );

      if (!isOpen) {
        panel.querySelector('button')?.focus();
      }
    });

    panel.querySelectorAll('[data-setting]').forEach((button) => {
      button.addEventListener('click', () => {
        const key = button.dataset.setting;
        settings[key] = !settings[key];
        saveSettings();
        applySettings();
        syncControls();
      });
    });

    panel.querySelectorAll('[data-lang]').forEach((button) => {
      button.addEventListener('click', () => translateTo(button.dataset.lang));
    });

    document.getElementById('a11y-read-toggle').addEventListener('click', readPage);
    document.getElementById('a11y-font-minus').addEventListener('click', () => changeFontSize(-1));
    document.getElementById('a11y-font-plus').addEventListener('click', () => changeFontSize(1));
    document.getElementById('a11y-reset').addEventListener('click', resetSettings);

    document.addEventListener('click', (event) => {
      if (
        !panel.hidden &&
        !panel.contains(event.target) &&
        !toggle.contains(event.target)
      ) {
        panel.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('aria-label', 'Barrierefreiheit-Einstellungen öffnen');
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !panel.hidden) {
        panel.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('aria-label', 'Barrierefreiheit-Einstellungen öffnen');
        toggle.focus();
      }
    });

    syncControls();
    updateLanguageButtons();
  }

  function changeFontSize(delta) {
    settings.fontSize = Math.max(-2, Math.min(6, settings.fontSize + delta));
    saveSettings();
    applySettings();
    updateFontValue();
  }

  function updateFontValue() {
    const element = document.getElementById('a11y-font-value');

    if (element) {
      element.textContent =
        `${Math.round((1 + settings.fontSize * 0.1) * 100)}%`;
    }
  }

  function syncControls() {
    document.querySelectorAll('[data-setting]').forEach((button) => {
      const key = button.dataset.setting;
      const isActive = Boolean(settings[key]);

      button.classList.toggle('active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    });

    updateFontValue();
  }

  function initialize() {
    buildWidget();
    applySettings();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }
})();