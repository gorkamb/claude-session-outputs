import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'session-outputs',
  component: 'Pane',
  requestId: 'session-outputs',
  props: {
    title: 'Session outputs',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('a PR made in a turn shows under that prompt with a copy button', async ($, on) => {
  on('command.register', () => ({ value: { command: 'outputs' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('tool.call', () => ({ result: { stdout: 'https://github.com/o/acme-web/pull/7\n/tmp/s/new.png\n/tmp/s/gone.png' } }))
  on('fs.stat', (_, e) =>
    e.path === '/tmp/s/new.png' ? { value: { kind: 'file', size: 1, mtimeMs: Date.now(), isLink: false } } : { deny: 'ENOENT' },
  )
  on('fs.exists', (_, e) => ({ value: e.path === '/tmp/s/new.png' }))
  on('clock.every', () => ({ value: undefined }))
  // The reset timer never fires here, so «copied» stays to be read.
  on('clock.after', () => new Promise<never>(() => {}))
  let copiedText = ''
  on('ui.copy', (_, e) => {
    copiedText = e.text
    return { value: { isCopied: true } }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'open the PR', origin: { kind: 'composer' } } as never)
  await $.tool.call({ tool: 'Bash', command: 'gh pr create', description: 'Open the pull request' })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /open the PR/ }))?.text).toContain('open the PR')
    expect((await ui.find({ type: 'Text', text: /Open the pull request/ }))?.text).toContain('Open the pull request')
    expect(await ui.find({ type: 'Button', text: /copy link/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /copy path/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /· Bash/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /new\.png/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /gone\.png/ })).toBeUndefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'copy:https://github.com/o/acme-web/pull/7' })
  expect(copiedText).toBe('https://github.com/o/acme-web/pull/7')
  // onPress runs after press settles: give the state write a few turns to land.
  let label: string | undefined
  for (let i = 0; i < 50 && label === undefined; i++) label = (await ui.find({ type: 'Button', text: /copied/ }))?.text
  expect(label).toBe('copied ✓')
  await ui.unmount()
})

test('a block with nothing dangerous carries no mark, never a safe one', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.turn.complete({ answer: '```bash\ngit status\n```', durationMs: 1, isAborted: false, turnId: 't', reason: 'completed' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /git status/ }))?.text).toContain('git status')
  expect(await ui.find({ type: 'Text', text: /read-only|●|▲|⛔/ })).toBeUndefined()
  await ui.unmount()
})

test('a SQL block in the answer shows as a query to copy, whole', async ($, on) => {
  let copiedText = ''
  on('ui.copy', (_, e) => {
    copiedText = e.text
    return { value: { isCopied: true } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.after', () => new Promise<never>(() => {}))
  on('turn.complete', (_, e) => ({ text: e.answer }))

  const sql = 'select count(*)\nfrom signups;'
  await $.turn.complete({
    answer: `Run this read:\n\n\`\`\`sql\n${sql}\n\`\`\`\n`,
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    reason: 'completed',
  } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /select count/ }))?.text).toContain('select count(*)')
  expect((await ui.find({ type: 'Text', text: /whole table/ }))?.text).toContain('▲ whole table')
  const button = await ui.find({ type: 'Button', text: /copy query/ })
  expect(button).toBeDefined()
  await ui.press({ key: button?.key ?? '' })
  expect(copiedText).toBe(sql)
  await ui.unmount()
})

test('every entry is drawn, however short the pane: the engine scrolls the rest', async ($, on) => {
  let n = 0
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', () => ({ result: { stdout: `/tmp/s/shot-${++n}.png` } }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: Date.now(), isLink: false } }))
  for (let i = 0; i < 12; i++) await $.tool.call({ tool: 'Bash', command: 'screencapture', description: `Shot ${i}` })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, scroll: { offset: 0, bodyRows: 6 } } })
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(12)
  expect((await ui.find({ type: 'Text', text: /📸 12/ }))?.text).toContain('📸 12')
  await ui.unmount()
})

test('a new session with nothing to show does not open the pane', async ($, on) => {
  let opened = 0
  on('ui.open', () => {
    opened++
    return { value: { isPlaced: true } }
  })
  on('clock.every', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'outputs' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(opened).toBe(0)
})

test("the project's config is found from a subfolder up to the repository root", async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'outputs' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/ana' : undefined }))
  const files: Record<string, string> = {
    '/home/ana/work/acme/.claude/session-outputs.json': '{"prod":["flyctl"]}',
    '/home/ana/work/acme/.git': '',
    '/home/ana/work/.claude/session-outputs.json': '{"destroy":["flyctl"]}',
  }
  on('fs.exists', (_, e) => ({ value: e.path in files }))
  on('fs.read', (_, e) => (e.path in files ? { value: files[e.path] } : { deny: 'ENOENT' }))
  on('session.cwd', () => ({ value: '/home/ana/work/acme/web/src' }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.session.start({ cwd: '/home/ana/work/acme/web/src', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: '```bash\nflyctl status\n```', durationMs: 1, isAborted: false, turnId: 't', reason: 'completed' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /· prod/ })).toBeDefined()
  // The walk stops at the repository root, so the folder above it adds nothing: no red.
  expect(await ui.find({ type: 'Text', text: /⛔/ })).toBeUndefined()
  await ui.unmount()
})

test('a command seen again moves under the prompt that brought it back', async ($, on) => {
  let opened = 0
  on('ui.open', () => {
    opened++
    return { value: { isPlaced: true } }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  const answer = (text: string) =>
    $.turn.complete({ answer: text, durationMs: 1, isAborted: false, turnId: 't', reason: 'completed' } as never)
  await $.prompt.submit({ text: 'first ask', origin: { kind: 'composer' } } as never)
  await answer('```bash\ngit status\n```')
  await $.prompt.submit({ text: 'second ask', origin: { kind: 'composer' } } as never)
  await answer('```bash\ngit status\n```')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /second ask/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /first ask/ })).toBeUndefined()
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(1)
  // Moving an entry is not news: a pane the person closed stays closed.
  expect(opened).toBe(1)
  await ui.unmount()
})

test('the walk for the project file stops at the repository root', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'outputs' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/ana/' : undefined }))
  const files: Record<string, string> = {
    '/home/ana/work/other/.git': '',
    '/home/ana/work/.claude/session-outputs.json': '{"prod":["flyctl"]}',
  }
  on('fs.exists', (_, e) => ({ value: e.path in files }))
  on('fs.read', (_, e) => (e.path in files ? { value: files[e.path] } : { deny: 'ENOENT' }))
  on('session.cwd', () => ({ value: '/home/ana/work/other/src' }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  await $.session.start({ cwd: '/home/ana/work/other/src', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: '```bash\nflyctl status\n```', durationMs: 1, isAborted: false, turnId: 't', reason: 'completed' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /flyctl status/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /· prod/ })).toBeUndefined()
  await ui.unmount()
})

test('a file written again moves up without reopening the pane', async ($, on) => {
  let opened = 0
  on('ui.open', () => {
    opened++
    return { value: { isPlaced: true } }
  })
  on('tool.call', () => ({ result: { stdout: '/tmp/s/shot.png' } }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: Date.now(), isLink: false } }))
  await $.tool.call({ tool: 'Bash', command: 'screencapture', description: 'First shot' })
  await $.tool.call({ tool: 'Bash', command: 'screencapture', description: 'Second shot' })
  expect(opened).toBe(1)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Second shot/ })).toBeDefined()
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(1)
  await ui.unmount()
})
