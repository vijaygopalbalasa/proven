import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../src/hooks/proven-guard.mjs';

const dir = '/tmp/proven-guard-allowlist';
const call = (command) => decide({ tool_name: 'Bash', tool_input: { command }, cwd: dir }, { projectDir: dir });

test('allowlist: the commands the agent really used in the live rehearsal stay allowed', () => {
  for (const command of [
    'find demo/app -type f | head -50 && cat .proven/state/T-3.json',
    'cat demo/app/cart.js demo/app/coupons.json; grep -n -i "coupon\\|total\\|ship" demo/app/index.html; git log --oneline -8 -- demo/app',
    'cat tickets/T-1.md .proven/state/T-1.json; ls -R demo/app | head -50',
    'node bin/proven.js done T-1',
    'node ./bin/proven.js done T-12',
    'proven done T-3',
    'node bin/proven.js done T-1 2>&1 | tail -5',
    'node bin/proven.js done T-1 2>/dev/null',
    'grep -rn "total$" demo/app',
    'sed -n \'1,5p\' tickets/T-1_test.md',
    'sed -n -e \'/coupon/p\' demo/app/cart.js',
    'awk \'{print $1}\' demo/app/coupons.json',
    'git status',
    'git diff HEAD -- demo/app',
    'git show HEAD --stat',
    'git branch',
    'git branch --list',
    'git rev-parse HEAD && git ls-files demo',
    'echo hello; pwd; wc -l demo/app/cart.js | sort | uniq',
    'rg -n coupon demo/app',
    'jq . .proven/state/T-1.json',
    'diff demo/app/cart.js demo/app/cart.js.orig',
  ]) {
    assert.equal(call(command), null, command);
  }
});

test('allowlist: everything else is blocked, and the message names the segment and what the agent may do', () => {
  const blocked = [
    // command substitution, process substitution, backticks, expansion
    'echo $(cat tickets/T-1.md)', 'echo `id`', 'cat <(echo x)', 'echo ${HOME}', 'cat $HOME/x', 'echo "$(id)"',
    // redirection
    'echo x > demo/app/a.txt', 'echo x >> demo/app/a.txt', 'cat a <> b', 'cat a > /tmp/x', 'cat a 1>/tmp/x', 'cat < a', 'cat a >/dev/null 2>out', 'echo x &> /tmp/y',
    // grouping, background, cd, assignments
    'cd demo && cat cart.js', '(cat a)', '{ cat a; }', 'cat a &', 'FOO=1 cat a', 'env cat a', 'cd sub && npm run x',
    // programs outside the list
    'npm run x', 'npm --prefix sub run x', 'npm -C dir run x', 'pnpm run x', 'yarn x', 'bun run x', 'npx proven red T-1', 'node script.js', 'node -e "1"',
    'python3 -c "print(1)"', 'sh -c "cat a"', 'bash -c "cat a"', 'curl http://x', 'wget http://x', 'chmod +x a', 'cp a b', 'mv a b', 'rm a', 'tee a', 'xargs rm', 'timeout 5 cat a', 'mkdir x', 'touch x', '/bin/cat a', 'sudo cat a',
    // person steps and other proven commands
    'node bin/proven.js red T-1', 'node bin/proven.js --port 8090 red T-3', 'proven freeze T-1', 'proven new T-4 x', 'node bin/proven.js loop', 'proven done T-1 red', 'node bin/proven.js recheck', 'node bin/proven.js verify receipts/T-1.json', 'node bin/proven.js done', 'node bin/proven.js done T-1 extra', 'node bin/proven.js done T-x',
    // read-only programs used to write or run something
    'find . -exec rm {} ;', 'find . -execdir rm {} ;', 'find . -delete', 'find . -fprint out', 'find . -ok rm {} ;', 'sed -i s/a/b/ demo/app/cart.js', 'sed -n w\\ out demo/app/cart.js', "sed -n '1w out' a", "sed s/a/b/ a", "sed -n 's/a/b/e' a", "sed -f x a",
    "awk '{print > \"out\"}' a", "awk '{print | \"sh\"}' a", "awk 'BEGIN{system(\"id\")}'", 'sort -o out a', 'sort --output=out a', 'sort --compress-program=sh a', 'tree -o out', 'uniq a b', 'rg --pre sh x', 'file -C', 'head -n 1 a | tee x',
    // git
    'git commit -m x', 'git add -A', 'git checkout -- a', 'git reset --hard', 'git branch newname', 'git branch -D x', 'git -C sub log', 'git -c core.pager=sh log', 'git config core.hooksPath x', 'git diff --output=out', 'git grep -O sh x', 'git push', 'git log; git commit -m x',
  ];
  for (const command of blocked) {
    const why = call(command);
    assert.match(why ?? '', /Proven: /, `should be blocked: ${command}`);
  }
  const why = call('curl http://x; cat a');
  assert.match(why, /curl http:\/\/x/);
  assert.match(why, /may only read files, edit the app with its edit tools, and run proven done/);
});
