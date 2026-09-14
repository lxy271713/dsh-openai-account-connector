import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { accessSync, constants, lstatSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, delimiter, isAbsolute, join } from 'node:path'
import readline from 'node:readline'

const REQUEST_TIMEOUT_MS = 30_000

/** Sanitized app-server request failure. */
export class AppServerRequestError extends Error {
  constructor(message: string, readonly code?: number | string) {
    super(message)
    this.name = 'AppServerRequestError'
  }
}

/** Provider notification after JSON validation of the envelope. */
export interface AppServerNotification {
  method: string
  params: Record<string, unknown>
}

/** App-server request that must be answered by the owning adapter. */
export interface AppServerInboundRequest extends AppServerNotification {
  id: number | string
  respond: (result: Record<string, unknown>) => void
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
  signal?: AbortSignal
  abort?: () => void
}

/** Credential-free stdio client for the official local Codex app-server. */
export class AppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private starting: Promise<void> | null = null
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly listeners = new Set<(message: AppServerNotification) => void>()
  private readonly requestListeners = new Set<(message: AppServerInboundRequest) => boolean>()
  private generation = 0
  private codexHome: string | null = null

  constructor(
    executable: string | undefined = undefined,
    private readonly spawnProcess: typeof spawn = spawn,
  ) {
    this.executable = resolveCodexExecutable(executable)
  }

  private readonly executable: string

  /** Send one bounded JSON-RPC request. */
  async request<T = unknown>(
    method: string,
    params: Record<string, unknown> | undefined,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    await this.ensureStarted()
    return this.requestRaw(method, params, options.timeoutMs, options.signal) as Promise<T>
  }

  /** Subscribe to validated notification envelopes. */
  subscribe(listener: (message: AppServerNotification) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Subscribe to app-server initiated requests; the first matching listener owns the response. */
  subscribeRequests(listener: (message: AppServerInboundRequest) => boolean): () => void {
    this.requestListeners.add(listener)
    return () => this.requestListeners.delete(listener)
  }

  /** Stop the owned child and reject every pending request. */
  close(): void {
    this.child?.kill('SIGTERM')
    this.reset(new Error('OpenAI account connector stopped'))
  }

  /** Runtime-owned root returned by the official initialize handshake. */
  getCodexHome(): string {
    if (!this.codexHome) throw new AppServerRequestError('OpenAI account runtime did not return its data root', 'TRANSPORT')
    return this.codexHome
  }

  private async ensureStarted(): Promise<void> {
    if (this.child) return
    if (this.starting) return this.starting
    this.starting = this.start()
    try {
      await this.starting
    } catch (cause) {
      const child = this.child as ChildProcessWithoutNullStreams | null
      child?.kill('SIGTERM')
      const error = cause instanceof Error ? cause : new Error(String(cause))
      this.reset(error)
      throw error
    } finally {
      this.starting = null
    }
  }

  private async start(): Promise<void> {
    const generation = ++this.generation
    const child = this.spawnProcess(this.executable, ['app-server', '--stdio'], {
      env: executableEnvironment(this.executable),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    })
    this.child = child
    readline.createInterface({ input: child.stdout }).on('line', line => { this.handleLine(line) })
    child.stderr.resume()
    child.once('error', error => { if (this.generation === generation) this.reset(error) })
    child.once('exit', () => {
      if (this.generation === generation) this.reset(new Error('OpenAI account runtime exited'))
    })
    const initialized = await this.requestRaw('initialize', {
      clientInfo: { name: 'dsh-openai-account-connector', title: 'DeepSeek Harness', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }) as { codexHome?: unknown }
    if (typeof initialized.codexHome !== 'string' || !isAbsolute(initialized.codexHome)) {
      throw new AppServerRequestError('OpenAI account runtime did not return its data root', 'TRANSPORT')
    }
    this.codexHome = initialized.codexHome
    this.write({ method: 'initialized', params: {} })
  }

  private requestRaw(
    method: string,
    params: Record<string, unknown> | undefined,
    timeoutMs = REQUEST_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted()
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pending.get(id)
        if (pending) this.clearPending(id, pending)
        reject(new AppServerRequestError(`OpenAI account request timed out: ${method}`, 'TIMEOUT'))
      }, timeoutMs)
      const abort = signal === undefined ? undefined : () => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.clearPending(id, pending)
        reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'))
      }
      this.pending.set(id, {
        resolve, reject, timeout,
        ...(signal === undefined || abort === undefined ? {} : { signal, abort }),
      })
      signal?.addEventListener('abort', abort!, { once: true })
      try {
        this.write({ id, method, params })
      } catch (cause) {
        const pending = this.pending.get(id)
        if (pending) this.clearPending(id, pending)
        reject(cause instanceof Error ? cause : new Error(String(cause)))
      }
    })
  }

  private handleLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line) as unknown
    } catch {
      return
    }
    if (!isRecord(parsed)) return
    const message = parsed
    if (typeof message.method === 'string' && message.id === undefined) {
      const params = isRecord(message.params) ? message.params : {}
      for (const listener of this.listeners) {
        try { listener({ method: message.method, params }) } catch { /* isolate plugin listeners */ }
      }
      return
    }
    if (typeof message.method === 'string' && (typeof message.id === 'number' || typeof message.id === 'string')) {
      const id = message.id
      let answered = false
      const respond = (result: Record<string, unknown>): void => {
        if (answered) return
        answered = true
        this.write({ id, result })
      }
      const request = { id, method: message.method, params: isRecord(message.params) ? message.params : {}, respond }
      try {
        for (const listener of this.requestListeners) {
          if (listener(request)) return
        }
      } catch {
        if (!answered) this.write({ id, error: { code: -32603, message: 'Connector request handler failed' } })
        return
      }
      this.write({ id, error: { code: -32601, message: 'Unsupported app-server request' } })
      return
    }
    if (typeof message.id !== 'number' || message.method !== undefined) return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.clearPending(message.id, pending)
    const error = isRecord(message.error) ? message.error : null
    if (error) {
      pending.reject(new AppServerRequestError(
        'OpenAI account request failed',
        typeof error.code === 'number' || typeof error.code === 'string' ? error.code : undefined,
      ))
    } else {
      pending.resolve(message.result)
    }
  }

  private write(message: Record<string, unknown>): void {
    if (!this.child?.stdin.writable || this.child.stdin.destroyed) {
      throw new AppServerRequestError('OpenAI account runtime input is unavailable', 'TRANSPORT')
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private reset(error: Error): void {
    this.child = null
    this.codexHome = null
    for (const [id, request] of this.pending) {
      this.clearPending(id, request)
      request.reject(error)
    }
  }

  private clearPending(id: number, request: PendingRequest): void {
    clearTimeout(request.timeout)
    if (request.signal && request.abort) request.signal.removeEventListener('abort', request.abort)
    this.pending.delete(id)
  }
}

function executableEnvironment(executable: string): NodeJS.ProcessEnv {
  if (!isAbsolute(executable)) return { ...process.env }
  const directory = dirname(executable)
  const current = (process.env.PATH || '').split(delimiter).filter(Boolean)
  return { ...process.env, PATH: [directory, ...current.filter(item => item !== directory)].join(delimiter) }
}

function assertExecutable(executable: string): void {
  if (executable.length === 0 || executable.includes('\0')
    || (!isAbsolute(executable) && !/^[A-Za-z0-9._-]+$/.test(executable))) {
    throw new Error('Codex executable must be an absolute path or command name')
  }
}

/** Resolve Codex without relying on the restricted PATH inherited by macOS GUI apps. */
export function resolveCodexExecutable(
  explicit: string | undefined = process.env.CODEX_BIN,
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  if (explicit !== undefined) {
    assertExecutable(explicit)
    const resolved = executableFile(explicit, environment.PATH)
    if (resolved) return resolved
    throw new AppServerRequestError('Configured Codex CLI was not found or is not executable', 'CODEX_NOT_FOUND')
  }

  const fromPath = executableFile('codex', environment.PATH)
  if (fromPath) return fromPath

  const candidates = [
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    join(home, '.local', 'bin', 'codex'),
    join(home, '.volta', 'bin', 'codex'),
    join(home, '.asdf', 'shims', 'codex'),
    join(home, '.local', 'share', 'pnpm', 'codex'),
    ...nvmCandidates(home),
  ]
  for (const candidate of candidates) {
    const resolved = executableFile(candidate)
    if (resolved) return resolved
  }
  throw new AppServerRequestError(
    'Codex CLI was not found. Install the Codex CLI, then restart DSH Desktop.',
    'CODEX_NOT_FOUND',
  )
}

function executableFile(command: string, pathValue?: string): string | undefined {
  const candidates = isAbsolute(command)
    ? [command]
    : (pathValue || '').split(delimiter).filter(Boolean).map(directory => join(directory, command))
  for (const candidate of candidates) {
    try {
      const resolved = realpathSync(candidate)
      if (!lstatSync(resolved).isFile()) continue
      accessSync(resolved, constants.X_OK)
      return candidate
    } catch {
      // Missing, non-executable, and broken-link candidates are not usable.
    }
  }
  return undefined
}

function nvmCandidates(home: string): string[] {
  const versionsRoot = join(home, '.nvm', 'versions', 'node')
  try {
    return readdirSync(versionsRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^v\d+(?:\.\d+){0,2}$/.test(entry.name))
      .map(entry => join(versionsRoot, entry.name, 'bin', 'codex'))
      .sort((left, right) => compareNodeVersions(basename(dirname(dirname(right))), basename(dirname(dirname(left)))))
  } catch {
    return []
  }
}

function compareNodeVersions(left: string, right: string): number {
  const a = left.slice(1).split('.').map(Number)
  const b = right.slice(1).split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0)
    if (difference !== 0) return difference
  }
  return 0
}

/** True only for non-array JSON objects. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
