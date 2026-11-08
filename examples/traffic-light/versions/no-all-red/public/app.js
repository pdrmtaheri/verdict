(function () {
  var SVGNS = 'http://www.w3.org/2000/svg';
  var COLORS = { red: '#FF5666', yellow: '#FFC24B', green: '#2FD184' };
  var OFF = '#3A3A40';
  var svg = document.getElementById('scene');

  function el(name, attrs) {
    var e = document.createElementNS(SVGNS, name);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    svg.appendChild(e);
    return e;
  }

  // Roads, centre dashes, stop lines (geometry from the Paper design, 584x340)
  el('rect', { x: 242, y: 0, width: 100, height: 340, fill: '#34343A' });
  el('rect', { x: 0, y: 120, width: 584, height: 100, fill: '#34343A' });
  el('path', { d: 'M292 0v120M292 220v120M0 170h242M342 170h242', fill: 'none', stroke: '#FFFFFF8C', 'stroke-width': 2, 'stroke-dasharray': '10 10' });
  el('path', { d: 'M242 112h50M292 228h50M234 170v50M350 120v50', fill: 'none', stroke: '#FFFFFF', 'stroke-width': 4 });

  // Signal head. Vertical heads stack red, yellow, green top to bottom;
  // horizontal heads run red, yellow, green left to right.
  function head(x, y, vertical) {
    el('rect', { x: x, y: y, width: vertical ? 18 : 48, height: vertical ? 48 : 18, rx: 4, fill: '#111114' });
    var lamps = {};
    ['red', 'yellow', 'green'].forEach(function (c, i) {
      lamps[c] = el('circle', {
        cx: vertical ? x + 9 : x + 12 + i * 12,
        cy: vertical ? y + 12 + i * 12 : y + 9,
        r: 5,
        fill: OFF
      });
    });
    return lamps;
  }

  var heads = {
    ns: [head(212, 64, true), head(354, 228, true)],
    ew: [head(148, 228, false), head(388, 94, false)]
  };

  var speed = 10;
  var virtual = 0;
  var last = Date.now();
  var controller = globalThis.TrafficController.createController({ now: function () { return virtual; } });

  var buttons = document.querySelectorAll('.speeds button');
  Array.prototype.forEach.call(buttons, function (b) {
    b.addEventListener('click', function () {
      speed = Number(b.getAttribute('data-speed'));
      Array.prototype.forEach.call(buttons, function (o) {
        o.setAttribute('aria-pressed', o === b ? 'true' : 'false');
      });
    });
  });

  function paint(axis, color) {
    heads[axis].forEach(function (lamps) {
      Object.keys(COLORS).forEach(function (c) {
        lamps[c].setAttribute('fill', c === color ? COLORS[c] : OFF);
      });
    });
  }

  var clockEl = document.getElementById('clock');
  var stateEl = document.getElementById('state');

  function frame() {
    var t = Date.now();
    virtual += (t - last) * speed;
    last = t;
    var s = controller.state();
    paint('ns', s.ns);
    paint('ew', s.ew);
    clockEl.textContent = 't = ' + ((virtual % globalThis.TrafficController.CYCLE_MS) / 1000).toFixed(1) + 's';
    stateEl.textContent = 'NS ' + s.ns + ' · EW ' + s.ew;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
