import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    "grep -rn 'total$' demo/app",
    'sed -n \'1,5p\' tickets/T-1_test.md',
    'sed -n -e \'/coupon/p\' demo/app/cart.js',
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

test('allowlist: each read-only program allows only its safe flags, and an unknown or abbreviated flag is blocked', () => {
  const allowed = [
    'cat -n a', 'head -n 5 a', 'head -5 a', 'head -c 20 a', 'tail -n 5 a', 'tail -20 a', 'ls -la demo', 'ls -R -1 -h', 'ls -A', 'wc -l a', 'wc -lw a',
    'grep -n -i -r coupon demo', 'grep -rni coupon demo', 'grep -A 2 -B2 -C 3 -e coupon a', 'grep -c -E "a|b" a', 'grep --include=*.js -r x .'.replace('*.js', '"*.js"'),
    'grep --color=never -w -v -H x a', 'rg -n -i -l x demo', 'rg -g "*.js" -A 2 --no-heading x', 'rg -nil x',
    'find demo -type f -name "*.js" -maxdepth 2 -print', "find demo '(' -name a -o -name b ')'", "find demo '!' -path x -a -iname y", 'find demo -mindepth 1 -ipath "*x*"',
    'sort -n -r -u a', 'sort -k 2 -t , a', 'sort -nr a', 'uniq -c a', 'uniq -d', 'diff -u a b', 'diff -rq a b', 'jq -r . a', 'jq -c -S . a', 'tree -L 2 -a -d', 'tree -L2',
    'echo hi there', 'pwd', 'file a', 'stat a',
    'git log --oneline -n 5', 'git log -5 --stat --graph --decorate --all', 'git log --format=%h -- demo', 'git log --pretty=oneline --name-only -- a b', 'git log -p --name-status',
    'git show --stat HEAD', 'git show --name-only --format=%s HEAD', 'git diff --stat --cached', 'git diff -U5 --no-color -- demo', 'git diff --name-status --staged',
    'git status -s -b', 'git status --porcelain', 'git rev-parse --short HEAD', 'git rev-parse --abbrev-ref HEAD', 'git rev-parse --show-toplevel', 'git ls-files -- demo',
    'git blame -L 1,5 demo/app/cart.js', 'git grep -n -i -e coupon -w -l', 'git cat-file -p HEAD', 'git cat-file -t HEAD', 'git branch --list',
  ];
  for (const command of allowed) assert.equal(call(command), null, command);

  const blocked = [
    'sort --out=f a', 'sort --outp=f a', 'git diff --outp=f', 'git log --ext-d', 'git log --output=f', 'git diff --ext-diff', 'git show --textconv x', 'git log --format', 'git grep -O sh x', 'git grep --open-files-in-pager=sh x',
    'cat -v a', 'cat --number a', 'head -q a', 'tail -f a', 'tail --follow a', 'ls -S', 'ls --recursive', 'ls -lZ', 'wc -m a', 'grep -P x a', 'grep -f pats a', 'grep --exclude-dir=x -r y .', 'grep -z x a',
    'rg --pre sh x', 'rg --files', 'rg -u x', 'find . -newer a', 'find . -regex x', 'find . -fprint x', 'find . -printf x', 'find . -exec x', 'sort -T /tmp a', 'sort -S 1G a', 'uniq -f 1 a', 'diff -y a b', 'diff --to-file=x a', 'jq -f x a', 'jq --arg a b . c', 'tree -o f', 'tree --du',
    'echo -n x', 'echo -e x', 'pwd -P', 'file -C', 'file -m x a', 'stat -f x a', 'awk 1 a', 'awk "{print}" a',
    'git diff -U --output=/tmp/x', 'git diff -U 5', 'git diff -U --output=/tmp/x HEAD', 'git log --output=/tmp/x', 'git log --output /tmp/x', 'git show --output=/tmp/x HEAD', 'git diff -- --output=/tmp/x', 'git grep -e --output=/tmp/x', 'git log -n --output=x', 'head -n --output=x a', 'tree -L --output=x',
    'git log --all-match', 'git log --graph-x', 'git status -u', 'git rev-parse --git-dir', 'git ls-files -o', 'git ls-files -z', 'git blame -w a', 'git cat-file --batch', 'git branch -a', 'git show -s HEAD', 'git diff --patch', 'git diff -w',
  ];
  for (const command of blocked) assert.match(call(command) ?? '', /Proven: /, `should be blocked: ${command}`);
  assert.match(call('sort -z a'), /the guard allows only these flags for sort: .*-n/);
  assert.match(call('git diff --outp=f'), /the guard allows only these flags for git diff: .*--stat/);
});

test('allowlist: the lexer is strict, and an unquoted word may hold only letters, digits and _ . / : = , @ % + -', () => {
  const blocked = [
    'find . -{exec,}', 'ls *', 'ls ?', 'ls [a]', 'cat a#b', 'cat a #c', "echo $'x'", 'echo $"x"', 'grep "$(id)" f', 'grep "a$b" f', 'grep "`id`" f', 'ls ~', 'cat {a,b}', 'cat a\\ b', 'echo !x', 'echo a^b', 'cat a<b', 'cat a>b',
    'echo $HOME', "echo '$HOME' $X", 'cat a & cat b', 'echo "a" "b$"', 'cat "a" > out', 'ls ../a;rm -rf x',
  ];
  for (const command of blocked) assert.match(call(command) ?? '', /Proven: /, `should be blocked: ${command}`);
  for (const command of [
    'find demo/app -type f | head -50 && cat .proven/state/T-3.json',
    'cat demo/app/cart.js demo/app/coupons.json; grep -n -i "coupon\\|total\\|ship" demo/app/index.html; git log --oneline -8 -- demo/app',
    'cat tickets/T-1.md .proven/state/T-1.json; ls -R demo/app | head -50',
    'node bin/proven.js done T-1',
    "grep -n 'a$' demo/app/cart.js", 'grep -n "a b" demo/app/cart.js', 'cat a,b:c=d@e%f+g-h_i.j/k',
  ]) assert.equal(call(command), null, command);
});

test('allowlist: a valued flag takes a value that does not itself start with a dash, unless it is a number', () => {
  assert.equal(call('head -n -5 a'), null);
  assert.equal(call('grep -A 3 -e coupon a'), null);
  for (const command of ['grep -e -foo a', 'sort -t -o a', 'find . -name -delete', 'head -n -x a', 'rg -g --pre x']) assert.match(call(command) ?? '', /Proven: /, command);
});

test('edit tools may write only inside the project: outside the root is denied, also through a symlink', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'proven-guard-root-')));
  const project = join(base, 'project');
  const outside = join(base, 'outside');
  mkdirSync(join(project, 'site'), { recursive: true });
  mkdirSync(outside);
  symlinkSync(outside, join(project, 'site', 'link'));
  const edit = (tool, input, cwd = project) => decide({ tool_name: tool, tool_input: input, cwd }, { projectDir: project });
  for (const [tool, key] of [['Write', 'file_path'], ['Edit', 'file_path'], ['MultiEdit', 'file_path'], ['NotebookEdit', 'notebook_path']]) {
    assert.equal(edit(tool, { [key]: join(project, 'site', 'a.html') }), null, `${tool} inside the app`);
    for (const target of [join(base, 'x.txt'), '../x.txt', '../../etc/x', '/etc/hosts', join(outside, 'x'), 'site/link/x', join(project, 'site', 'link', 'x'), 'site/link']) {
      assert.match(edit(tool, { [key]: target }) ?? '', /outside the project/, `${tool} ${target}`);
    }
  }
  const home = join(base, 'home');
  assert.match(edit('Edit', { file_path: join(home, '.gitconfig') }) ?? '', /outside the project/);
  assert.match(edit('Edit', { file_path: join(home, '.config', 'git', 'config') }) ?? '', /outside the project/);
  assert.match(edit('Write', {}) ?? '', /Proven: /, 'no path at all is denied too');
  assert.match(edit('Write', { file_path: '' }) ?? '', /Proven: /);
  // protected paths inside the project stay protected
  assert.match(edit('Write', { file_path: join(project, 'tickets', 'T-1.md') }) ?? '', /under tickets\//);
});
