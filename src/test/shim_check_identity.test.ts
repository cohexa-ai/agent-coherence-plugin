/**
 * Both SessionStart shims carry the `.coherence` check inline, between marker
 * comments: the dispatcher checks the git root's `.coherence`, and the Node
 * bootstrap, which also runs on its own, checks its workspace's. Inline rather
 * than sourced, so a stub plugin root that copies one script still has its
 * check, and a missing file can neither skip the check nor refuse every start.
 * This pins the two copies to one check.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const START = '# >>> coherence-dir-check';
const END = '# <<< coherence-dir-check';

/** The lines from the start marker through the end marker in `bin/<script>`. */
function checkBlock(script: string): string {
  const lines = readFileSync(join(PLUGIN_ROOT, 'bin', script), 'utf8').split('\n');
  const at = (marker: string) => lines.flatMap((line, i) => (line.startsWith(marker) ? [i] : []));
  const [starts, ends] = [at(START), at(END)];
  assert.equal(starts.length, 1, `${script}: one "${START}" line`);
  assert.equal(ends.length, 1, `${script}: one "${END}" line`);
  assert.ok(starts[0]! < ends[0]!, `${script}: the start marker comes first`);
  return lines.slice(starts[0], ends[0]! + 1).join('\n');
}

test('the .coherence check is the same in both SessionStart shims', () => {
  const dispatch = checkBlock('ensure-coordinator-dispatch');
  assert.equal(checkBlock('ensure-coordinator-node'), dispatch);
  assert.match(dispatch, /^refuse_coherence_dir\(\) \{/m);
});
