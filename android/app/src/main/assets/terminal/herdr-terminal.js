// Herdr Remote live terminal: renders the laptop pane's VT bytes. Render-only:
// stdin is disabled and nothing listens to onData, so the phone never answers
// terminal queries or sends mouse reports. Input goes through the app's controls.
(function () {
  'use strict';
  const element = document.getElementById('terminal');
  const term = new Terminal({
    disableStdin: true, cursorBlink: false, scrollback: 3000, fontSize: 12,
    fontFamily: 'ui-monospace, "Droid Sans Mono", "Noto Sans Mono", monospace',
    theme: { background: '#0f1115' }, allowProposedApi: false,
  });
  term.open(element);
  let cols = 80, rendered = 0, written = 0, scale = 1;
  function fit() {
    const width = Math.max(1, element.clientWidth - 8);
    // Show every column of the laptop pane: shrink the font to fit, never reflow the program.
    const size = Math.max(5, Math.min(18, Math.floor((width / cols) / 0.6 * scale)));
    if (term.options.fontSize !== size) term.options.fontSize = size;
  }
  function bytes(base64) {
    const binary = atob(base64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  const keys = {
    enter: '\r', esc: '\x1b', tab: '\t', backspace: '\x7f', 'ctrl+c': '\x03', 'ctrl+d': '\x04',
    'ctrl+z': '\x1a', 'ctrl+l': '\x0c', 'shift+tab': '\x1b[Z', home: '\x1b[H', end: '\x1b[F',
    pageup: '\x1b[5~', pagedown: '\x1b[6~', delete: '\x1b[3~',
  };
  const arrows = { up: 'A', down: 'B', right: 'C', left: 'D' };
  window.herdrTerminal = {
    reset(nextCols, nextRows) {
      cols = Math.max(2, nextCols | 0);
      term.reset(); term.resize(cols, Math.max(2, nextRows | 0));
      rendered = 0; written = 0; fit(); return true;
    },
    // `end` is the stream cursor after these bytes; it counts as rendered once xterm parsed them.
    write(base64, end) {
      written = end;
      term.write(bytes(base64), () => { if (end > rendered) rendered = end; });
      return true;
    },
    rendered() { return rendered; },
    zoom(factor) { scale = Math.max(0.5, Math.min(3, factor)); fit(); return true; },
    // The bytes a key press sends, honouring the program's cursor-key mode.
    key(name) {
      if (arrows[name]) return (term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + arrows[name];
      if (keys[name]) return keys[name];
      return /^[0-9]$/.test(name) ? name : '';
    },
  };
  window.addEventListener('resize', fit);
})();
