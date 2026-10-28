import { expect, test } from 'claude-code/testing'
import { candidates, codeBlocks, copyText, matches, parseConfig, riskOf, touchesProd, groups, iconOf, newest, strings, titleFrom, toItem, when } from './register'

const kinds = (tool: string, input: Record<string, unknown>, result: unknown) =>
  candidates(tool, input, result).map(c => [c.kind, c.found])

test('a path is taken only standing on its own, not as the tail of a relative one', () => {
  const listing = '2056\tassets/artifact-mod.png\n188531\tassets/x.png'
  expect(kinds('Bash', { command: 'gh api …' }, { stdout: listing })).toEqual([])
  expect(kinds('Bash', { command: 'screencapture -x "/tmp/s/a.png"' }, { stdout: '/tmp/s/a.png\n' })).toEqual([
    ['image', '/tmp/s/a.png'],
  ])
})

test('Windows paths, and quoted paths with spaces, are taken too', () => {
  expect(kinds('Bash', { command: 'shot' }, { stdout: 'Saved C:\\Users\\ana\\shot.png\n' })).toEqual([['image', 'C:\\Users\\ana\\shot.png']])
  const mac = '/Users/ana/Desktop/Screenshot 2026-10-27 at 10.22.png'
  expect(kinds('Bash', { command: `screencapture -x "${mac}"` }, '').filter(([, f]) => f === mac)).toEqual([['image', mac]])
  expect(kinds('Bash', { command: 'ls' }, { stdout: 'see docs\\shot.png' })).toEqual([])
  const win = toItem({ kind: 'image', found: 'C:\\Users\\ana\\my shot.png' }, 'Bash', undefined, 0, '')
  expect([win.href, win.label, copyText(win.href)]).toEqual(['file:///C:/Users/ana/my%20shot.png', 'my shot.png', 'C:\\Users\\ana\\my shot.png'])
})

test('a local HTML page counts as a file, except when a source file is edited or an Artifact is published', () => {
  expect(kinds('Write', { file_path: '/t/report.html', content: '<html>' }, '')).toEqual([['file', '/t/report.html']])
  expect(kinds('Bash', { command: 'make' }, { stdout: 'Wrote "/t/my page.htm"' })).toEqual([['file', '/t/my page.htm']])
  expect(kinds('Edit', { file_path: '/app/index.html', old_string: 'a', new_string: 'b' }, '')).toEqual([])
  expect(kinds('Artifact', { file_path: '/t/p.html' }, 'Published at https://claude.ai/artifact/Bws5cbdhuzv1S9syDqWnd')).toEqual([
    ['artifact', 'https://claude.ai/artifact/Bws5cbdhuzv1S9syDqWnd'],
  ])
})

test('spreadsheets, documents, decks, SVGs and archives count; a CSV or SVG being edited does not', () => {
  const out = { stdout: 'Wrote /t/q3.csv /t/q3.xlsx /t/memo.docx /t/deck.pptx /t/logo.svg /t/build.zip' }
  expect(kinds('Bash', { command: 'make report' }, out)).toEqual([
    ['file', '/t/q3.csv'],
    ['file', '/t/q3.xlsx'],
    ['file', '/t/memo.docx'],
    ['file', '/t/deck.pptx'],
    ['image', '/t/logo.svg'],
    ['file', '/t/build.zip'],
  ])
  expect(kinds('Write', { file_path: '/t/q3.csv', content: 'a,b' }, '')).toEqual([['file', '/t/q3.csv']])
  expect(kinds('Edit', { file_path: '/app/fixtures/users.csv', old_string: 'a', new_string: 'b' }, '')).toEqual([])
  expect(kinds('Edit', { file_path: '/app/icon.svg', old_string: 'a', new_string: 'b' }, '')).toEqual([])
  expect(kinds('Bash', { command: 'ls' }, { stdout: '/t/notes.md /t/data.json /t/log.txt' })).toEqual([])
  const icon = (f: string) => iconOf(toItem({ kind: 'file', found: f }, 'Bash', undefined, 0, ''))
  expect([icon('/t/q3.csv'), icon('/t/deck.pptx'), icon('/t/build.zip'), icon('/t/memo.docx')]).toEqual(['📊', '📽️', '🗜️', '📄'])
})

test('artifact links count only from an Artifact publish result', () => {
  const url = 'Published at https://claude.ai/artifact/Bws5cbdhuzv1S9syDqWnd'
  expect(kinds('Artifact', { file_path: '/t/p.html' }, url)).toEqual([['artifact', 'https://claude.ai/artifact/Bws5cbdhuzv1S9syDqWnd']])
  expect(kinds('Artifact', { action: 'read', url: 'https://claude.ai/artifact/Bws5cbdhuzv1S9syDqWnd' }, url)).toEqual([])
  expect(kinds('Bash', { command: "echo 'https://claude.ai/artifact/x'" }, { stdout: url })).toEqual([])
})

test('a publish through the claude-artifacts MCP server counts too', () => {
  const said = [{ type: 'text', text: '{"title":"Plan","url":"https://claude.ai/artifact/9Whu26JUnNEGN4EsNFZEGK"}' }]
  const input = { files: [{ as: 'index.html', path: '/t/p.html' }], title: 'Plan' }
  expect(kinds('mcp__claude-artifacts__publish_files', input, said)).toEqual([['artifact', 'https://claude.ai/artifact/9Whu26JUnNEGN4EsNFZEGK']])
  expect(kinds('mcp__claude-artifacts__read', { url: 'https://claude.ai/artifact/9Whu26JUnNEGN4EsNFZEGK' }, said)).toEqual([])
  expect(kinds('mcp__other__publish_files', input, said).filter(([k]) => k === 'artifact')).toEqual([])
})

test('a Claude Docs document counts when a batch creates it, titled by its name', () => {
  const tool = 'mcp__claude_ai_Claude_Docs__batch'
  const said = [{ type: 'text', text: 'created.bound:true\nOpen: https://claude.ai/artifact/Plan-año-Q3-9Whu26JUnNEGN4EsNFZEGK' }]
  const birth = { container: { kind: 'project', create: { name: 'Plan Q3', doc: { markdown: '# Plan Q3' } } }, batch: [] }
  expect(kinds(tool, birth, said)).toEqual([['doc', 'https://claude.ai/artifact/Plan-año-Q3-9Whu26JUnNEGN4EsNFZEGK']])
  expect(titleFrom(birth)).toBe('Plan Q3')
  expect(iconOf(toItem({ kind: 'doc', found: 'https://claude.ai/artifact/x' }, tool, 'Plan Q3', 0, ''))).toBe('📝')
  expect(kinds(tool, { container: { kind: 'project', id: '3f2a' }, batch: [] }, said)).toEqual([])
  expect(kinds('mcp__claude_ai_Claude_Docs__update', birth, said)).toEqual([])
  expect(kinds(tool, { container: { kind: 'project', create: [] } }, said)).toEqual([])
  for (const container of [null, 'x', 3, [], { create: null }, { create: 'x' }])
    expect(kinds(tool, { container }, said)).toEqual([])
})

test('third review: only the link made counts, whole and alone', () => {
  // As the Artifact tool answers a create from a type: the type's own link comes after.
  const fromType =
    'Created a new Artifact at https://claude.ai/artifact/6c7D9h7WRatXofB4EytaAX (version 1) from the Artifact type https://claude.ai/artifact/QKN21svewxgyPb6SYRqWnd (release 2).'
  expect(kinds('Artifact', { type_url: 'https://claude.ai/artifact/QKN21svewxgyPb6SYRqWnd', title: 'Deck' }, fromType)).toEqual([
    ['artifact', 'https://claude.ai/artifact/6c7D9h7WRatXofB4EytaAX'],
  ])
  expect(kinds('Artifact', { file_path: '/t/p.html' }, 'https://claude.ai/artifact/6c7D9h7WRatXofB4EytaAXを開く')).toEqual([
    ['artifact', 'https://claude.ai/artifact/6c7D9h7WRatXofB4EytaAX'],
  ])
  expect(kinds('Artifact', {}, 'https://claude.ai/code/artifact/2bee1053-9c41-4376-b8e3-e785ebe7cc35.')).toEqual([
    ['artifact', 'https://claude.ai/code/artifact/2bee1053-9c41-4376-b8e3-e785ebe7cc35'],
  ])
  expect(kinds('mcp__plugin_claude-artifacts_claude-artifacts__publish_files', { title: 'P' }, 'https://claude.ai/artifact/9Whu26JUnNEGN4EsNFZEGK')).toEqual([
    ['artifact', 'https://claude.ai/artifact/9Whu26JUnNEGN4EsNFZEGK'],
  ])
})

test('PRs only from gh pr create, runs only from gh pr checks or gh run', () => {
  const out = { stdout: 'https://github.com/o/app/pull/7\nhttps://github.com/o/app/actions/runs/42/job/1' }
  expect(kinds('Bash', { command: 'gh pr create --fill' }, out)).toEqual([['pr', 'https://github.com/o/app/pull/7']])
  expect(kinds('Bash', { command: 'gh pr checks --watch' }, out)).toEqual([['ci', 'https://github.com/o/app/actions/runs/42']])
  expect(kinds('Bash', { command: 'cat notes.md' }, out)).toEqual([])
})

test('SendUserFile names its files; its caption mentions nothing', () => {
  expect(kinds('SendUserFile', { files: ['/t/r.pdf'], caption: 'see /t/x.png' }, '')).toEqual([['file', '/t/r.pdf']])
})

test('strings walks nested values', () => {
  expect(strings({ a: 'x', b: [1, 'y', { c: 'z' }] })).toEqual(['x', 'y', 'z'])
})

test('toItem makes file links and labels', () => {
  const a = toItem({ kind: 'image', found: '/tmp/a b.png' }, 'Bash', 'Screenshot', 0, 'one')
  expect([a.href, a.label, a.title, a.turn]).toEqual(['file:///tmp/a%20b.png', 'a b.png', 'Screenshot', 'one'])
  expect(toItem({ kind: 'pr', found: 'https://github.com/o/app/pull/7' }, 'Bash', undefined, 0, '').label).toBe('app#7')
  expect(toItem({ kind: 'ci', found: 'https://github.com/o/app/actions/runs/42' }, 'Bash', undefined, 0, '').label).toBe(
    'app run 42',
  )
})

test('titleFrom prefers title, then page <title>, caption, description', () => {
  expect(titleFrom({ title: 'A', description: 'D' })).toBe('A')
  expect(titleFrom({ description: 'D' }, '<title>Page</title>')).toBe('Page')
  expect(titleFrom({ caption: 'C', description: 'D' })).toBe('C')
  expect(titleFrom({})).toBeUndefined()
})

test('titleFrom decodes the entities of a page <title>', () => {
  expect(titleFrom({}, '<title>Q&amp;A &#8212; R&#x26;D &copy;</title>')).toBe('Q&A — R&D &copy;')
})

test('when formats day, month and local time', () => {
  expect(when(new Date(2026, 9, 26, 9, 5).getTime())).toBe('26 Oct · 09:05')
})

test('copyText gives the plain path for files, the URL otherwise', () => {
  expect(copyText('file:///tmp/a%20b.png')).toBe('/tmp/a b.png')
  expect(copyText('https://claude.ai/artifact/x')).toBe('https://claude.ai/artifact/x')
})

test('groups puts newest first and keeps one heading per consecutive prompt', () => {
  const a = (f: string, turn: string) => toItem({ kind: 'image', found: f }, 'Bash', undefined, 0, turn)
  expect(groups([a('/t/1.png', 'one'), a('/t/2.png', 'one'), a('/t/3.png', 'two')]).map(g => [g.turn, g.items.map(i => i.label)])).toEqual([
    ['two', ['3.png']],
    ['one', ['2.png', '1.png']],
  ])
})

test('newest moves an item seen again to the top, under the prompt that brought it back', () => {
  const a = (f: string, turn: string, title?: string) => toItem({ kind: 'file', found: f }, 'Bash', title, 0, turn)
  const list = newest(newest([], [a('/t/r.pdf', 'one', 'old')]), [a('/t/b.png', 'two')])
  const again = newest(list, [a('/t/r.pdf', 'three', 'new'), a('/t/r.pdf', 'three', 'new')])
  expect(again.map(i => [i.label, i.turn, i.title])).toEqual([
    ['b.png', 'two', 'b.png'],
    ['r.pdf', 'three', 'new'],
  ])
})

test('iconOf picks an emoji per kind and per file extension', () => {
  const i = (kind: 'image' | 'file' | 'artifact', found: string) => iconOf(toItem({ kind, found }, 'Bash', undefined, 0, ''))
  expect(i('image', '/t/a.png')).toBe('📸')
  expect(i('file', '/t/a.pdf')).toBe('📕')
  expect(i('file', '/t/a.mp4')).toBe('🎬')
  expect(i('artifact', 'https://claude.ai/artifact/x')).toBe('🌐')
})

test('codeBlocks takes shell and SQL blocks, never plain or other-language ones', () => {
  const answer = [
    'Run this:',
    '```sql',
    'select count(*) from users',
    'where created_at > now() - interval 1 day;',
    '```',
    '```',
    'a mockup, no language',
    '```',
    '```ts',
    'const x = 1',
    '```',
    '```bash',
    'gh pr checks --watch',
    '```',
  ].join('\n')
  const got = codeBlocks(answer, 0, 'how many signups?')
  expect(got.map(a => [a.kind, a.title, a.label])).toEqual([
    ['sql', 'select count(*) from users', '2 lines · sql'],
    ['command', 'gh pr checks --watch', '1 line · bash'],
  ])
  expect(got[0]?.code).toBe('select count(*) from users\nwhere created_at > now() - interval 1 day;')
  expect(got[0]?.href).toBe(codeBlocks(answer, 9, 'other')[0]?.href)
})

test('riskOf: SQL warns about writes, deletes and slow queries, and says nothing else', () => {
  const lvl = (code: string) => riskOf('sql', code).level
  expect(lvl('select status, count(*) from events where created_at > now() - interval \'1 day\' group by status')).toBe('none')
  expect(lvl('select id from events limit 10')).toBe('none')
  expect(lvl('select count(*) from events')).toBe('heavy')
  expect(lvl('explain analyze select 1 from events where id = 1')).toBe('heavy')
  expect(lvl("select * from notes where body = 'drop table x'")).toBe('none')
  expect(lvl('insert into t values (1)')).toBe('write')
  expect(lvl('update users set name = 1 where id = 2')).toBe('write')
  expect(lvl('update users set name = 1')).toBe('destroy')
  expect(lvl('with gone as (delete from t returning id) select count(*) from gone')).toBe('destroy')
  expect(lvl('drop table t')).toBe('destroy')
  expect(lvl('set search_path = app')).toBe('write')
})

test('riskOf: commands warn about destruction and writes that are easy to miss, nothing else', () => {
  const lvl = (code: string) => riskOf('command', code).level
  expect(lvl('git log --oneline -5')).toBe('none')
  expect(lvl('cd ~/.claude/mods\ngit status --short')).toBe('none')
  expect(lvl('gh pr checks --watch')).toBe('none')
  expect(lvl('ls -la | grep png 2>&1')).toBe('none')
  expect(lvl('gh api -X DELETE repos/o/r')).toBe('destroy')
  expect(lvl('gh api -X PATCH repos/o/r -f name=x')).toBe('write')
  expect(lvl("curl -s https://example.com")).toBe('none')
  expect(lvl("curl -X POST https://example.com")).toBe('write')
  // An obvious write needs no mark: anyone reading it knows.
  expect(lvl('git push origin main')).toBe('none')
  expect(lvl('echo hi > notes.txt')).toBe('write')
  expect(lvl('sed -i "" s/a/b/ f')).toBe('write')
  expect(lvl('rm -rf build')).toBe('destroy')
  expect(lvl('git push --force origin main')).toBe('destroy')
  expect(lvl('sail artisan migrate:fresh')).toBe('destroy')
  expect(lvl('sail artisan cache:purge-uploads --force')).toBe('destroy')
  expect(lvl('find . -name "*.log" -delete')).toBe('destroy')
  expect(lvl('make deploy')).toBe('none')
  // The README image shows these two.
  expect(lvl('git branch -r')).toBe('none')
  expect(lvl('git push origin --delete preview/old-header')).toBe('destroy')
})

test('touchesProd spots production targets', () => {
  expect(touchesProd('deploy acme-prod')).toBe(true)
  expect(touchesProd('flyctl deploy')).toBe(false)
  expect(touchesProd('php artisan x --env=production')).toBe(true)
  expect(touchesProd('git log')).toBe(false)
  for (const code of [
    'psql -d myapp_production -c "select count(*) from users"',
    'psql "$PROD_DATABASE_URL" -c "select 1"',
    'kubectl --context gke_acme_europe-west1_prod get pods',
    'aws s3 ls --profile prd',
  ])
    expect([code, touchesProd(code)]).toEqual([code, true])
  for (const code of ['kubectl --env=nonprod get pods', 'NODE_ENV=production npm run build', 'cat products.csv'])
    expect([code, touchesProd(code)]).toEqual([code, false])
})

test('config: prod names and destroy entries add warnings', () => {
  const cfg = parseConfig('{"prod":["flyctl","/acme-(live|main)/"],"destroy":["purge-uploads"]}')!
  expect(touchesProd('flyctl deploy', cfg)).toBe(true)
  expect(touchesProd('psql acme-live', cfg)).toBe(true)
  expect(riskOf('command', 'sail artisan cache:purge-uploads', cfg)).toEqual({ level: 'destroy', why: 'purge-uploads (your config)' })
  expect(riskOf('command', 'sail artisan cache:purge-uploads').level).toBe('none')
})

test('parseConfig ignores what is not a list of strings, an old read list, and broken JSON', () => {
  expect(parseConfig('{"prod":"flyctl","read":["ls2"],"destroy":[1,"x"]}')).toEqual({ prod: [], destroy: ['x'] })
  expect(parseConfig('{nope')).toBeUndefined()
  expect(parseConfig('[]')).toEqual({ prod: [], destroy: [] })
})

test('matches: substring any case, or /regex/', () => {
  expect(matches('FLYCTL', 'flyctl deploy')).toBe(true)
  expect(matches('/^psql\\b/i', 'PSQL -c 1')).toBe(true)
  expect(matches('/[/', 'x')).toBe(false)
})
