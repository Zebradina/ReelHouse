/*
 * Injected into every page of the ReelHouse web app when it runs on a TV.
 *
 * The web UI is built for a mouse: cards are <a>/<button> (already focusable)
 * but plenty of clickable containers are plain <article>/<div>, and there is no
 * visible focus state at 10 feet. This adds exactly those two things and
 * nothing else — no layout changes, so the TV shows the same app as the desktop.
 */
(function () {
  if (window.__reelhouseTV) return;
  window.__reelhouseTV = true;

  var style = document.createElement('style');
  style.id = 'reelhouse-tv-style';
  style.textContent = [
    /* 10-foot UI: everything a little larger and higher contrast. */
    'html { font-size: 112% !important; }',
    /* A remote has no pointer, so the focus ring is the only cursor. */
    ':focus { outline: 3px solid #5ad1c8 !important; outline-offset: 4px !important; border-radius: 8px !important; }',
    '.card:focus, .dcard:focus, .episode-row:focus { transform: scale(1.04); }',
    /* Scrollbars are noise on a TV and steal width from the rows. */
    '::-webkit-scrollbar { width: 0 !important; height: 0 !important; }',
    'html { scrollbar-width: none; }'
  ].join('\n');
  (document.head || document.documentElement).appendChild(style);

  /* Clickable things that are not natively focusable. */
  var SELECTOR = [
    '.dcard',
    '.card:not(a):not(button)',
    '[role="button"]',
    '[data-now]',
    '.chip',
    '.episode-row',
    '.prov-btn'
  ].join(',');

  function makeFocusable() {
    var nodes = document.querySelectorAll(SELECTOR);
    for (var i = 0; i < nodes.length; i += 1) {
      var el = nodes[i];
      if (!el.hasAttribute('tabindex') && el.getAttribute('aria-hidden') !== 'true') {
        el.setAttribute('tabindex', '0');
      }
    }
  }

  /* The app re-renders whole views on navigation, so watch rather than run once. */
  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () {
      scheduled = false;
      makeFocusable();
    });
  }

  if (document.body) {
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', function () {
      new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    });
  }
  schedule();

  /* OK on a focused container should click it, like it would on a phone. */
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter') return;
    var el = document.activeElement;
    if (!el) return;
    var tag = el.tagName;
    // Anchors and buttons already activate themselves; inputs need Enter.
    if (tag === 'A' || tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (typeof el.click !== 'function') return;
    event.preventDefault();
    el.click();
  }, true);

  /* Keep the focused card inside the visible area of a horizontal row. */
  document.addEventListener('focusin', function (event) {
    var el = event.target;
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, true);
})();
