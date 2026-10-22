/* =====================================================================
   Motion layer for the public site.
   Everything here is cheap: transforms and opacity only, one scroll
   listener, one observer, and nothing at all when the visitor has asked
   for reduced motion.
   ===================================================================== */

(function () {
  'use strict';

  var root = document.documentElement;
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');

  // Marks the page as script-driven, so the things that wait for a scroll
  // only hide themselves when there is something there to bring them back.
  root.classList.add('js');

  /* ---------------- Dark mode ---------------- */

  var THEME_KEY = 'chipo-theme';

  function storedTheme() {
    try { return window.localStorage.getItem(THEME_KEY); } catch (err) { return null; }
  }

  function applyTheme(theme) {
    root.setAttribute('data-theme', theme);
    var toggle = document.getElementById('themeToggle');
    if (toggle) {
      toggle.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
      toggle.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    }
    var toggle2 = document.getElementById('portalThemeToggle');
    if (toggle2) {
      toggle2.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
      toggle2.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    }
  }

  function preferredTheme() {
    var stored = storedTheme();
    if (stored === 'dark' || stored === 'light') return stored;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  applyTheme(preferredTheme());

  var themeToggle = document.getElementById('themeToggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      try { window.localStorage.setItem(THEME_KEY, next); } catch (err) { /* private mode */ }
    });
  }
  var themeToggle2 = document.getElementById('portalThemeToggle');
  if (themeToggle2) {
    themeToggle2.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      try { window.localStorage.setItem(THEME_KEY, next); } catch (err) { /* private mode */ }
    });
  }

  /* ---------------- Smooth scrolling ---------------- */

  root.style.scrollBehavior = reduceMotion.matches ? 'auto' : 'smooth';

  document.addEventListener('click', function (event) {
    var link = event.target.closest('a[href^="#"]');
    if (!link) return;
    var id = link.getAttribute('href');
    if (!id || id === '#') return;
    var target = document.querySelector(id);
    if (!target) return;
    event.preventDefault();
    target.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'start' });
    if (history.replaceState) history.replaceState(null, '', id);
  });

  /* ---------------- Sticky header state ---------------- */

  var header = document.querySelector('.site-header');

  /* ---------------- Parallax hero ---------------- */

  var parallaxLayers = Array.prototype.slice.call(document.querySelectorAll('[data-parallax]'));

  function onScroll() {
    if (header) header.classList.toggle('is-scrolled', window.scrollY > 24);

    if (parallaxLayers.length && !reduceMotion.matches) {
      var y = window.scrollY;
      for (var i = 0; i < parallaxLayers.length; i++) {
        var layer = parallaxLayers[i];
        var speed = parseFloat(layer.getAttribute('data-parallax')) || 0.15;
        var offset = Math.max(-140, Math.min(140, y * speed));
        layer.style.transform = 'translate3d(0,' + offset.toFixed(1) + 'px,0)';
      }
    }
  }

  var ticking = false;
  function requestScroll() {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(function () {
      onScroll();
      ticking = false;
    });
  }

  window.addEventListener('scroll', requestScroll, { passive: true });
  window.addEventListener('resize', requestScroll, { passive: true });
  onScroll();

  /* ---------------- Scroll reveal + stagger ---------------- */

  var revealables = Array.prototype.slice.call(document.querySelectorAll('.reveal'));

  // Elements inside a staggered group get their delay from their position.
  Array.prototype.slice.call(document.querySelectorAll('[data-stagger]')).forEach(function (group) {
    var step = parseFloat(group.getAttribute('data-stagger')) || 90;
    var children = Array.prototype.slice.call(group.querySelectorAll('.reveal'));
    children.forEach(function (child, index) {
      child.style.setProperty('--reveal-delay', (index * step) + 'ms');
    });
  });

  if (reduceMotion.matches || !('IntersectionObserver' in window)) {
    revealables.forEach(function (element) { element.classList.add('is-visible'); });
  } else {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -8% 0px' });

    revealables.forEach(function (element) { observer.observe(element); });
  }

  /* ---------------- Card tilt and light follow ---------------- */

  var tiltCards = Array.prototype.slice.call(document.querySelectorAll('[data-tilt]'));

  if (tiltCards.length && finePointer.matches && !reduceMotion.matches) {
    tiltCards.forEach(function (card) {
      var frame = null;

      function move(event) {
        var rect = card.getBoundingClientRect();
        var x = (event.clientX - rect.left) / rect.width;
        var y = (event.clientY - rect.top) / rect.height;
        card.style.setProperty('--mx', (x * 100).toFixed(1) + '%');
        card.style.setProperty('--my', (y * 100).toFixed(1) + '%');
        if (frame) return;
        frame = window.requestAnimationFrame(function () {
          frame = null;
          var rotateX = (0.5 - y) * 5;
          var rotateY = (x - 0.5) * 6;
          card.style.transform = 'perspective(900px) translateY(-8px) rotateX(' + rotateX.toFixed(2) + 'deg) rotateY(' + rotateY.toFixed(2) + 'deg)';
        });
      }

      function reset() {
        if (frame) { window.cancelAnimationFrame(frame); frame = null; }
        card.style.transform = '';
        card.style.setProperty('--mx', '50%');
        card.style.setProperty('--my', '0%');
      }

      card.addEventListener('pointermove', move);
      card.addEventListener('pointerleave', reset);
    });
  }

  /* ---------------- Floating cards ---------------- */

  // A slow, gentle bob for a few cards so the page feels alive.
  Array.prototype.slice.call(document.querySelectorAll('[data-float]')).forEach(function (element, index) {
    var delay = (index % 4) * 1.1;
    element.style.animation = 'cardFloat 7s ease-in-out ' + delay + 's infinite';
  });

  /* ---------------- Live ticker for the time in the header ---------------- */

  root.classList.toggle('no-motion', reduceMotion.matches);
})();
