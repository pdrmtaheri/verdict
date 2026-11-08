function bad() {
  // ruleid: controller-reads-real-clock
  var a = Date.now();
  // ruleid: controller-reads-real-clock
  var b = new Date().getTime();
  // ruleid: controller-reads-real-clock
  var c = performance.now();
  // ruleid: controller-reads-real-clock
  var d = globalThis.Date.now();
  // ruleid: controller-reads-real-clock
  var e = process.hrtime();
  // ruleid: controller-reads-real-clock
  var f = Date;
  // ruleid: controller-reads-real-clock
  var g = window.performance.now();
}

function good(opts) {
  var now = opts.now;
  // ok: controller-reads-real-clock
  var t = now() % 1000;
  // ok: controller-reads-real-clock
  var updated = opts.update;
  return t + updated;
}
