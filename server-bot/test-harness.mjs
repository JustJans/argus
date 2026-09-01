// ➤ The one assertion kit every suite uses. Each suite used to carry its own
// ➤ copy of these three lines and its own closing tally, and the copies had
// ➤ drifted: four different shapes of `check`, two ways of counting, one suite
// ➤ that collected failures and printed them at the end. One kit, one report.
// ➤   const { ok, eq, done } = harness('filter');
// ➤   ok(cond, 'what should hold');            eq(got, want, 'what should match');
// ➤   done();   // prints "All N filter tests passed." or the failures, exit 1
export function harness(name) {
  let pass = 0, fail = 0;
  const ok = (cond, label) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${label}`); } };
  // ➤ Structural equality by JSON, so arrays and objects compare by content.
  const eq = (got, want, label) => ok(JSON.stringify(got) === JSON.stringify(want), `${label} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
  const done = () => {
    if (fail) { console.log(`\n${fail}/${pass + fail} ${name} tests FAILED.`); process.exit(1); }
    console.log(`All ${pass} ${name} tests passed.`);
  };
  return { ok, eq, done };
}
