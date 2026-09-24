/**
 * Small DOM helpers.
 *
 * Everything the UI renders goes through `el()`, which builds nodes from
 * arguments rather than HTML strings. That makes the app structurally
 * injection-proof: user text is only ever assigned through `textContent`.
 */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

/**
 * Create an element.
 *
 * Supported props: `class`, `text`, `html` (trusted markup only), `dataset`,
 * `style` (object; keys starting with `--` are treated as custom properties),
 * `on*` listeners, `aria-*` and `data-*` attributes, and any real DOM property
 * such as `value`, `type` or `placeholder`.
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;

    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') {
      for (const [property, setting] of Object.entries(value)) {
        if (setting == null) continue;
        // Custom properties are not settable as object members on every
        // engine, so they go through setProperty explicitly.
        if (property.startsWith('--')) node.style.setProperty(property, String(setting));
        else node.style[property] = setting;
      }
    }
    else if (key === 'for') node.htmlFor = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key.includes('-') || key.startsWith('aria')) {
      node.setAttribute(key, value === true ? '' : String(value));
    } else if (key in node) {
      node[key] = value;
    } else {
      node.setAttribute(key, String(value));
    }
  }

  append(node, children);
  return node;
}

/** Append a child, an array of children, or a string of text. */
export function append(parent, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child == null || child === false) continue;
    parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return parent;
}

/** Replace every child of `parent` with `children`. */
export function replace(parent, children) {
  parent.replaceChildren();
  append(parent, children);
  return parent;
}

/**
 * An inline `<svg><use href="#id"/></svg>`.
 *
 * The size is set as an attribute rather than left to CSS because an SVG with
 * no width, height or viewBox falls back to the replaced-element default of
 * 300×150 — which is how a supposedly small icon ends up rendering as a giant
 * button. Passing an explicit size, or inheriting `1em` from the surrounding
 * text, removes that failure mode entirely. Sizing rules in the stylesheet
 * still win, since CSS beats presentation attributes.
 */
export function icon(id, size = '1em') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  svg.appendChild(use);
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  // Icons are decorative; the control that owns them carries the label.
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  return svg;
}

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** Debounce: run `fn` once, `ms` after the last call. */
export function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  wrapped.flush = (...args) => {
    clearTimeout(timer);
    timer = null;
    fn(...args);
  };
  return wrapped;
}

/**
 * Coalesce rapid calls into at most one per animation frame. Used for anything
 * that runs on scroll or resize, so layout reads happen once per frame.
 */
export function rafThrottle(fn) {
  let queued = false;
  let lastArgs = null;

  return (...args) => {
    lastArgs = args;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...lastArgs);
    });
  };
}

/** Resolves on the next frame, so transitions can be triggered after layout. */
export const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

/** Wait for `ms`, or for a transitionend on `node`, whichever comes first. */
export function waitForTransition(node, ms) {
  return new Promise((resolve) => {
    const done = () => {
      node.removeEventListener('transitionend', done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, ms);
    node.addEventListener('transitionend', done, { once: true });
  });
}

/**
 * Emit a ripple from the pointer position. Attached once at the document
 * level so buttons added later are covered automatically.
 */
export function installRipples(root = document) {
  root.addEventListener(
    'pointerdown',
    (event) => {
      if (event.button !== 0) return;
      const target = event.target.closest('.btn, .tool, .menu-item, .palette-item, .view-row');
      if (!target) return;

      const rect = target.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height);
      const ripple = el('span', {
        class: 'ripple',
        style: {
          width: `${size}px`,
          height: `${size}px`,
          left: `${event.clientX - rect.left - size / 2}px`,
          top: `${event.clientY - rect.top - size / 2}px`,
        },
      });

      target.appendChild(ripple);
      ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
    },
    { capture: true },
  );
}

/** True when the OS asks for reduced motion. */
export function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Focus trap for modal dialogs. Returns a teardown function.
 */
export function trapFocus(container) {
  const selector = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  const onKeydown = (event) => {
    if (event.key !== 'Tab') return;
    const focusable = $$(selector, container).filter(
      (node) => node.offsetParent !== null || node === document.activeElement,
    );
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  container.addEventListener('keydown', onKeydown);
  return () => container.removeEventListener('keydown', onKeydown);
}

/**
 * Run `fn` outside the app's global key handlers.
 *
 * Shortcuts listen on `document`, so a keystroke inside a modal would
 * otherwise trigger app-level actions too.
 */
export function stopPropagationOn(node, events = ['keydown']) {
  for (const type of events) {
    node.addEventListener(type, (event) => event.stopPropagation());
  }
}
