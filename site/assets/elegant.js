/* WorkBuro, elegant take. Release data comes from release.js, which is loaded first.
 *
 * Nothing here is required for the page to be correct. Without it the page is
 * complete and still: the download rows are static HTML, and no motion runs.
 */

var RELEASE = WORKBURO_RELEASE;

(function () {
  'use strict';

  var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------------------------------------------------------------- downloads */

  function fileUrl(key) { return RELEASE.repo + '/releases/latest/download/' + RELEASE.files[key].name; }
  function sumsName() { return 'SHA256SUMS-' + RELEASE.version + '.txt'; }
  function sumsUrl() { return RELEASE.repo + '/releases/latest/download/' + sumsName(); }
  function sizeLabel(key) {
    var f = RELEASE.files[key];
    return f.bytes ? Math.round(f.bytes / 1000000) + ' MB' : f.mb + ' MB';
  }

  function fillLinks() {
    var hrefs = {
      installer: fileUrl('installer'),
      portable: fileUrl('portable'),
      dmg: fileUrl('dmg'),
      maczip: fileUrl('maczip'),
      releases: RELEASE.releases + '/latest',
      sums: sumsUrl()
    };
    var nodes = document.querySelectorAll('[data-release]');
    for (var i = 0; i < nodes.length; i++) {
      var key = nodes[i].getAttribute('data-release');
      if (hrefs[key]) nodes[i].setAttribute('href', hrefs[key]);
    }
    var sums = document.getElementById('sums-link');
    if (sums) sums.textContent = sumsName();
  }

  function row(no, label, key) {
    var f = RELEASE.files[key];
    var el = document.createElement('div');
    el.className = 'dl-row';

    var num = document.createElement('span');
    num.className = 'rowno';
    num.textContent = no;
    num.setAttribute('aria-hidden', 'true');

    var name = document.createElement('div');
    name.className = 'name';
    name.textContent = label;

    var file = document.createElement('div');
    file.className = 'file';
    file.textContent = f.name;

    var size = document.createElement('div');
    size.className = 'size';
    size.textContent = sizeLabel(key);

    el.appendChild(num);
    el.appendChild(name);
    el.appendChild(file);
    el.appendChild(size);

    if (f.published === false) {
      var soon = document.createElement('div');
      soon.className = 'soon';
      soon.textContent = 'Coming soon';
      el.appendChild(soon);
    } else {
      var act = document.createElement('a');
      act.className = 'act';
      act.href = fileUrl(key);
      act.rel = 'noopener';
      act.textContent = 'Download';
      el.appendChild(act);
    }
    return el;
  }

  function group(label, rows) {
    var wrap = document.createElement('div');
    wrap.className = 'dl-group';
    var head = document.createElement('p');
    head.className = 'tag';
    head.textContent = label;
    wrap.appendChild(head);
    rows.forEach(function (r) { wrap.appendChild(row(r[2], r[0], r[1])); });
    return wrap;
  }

  function fillDownloads() {
    var host = document.getElementById('download-rows');
    if (!host) return;
    host.appendChild(group('Windows', [
      ['Windows installer', 'installer', '01'],
      ['Windows portable', 'portable', '02']
    ]));
    host.appendChild(group('macOS, Apple silicon', [
      ['macOS, Apple silicon', 'dmg', '03'],
      ['macOS, zipped app', 'maczip', '04']
    ]));
  }

  function fillJsonLd() {
    var node = document.getElementById('ld-workburo');
    if (!node) return;
    node.textContent = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: 'WorkBuro',
      applicationCategory: 'UtilitiesApplication',
      operatingSystem: RELEASE.platforms || 'Windows 10, Windows 11',
      description: document.querySelector('meta[name="description"]').getAttribute('content'),
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      downloadUrl: fileUrl('installer'),
      softwareVersion: RELEASE.version
    }, null, 2);
  }

  function setCanonical() {
    if (!RELEASE.canonical) return;
    var link = document.createElement('link');
    link.rel = 'canonical';
    link.href = RELEASE.canonical;
    document.head.appendChild(link);
  }

  /* ---------------------------------------------------------------- motion */

  function settle(el) { el.classList.add('in'); }

  function reveal() {
    var items = [].slice.call(document.querySelectorAll('[data-d]'));
    var rails = [].slice.call(document.querySelectorAll('.rail'));
    var triggers = [].slice.call(document.querySelectorAll('.triggers'));

    items.forEach(function (el) {
      if (!el.closest('.hero')) el.classList.add('reveal');
    });

    if (calm || !('IntersectionObserver' in window)) {
      items.concat(rails, triggers).forEach(settle);
      return;
    }

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        settle(entry.target);
        io.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.12 });

    items.concat(rails, triggers).forEach(function (el) { io.observe(el); });
  }

  /* A screenshot resolving out of its own surface. Failsafe timer included, so the
     veil can never be left sitting on top of a picture. */
  function shots() {
    var list = [].slice.call(document.querySelectorAll('.shot'));
    list.forEach(function (shot, n) {
      var img = shot.querySelector('img');
      var revealShot = function () { shot.classList.add('ready'); };
      if (!img || img.complete) {
        setTimeout(revealShot, calm ? 0 : 120 + n * 90);
      } else {
        img.addEventListener('load', revealShot);
        img.addEventListener('error', revealShot);
      }
      setTimeout(revealShot, 2500);
    });
  }

  function progress() {
    var fill = document.getElementById('barFill');
    if (!fill || calm) return;
    var queued = false;
    var update = function () {
      queued = false;
      var doc = document.documentElement;
      var max = doc.scrollHeight - window.innerHeight;
      var p = max > 0 ? Math.min(1, Math.max(0, window.pageYOffset / max)) : 0;
      fill.style.transform = 'scaleX(' + p + ')';
    };
    var onScroll = function () {
      if (queued) return;
      queued = true;
      window.requestAnimationFrame(update);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    update();
  }

  /* ---------------------------------------------------------------- shortcut */

  function copyShortcut() {
    var key = document.querySelector('[data-copy]');
    var note = document.getElementById('copied');
    if (!key) return;
    var value = key.getAttribute('data-copy');
    var flash = function () {
      key.classList.add('done');
      if (note) {
        note.textContent = value + ' copied';
        note.style.opacity = '1';
      }
      window.setTimeout(function () {
        key.classList.remove('done');
        if (note) note.style.opacity = '0';
      }, 1700);
    };

    key.addEventListener('click', function () {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(flash, function () { legacy(value, flash); });
      } else {
        legacy(value, flash);
      }
    });
  }

  function legacy(value, done) {
    var field = document.createElement('textarea');
    field.value = value;
    field.setAttribute('readonly', '');
    field.style.cssText = 'position:absolute;left:-9999px;top:0';
    document.body.appendChild(field);
    field.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(field);
    if (ok) done();
  }

  fillLinks();
  fillDownloads();
  fillJsonLd();
  setCanonical();
  reveal();
  shots();
  progress();
  copyShortcut();
})();