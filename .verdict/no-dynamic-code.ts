// ruleid: no-dynamic-code-execution
eval("1+1");
// ruleid: no-dynamic-code-execution
const f = new Function("return 1");
// ruleid: no-dynamic-code-execution
const g = Function("return 1");
// ruleid: no-dynamic-code-execution
globalThis.eval("1");
// ruleid: no-dynamic-code-execution
(() => {}).constructor("return 1");
// ruleid: no-dynamic-code-execution
setTimeout("alert(1)", 10);
// ok: no-dynamic-code-execution
setTimeout(() => 1, 10);
// ok: no-dynamic-code-execution
const h = (x: number) => x + 1;
