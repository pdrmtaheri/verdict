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

  // Traffic flow, so the lights can be read from the roads: each lane is a stream of marks
  // that bunches up at its stop line unless the light lets it go. If crossing streams meet
  // in the junction, the junction turns red. Marks are rects, not circles: the 12 circles
  // are the lamps.
  var MARK_LEN = 10, MARK_W = 6, GAP = 6, FLOW_SPEED = 0.09; // px, px, px, px per virtual ms
  // One lane per approach, driving on the right. `stop` is how far the front of a mark may
  // come before the stop line; `exit` is where it has left the scene.
  var lanes = [
    { axis: 'ns', x: 267, y: 0, dx: 0, dy: 1, stop: 106, exit: 340 + MARK_LEN },   // southbound
    { axis: 'ns', x: 317, y: 340, dx: 0, dy: -1, stop: 106, exit: 340 + MARK_LEN }, // northbound
    { axis: 'ew', x: 0, y: 195, dx: 1, dy: 0, stop: 228, exit: 584 + MARK_LEN },   // eastbound
    { axis: 'ew', x: 584, y: 145, dx: -1, dy: 0, stop: 228, exit: 584 + MARK_LEN }  // westbound
  ];
  var BOX = { x0: 242, x1: 342, y0: 120, y1: 220 };
  var conflict = el('rect', { x: BOX.x0, y: BOX.y0, width: BOX.x1 - BOX.x0, height: BOX.y1 - BOX.y0, fill: '#FF5666', 'fill-opacity': 0 });
  var flowLayer = el('g', { fill: '#FFFFFF', 'fill-opacity': 0.85 });
  lanes.forEach(function (lane) {
    lane.marks = []; // front of the stream first
    lane.wait = 0;   // virtual ms until the next mark may enter
    lane.pool = [];
    for (var n = 0; n < 24; n++) {
      var r = document.createElementNS(SVGNS, 'rect');
      r.setAttribute('rx', 2);
      flowLayer.appendChild(r);
      lane.pool.push(r);
    }
  });

  // A mark's box in scene coordinates, from how far its front has come (f).
  function markBox(lane, f) {
    var fx = lane.x + lane.dx * f, fy = lane.y + lane.dy * f;
    var vertical = lane.dx === 0;
    return {
      x: vertical ? lane.x - MARK_W / 2 : Math.min(fx, fx - lane.dx * MARK_LEN),
      y: vertical ? Math.min(fy, fy - lane.dy * MARK_LEN) : lane.y - MARK_W / 2,
      w: vertical ? MARK_W : MARK_LEN,
      h: vertical ? MARK_LEN : MARK_W
    };
  }

  function stepFlow(s, dt) {
    lanes.forEach(function (lane) {
      var light = s[lane.axis];
      var ahead = null;
      lane.marks.forEach(function (m) {
        var limit = Infinity;
        // Traffic stops for red, and for yellow unless it is too close to stop.
        var mustStop = light === 'red' || (light === 'yellow' && m.f < lane.stop - 14);
        if (m.f <= lane.stop && mustStop) limit = lane.stop;
        if (ahead) limit = Math.min(limit, ahead.f - MARK_LEN - GAP);
        m.f = Math.max(m.f, Math.min(m.f + FLOW_SPEED * dt, limit));
        ahead = m;
      });
      while (lane.marks.length && lane.marks[0].f > lane.exit) lane.marks.shift();
      lane.wait -= dt;
      var last = lane.marks[lane.marks.length - 1];
      if (lane.wait <= 0 && lane.marks.length < lane.pool.length && (!last || last.f - MARK_LEN > GAP)) {
        lane.marks.push({ f: 0 });
        lane.wait = 250 + Math.random() * 700;
      }
    });
  }

  function inBox(b) { return b.x < BOX.x1 && b.x + b.w > BOX.x0 && b.y < BOX.y1 && b.y + b.h > BOX.y0; }

  function drawFlow() {
    var inside = { ns: false, ew: false };
    lanes.forEach(function (lane) {
      lane.pool.forEach(function (r, n) {
        var m = lane.marks[n];
        if (!m) { r.setAttribute('visibility', 'hidden'); return; }
        var b = markBox(lane, m.f);
        if (inBox(b)) inside[lane.axis] = true;
        r.setAttribute('visibility', 'visible');
        r.setAttribute('x', b.x);
        r.setAttribute('y', b.y);
        r.setAttribute('width', b.w);
        r.setAttribute('height', b.h);
      });
    });
    // Both roads moving through the junction at once: the thing the laws forbid.
    conflict.setAttribute('fill-opacity', inside.ns && inside.ew ? 0.55 : 0);
  }

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

  // The speed slider runs 0..1000 on a log scale from 1x to 60x.
  var slider = document.getElementById('speed');
  var speedOut = document.getElementById('speed-value');
  function setSpeed() {
    var x = Math.pow(60, Number(slider.value) / 1000);
    speed = x < 10 ? Math.round(x * 10) / 10 : Math.round(x);
    speedOut.textContent = speed + '×';
    slider.setAttribute('aria-valuetext', speed + ' times real time');
  }
  if (slider && speedOut) {
    slider.addEventListener('input', setSpeed);
    setSpeed();
  }

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
    var dt = (t - last) * speed;
    virtual += dt;
    last = t;
    var s = controller.state();
    // Move the traffic in small steps, and no more than a few seconds' worth after the tab was away.
    for (var left = Math.min(dt, 3000); left > 0; left -= 50) stepFlow(s, Math.min(50, left));
    drawFlow();
    paint('ns', s.ns);
    paint('ew', s.ew);
    clockEl.textContent = 't = ' + ((virtual % globalThis.TrafficController.CYCLE_MS) / 1000).toFixed(1) + 's';
    stateEl.textContent = 'NS ' + s.ns + ' · EW ' + s.ew;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
