/* Static markup in index.html declares its event handlers as
   data-on<event>="…" attributes, because the Content-Security-Policy forbids
   inline on<event> handlers. This binds them once, at startup.

   It never evaluates code. A tiny parser accepts only the statement forms the
   markup uses, and calls global functions by name with literal arguments:

     fn()  fn('text', 1, true, null)  fn(event)  fn(this.checked)
     a(); b()                          return fn(event)   return false
     if(event.target===this) fn()      if(event.key==='Enter') fn()
     document.getElementById('id').click()
     this.parentElement.hidden=true    event.stopPropagation()

   Only elements present when this runs are bound, so markup inserted later
   (book metadata, EPUB content) can never gain behaviour from these attributes. */
(() => {
  const EVENTS = ['click', 'change', 'input', 'keydown', 'submit'];
  const IDENT = '[A-Za-z_$][\\w$]*';
  const CALL_RE = new RegExp(`^(${IDENT})\\((.*)\\)$`);
  const CLICK_BY_ID_RE = /^document\.getElementById\('([^']+)'\)\.click\(\)$/;
  const TARGET_GUARD_RE = /^if\s*\(\s*event\.target\s*===\s*this\s*\)\s*(.+)$/;
  const KEY_GUARD_RE = /^if\s*\(\s*event\.key\s*===\s*'([^']+)'\s*\)\s*(.+)$/;

  function compileArgument(token) {
    if (token === 'event') return (event) => event;
    if (token === 'this.checked') return (event, element) => element.checked;
    if (token === 'this.value') return (event, element) => element.value;
    if (token === 'true') return () => true;
    if (token === 'false') return () => false;
    if (token === 'null') return () => null;
    if (/^-?\d+(?:\.\d+)?$/.test(token)) { const value = Number(token); return () => value; }
    const text = /^'([^']*)'$/.exec(token);
    if (text) return () => text[1];
    throw new Error(`Unsupported argument: ${token}`);
  }

  function compileCall(source) {
    const match = CALL_RE.exec(source);
    if (!match) return null;
    const [, name, argSource] = match;
    const args = argSource.trim() ? argSource.split(',').map(token => compileArgument(token.trim())) : [];
    return (event, element) => {
      const fn = globalThis[name];
      if (typeof fn !== 'function') throw new Error(`Unknown handler: ${name}`);
      return fn.apply(element, args.map(arg => arg(event, element)));
    };
  }

  // Each compiled statement returns false when the default action should be prevented.
  function compileStatement(source) {
    const targetGuard = TARGET_GUARD_RE.exec(source);
    if (targetGuard) {
      const inner = compileStatement(targetGuard[1].trim());
      return (event, element) => (event.target === element ? inner(event, element) : undefined);
    }
    const keyGuard = KEY_GUARD_RE.exec(source);
    if (keyGuard) {
      const inner = compileStatement(keyGuard[2].trim());
      return (event, element) => (event.key === keyGuard[1] ? inner(event, element) : undefined);
    }
    if (source === 'return false') return () => false;
    if (source === 'event.stopPropagation()') return (event) => { event.stopPropagation(); };
    if (source === 'this.parentElement.hidden=true') return (event, element) => { element.parentElement.hidden = true; };
    const clickById = CLICK_BY_ID_RE.exec(source);
    if (clickById) return () => { document.getElementById(clickById[1])?.click(); };
    if (source.startsWith('return ')) {
      const call = compileCall(source.slice(7).trim());
      if (call) return (event, element) => (call(event, element) === false ? false : undefined);
    }
    const call = compileCall(source);
    if (call) return (event, element) => { call(event, element); };
    throw new Error(`Unsupported handler statement: ${source}`);
  }

  function compileHandler(source) {
    // Statements never contain ';' inside their string arguments.
    const statements = source.split(';').map(part => part.trim()).filter(Boolean).map(compileStatement);
    return function handler(event) {
      for (const statement of statements) {
        if (statement(event, this) === false) { event.preventDefault(); return; }
      }
    };
  }

  for (const type of EVENTS) {
    const attribute = `data-on${type}`;
    document.querySelectorAll(`[${attribute}]`).forEach(element => {
      try {
        element.addEventListener(type, compileHandler(element.getAttribute(attribute)));
      } catch (error) {
        console.error(`Could not bind ${attribute} on`, element, error);
      }
    });
  }
})();
