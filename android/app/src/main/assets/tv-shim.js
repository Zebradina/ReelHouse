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

  /*
   * Keep the focused card on screen.
   *
   * Not scrollIntoView: in this layout it resolves to the page's body wrapper and
   * scrolls nothing, which left the focus ring stranded below the fold whenever
   * the remote moved into the rows. Scrolling the window by the exact shortfall
   * is explicit and works from inside a key handler.
   */
  var MARGIN = 24;

  document.addEventListener('focusin', function (event) {
    var el = event.target;
    if (!el || typeof el.getBoundingClientRect !== 'function') return;

    requestAnimationFrame(function () {
      if (!el.isConnected) return;
      var r = el.getBoundingClientRect();

      var visible = window.innerHeight - MARGIN;
      if (r.top < MARGIN) {
        window.scrollBy({ top: r.top - MARGIN, behavior: 'instant' });
      } else if (r.top + Math.min(r.height, 200) > visible) {
        /* Land the card near the bottom edge, not one pixel of it. */
        window.scrollBy({ top: r.top - (visible - Math.min(r.height, 200)), behavior: 'instant' });
      }
    });
  }, true);

  /*
   * Spatial navigation.
   *
   * Chromium removed spatial navigation from the web, so a WebView only moves
   * focus on Tab. On a TV the D-pad sends arrow keys, which therefore scroll the
   * page instead of moving between cards — the library below the hero is
   * unreachable. This walks the focusable elements itself and picks the nearest
   * one in the direction pressed, so the remote behaves like every other TV app.
   */
  var CANDIDATE = [
    'a[href]',
    'button',
    'input',
    'select',
    'textarea',
    '[tabindex]',
    '[role="button"]'
  ].join(',');

  /* Too small to aim at, or not meant to be a stop on the way. */
  var MIN_SIZE = 12;

  /*
   * Note the difference between these two: aria-hidden on a wrapper really does
   * hide everything inside it, but tabindex="-1" usually sits on a page
   * container (a skip-link target) whose contents are still perfectly
   * focusable. Checking it up the tree would exclude the whole library.
   */
  function excluded(el) {
    if (el.getAttribute('tabindex') === '-1') return true;
    if (el.disabled) return true;
    return !!el.closest('.hero-dot,[aria-hidden="true"]');
  }

  /*
   * Size only — deliberately not the viewport. A candidate below the fold is a
   * valid destination (focusing it scrolls it into view); rejecting off-screen
   * elements is what leaves the rows under the hero unreachable.
   *
   * Off the document, though, means it is not on the page at all: skip links
   * are parked at left:-999px so only screen readers see them, and those must
   * not become the first stop on a remote.
   */
  function rectOf(el) {
    var r = el.getBoundingClientRect();
    if (r.width < MIN_SIZE || r.height < MIN_SIZE) return null;

    var x = r.left + window.scrollX;
    var y = r.top + window.scrollY;
    var width = Math.max(document.documentElement.scrollWidth, window.innerWidth);
    var height = Math.max(document.documentElement.scrollHeight, window.innerHeight);
    if (x < -8 || y < -8 || x > width || y > height) return null;
    return r;
  }

  function candidates() {
    var all = document.querySelectorAll(CANDIDATE);
    var out = [];
    for (var i = 0; i < all.length; i += 1) {
      var el = all[i];
      if (excluded(el)) continue;
      if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') continue;
      var r = rectOf(el);
      if (r) out.push({ el: el, rect: r });
    }
    return out;
  }

  /* How far a candidate sits from `from` in one direction, or null if it is
     not in that direction at all. Cross-axis distance dominates the score so
     that a card in the same row beats one in the row below. */
  function distance(from, to, dir) {
    var fcx = from.left + from.width / 2;
    var fcy = from.top + from.height / 2;
    var tcx = to.left + to.width / 2;
    var tcy = to.top + to.height / 2;
    var primary, cross;

    if (dir === 'down' || dir === 'up') {
      primary = dir === 'down' ? to.top - from.bottom : from.top - to.bottom;
      cross = Math.abs(tcx - fcx);
    } else {
      primary = dir === 'right' ? to.left - from.right : from.left - to.right;
      cross = Math.abs(tcy - fcy);
    }
    if (primary < -4) return null;
    return Math.max(primary, 0) + cross * 1.8;
  }

  /*
   * Where focus was. The app re-renders pieces of itself while it is on screen,
   * and a focused button that gets replaced takes the focus with it; remembering
   * the element (not a coordinate) means the next D-pad press can carry on from
   * it while it still exists, and start from the top once it is gone.
   */
  var lastFocused = null;
  var lastHash = location.hash;

  document.addEventListener('focusin', function (event) {
    if (event.target && event.target.tagName) lastFocused = event.target;
  }, true);

  function rememberedRect() {
    if (!lastFocused || !lastFocused.isConnected) return null;
    return rectOf(lastFocused);
  }

  function moveFocus(dir) {
    var list = candidates();
    if (!list.length) return false;

    var current = document.activeElement;
    var from = current && current !== document.body ? rectOf(current) : rememberedRect();

    /*
     * Nothing focused yet: start at whatever sits closest to the middle of the
     * screen. On the home page that is the hero's Play button, on a detail page
     * its own Play button — the thing a viewer means when they first press a
     * key, rather than the logo in the corner.
     */
    if (!from) {
      var mid = window.innerHeight / 2;
      var visibleOnly = list.filter(function (item) {
        return item.rect.top >= 0 && item.rect.top < window.innerHeight;
      });
      var pool = visibleOnly.length ? visibleOnly : list;
      var start = pool.reduce(function (best, item) {
        if (!best) return item;
        var score = Math.abs(item.rect.top + item.rect.height / 2 - mid);
        var bestScore = Math.abs(best.rect.top + best.rect.height / 2 - mid);
        if (score < bestScore - 8) return item;
        if (Math.abs(score - bestScore) <= 8 && item.rect.left < best.rect.left) return item;
        return best;
      }, null);
      if (!start) return false;
      start.el.focus();
      return true;
    }

    var best = null;
    var bestScore = Infinity;
    for (var i = 0; i < list.length; i += 1) {
      var item = list[i];
      if (item.el === current) continue;
      var score = distance(from, item.rect, dir);
      if (score === null || score >= bestScore) continue;
      bestScore = score;
      best = item;
    }
    if (!best) return false;
    /*
     * No preventScroll here: Chrome discards scrolling — including the
     * scrollIntoView in the focusin handler below — when a focus is marked as
     * not scrolling. Letting the browser reveal the element is what keeps the
     * remote's focus on screen when it moves to a row below the fold.
     */
    best.el.focus();
    return true;
  }

  var DIRECTIONS = {
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right'
  };

  document.addEventListener('keydown', function (event) {
    var dir = DIRECTIONS[event.key];
    if (!dir || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

    /* A new page has its own layout; an old position would be misleading. */
    if (location.hash !== lastHash) {
      lastHash = location.hash;
      lastFocused = null;
    }

    /* Caret movement in a text field must stay native. */
    var el = document.activeElement;
    if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;

    /* The player owns the screen while it is open; leave its keys alone. */
    if (document.querySelector('.player-page')) return;

    /*
     * Swallow the arrow either way. With no candidate in that direction the
     * browser would otherwise scroll the page a little, which on a TV looks
     * like the layout twitching for no reason.
     */
    event.preventDefault();
    moveFocus(dir);
  }, true);
})();
