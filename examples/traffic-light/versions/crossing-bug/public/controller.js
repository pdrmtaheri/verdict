(function (root) {
  // The cycle (ms): NS green, NS yellow, all red, EW green, EW yellow, all red.
  var PHASES = [
    { ms: 10000, ns: 'green', ew: 'red' },
    { ms: 3000, ns: 'yellow', ew: 'green' },
    { ms: 2000, ns: 'red', ew: 'red' },
    { ms: 10000, ns: 'red', ew: 'green' },
    { ms: 3000, ns: 'red', ew: 'yellow' },
    { ms: 2000, ns: 'red', ew: 'red' }
  ];
  var GREEN = { ns: 0, ew: 3 };   // index of each axis's green phase
  var ALL_RED = 2;                // a safe place to restart from
  var CYCLE = PHASES.reduce(function (sum, p) { return sum + p.ms; }, 0);

  // Events, all stamped with now():
  // The lights only ever move through the cycle, so no event can skip a step:
  //   emergency(axis)  when the cycle next gives `axis` ('ns' | 'ew') its green,
  //                    hold that green until clear(). Ignored while another
  //                    emergency or a fault is pending.
  //   clear()          end the hold; the cycle carries on from that green.
  //   fault()          at the next all red, both roads stay red until recover().
  //   recover()        leave the fault through all red.
  function createController(opts) {
    var now = opts.now;
    var mode = 'cycle';   // 'cycle' | 'fault'
    var i = 0;            // current phase
    var start = 0;        // when it began: time zero, so with no events state() is a pure function of now()
    var hold = null;      // the axis an emergency is holding green
    var faulting = false; // a fault is waiting for the lights to reach all red

    function advance() {
      if (mode !== 'cycle') return;
      var t = now();
      if (t < start) { start = 0; i = 0; } // time went backwards: start the cycle again from zero
      if (!hold && !faulting) start += Math.floor((t - start) / CYCLE) * CYCLE; // whole cycles change nothing
      while (t - start >= PHASES[i].ms) {
        if (hold && i === GREEN[hold]) return; // held green: stay until clear()
        start += PHASES[i].ms;
        i = (i + 1) % PHASES.length;
        if (faulting && PHASES[i].ns === 'red' && PHASES[i].ew === 'red') { mode = 'fault'; faulting = false; return; }
      }
    }

    return {
      state: function () {
        advance();
        if (mode === 'fault') return { ns: 'red', ew: 'red' };
        return { ns: PHASES[i].ns, ew: PHASES[i].ew };
      },
      emergency: function (axis) {
        advance();
        if (mode !== 'cycle' || faulting || hold) return;
        hold = axis;
      },
      clear: function () {
        advance();
        if (hold) { hold = null; start = now(); }
      },
      fault: function () {
        advance();
        if (mode !== 'cycle') return;
        if (hold) { hold = null; start = now(); } // a held green restarts its clock, so its yellow is not skipped
        if (PHASES[i].ns === 'red' && PHASES[i].ew === 'red') mode = 'fault';
        else faulting = true;
      },
      recover: function () {
        if (mode !== 'fault') return;
        mode = 'cycle'; faulting = false; hold = null; i = ALL_RED; start = now();
      }
    };
  }

  var api = { createController: createController, CYCLE_MS: CYCLE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TrafficController = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
