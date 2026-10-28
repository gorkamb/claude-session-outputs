import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Item, Config, Kind } from '../types'

const PANE = 'session-outputs'
const TITLE = 'Session outputs'
// What the session made for the person, oldest first: only what exists, never what was merely mentioned.
const items = atom({ plugin: 'session-outputs', key: 'items' } as const, [], {
  shape: 'items-1',
})
// The person's last prompt: the group each new item lands in.
const turn = atom({ plugin: 'session-outputs', key: 'turn' } as const, '', {
  shape: 'turn-1',
})
// The href whose copy button reads «copied» for a moment.
const copied = atom({ plugin: 'session-outputs', key: 'copied' } as const, '', {
  shape: 'copied-1',
})
const COPIED_MS = 1500
// What ~/.claude/session-outputs.json and the project's .claude/session-outputs.json add, merged.
const config = atom({ plugin: 'session-outputs', key: 'config' } as const, { prod: [], destroy: [] }, {
  shape: 'config-2',
})
const CONFIG_FILE = 'session-outputs.json'
const CONFIG_PATH = /[\\/]session-outputs\.json\b/

// Ends at the id (22 letters and digits, or a UUID), so text right after the link stays out.
// A doc's link may carry its title before the id: /artifact/<title>-<id>.
const ARTIFACT =
  /https:\/\/claude\.ai\/(?:code\/)?artifact\/(?:[^\s/?#"'`<>()[\]{}]*-)?(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[A-Za-z0-9]{16,40})/u
const PR = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g
// One entry per run: the per-job links of `gh pr checks` fold into it.
const CI = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+/g
// An absolute path standing on its own, POSIX or Windows: not the tail of `assets/x.png` or of a URL.
const PATH = /(?<![\p{L}\p{N}_.~:/\\-])(?:[A-Za-z]:)?(?:[\\/][\p{L}\p{N}_.@%+-]+)+\.(?:png|jpe?g|webp|gif|pdf|mp4|webm|html?)\b/giu
// The same in quotes, where it may hold spaces (macOS names screenshots "Screenshot … at 10.22.png").
const QUOTED_PATH = /(["'])((?:[A-Za-z]:)?[\\/][^"'\n]*?\.(?:png|jpe?g|webp|gif|pdf|mp4|webm|html?))\1/gi
const isPath = (s: string) => /^(?:[A-Za-z]:)?[\\/]/.test(s)
const HTML_TITLE = /<title>([^<]*)<\/title>/i
const HTML_PAGE = /\.html?$/i

/** Every string inside a value: the fields of a tool's input or result, newlines intact. */
export function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const one of v) strings(one, out)
  else if (v !== null && typeof v === 'object') for (const one of Object.values(v)) strings(one, out)
  return out
}

function labelOf(kind: Kind, found: string): string {
  const parts = found.split(/[\\/]/)
  if (kind === 'pr') return `${parts[4]}#${parts[6]}`
  if (kind === 'ci') return `${parts[4]} run ${parts[7]}`
  return parts.pop() ?? found
}

export type Candidate = { kind: Kind; found: string }

/**
 * What a call may have made for the person, before the disk is asked.
 * URLs only from what a tool answered, never from what it was asked: a link
 * named in a command is a mention. Artifacts from an Artifact publish, PRs from
 * `gh pr create`, runs from `gh pr checks`/`gh run`. Paths from both sides;
 * the hook keeps the ones that exist and the call wrote.
 */
export function candidates(tool: string, input: Record<string, unknown>, result: unknown): Candidate[] {
  const said = strings(result).join('\n')
  const out: Candidate[] = []
  const add = (kind: Kind, re: RegExp, text: string) => {
    for (const found of new Set(text.match(re) ?? [])) out.push({ kind, found })
  }
  const command = typeof input.command === 'string' ? input.command : ''
  // Hosts without the Artifact tool publish through the claude-artifacts MCP server instead, under
  // its own name or a plugin's.
  const publish =
    tool === 'Artifact' ? input.action === undefined || input.action === 'publish' : /^mcp__(plugin_[\w-]+_)?claude-artifacts__publish/.test(tool)
  // A Claude Docs document counts when the batch creates it; edits to an existing one do not.
  const made: Kind | undefined = publish && input.asset !== true ? 'artifact' : isDocBirth(tool, input) ? 'doc' : undefined
  // The first link is the one made: the rest are what it came from (an Artifact type, design systems).
  const link = made === undefined ? undefined : ARTIFACT.exec(said)?.[0]
  if (made !== undefined && link !== undefined) out.push({ kind: made, found: link })
  if (tool === 'Bash' && /\bgh\s+pr\s+create\b/.test(command)) add('pr', PR, said)
  if (tool === 'Bash' && /\bgh\s+(pr\s+checks|run)\b/.test(command)) add('ci', CI, said)
  const files = tool === 'SendUserFile' ? strings(input.files) : [...strings(input), said]
  const text = files.join('\n')
  // A page is the person's to open when written whole or printed, not when a source file is edited
  // or when it is what an Artifact publish read.
  const pages = !/^(Edit|MultiEdit|NotebookEdit)$/.test(tool) && made === undefined
  for (const found of new Set([...(text.match(PATH) ?? []), ...[...text.matchAll(QUOTED_PATH)].map(m => m[2] ?? '')]))
    if (pages || !HTML_PAGE.test(found)) out.push({ kind: /\.(pdf|mp4|webm|html?)$/i.test(found) ? 'file' : 'image', found })
  return out
}

export function toItem(c: Candidate, tool: string, title: string | undefined, at: number, turn: string): Item {
  const label = labelOf(c.kind, c.found)
  const posix = c.found.replace(/\\/g, '/')
  const href = isPath(c.found) ? `file://${encodeURI(/^[A-Za-z]:/.test(posix) ? `/${posix}` : posix)}` : c.found
  return { href, title: title ?? label, label, kind: c.kind, tool, at, turn }
}

/** Filesystem mtimes can trail the wall clock a little. */
const MTIME_SLACK_MS = 2000
const PRUNE_EVERY_MS = 10_000

// What the call says it is for: Artifact's title or the page's <title>, a caption, a Bash description.
export function titleFrom(input: Record<string, unknown>, html?: string): string | undefined {
  const pick = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)
  return pick(input.title) ?? pick(docCreate(input)?.name) ?? pick(unescapeHtml(html?.match(HTML_TITLE)?.[1])) ?? pick(input.caption) ?? pick(input.description)
}

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
const unescapeHtml = (s?: string) =>
  s?.replace(/&(?:#(\d{1,7})|#x([\da-f]{1,6})|(\w+));/gi, (m, dec?: string, hex?: string, name?: string) =>
    name !== undefined ? (ENTITY[name.toLowerCase()] ?? m) : String.fromCodePoint(Math.min(0x10ffff, parseInt(dec ?? hex ?? '', dec ? 10 : 16))),
  )

// The `create` of a Claude Docs batch: present only when the call makes a new document.
function docCreate(input: Record<string, unknown>): Record<string, unknown> | undefined {
  const create = (input.container as { create?: unknown } | undefined)?.create
  return create !== null && typeof create === 'object' && !Array.isArray(create) ? (create as Record<string, unknown>) : undefined
}
const isDocBirth = (tool: string, input: Record<string, unknown>) =>
  /^mcp__.*Claude_Docs__batch$/.test(tool) && docCreate(input) !== undefined

// What a copy hands over: the path itself for a file (backslashes again on Windows), else the URL.
export function copyText(href: string): string {
  if (!href.startsWith('file://')) return href
  const path = decodeURI(href.slice(7))
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1).replace(/\//g, '\\') : path
}

// Blocks in an answer that are for the person to run: shell and SQL, marked with their language,
// any case, and indented when they sit inside a list item. Only a bare fence closes one, indented
// at most 3 spaces past the opening one, as in CommonMark: a ```js inside a heredoc is part of the
// command, and so is a fence indented as code.
const OPEN_FENCE = /^([ \t]*)(`{3,}|~{3,})(sql|psql|postgresql|postgres|pgsql|plpgsql|mysql|sqlite|bash|sh|zsh|shell|console|powershell|pwsh|ps1|cmd|bat|batch)[ \t]*$/i
const SQL_LANGS = new Set(['sql', 'psql', 'postgresql', 'postgres', 'pgsql', 'plpgsql', 'mysql', 'sqlite'])
// The closing fence is the opening one's character, at least as many times.
const closer = (fence: string) => new RegExp(`^ {0,3}${fence[0] === '~' ? '~' : '`'}{${fence.length},}[ \\t]*$`)
const closes = (line: string, indent: string, close: RegExp) => close.test(line.startsWith(indent) ? line.slice(indent.length) : line)

function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

export function codeBlocks(answer: string, at: number, turn: string): Item[] {
  const out: Item[] = []
  const all = answer.split(/\r?\n/)
  for (let i = 0; i < all.length; i++) {
    const open = OPEN_FENCE.exec(all[i] ?? '')
    if (open === null) continue
    const indent = open[1] ?? ''
    const close = closer(open[2] ?? '```')
    const lang = (open[3] ?? '').toLowerCase()
    let end = i + 1
    while (end < all.length && !closes(all[end] ?? '', indent, close)) end++
    // No closing fence below this one means none below any later one either.
    if (end === all.length) break
    let lines = all.slice(i + 1, end).map(l => (l.startsWith(indent) ? l.slice(indent.length) : l))
    i = end
    // A console block mixes commands and their output: keep the commands, with their `> ` continuations.
    if (lang === 'console' && lines.some(l => l.startsWith('$ '))) {
      const kept: string[] = []
      let inCommand = false
      for (const l of lines) {
        if (l.startsWith('$ ')) kept.push(l.slice(2))
        else if (inCommand && l.startsWith('> ')) kept.push(l.slice(2))
        inCommand = l.startsWith('$ ') || (inCommand && l.startsWith('> '))
      }
      lines = kept
    }
    const code = lines.join('\n').replace(/\s+$/, '')
    const href = `code:${hash(code)}`
    if (code.trim() === '' || out.some(a => a.href === href)) continue
    const kind: Kind = SQL_LANGS.has(lang) ? 'sql' : 'command'
    const first = code.split('\n').find(l => l.trim() !== '')?.trim() ?? ''
    const count = code.split('\n').length
    out.push({
      href,
      title: first.length > 70 ? `${first.slice(0, 69)}…` : first,
      label: `${count} ${count === 1 ? 'line' : 'lines'} · ${lang}`,
      kind,
      tool: 'answer',
      at,
      turn,
      code,
    })
  }
  return out
}

// ---------- risk of a command or query ----------
// Warnings only. Nothing is ever called safe: no mark means "not checked", and the person still
// reads what they paste. Four passes of review showed that proving a command only reads is not
// possible from its text; spotting what is dangerous is, and a miss costs one warning, not a promise.
//   destroy: deletes, drops, wipes, force-pushes.
//   write:   writes that are easy to miss when reading (curl -X POST, sed -i, a > redirect).
//   heavy:   a query that may be slow (no where, no limit; explain analyze).

export type Risk = { level: 'none' | 'heavy' | 'write' | 'destroy'; why: string }
const RANK: Risk['level'][] = ['none', 'heavy', 'write', 'destroy']
const worse = (a: Risk, b: Risk) => (RANK.indexOf(b.level) > RANK.indexOf(a.level) ? b : a)
const NONE: Risk = { level: 'none', why: '' }

export const NO_CONFIG: Config = { prod: [], destroy: [] }

/** An entry is a substring, any case, or a regular expression written /pattern/flags. */
export function matches(entry: string, text: string): boolean {
  const re = /^\/(.+)\/([a-z]*)$/.exec(entry)
  if (re === null) return text.toLowerCase().includes(entry.toLowerCase())
  try {
    return new RegExp(re[1] ?? '', (re[2] ?? '').replace('g', '')).test(text)
  } catch {
    return false
  }
}

function configDestroy(code: string, cfg: Config): Risk | undefined {
  const hit = cfg.destroy.find(entry => matches(entry, code))
  return hit === undefined ? undefined : { level: 'destroy', why: `${hit} (your config)` }
}

const SQL_DESTROY = /\b(drop|truncate|delete)\b/i
const SQL_WRITE =
  /\b(insert|update|merge|upsert|replace\s+into|alter|(?<!show\s+)create|grant|revoke|copy|call|do|vacuum|reindex|cluster|lock|refresh|into|comment\s+on|security\s+label|for\s+(update|no\s+key\s+update|(key\s+)?share)|load\s+data|rename|import|attach|detach|pragma\s+[\w.]+(?=\s*=)|pragma\s+(\w+\.)?(wal_checkpoint|shrink_memory|incremental_vacuum)|handler|kill|shutdown|install|uninstall|flush|purge|optimize|repair)\b/i
// Statements that change the session or run another one.
const SQL_STATEMENT_WRITE = /^(set|reset|execute|prepare|notify|discard|load|savepoint|release|rollback\s+to)\b/i
// Functions with side effects, as a call (also quoted or schema-qualified): sequences, other
// sessions, server files and settings, other databases, shell access.
const SQL_SIDE_EFFECT = new Set(['setval', 'nextval', 'pg_terminate_backend', 'pg_cancel_backend', 'pg_reload_conf',
  'pg_rotate_logfile', 'set_config', 'dblink', 'dblink_exec', 'dblink_send_query', 'lo_import', 'lo_export', 'lo_unlink',
  'lo_from_bytea', 'lo_put', 'pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'pg_stat_file', 'pg_file_write',
  'pg_switch_wal', 'pg_create_restore_point', 'pg_logical_emit_message', 'pg_advisory_lock', 'pg_advisory_xact_lock',
  'pg_try_advisory_lock', 'pg_notify', 'load_file', 'sys_exec', 'sys_eval', 'xp_cmdshell', 'sp_configure', 'get_lock',
  'release_lock', 'master_pos_wait', 'source_pos_wait'])

// Strings become '', quoted names x_ (so a quoted call is still a call) and comments a space, in
// one pass so `'--'` hides nothing. Postgres also quotes with $$; MySQL escapes with a backslash,
// quotes names with backticks, comments with # and `-- `, and runs what /*! … */ holds. Read both
// ways and keep the worse, so neither dialect can hide a delete from the other.
// A $ right after a name is part of it (a$q$ is a name), a tag may hold any letter ($é$), and E'…'
// takes backslash escapes. MariaDB runs /*M! … */ too. An unclosed comment, $-quote or MySQL string runs to the end:
// the server refuses it, so it hides nothing, and the scan stays linear.
const STANDARD =
  /(?<![\p{L}\p{N}_$])\$([\p{L}_][\p{L}\p{N}_]*)?\$[\s\S]*?(?:\$\1\$|$)|(?<![\p{L}\p{N}_$])[Ee]'(?:[^'\\]|\\.|'')*'|'(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/gu
const MYSQL = /'(?:[^'\\]|\\.|'')*(?:'|$)|"(?:[^"\\]|\\.|"")*(?:"|$)|`[^`]*`|\/\*(?:[!+]|M!)\d*|--(?=\s|$)[^\n]*|#[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g
function blank(code: string, re: RegExp): string {
  const names = re === STANDARD ? '"`' : '`'
  return code.replace(re, m => (/^([Ee]?'|\$)/.test(m) || (m[0] === '"' && !names.includes('"')) ? "''" : names.includes(m[0] ?? '') ? 'x_' : ' '))
}

function sqlLevel(text: string): Risk {
  const statements = text.split(';').map(st => st.trim()).filter(st => st !== '')
  if (/\\(gexec|g\s*\||!)/.test(text)) return { level: 'destroy', why: 'runs what the query prints' }
  if (SQL_DESTROY.test(text)) return { level: 'destroy', why: 'deletes or drops' }
  // Read at the statement's own level: a where in a subquery filters nothing, and the update may
  // follow a with or an explain analyze.
  const tops = statements.map(topLevel)
  for (const top of tops) {
    const up = /\bupdate\s+(?:only\s+)?[\w."`$]+(?:\s+(?:as\s+)?\w+)?\s+set\b/i.exec(top)
    if (up !== null && !/\bwhere\b/i.test(top.slice(up.index))) return { level: 'destroy', why: 'update without where' }
  }
  // psql meta-commands that write a file, run one, or send output somewhere.
  if (/\\(o|out|w|write|copy|i|include|ir|include_relative|lo_\w+|setenv|cd)\b|\\gx?(?![a-z])\s*[^\s;|]/.test(text)) return { level: 'write', why: 'psql meta-command' }
  if (SQL_WRITE.test(text)) return { level: 'write', why: 'writes' }
  const st = statements.find(s => SQL_STATEMENT_WRITE.test(s))
  if (st !== undefined) return { level: 'write', why: `${st.split(/\s/)[0]?.toLowerCase()} statement` }
  // A name starts only after a non-name character, so a.a.a… is scanned once, not once per letter.
  for (const [, name] of text.matchAll(/(?<![\p{L}\p{N}_.$])([\p{L}_][\p{L}\p{N}_.$]*)\s*\(/gu)) {
    const fn = (name ?? '').toLowerCase().split('.').pop() ?? ''
    if (fn === 'x_') return { level: 'write', why: 'a function with a quoted name' }
    if (SQL_SIDE_EFFECT.has(fn)) return { level: 'write', why: `${fn}() has side effects` }
  }
  if (/\bexplain\s+(\(\s*)?analy[sz]e\b/i.test(text)) return { level: 'heavy', why: 'explain analyze runs the query' }
  if (/\b(pg_sleep|sleep|benchmark)\s*\(|\bcross\s+join\b|\bgenerate_series\b/i.test(text)) return { level: 'heavy', why: 'heavy query' }
  for (const st of tops)
    if (/^table\b/i.test(st) || (/\bfrom\b/i.test(st) && !/\bwhere\b/i.test(st) && !/\blimit\b/i.test(st)))
      return { level: 'heavy', why: 'whole table: no where, no limit' }
  return NONE
}

// The text outside parentheses: extract(epoch from now()) has no from of its own.
function topLevel(st: string): string {
  let [out, depth] = ['', 0]
  for (const c of st) {
    if (c === '(') depth++
    else if (c === ')') depth = Math.max(0, depth - 1)
    else if (depth === 0) out += c
  }
  return out
}

// Statements that run a string: do '…', prepare … from '…', execute '…' (also inside a $$ body),
// sp_executesql, \set v '…' then :v.
const RUNS_STRINGS = /(^|;)\s*do\b|\bprepare\b[^;]*\bfrom\b|\bexec(ute)?\b|\bsp_executesql\b|\\set\b/i
// Their strings, unescaped. An unclosed $-quote runs to the end, as in STANDARD; an unclosed ' is
// already left as code there.
const LITERAL = /'((?:[^']|'')*)'|(?<![\p{L}\p{N}_$])\$([\p{L}_][\p{L}\p{N}_]*)?\$([\s\S]*?)(?:\$\2\$|$)/gu

function sqlRisk(code: string, depth = 0): Risk {
  let r = worse(sqlLevel(blank(code, STANDARD)), sqlLevel(blank(code, MYSQL)))
  if (depth < 3 && RUNS_STRINGS.test(blank(code, STANDARD)))
    for (const m of code.matchAll(LITERAL)) r = worse(r, sqlRisk(m[1]?.replace(/''/g, "'") ?? m[3] ?? '', depth + 1))
  return r
}

// git with its global options (-C dir, --git-dir=…) before the subcommand.
const GIT = String.raw`^git(?:\s+(?:-[Cc]\s+\S+|--[\w-]+(?:=\S+)?))*\s+`
// Checked one command at a time, so a push rule never reaches past `&&` into the next command.
const CMD_DESTROY: [RegExp, string][] = [
  [/(^|[\s(`'":]|\/)rm(\s|$)/, 'rm'],
  [/^(del|erase|ri|rd|rmdir|unlink|rimraf)(\s|$)|^(npx|pnpx|bunx)(\s+-\S+)*\s+rimraf\b|\bRemove-\w+|\bClear-(Content|Item|RecycleBin|Disk)\b|\bFormat-Volume\b/i, 'removes files'],
  [
    new RegExp(
      GIT +
        String.raw`(reset\b.*\s--hard\b|clean\b.*\s(-\w*f|--force)\b|branch\b.*\s-\w*D|checkout\b(.*\s(--|-f|--force)(\s|$)|\s+\.(\s|$))|restore\b(?=(?!.*\s(--staged|-S)\b)|.*\s(--worktree|-W)\b)|stash\s+(drop|clear)\b|reflog\s+(expire|delete)\b|gc\b.*--prune|filter-(branch|repo)\b|update-ref\s+-d\b)`,
    ),
    'discards git work',
  ],
  [new RegExp(GIT + String.raw`push\b.*(\s-\w*[fd]\w*\b|--force|--delete|--mirror|--prune|\s\+\S|\s:\S)`), 'force push or branch delete'],
  [/\b(migrate:(fresh|reset|refresh|rollback)|db:(wipe|drop|reset|purge|schema:load|structure:load|truncate_all|seed:replant))\b/, 'wipes the database'],
  [/\bmanage\.py\s+(flush|reset_db|sqlflush)\b|\bmanage\.py\s+migrate\s+\S+\s+zero\b/, 'wipes the database'],
  [/^(dropdb|dropuser)\b|^pg_restore\b.*\s(--clean|-\w*c)\b/, 'drops a database'],
  [/\.(dropDatabase|drop|dropIndexes|deleteMany|deleteOne|findOneAndDelete|remove|delete)\s*\(/, 'deletes'],
  [/^redis-cli\b.*\s(del|unlink)\b/i, 'deletes keys'],
  // Anchored lookaheads, each one pass: nested .* went quadratic on `docker down down down…`.
  [/^docker\b(?:(?=.*\b(?:volume\s+(?:rm|prune)|system\s+prune)\b)|(?=.*\bdown\b)(?=.*(?:\s-v\b|--volumes)))/, 'removes docker data'],
  [/^(terraform|tofu|terragrunt|pulumi|cdk|cdktf)\b.*(\s|^)-{0,2}destroy\b/, 'destroys infrastructure'],
  [/^helm\b.*\s(uninstall|delete|del)\b/, 'uninstalls a release'],
  [/^aws\s+s3\s+rb\b|\bterminate-\w|^gsutil\b.*\s(rb|rm)\b|^gsutil\b.*\srsync\b.*\s-\w*d/, 'deletes cloud resources'],
  [/^crontab\b.*\s-\w*r/, 'removes the crontab'],
  [/\bflush(all|db)\b/i, 'empties a database'],
  // Whole words only: not --cap-drop, routes/delete.ts or '*delete*'; --delete and -delete count.
  [/(?<![\w/.*]|\w-)(drop|truncate)(?![\w./*])/i, 'drops or truncates'],
  [/(?<![\w/.*]|\w-)delete(?![\w./*])/i, 'deletes'],
  [/^(dd|mkfs\S*|shred)\s/, 'overwrites a disk or file'],
  [/^(?=.*\bartisan\b).*\s--force\b/, 'artisan --force skips the production prompt'],
]
// Searches name what they look for: `grep -r delete` deletes nothing.
const SEARCH = /^(grep|egrep|fgrep|rg|ag|git\s+(log|grep))\b/
// A git message is prose: `git commit -m "Delete unused helpers"` deletes nothing. One that runs a
// substitution is not, so it stays.
const MESSAGE = /(\s(?:-m|--message)(?:=|\s+))(?:"(?:\\.|[^"\\$`])*"|'[^']*'|[^\s"'$`]+)/g
// `> file` alone empties it.
const EMPTIES_FILE = /^(?::|true|cat\s+\/dev\/null)?\s*>(?![>&])\s*\S|^cp\s+\/dev\/null\s/
// Clients whose quoted arguments are queries: psql -c "…" is read as SQL.
const DB_CLIENT = /^(psql|mysql|mariadb|sqlite3?|duckdb|clickhouse(-client)?|sqlcmd|cockroach\s+sql)\b/

// Quoted text and $(…) hold commands of their own (ssh host '…', bash -c '…', grep x "$(…)"), read
// a few levels deep. A search runs only its substitutions: grep -r "delete" names what it looks for.
// An unclosed quote runs to the end, so a run of \" is scanned once.
const QUOTED = /"((?:\\.|[^"\\])*)(?:"|$)|'([^']*)'/g
const SUBST = /\$\(([^()]*(?:\([^()]*\)[^()]*)*)\)|`([^`]*)`/g
const bodies = (seg: string, re: RegExp) => [...seg.matchAll(re)].map(m => m[1] ?? m[2] ?? '')
function pieces(segs: string[], depth = 0): string[] {
  const out: string[] = []
  for (let seg of trimSeg(segs)) {
    if (/^git\b/.test(seg)) seg = seg.replace(MESSAGE, '$1')
    const search = SEARCH.test(seg)
    if (!search) out.push(seg)
    if (depth < 3)
      for (const body of [...bodies(seg, SUBST), ...(search ? [] : bodies(seg, QUOTED))]) out.push(...pieces(split(body).segs, depth + 1))
  }
  return out
}

// Commands whose writes hide in an option, and what in their arguments writes or runs something.
// Short flags are read glued too: -XPOST, -d@f, -Ei. The third part names long options: GNU getopt
// and git take any unambiguous prefix (--in for --in-place), so any prefix of one counts, and so does
// one with a tail (--data-binary for --data), unless the fourth part says the tool takes names whole.
// The first rule that names the command decides.
const CMD_WRITE_OPTS: [RegExp, (RegExp | ((args: string) => boolean))?, string[]?, boolean?][] = [
  // A refspec src:dst writes a branch; a URL or user@host:path is the remote.
  [/^git\s+fetch(?=\s|$)/, /\s(?![\w+.-]*:\/\/|[^\s:]*@)\S*:\S|\s\+\S|\s-\w*p\b/, ['upload-pack', 'set-upstream', 'prune', 'prune-tags', 'write-commit-graph']],
  [/^git\s+ls-remote(?=\s|$)/, /\s-u\b/, ['upload-pack']],
  [/^git\s+(log|diff|show|format-patch)(?=\s|$)/, undefined, ['output']],
  [/^git\s+grep(?=\s|$)/, /\s-\w*O/, ['open-files-in-pager']],
  [/^gh\s+api(?=\s|$)/, ghApiWrites],
  // -Q sends commands to an FTP/SFTP server; any scheme but http(s) may send raw bytes (gopher, telnet…).
  // curl's flags are case-sensitive (-f fails, -F posts a form) and its long options take no prefix.
  [
    /^curl(?=\s|$)/,
    /\s-[a-zA-Z]*[XdFTKoOcDQ]|%output|(?<![\w+.-])(?![hH][tT][tT][pP][sS]?:)[a-zA-Z][\w+.-]*:\/\//,
    ['request', 'data', 'data-binary', 'data-raw', 'data-urlencode', 'data-ascii', 'form', 'form-string', 'upload-file', 'json', 'config', 'output', 'remote-name', 'remote-name-all', 'cookie-jar', 'dump-header', 'trace', 'trace-ascii', 'stderr', 'libcurl', 'etag-save', 'hsts', 'alt-svc', 'quote', 'ssl-sessions', 'proto-default'],
    true,
  ],
  [/^wget(?=\s|$)/, /\s-[a-zA-Z]*[O]|--post/],
  [/^find(?=\s|$)/, /\s-(delete|exec|execdir|ok|okdir|fprint\w*|fls)\b/],
  // sed runs programs with e and writes with w/W, as commands or as flags of s: any of them counts.
  // A command starts the script or follows an address, ; or {; a flag closes an s command. Delimiters
  // are punctuation, so a scan for the closing one can only restart once per kind: linear.
  [/^sed(?=\s|$)/, /\s-[a-zA-Z]*[ifI]|(?:^|[\s;{}!\d$,])(?:[ewW](?=\s|;|$)|s([^\w\s\\])(?:\\.|(?!\1).)*\1(?:\\.|(?!\1).)*\1[gpiImM\d]*[ewW])/, ['in-place', 'file']],
  // gawk: -i inplace writes, -l loads an extension, -p/-d/-o write a file; system(), print | "cmd" and
  // print > "file" run or write one. A | elsewhere is a regex or -F'|'.
  [/^awk(?=\s|$)/, /\bsystem\s*\(|\s-[a-zA-Z]*[ildop]\b|@load|getline|\bprintf?\b[^;}\n]*[|>]/, ['include', 'load', 'profile', 'dump-variables', 'pretty-print', 'debug']],
  [/^(yq|perl|ruby)(?=\s|$)/, /\s-[a-zA-Z]*i/, ['inplace', 'in-place']],
  [/^sort(?=\s|$)/, /\s-[a-zA-Z]*o/, ['output', 'compress-program']],
  [/^rg(?=\s|$)/, undefined, ['pre', 'hostname-bin']],
  [/^docker\s+compose\s+config(?=\s|$)/, /\s-[a-zA-Z]*o/, ['output']],
  [/^aws\s+[a-z0-9][a-z0-9-]*\s+(describe|list|get)-[\w-]+(?=\s|$)/, /get-object\b/, ['outfile', 'auto-create']],
  // Tools people take for readers: uniq in out writes out, less +!cmd runs cmd.
  [/^uniq(?=\s|$)/, /\s[^-\s]\S*\s+(?:-\S*\s+)*[^-\s]/, ['output']],
  [/^tree(?=\s|$)/, /\s-\w*o\b/],
  [/^date(?=\s|$)/, /\s-\w*s\b/, ['set']],
  [/^less(?=\s|$)/, /\s\+\S*!|\s-\w*o\b/, ['log-file']],
  [/^file(?=\s|$)/, /\s-\w*C/, ['compile']],
  [/^((\.\/vendor\/bin\/)?sail|php)\s+artisan\s+env:(de|en)crypt(?=\s|$)/, /^/],
]
// Streaming aws commands take their output file as a bare argument: any word that is not an option's
// value. A boolean option looks like one that takes a value, so for the streaming ones a value that
// looks like a path counts as well. Words are read as the shell does: a quoted --query is one.
const AWS_STREAMS = /^get-(object(-torrent)?|job-output|media|clip|media-for-fragment-list|snapshot-block|raw-message-content|package-version-asset)$/
function awsPositional(seg: string): boolean {
  const words = seg.match(/(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s"'])+/g) ?? []
  const get = AWS_STREAMS.test(words[2] ?? '')
  for (let i = 3; i < words.length; i++) {
    const w = words[i] ?? ''
    if (!w.startsWith('-')) return true
    if (!w.includes('=') && !(words[i + 1] ?? '-').startsWith('-')) {
      i++
      if (get && /[./\\]/.test(words[i] ?? '')) return true
    }
  }
  return false
}
const longHit = (args: string, longs: string[] = [], exact = false) =>
  [...args.matchAll(/(?:^|\s)--([\w-]+)/g)].some(([, tok = '']) => longs.some(d => (exact ? d === tok : d.startsWith(tok) || tok.startsWith(d))))

// gh api sends a POST once it has fields, unless told GET (fields become the query string). A GraphQL
// query reads; a mutation, or a query read from a file, may write.
function ghApiWrites(args: string): boolean {
  const method = /\s(?:-[a-zA-Z]*X\s*|--method[=\s]+)(\w+)/.exec(args)?.[1]
  if (method !== undefined) return !/^(GET|HEAD)$/i.test(method)
  if (!/\s(?:-[a-zA-Z]*[fF]|--(?:raw-)?field\b|--input\b)/.test(args)) return false
  return !/\sgraphql(?:\s|$)/.test(args) || /\bmutation\b|=@/.test(args)
}

// Variables that make a harmless-looking command run a program: GIT_PAGER=./x.sh git log.
const RUNS_ENV = /^(\w*PAGER|\w*EDITOR|VISUAL|GIT_EXTERNAL_DIFF|GIT_SSH(_COMMAND)?|GIT_ASKPASS|SSH_ASKPASS|LESSOPEN|LESSCLOSE|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_\w+|BASH_ENV|ENV|PROMPT_COMMAND|PERL5OPT|PYTHONSTARTUP|NODE_OPTIONS)$/
// The values people set every day: a pager that only shows, Node options that load no code.
const harmlessEnv = (name: string, value: string, seg: string) =>
  /PAGER$/.test(name) ? /^(cat|less|more)?$/.test(value) : name === 'NODE_OPTIONS' && !/--(require|import|(experimental-)?loader|inspect)|\s-r\s/.test(seg)
// Text handed to a shell or interpreter to run: curl … | sh, | bash -s, | python3, bash <(curl …),
// bash -c '…', eval, iex.
const RUNS_SHELL =
  /^((sh|bash|zsh|dash|ksh|fish)(\s+-\w*[cs]\b|\s+-(\s|$)|\s*$)|eval\b|(iex|Invoke-Expression)\b|(python[\d.]*|node|perl|ruby|php)(\s+-)?\s*$|(sh|bash|zsh|dash|ksh|fish|source|\.)\s+<\()/i
// git -c settings that name a program: core.pager, core.sshCommand, an alias…
const GIT_CONFIG_RUNS = /^git\b.*\s-c\s*\S*(pager|editor|command|cmd|program|askpass|fsmonitor|hookspath|textconv|external|proxy|alias\.)|^git\b.*\s--config-env\b/i

const dequote = (seg: string) => seg.replace(/\\(.)/g, '$1').replace(/["']/g, '')

/**
 * Splits at ; & && | ||, but not inside quotes or after a backslash: grep -E '(a|b)' is one command.
 * A newline always splits and closes any quote, and `open` says a quote ran into one: the shell would
 * keep it open, so where commands end is no longer certain. `bare` is the text outside quotes.
 */
function split(code: string): { segs: string[]; open: boolean; bare: string } {
  const segs: string[] = []
  let [seg, quote, open, bare] = ['', '', false, '']
  for (let i = 0; i < code.length; i++) {
    const c = code[i] ?? ''
    if (c === '\n') {
      segs.push(seg)
      open ||= quote !== ''
      ;[seg, quote] = ['', '']
      bare += c
      continue
    }
    if (quote !== '') {
      seg += c
      if (c === '\\' && quote === '"') seg += code[++i] ?? ''
      else if (c === quote) quote = ''
      continue
    }
    if (c === '\\') {
      seg += c + (code[++i] ?? '')
      continue
    }
    // A # that starts a word comments out the rest of the line.
    if (c === '#' && /^\s?$/.test(seg.slice(-1))) {
      while (i + 1 < code.length && code[i + 1] !== '\n') i++
      continue
    }
    if (c === "'" || c === '"') quote = c
    else bare += c
    if (';&|'.includes(c)) {
      segs.push(seg)
      seg = ''
      continue
    }
    seg += c
  }
  return { segs: [...segs, seg], open: open || quote !== '', bare }
}

// Wrappers that run the command after them, with their own options: sudo -u deploy, xargs -I {}.
const WRAPPER =
  /^(?:(?:sudo|doas)(?:\s+(?:-[ugpCDrtUTh]\s+[^\s-]\S*|-\w+|--[\w-]+(?:=\S+)?))*\s+|xargs(?:\s+(?:-[IiEdnLPs]\s+[^\s-]\S*|-\w+|--[\w-]+(?:=\S+)?))*\s+|(?:time|command|env|nohup|nice|exec)\s+)*/
const trimSeg = (segs: string[]) => segs.map(seg => seg.trim().replace(WRAPPER, '')).filter(seg => seg !== '' && !seg.startsWith('#'))

function commandRisk(code: string): Risk {
  // A line ends in a continuation only after an odd number of backslashes: `echo \\` ends its command.
  const joined = code.replace(/\r\n/g, '\n').replace(/(?<!\\)((?:\\\\)*)\\\n/g, '$1 ')
  const { segs, open, bare } = split(joined)
  // Where the plugin cannot tell where commands end ($'…', a quote across lines), look for destruction
  // at every separator too.
  const loose = open || /\$['"]/.test(joined) ? joined.split(/[\n;&|]/) : []
  let sql = NONE
  for (const seg of pieces([...segs, ...loose])) {
    const plain = dequote(seg)
    for (const [re, why] of CMD_DESTROY) if (re.test(seg) || re.test(plain)) return { level: 'destroy', why }
    if (DB_CLIENT.test(seg))
      for (const body of bodies(seg, QUOTED)) {
        const r = sqlRisk(body)
        if (r.level === 'destroy') return { level: 'destroy', why: `${seg.split(/\s/)[0]}: ${r.why}` }
        sql = worse(sql, r)
      }
  }
  if (trimSeg(segs).some(seg => EMPTIES_FILE.test(seg))) return { level: 'destroy', why: 'empties a file' }
  // Duplicated descriptors and /dev/null are not files. Any other > outside quotes writes one: >&1out.txt too.
  if (/>|\btee\b/.test(bare.replace(/(\d*>&[\d-]|&?\d*>\s*\/dev\/null)(?=[\s;|&)]|$)/g, ' ')))
    return { level: 'write', why: 'writes a file' }
  // The shell drops quotes and backslashes before a command sees its words: '-exec' is -exec.
  for (let raw of trimSeg(segs)) {
    let seg = dequote(raw)
    for (let set = /^(\w+)=(\S*)\s+/.exec(seg); set !== null; set = /^(\w+)=(\S*)\s+/.exec(seg)) {
      if (RUNS_ENV.test(set[1] ?? '') && !harmlessEnv(set[1] ?? '', set[2] ?? '', seg))
        return { level: 'write', why: `${set[1]} runs a program` }
      seg = seg.slice(set[0].length)
    }
    raw = raw.replace(/^(?:\w+=(?:"(?:\\.|[^"\\])*"|'[^']*'|\S)*\s+)+/, '')
    if (RUNS_SHELL.test(seg)) return { level: 'write', why: 'runs shell code' }
    if (GIT_CONFIG_RUNS.test(seg)) return { level: 'write', why: 'git -c runs a program' }
    const word = seg.split(/\s+/)[0] ?? ''
    const rule = CMD_WRITE_OPTS.find(([is]) => is.test(seg))
    if (rule === undefined) continue
    const args = ` ${seg.slice(word.length)} `
    const [, opts, longs, exact] = rule
    if ((typeof opts === 'function' ? opts(args) : opts?.test(args)) || longHit(args, longs, exact) || (word === 'aws' && awsPositional(raw)))
      return { level: 'write', why: `${word}: writes or runs something` }
  }
  return sql
}

export const riskOf = (kind: Kind, code: string, cfg: Config = NO_CONFIG): Risk =>
  configDestroy(code, cfg) ?? (kind === 'sql' ? sqlRisk(code) : commandRisk(code))
// prod as a name of its own, also between underscores (myapp_production, $PROD_DATABASE_URL, gke_…_prod),
// but not nonprod. NODE_ENV=production builds here in production mode: it reaches no production server.
export const touchesProd = (code: string, cfg: Config = NO_CONFIG) =>
  /(?<![a-z0-9])(production|prod|prd)(?![a-z0-9])/i.test(code.replace(/\b[A-Z_]*ENV=["']?\w*["']?/g, ' ')) ||
  cfg.prod.some(entry => matches(entry, code))

/** Reads both config files; a missing one adds nothing, a broken one says so and adds nothing. */
export function parseConfig(text: string): Config | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (raw === null || typeof raw !== 'object') return undefined
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [])
  const o = raw as Record<string, unknown>
  return { prod: list(o.prod), destroy: list(o.destroy) }
}

// A path to compare: forward slashes, no trailing one, any case on Windows.
const norm = (p: string) => {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[A-Za-z]:/.test(s) ? s.toLowerCase() : s
}

// Reads overlap (session start, /outputs, a config edit): only the latest one is saved.
let loads = 0
async function loadConfig($: EngineInterface) {
  const load = ++loads
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  // The project's file is the nearest one from the session's directory up to the repository root,
  // short of the home folder.
  let project: string | undefined
  for (let dir = await $.session.cwd(); home === undefined || norm(dir) !== norm(home); ) {
    const path = `${dir}/.claude/${CONFIG_FILE}`
    if (await $.fs.exists(path).catch(() => false)) {
      project = path
      break
    }
    if (await $.fs.exists(`${dir}/.git`).catch(() => false)) break
    const up = dir.replace(/[\\/][^\\/]*$/, '')
    if (up === dir || up === '') break
    dir = up
  }
  const paths = [home && `${home}/.claude/${CONFIG_FILE}`, project].filter(Boolean)
  const merged: Config = { prod: [], destroy: [] }
  for (const path of paths as string[]) {
    const text = await $.fs.read(path).catch(() => undefined)
    if (load !== loads) return
    if (text === undefined) continue
    const one = parseConfig(text)
    if (one === undefined) {
      $.ui.toast(`session-outputs: ${path} is not valid JSON; ignored`)
      continue
    }
    // Both files only add warnings, so a project you clone can make nothing look safer.
    merged.prod.push(...one.prod)
    merged.destroy.push(...one.destroy)
  }
  if (load === loads) await update($, config, () => merged)
}


const RISK_COLOR: Record<Risk['level'], string> = { none: '', heavy: 'warning', write: 'warning', destroy: 'error' }
const RISK_MARK: Record<Risk['level'], string> = { none: '', heavy: '▲', write: '▲', destroy: '⛔' }

// Emoji per kind; files split by extension.
const ICON: Record<Kind, string> = { artifact: '🌐', doc: '📝', image: '📸', file: '📄', pr: '🔀', ci: '🧪', command: '💻', sql: '🔍' }
const FILE_ICON: Record<string, string> = { pdf: '📕', mp4: '🎬', webm: '🎬' }
export const iconOf = (a: Item) =>
  a.kind === 'file' ? (FILE_ICON[a.label.split('.').pop()?.toLowerCase() ?? ''] ?? ICON.file) : ICON[a.kind]
// Theme keys, so both terminal themes keep contrast.
const COLOR: Record<Kind, string> = {
  artifact: 'claude',
  doc: 'claude',
  image: 'suggestion',
  file: 'warning',
  pr: 'merged',
  ci: 'success',
  command: 'planMode',
  sql: 'ide',
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const pad = (n: number) => String(n).padStart(2, '0')
export const hhmm = (at: number) => `${pad(new Date(at).getHours())}:${pad(new Date(at).getMinutes())}`
export const day = (at: number) => `${new Date(at).getDate()} ${MONTHS[new Date(at).getMonth()]}`

export function when(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getDate()} ${MONTHS[d.getMonth()]} · ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// Newest first, consecutive items of one prompt under one heading.
export function groups(list: Item[]): { turn: string; items: Item[] }[] {
  const out: { turn: string; items: Item[] }[] = []
  for (const a of [...list].reverse()) {
    const last = out[out.length - 1]
    if (last !== undefined && last.turn === a.turn) last.items.push(a)
    else out.push({ turn: a.turn, items: [a] })
  }
  return out
}

const oneLine = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Adds `fresh` last; one seen before moves there, under the prompt that brought it back. */
export function newest(list: Item[], add: Item[]): Item[] {
  const last = [...new Map(add.map(a => [a.href, a])).values()]
  const again = new Set(last.map(a => a.href))
  return [...list.filter(a => !again.has(a.href)), ...last].slice(-300)
}

/** How many of `add` the list did not hold yet: only those reopen a closed pane. */
const fresh = (list: Item[], add: Item[]) => new Set(add.map(a => a.href).filter(h => !list.some(a => a.href === h))).size

/** Drops the files that are gone from disk; links stay. */
async function prune($: EngineInterface) {
  const list = await read($, items)
  const gone = new Set<string>()
  for (const a of list)
    if (a.href.startsWith('file://') && !(await $.fs.exists(copyText(a.href)).catch(() => false))) gone.add(a.href)
  if (gone.size > 0) await update($, items, l => l.filter(a => !gone.has(a.href)))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'outputs', description: 'Open the pane of files, Artifacts, docs, PRs, CI runs and commands this session made for you' })
    await loadConfig($).catch(() => {})
    await prune($)
    $.clock.every(PRUNE_EVERY_MS, () => void prune($))
    // Opens by itself only with something to show: an empty pane in every session is noise.
    if ((await read($, items)).length > 0) void $.ui.open({ id: PANE, title: TITLE })
    return next(e)
  })

  on('command.run', { command: 'outputs' }, async $ => {
    await loadConfig($).catch(() => {})
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Session outputs pane opened.' }
  })

  // Commands and SQL the main loop's answer hands the person to run.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined || e.answer === '') return done
    const found = codeBlocks(e.answer, Date.now(), await read($, turn))
    if (found.length === 0) return done
    let added = 0
    await update($, items, list => {
      added = fresh(list, found)
      return newest(list, found)
    })
    if (added > 0) void $.ui.open({ id: PANE, title: TITLE })
    return done
  }).catch(($, e, next) => next(e))

  // The prompt names the group only once it entered: a dropped one leaves the last group as it was.
  on('prompt.submit', async ($, e, next) => {
    const done = await next(e)
    const isPerson = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (done.drop === undefined && isPerson && e.isMeta !== true && e.command === undefined && e.text.trim() !== '')
      await update($, turn, () => e.text)
    return done
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const since = Date.now()
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran

    const input = e as unknown as Record<string, unknown>
    // A config file just written or edited takes effect at once.
    if (strings(input).some(v => CONFIG_PATH.test(v)))
      await loadConfig($).catch(() => {})
    const found = candidates(e.tool, input, ran.result)
    if (found.length === 0) return ran

    // A path counts when it is a file now and this call wrote it; SendUserFile hands over old ones too.
    const kept: Candidate[] = []
    for (const c of found) {
      if (!isPath(c.found)) {
        kept.push(c)
        continue
      }
      const st = await $.fs.stat(c.found).catch(() => undefined)
      if (st?.kind === 'file' && (e.tool === 'SendUserFile' || st.mtimeMs >= since - MTIME_SLACK_MS)) kept.push(c)
    }
    if (kept.length === 0) return ran

    let html: string | undefined
    const page = e.tool === 'Artifact' ? input.file_path : kept.find(c => HTML_PAGE.test(c.found))?.found
    if (typeof page === 'string' && HTML_PAGE.test(page)) html = await $.fs.read(page).then(t => t.slice(0, 8192), () => undefined)

    const title = titleFrom(input, html)
    const at = Date.now()
    const now = await read($, turn)
    let added = 0
    await update($, items, list => {
      const made = kept.map(c => toItem(c, e.tool, title, at, now))
      added = fresh(list, made)
      return newest(list, made)
    })
    // A new item brings the pane back if it was closed; open on an open pane is a no-op.
    if (added > 0) void $.ui.open({ id: PANE, title: TITLE })
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Link, Button } = $.ui.resolve(e)
    const list = await read($, items)
    const justCopied = await read($, copied)
    const cfg = await read($, config)
    const copy = async ({ href, code }: Item, surface: Parameters<typeof $.ui.copy>[0]['surface']) => {
      const done = await $.ui.copy({ text: code ?? copyText(href), surface })
      if (!done.isCopied) return $.ui.toast(`Could not copy: ${done.reason}`)
      await update($, copied, () => href)
      $.clock.after(COPIED_MS, () => void update($, copied, now => (now === href ? '' : now)))
    }
    const danger = (a: Item) => a.code !== undefined && riskOf(a.kind, a.code, cfg).level === 'destroy'
    // Warnings only: a block with nothing found carries no mark, never a "safe" one.
    const riskBadge = (a: Item) => {
      const r = riskOf(a.kind, a.code ?? '', cfg)
      const prod = touchesProd(a.code ?? '', cfg)
      return (
        <Text>
          {r.level !== 'none' && (
            <Text>
              {' · '}
              <Text color={RISK_COLOR[r.level]} bold>
                {RISK_MARK[r.level]} {r.why}
              </Text>
            </Text>
          )}
          {prod && <Text color="error" bold> · prod</Text>}
        </Text>
      )
    }
    const width = Math.max(24, (e.props.bodyColumns ?? 40) - 2)
    const counts = (Object.keys(ICON) as Kind[])
      .map(kind => ({ kind, n: list.filter(a => a.kind === kind).length }))
      .filter(c => c.n > 0)
    const copyLabel = (a: Item) =>
      justCopied === a.href ? 'copied ✓' : a.kind === 'sql' ? 'copy query' : a.code !== undefined ? 'copy command' : a.href.startsWith('file://') ? 'copy path' : 'copy link'

    // Every entry is drawn: a tree taller than the pane scrolls (wheel, or the arrows once focused).
    return (
      <Box flexDirection="column" paddingLeft={1} paddingRight={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>{TITLE}</Text>
          <Text dimColor>
            {list.length} {list.length === 1 ? 'item' : 'items'}
          </Text>
        </Box>
        {counts.length > 0 && (
          <Text dimColor wrap="truncate-end">
            {counts.map(c => `${ICON[c.kind]} ${c.n}`).join('   ')}
          </Text>
        )}
        {list.length === 0 && (
          <Box marginTop={1}>
            <Text dimColor wrap="wrap">
              Nothing yet. Screenshots, published Artifacts, docs, PRs, CI runs and the commands Claude hands you show up here.
            </Text>
          </Box>
        )}
        {groups(list).map(g => (
          <Box flexDirection="column" marginTop={1}>
            <Box flexDirection="row" justifyContent="space-between" gap={1}>
              <Text color="subtle" italic wrap="truncate-end">
                › {g.turn === '' ? 'before your first message' : oneLine(g.turn, width - 10)}
              </Text>
              <Box flexShrink={0}>
                <Text dimColor>{day(g.items[0]?.at ?? 0)}</Text>
              </Box>
            </Box>
            <Text dimColor>{'─'.repeat(width)}</Text>
            <Box flexDirection="column" gap={1}>
              {g.items.map(a => (
                <Box flexDirection="column">
                  <Box flexDirection="row" justifyContent="space-between" gap={1}>
                    <Text color={danger(a) ? 'error' : COLOR[a.kind]} bold wrap="truncate-end">
                      {iconOf(a)} {a.title}
                    </Text>
                    <Box flexShrink={0}>
                      <Text dimColor>{hhmm(a.at)}</Text>
                    </Box>
                  </Box>
                  <Box flexDirection="row" gap={1}>
                    <Text wrap="truncate-end">
                      {'   '}
                      {a.code === undefined ? <Link href={a.href} label={a.label} /> : <Text dimColor>{a.label}</Text>}
                      {a.code !== undefined && riskBadge(a)}
                    </Text>
                    <Button
                      key={`copy:${a.href}`}
                      label={copyLabel(a)}
                      dimColor={justCopied !== a.href}
                      onPress={press => copy(a, press.surface)}
                    />
                  </Box>
                </Box>
              ))}
            </Box>
          </Box>
        ))}
      </Box>
    )
  })
}
