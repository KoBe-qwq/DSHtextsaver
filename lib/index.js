/**
 * dsh-context-pack — package a whole Session (context, subagents, attachments,
 * referenced artifacts, environment, usage) into one portable `.dshpack` file,
 * and import it into a Workspace on another DSH installation.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { gunzipSync, gzipSync } from 'node:zlib'
import path from 'node:path'
import os from 'node:os'

export const name = 'context-pack'
export const inject = ['connection']

const MAGIC = Buffer.from('DSHCP1\n', 'ascii')
const SCHEMA_VERSION = 1
const PLUGIN_VERSION = '1.0.0'
const MAX_PACKAGE_BYTES = 256 * 1024 * 1024
const MAX_ARTIFACT_FILE_BYTES = 8 * 1024 * 1024
const MAX_ARTIFACT_TOTAL_BYTES = 64 * 1024 * 1024
const MAX_ATTACHMENT_BYTES = 128 * 1024 * 1024
const ARTIFACT_PATH_KEYS = new Set(['path', 'file_path', 'filePath', 'target', 'filename', 'notebook_path', 'cwd'])
const SECRET_FILE = /(^|[\\/])(\.credentials[^\\/]*|\.env(\.[^\\/]*)?|id_rsa|id_ed25519|[^\\/]+\.(pem|key|pfx|p12))$/i
const SECRET_LINE = /^(\s*["']?[A-Za-z0-9_.-]*(api[_-]?key|token|secret|password|credential)[A-Za-z0-9_.-]*["']?\s*[:=]\s*).*$/gim

export function apply(ctx) {
  const connection = ctx.connection
  ctx.effect(() => {
    const registrations = [
      connection.fetch.register({
        path: '/api/context-pack.export',
        methods: ['GET', 'HEAD'],
        requestBody: 'buffered',
        fetch: (request) => exportResponse(ctx, request),
      }),
      connection.fetch.register({
        path: '/api/context-pack.import',
        methods: ['POST'],
        requestBody: 'streaming',
        fetch: (request) => importResponse(ctx, request),
      }),
    ]
    return () => {
      for (const pending of registrations) void Promise.resolve(pending).then((dispose) => dispose())
    }
  }, 'context-pack: routes')
}

/* ------------------------------------------------------------------ export */

async function exportResponse(ctx, request) {
  const url = new URL(request.url)
  const sessionId = url.searchParams.get('sessionId')
  if (!sessionId) return textResponse(400, 'missing sessionId')
  const displayTitle = url.searchParams.get('displayTitle') ?? ''
  const includeSubagents = url.searchParams.get('includeSubagents') !== '0'
  const includeArtifacts = url.searchParams.get('includeArtifacts') !== '0'
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) return textResponse(500, 'session persistence is unavailable')
  try {
    await persistence.flush().catch(() => undefined)
    const root = await readLog(persistence, sessionId)
    if (root === undefined) return textResponse(404, 'session not found')

    const sessions = [{ header: root.header, events: root.events, role: 'root' }]
    if (includeSubagents) {
      const snapshots = await persistence.list()
      const headers = new Map(snapshots.map((snapshot) => [String(snapshot.header.id), snapshot.header]))
      const queue = [String(root.header.id)]
      const seen = new Set(queue)
      while (queue.length > 0) {
        const parent = queue.shift()
        for (const [id, header] of headers) {
          if (seen.has(id) || header.origin !== 'subagent' || String(header.parentSession ?? '') !== parent) continue
          const log = await readLog(persistence, id).catch(() => undefined)
          if (log === undefined) continue
          seen.add(id)
          queue.push(id)
          sessions.push({ header: log.header, events: log.events, role: 'subagent' })
        }
      }
    }

    const attachments = await collectAttachments(ctx, sessions)
    const artifacts = includeArtifacts ? await collectArtifacts(sessions, root.header.cwd) : emptyArtifacts()
    const title = latestTitle(root.events) || displayTitle || String(root.header.id)
    const environment = await collectEnvironment(ctx, root.events, root.header)
    const usage = summarizeUsage(sessions)
    const fidelity = {
      level: 'high-fidelity',
      context: 'complete',
      subagents: includeSubagents ? 'complete' : 'excluded',
      attachments: `${attachments.items.length} restored, ${attachments.missing.length} missing`,
      artifacts: includeArtifacts
        ? `${artifacts.items.filter((item) => item.included).length}/${artifacts.candidates} included`
        : 'excluded',
      environment: 'redacted',
      usage: 'derived',
      omissions: [
        ...(includeSubagents ? [] : ['subagent session logs']),
        ...(includeArtifacts ? [] : ['workspace artifact files']),
        'DSH credentials, API keys, and provider secrets',
        'runtime process memory and in-flight tool state',
        'files outside the session working directory are recorded but not mirrored',
      ],
      warnings: [...attachments.warnings, ...artifacts.warnings],
    }
    const payload = {
      format: 'dsh-context-pack',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      generator: { name, version: PLUGIN_VERSION },
      source: {
        dshVersion: readDshVersion(),
        platform: process.platform,
        arch: process.arch,
        sessionId: String(root.header.id),
        title,
        cwd: root.header.cwd ?? null,
        createdAt: root.header.createdAt,
        eventCount: sessions.reduce((sum, session) => sum + session.events.length, 0),
      },
      session: { header: pureHeader(root.header), events: root.events },
      subagents: sessions.slice(1).map((session) => ({
        header: pureHeader(session.header),
        events: session.events,
      })),
      attachments: attachments.items,
      artifacts: artifacts.items,
      environment,
      usage,
      fidelity,
    }
    const raw = Buffer.from(JSON.stringify(payload), 'utf8')
    const digest = createHash('sha256').update(raw).digest('hex')
    const body = Buffer.concat([
      MAGIC,
      Buffer.from(JSON.stringify({ digest, bytes: raw.byteLength }), 'utf8'),
      Buffer.from('\n', 'ascii'),
      gzipSync(raw, { level: 9 }),
    ])
    const filename = `context-pack-${slug(title)}-${stamp()}.dshpack`
    const headers = {
      'content-type': 'application/octet-stream',
      'content-disposition': contentDisposition(filename),
      'content-length': String(body.byteLength),
      'cache-control': 'no-store',
    }
    if (request.method === 'HEAD') return new Response(null, { headers })
    return new Response(body, { headers })
  } catch (error) {
    return textResponse(500, `export failed: ${messageOf(error)}`)
  }
}

async function readLog(persistence, sessionId) {
  const handle = await persistence.open(sessionId, 'read')
  try {
    const result = await handle.read(0)
    return { header: handle.header, events: result.events }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

function pureHeader(header) {
  const { type: _type, ...rest } = header
  return rest
}

function latestTitle(events) {
  let title = ''
  for (const event of events) {
    if (event.type === 'session/title' && typeof event.data?.title === 'string') title = event.data.title
  }
  return title
}

function summarizeUsage(sessions) {
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 }
  let messages = 0
  let toolCalls = 0
  let turns = 0
  let steps = 0
  let first
  let last
  let model
  for (const session of sessions) {
    for (const event of session.events) {
      if (typeof event.time === 'number') {
        first = first === undefined ? event.time : Math.min(first, event.time)
        last = last === undefined ? event.time : Math.max(last, event.time)
      }
      if (event.type === 'assistant/message') {
        messages++
        const usage = event.data?.usage
        if (usage && typeof usage === 'object') {
          for (const key of Object.keys(totals)) {
            if (typeof usage[key] === 'number') totals[key] += usage[key]
          }
        }
        if (typeof event.data?.turn === 'number') turns = Math.max(turns, event.data.turn)
        if (typeof event.data?.step === 'number') steps = Math.max(steps, event.data.step)
      }
      if (event.type === 'tool/call') toolCalls++
      if (event.type === 'request/header' && event.data?.header?.config) model = event.data.header.config
    }
  }
  return {
    ...totals,
    model,
    assistantMessages: messages,
    toolCalls,
    turns,
    steps,
    durationMs: first === undefined || last === undefined ? 0 : last - first,
    sessions: sessions.length,
  }
}

/* -------------------------------------------------------------- artifacts */

function emptyArtifacts() {
  return { items: [], candidates: 0, warnings: [] }
}

async function collectArtifacts(sessions, cwd) {
  const paths = new Map()
  for (const session of sessions) {
    for (const event of session.events) {
      if (event.type !== 'tool/call' || typeof event.data?.arguments !== 'string') continue
      let args
      try {
        args = JSON.parse(event.data.arguments)
      } catch {
        continue
      }
      walk(args, (key, value) => {
        if (!ARTIFACT_PATH_KEYS.has(key) || typeof value !== 'string' || value.length === 0) return
        const resolved = path.isAbsolute(value) ? path.normalize(value) : cwd ? path.resolve(cwd, value) : undefined
        if (resolved === undefined) return
        paths.set(resolved, true)
      })
    }
  }
  const items = []
  const warnings = []
  let total = 0
  for (const filePath of paths.keys()) {
    if (SECRET_FILE.test(filePath)) {
      warnings.push(`artifact skipped (secret-like name): ${filePath}`)
      continue
    }
    let info
    try {
      info = await stat(filePath)
    } catch {
      items.push({ path: filePath, relative: relativeTo(cwd, filePath), exists: false, included: false })
      continue
    }
    if (!info.isFile()) continue
    const item = {
      path: filePath,
      relative: relativeTo(cwd, filePath),
      exists: true,
      bytes: info.size,
      mtime: new Date(info.mtimeMs).toISOString(),
      sha256: await hashFile(filePath),
      included: false,
    }
    if (info.size <= MAX_ARTIFACT_FILE_BYTES && total + info.size <= MAX_ARTIFACT_TOTAL_BYTES) {
      item.data = (await readFile(filePath)).toString('base64')
      item.included = true
      total += info.size
    } else {
      warnings.push(`artifact not embedded (size budget): ${filePath}`)
    }
    items.push(item)
  }
  return { items, candidates: paths.size, warnings }
}

function walk(value, visit, key = '', depth = 0) {
  if (depth > 12) return
  if (typeof value === 'string') {
    visit(key, value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit, key, depth + 1)
    return
  }
  if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) walk(child, visit, childKey, depth + 1)
  }
}

function relativeTo(cwd, filePath) {
  if (!cwd) return undefined
  const relative = path.relative(cwd, filePath)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return undefined
  return relative.split(path.sep).join('/')
}

async function hashFile(filePath) {
  const data = await readFile(filePath)
  return createHash('sha256').update(data).digest('hex')
}

/* ------------------------------------------------------------ attachments */

async function collectAttachments(ctx, sessions) {
  const service = ctx.get('attachments')
  const refs = new Map()
  for (const session of sessions) {
    for (const event of session.events) collectRefs(event, refs)
  }
  const items = []
  const missing = []
  const warnings = []
  let total = 0
  for (const [id, ref] of refs) {
    if (total > MAX_ATTACHMENT_BYTES) {
      missing.push(id)
      warnings.push(`attachment not embedded (size budget): ${id}`)
      continue
    }
    if (service === undefined) {
      missing.push(id)
      warnings.push('attachment service is unavailable')
      continue
    }
    try {
      const image = isImageRef(ref)
      if (image) {
        const stored = await service.readImage(ref)
        const data = Buffer.from(stored.data)
        items.push({ kind: 'image', ref: stored.ref, data: data.toString('base64') })
        total += data.byteLength
      } else {
        const chunks = []
        for await (const chunk of service.readFileStream(ref)) chunks.push(Buffer.from(chunk))
        const data = Buffer.concat(chunks)
        items.push({ kind: 'file', ref, data: data.toString('base64') })
        total += data.byteLength
      }
    } catch (error) {
      missing.push(id)
      warnings.push(`attachment unreadable: ${id} (${messageOf(error)})`)
    }
  }
  return { items, missing, warnings }
}

function collectRefs(value, out, depth = 0) {
  if (depth > 16 || value === null || typeof value !== 'object') return
  if (typeof value.attachmentId === 'string' && typeof value.mediaType === 'string') {
    out.set(value.attachmentId, value)
  }
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, out, depth + 1)
    return
  }
  for (const child of Object.values(value)) collectRefs(child, out, depth + 1)
}

function isImageRef(ref) {
  return typeof ref.width === 'number' && typeof ref.height === 'number'
    && /^image\//.test(String(ref.mediaType))
}

/* ------------------------------------------------------------ environment */

async function collectEnvironment(ctx, events, header) {
  const profileContext = ctx.get('profileContext')
  let model
  let permissionPreset
  let sandboxMode
  let approvalPolicy
  let agentPreset
  for (const event of events) {
    if (event.type === 'request/header' && event.data?.header?.config) model = event.data.header.config
    if (event.type === 'permission/preset') permissionPreset = event.data?.preset
    if (event.type === 'sandbox/mode') sandboxMode = event.data?.mode
    if (event.type === 'approval/policy') approvalPolicy = event.data
    if (event.type === 'agent-preset/selected') agentPreset = event.data?.agentPreset
  }
  return {
    dshVersion: readDshVersion(),
    pluginVersion: PLUGIN_VERSION,
    os: { platform: process.platform, release: os.release(), arch: process.arch, hostname: os.hostname() },
    runtime: { node: process.versions.node, electron: process.versions.electron ?? null },
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    dshHome: profileContext?.home ?? dshHome(),
    cwd: header.cwd ?? null,
    model: model ?? null,
    permissionPreset: permissionPreset ?? null,
    sandboxMode: sandboxMode ?? null,
    approvalPolicy: approvalPolicy ?? null,
    agentPreset: agentPreset ?? header.agentPreset ?? null,
    profile: profileContext?.name ?? process.env.DSH_PROFILE ?? 'desktop',
    profileConfigs: await readProfileConfigs(profileContext?.dir),
  }
}

async function readProfileConfigs(profileDir) {
  const dir = profileDir ?? path.join(dshHome(), 'profiles', process.env.DSH_PROFILE ?? 'desktop')
  const files = ['cordis.patch.yml', 'cordis.yml', 'package.json']
  const configs = []
  for (const file of files) {
    const filePath = path.join(dir, file)
    try {
      const info = await stat(filePath)
      if (!info.isFile() || info.size > 512 * 1024) continue
      const text = await readFile(filePath, 'utf8')
      configs.push({
        file,
        bytes: info.size,
        sha256: createHash('sha256').update(text).digest('hex'),
        content: redact(text),
      })
    } catch {
      // optional profile file
    }
  }
  return configs
}

function redact(text) {
  return text.replace(SECRET_LINE, '$1<redacted>')
}

function readDshVersion() {
  const candidates = [
    process.env.DSH_VERSION,
    safeJson(path.join(process.resourcesPath ?? '', 'app.asar', 'package.json'))?.version,
    safeJson(path.join(path.dirname(process.execPath), 'resources', 'app.asar', 'package.json'))?.version,
  ]
  return candidates.find((value) => typeof value === 'string' && value.length > 0) ?? 'unknown'
}

function safeJson(filePath) {
  try {
    if (!filePath || !existsSync(filePath)) return undefined
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return undefined
  }
}

function dshHome() {
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
}

/** Replace every occurrence of a packaged session id with its imported id. */
function rewriteReferences(value, replacements) {
  if (typeof value === 'string') {
    let result = value
    for (const [from, to] of replacements) {
      if (from && result.includes(from)) result = result.split(from).join(to)
    }
    return result
  }
  if (Array.isArray(value)) return value.map((item) => rewriteReferences(item, replacements))
  if (value !== null && typeof value === 'object') {
    const result = {}
    for (const key of Object.keys(value)) result[key] = rewriteReferences(value[key], replacements)
    return result
  }
  return value
}

/* ----------------------------------------------------------------- import */

async function importResponse(ctx, request) {
  const url = new URL(request.url)
  const workspaceId = url.searchParams.get('workspaceId') ?? ''
  const persistence = ctx.get('sessionPersistence')
  const registry = ctx.get('workspaceRegistry')
  if (persistence === undefined) return textResponse(500, 'session persistence is unavailable')
  if (registry === undefined) return textResponse(500, 'workspace registry is unavailable')

  const workspace = workspaceId ? registry.get(workspaceId) : registry.list()[0]
  if (workspace === undefined) {
    return textResponse(400, workspaceId
      ? 'workspace not found; import into an existing workspace'
      : 'no workspace is available; create one before importing')
  }

  let pack
  try {
    const body = await readBody(request, MAX_PACKAGE_BYTES)
    pack = parsePackage(body)
  } catch (error) {
    return textResponse(400, `invalid context pack: ${messageOf(error)}`)
  }

  const warnings = [...(Array.isArray(pack.fidelity?.warnings) ? pack.fidelity.warnings : [])]
  if (pack.source?.dshVersion && pack.source.dshVersion !== readDshVersion()) {
    warnings.push(`pack was created by DSH ${pack.source.dshVersion}; this instance is ${readDshVersion()}`)
  }
  if (pack.source?.cwd && path.normalize(pack.source.cwd) !== workspace.path) {
    warnings.push(`working directory rewritten from ${pack.source.cwd} to ${workspace.path}; historical absolute paths are unchanged`)
  }

  const attachmentReport = await restoreAttachments(ctx, pack.attachments)
  warnings.push(...attachmentReport.warnings)

  const idMap = new Map()
  const imported = []
  const ordered = [
    { header: pack.session.header, events: pack.session.events, role: 'root' },
    ...(Array.isArray(pack.subagents) ? pack.subagents : []).map((session) => ({ ...session, role: 'subagent' })),
  ]
  for (const session of ordered) idMap.set(String(session.header.id), `session-${randomUUID()}`)
  const replacements = [...idMap.entries()]
  for (const session of ordered) {
    try {
      const newId = idMap.get(String(session.header.id))
      const parentSource = session.header.parentSession
      const header = {
        version: 4,
        id: newId,
        createdAt: Date.now(),
        cwd: workspace.path,
        isSeeded: false,
        ...(session.header.origin === 'subagent' ? { origin: 'subagent' } : {}),
        ...(session.header.delegationDepth !== undefined ? { delegationDepth: session.header.delegationDepth } : {}),
        ...(session.header.agentPreset !== undefined ? { agentPreset: session.header.agentPreset } : {}),
        ...(parentSource !== undefined ? { parentSession: idMap.get(String(parentSource)) ?? idMap.get(String(pack.session.header.id)) } : {}),
      }
      const handle = await persistence.create(header)
      try {
        const events = session.events.map((event, index) => ({
          ...rewriteReferences(event, replacements),
          seq: index,
        }))
        if (events.length > 0) await handle.append(events)
        await handle.flush()
      } finally {
        await handle.close().catch(() => undefined)
      }
      imported.push({ sourceId: String(session.header.id), sessionId: newId, role: session.role, events: session.events.length })
    } catch (error) {
      warnings.push(`session restore failed (${session.role}): ${messageOf(error)}`)
    }
  }
  const root = imported.find((session) => session.role === 'root')
  if (root === undefined) return textResponse(500, 'failed to restore the root session')

  try {
    await workspace.attachSession(root.sessionId)
  } catch (error) {
    warnings.push(`session restored but not attached to the workspace: ${messageOf(error)}`)
  }

  const artifactReport = await restoreArtifacts(workspace.path, pack.artifacts)
  warnings.push(...artifactReport.warnings)

  return jsonResponse(200, {
    sessionId: root.sessionId,
    title: pack.source?.title ?? null,
    workspaceId: workspace.id,
    workspacePath: workspace.path,
    sessions: imported,
    attachments: attachmentReport,
    artifacts: artifactReport,
    usage: pack.usage ?? null,
    fidelity: pack.fidelity ?? null,
    warnings,
  })
}

function parsePackage(body) {
  if (!body.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('unrecognized file header')
  const newline = body.indexOf(0x0a, MAGIC.length)
  if (newline < 0) throw new Error('missing package metadata')
  const meta = JSON.parse(body.subarray(MAGIC.length, newline).toString('utf8'))
  const compressed = body.subarray(newline + 1)
  const raw = gunzipSync(compressed)
  const digest = createHash('sha256').update(raw).digest('hex')
  if (meta.digest !== digest) throw new Error('integrity check failed')
  const pack = JSON.parse(raw.toString('utf8'))
  if (pack.format !== 'dsh-context-pack') throw new Error('not a DSH context pack')
  if (typeof pack.schemaVersion !== 'number' || pack.schemaVersion > SCHEMA_VERSION) {
    throw new Error(`unsupported pack schema ${String(pack.schemaVersion)}`)
  }
  if (!pack.session?.header || !Array.isArray(pack.session.events)) throw new Error('pack has no session log')
  return pack
}

async function readBody(request, limit) {
  const chunks = []
  let total = 0
  for await (const chunk of request.body) {
    const buffer = Buffer.from(chunk)
    total += buffer.byteLength
    if (total > limit) throw new Error(`package exceeds ${Math.round(limit / 1024 / 1024)} MB`)
    chunks.push(buffer)
  }
  if (total === 0) throw new Error('empty request body')
  return Buffer.concat(chunks)
}

async function restoreAttachments(ctx, attachments) {
  const report = { restored: 0, skipped: 0, warnings: [] }
  if (!Array.isArray(attachments)) return report
  const service = ctx.get('attachments')
  const root = typeof service?.root === 'string' ? service.root : path.join(dshHome(), 'attachments', 'v1')
  for (const item of attachments) {
    try {
      const data = Buffer.from(String(item.data ?? ''), 'base64')
      if (data.byteLength === 0) {
        report.skipped++
        continue
      }
      if (item.kind === 'file') {
        if (service !== undefined) {
          const saved = await service.saveFile({ data, name: item.ref?.name })
          if (String(saved.attachmentId) !== String(item.ref?.attachmentId)) {
            report.warnings.push(`file attachment id changed: ${String(item.ref?.attachmentId)} -> ${String(saved.attachmentId)}`)
          }
        } else {
          report.warnings.push('attachment service is unavailable; file attachment skipped')
          report.skipped++
          continue
        }
      } else if (item.kind === 'image') {
        const target = service?.imageHostPath?.(item.ref)
        const destination = target ?? path.join(root, 'objects', String(item.ref.attachmentId).slice(0, 2), String(item.ref.attachmentId))
        await mkdir(path.dirname(destination), { recursive: true })
        if (!existsSync(destination)) await writeFile(destination, data)
      } else {
        report.skipped++
        continue
      }
      report.restored++
    } catch (error) {
      report.skipped++
      report.warnings.push(`attachment restore failed: ${messageOf(error)}`)
    }
  }
  return report
}

async function restoreArtifacts(workspacePath, artifacts) {
  const report = { restored: 0, skipped: 0, missingData: 0, warnings: [] }
  if (!Array.isArray(artifacts)) return report
  const mirror = path.join(workspacePath, '.dsh-context-pack', `import-${stamp()}`)
  for (const item of artifacts) {
    if (item.included !== true || typeof item.data !== 'string') {
      if (item.exists) report.missingData++
      continue
    }
    try {
      const relative = typeof item.relative === 'string' && item.relative.length > 0 ? item.relative : undefined
      const target = relative
        ? path.join(workspacePath, relative)
        : path.join(mirror, path.basename(String(item.path ?? 'artifact')))
      if (!target.startsWith(workspacePath) && relative !== undefined) {
        report.skipped++
        continue
      }
      if (existsSync(target)) {
        report.skipped++
        continue
      }
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, Buffer.from(item.data, 'base64'))
      report.restored++
    } catch (error) {
      report.skipped++
      report.warnings.push(`artifact restore failed: ${messageOf(error)}`)
    }
  }
  return report
}

/* ------------------------------------------------------------------ utils */

function textResponse(status, message) {
  return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}

function jsonResponse(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

function slug(value) {
  const cleaned = String(value).replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, '-').replace(/^-+|-+$/g, '')
  return (cleaned.slice(0, 60) || 'session')
}

function stamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
