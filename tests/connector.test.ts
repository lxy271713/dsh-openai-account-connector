import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId, type ImageAttachmentLimits, type SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { AuthorizationFlow, AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { createUserMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { AppServerClient, type AppServerInboundRequest, type AppServerNotification } from '../src/app-server.ts'
import { OpenAIAccountAdapter } from '../src/adapter.ts'
import { CONNECTION_KEY, PROVIDER_ID, registerAuthorization } from '../src/authorization.ts'

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

class FakeClient {
  readonly requests: Array<{ method: string; params: Record<string, unknown> | undefined }> = []
  private readonly listeners = new Set<(message: AppServerNotification) => void>()
  private readonly requestListeners = new Set<(message: AppServerInboundRequest) => boolean>()
  account: unknown = null
  cwd = ''
  authUrl = 'https://auth.openai.com/authorize'
  generatedPath: string | undefined
  completeLogin = true
  completedAccount: unknown = { type: 'chatgpt' }
  rejectForcedRefresh = false
  toolRequest: { namespace?: unknown; tool: string; arguments: unknown } | undefined
  toolResponse: Record<string, unknown> | undefined
  toolHandlerError: unknown
  codexHome = tmpdir()

  getCodexHome(): string { return this.codexHome }

  subscribe(listener: (message: AppServerNotification) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  subscribeRequests(listener: (message: AppServerInboundRequest) => boolean): () => void {
    this.requestListeners.add(listener)
    return () => { this.requestListeners.delete(listener) }
  }

  async request<T>(method: string, params: Record<string, unknown> | undefined): Promise<T> {
    this.requests.push({ method, params })
    if (method === 'account/read') {
      if (params?.refreshToken === true && this.rejectForcedRefresh) {
        throw new Error('forced refresh unavailable')
      }
      return { account: this.account } as T
    }
    if (method === 'account/login/start') {
      if (this.completeLogin) {
        setTimeout(() => {
          this.account = this.completedAccount
          this.emit('account/login/completed', { loginId: '11111111-1111-4111-8111-111111111111', success: true })
        }, 0)
      }
      return {
        type: 'chatgpt',
        loginId: '11111111-1111-4111-8111-111111111111',
        authUrl: this.authUrl,
      } as T
    }
    if (method === 'modelProvider/capabilities/read') return { imageGeneration: true } as T
    if (method === 'model/list') return { data: [model()], nextCursor: null } as T
    if (method === 'thread/start') {
      this.cwd = String(params?.cwd)
      return { thread: { id: 'thread-1' } } as T
    }
    if (method === 'turn/start') {
      if (this.toolRequest) {
        setTimeout(() => {
          try {
            for (const listener of this.requestListeners) {
              if (listener({
                id: 44,
                method: 'item/tool/call',
                params: {
                  threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1',
                  namespace: this.toolRequest!.namespace,
                  tool: this.toolRequest!.tool, arguments: this.toolRequest!.arguments,
                },
                respond: result => { this.toolResponse = result },
              })) break
            }
          } catch (error) {
            this.toolHandlerError = error
            this.emit('turn/completed', {
              threadId: 'thread-1', turnId: 'turn-1', turn: { id: 'turn-1', status: 'completed' },
            })
          }
        }, 0)
        return { turn: { id: 'turn-1' } } as T
      }
      const savedPath = this.generatedPath ?? join(this.cwd, 'generated.png')
      await writeFile(savedPath, PNG)
      queueMicrotask(() => {
        this.emit('item/completed', {
          threadId: 'thread-1', turnId: 'turn-1',
          item: { id: 'image-1', type: 'imageGeneration', status: 'completed', savedPath },
        })
        this.emit('turn/completed', {
          threadId: 'thread-1', turnId: 'turn-1', turn: { id: 'turn-1', status: 'completed' },
        })
      })
      return { turn: { id: 'turn-1' } } as T
    }
    if (method === 'turn/interrupt' || method === 'account/login/cancel') return {} as T
    throw new Error(`unexpected request: ${method}`)
  }

  private emit(method: string, params: Record<string, unknown>): void {
    for (const listener of this.listeners) listener({ method, params })
  }
}

describe('OpenAI account connector', () => {
  it('rejects ambiguous executable paths before spawning a process', () => {
    expect(() => new AppServerClient('../codex')).toThrow('absolute path or command name')
    expect(() => new AppServerClient('')).toThrow('absolute path or command name')
  })

  it('asks only for official browser login and commits an ambient connection marker', async () => {
    const client = new FakeClient()
    let flow: AuthorizationFlow & { target?: unknown } | undefined
    const modifyRecord = vi.fn(async (_key: unknown, update: (current: undefined) => unknown) => update(undefined))
    const ctx = {
      authorization: { registerFlow: (value: AuthorizationFlow) => { flow = value; return () => undefined } },
      credentials: { modifyRecord },
    } as unknown as Context
    registerAuthorization(ctx, client as unknown as AppServerClient)

    expect(flow?.key).toBe(CONNECTION_KEY)
    expect(flow?.target).toEqual({ kind: 'llm-provider', providerId: PROVIDER_ID })
    const notices: unknown[] = []
    await flow!.run({
      method: 'browser', signal: new AbortController().signal,
      notify: notice => { notices.push(notice) },
      prompt: async () => { throw new Error('credential input must not be requested') },
    } satisfies AuthorizationSession)

    expect(notices).toEqual([expect.objectContaining({ url: 'https://auth.openai.com/authorize' })])
    expect(modifyRecord).toHaveBeenCalledOnce()
    expect(await modifyRecord.mock.calls[0]![1](undefined)).toEqual({ kind: 'api-key' })
    expect(client.requests).toContainEqual({ method: 'account/read', params: { refreshToken: true } })
    expect(JSON.stringify(client.requests)).not.toMatch(/accessToken|apiKey|authorization"\s*:/)
  })

  it('connects an existing ChatGPT account without forcing a token refresh', async () => {
    const client = new FakeClient()
    client.account = { type: 'chatgpt' }
    client.rejectForcedRefresh = true
    let flow: AuthorizationFlow | undefined
    const modifyRecord = vi.fn(async (_key: unknown, update: (current: undefined) => unknown) => update(undefined))
    registerAuthorization({
      authorization: { registerFlow: (value: AuthorizationFlow) => { flow = value; return () => undefined } },
      credentials: { modifyRecord },
    } as unknown as Context, client as unknown as AppServerClient)

    await flow!.run({
      method: 'browser', signal: new AbortController().signal, notify: vi.fn(),
      prompt: async () => { throw new Error('unexpected prompt') },
    })

    expect(modifyRecord).toHaveBeenCalledOnce()
    expect(client.requests).not.toContainEqual({ method: 'account/read', params: { refreshToken: true } })
  })

  it('does not accept a non-ChatGPT account as an existing browser connection', async () => {
    const client = new FakeClient()
    client.account = { type: 'apiKey' }
    let flow: AuthorizationFlow | undefined
    registerAuthorization({
      authorization: { registerFlow: (value: AuthorizationFlow) => { flow = value; return () => undefined } },
      credentials: { modifyRecord: vi.fn(async (_key: unknown, update: (current: undefined) => unknown) => update(undefined)) },
    } as unknown as Context, client as unknown as AppServerClient)
    await flow!.run({
      method: 'browser', signal: new AbortController().signal, notify: vi.fn(),
      prompt: async () => { throw new Error('unexpected prompt') },
    })
    expect(client.requests.some(request => request.method === 'account/login/start')).toBe(true)
  })

  it('does not commit a marker when browser login resolves to another account type', async () => {
    const client = new FakeClient()
    client.completedAccount = { type: 'apiKey' }
    let flow: AuthorizationFlow | undefined
    const modifyRecord = vi.fn()
    registerAuthorization({
      authorization: { registerFlow: (value: AuthorizationFlow) => { flow = value; return () => undefined } },
      credentials: { modifyRecord },
    } as unknown as Context, client as unknown as AppServerClient)
    await expect(flow!.run({
      method: 'browser', signal: new AbortController().signal, notify: vi.fn(),
      prompt: async () => { throw new Error('unexpected prompt') },
    })).rejects.toThrow('未返回 ChatGPT 账号')
    expect(modifyRecord).not.toHaveBeenCalled()
  })

  it('streams a generated image into the Harness attachment result', async () => {
    const client = new FakeClient()
    client.account = { type: 'chatgpt' }
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-home-'))
    client.codexHome = codexHome
    const providerOutput = join(codexHome, 'generated_images')
    await mkdir(providerOutput)
    client.generatedPath = join(providerOutput, 'generated.png')
    const limits: ImageAttachmentLimits = {
      maxImageBytes: 1024,
      maxImagesPerMessage: 4,
      maxMessageImageBytes: 4096,
      maxImagePixels: 4_000_000,
      maxImageDimension: 4096,
      mediaTypes: ['image/png'],
    }
    const saved: SaveImageAttachment[] = []
    const attachments = {
      imageLimits: limits,
      readImageRequest: vi.fn(),
      saveImage: vi.fn(async (input: SaveImageAttachment) => {
        saved.push(input)
        return {
          attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
          mediaType: 'image/png' as const,
          bytes: input.data.byteLength,
          width: 1,
          height: 1,
          ...(input.name === undefined ? {} : { name: input.name }),
        }
      }),
    }
    const adapter = new OpenAIAccountAdapter(client as unknown as AppServerClient, attachments)
    const chunks: StreamChunk[] = []
    try {
      for await (const chunk of adapter.stream({
        provider: PROVIDER_ID,
        model: 'gpt-test',
        messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '生成一张蓝色方块图片' }] })],
      })) chunks.push(chunk)
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }

    expect(chunks).toContainEqual(expect.objectContaining({
      type: 'block-end',
      block: expect.objectContaining({ type: 'image', attachment: expect.objectContaining({ mediaType: 'image/png' }) }),
    }))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(saved).toHaveLength(1)
    expect(saved[0]?.name).toBe('generated.png')
    expect(client.requests.find(request => request.method === 'thread/start')?.params?.config).toEqual({
      'features.image_generation': true,
    })
    expect(JSON.stringify(client.requests.find(request => request.method === 'turn/start')?.params)).toContain('生成一张蓝色方块图片')
  })

  it('namespaces a colliding DSH tool and restores its Harness name', async () => {
    const client = new FakeClient()
    client.account = { type: 'chatgpt' }
    client.toolRequest = { namespace: 'dsh', tool: 'skill', arguments: { name: 'imagegen' } }
    const adapter = new OpenAIAccountAdapter(client as unknown as AppServerClient)
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      provider: PROVIDER_ID,
      model: 'gpt-test',
      messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '生成图片' }] })],
      tools: [{ name: 'skill', description: 'Load a Harness skill', parameters: { type: 'object' } }],
    })) chunks.push(chunk)
    expect(chunks).toContainEqual(expect.objectContaining({
      type: 'block-end',
      block: { type: 'tool-call', id: 'call-1', name: 'skill', arguments: '{"name":"imagegen"}' },
    }))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(client.requests).toContainEqual({
      method: 'turn/interrupt', params: { threadId: 'thread-1', turnId: 'turn-1' },
    })
    expect(client.requests.find(request => request.method === 'thread/start')?.params?.dynamicTools).toEqual([{
      type: 'namespace', name: 'dsh', description: 'DeepSeek Harness tools', tools: [{
        type: 'function', name: 'skill', description: 'Load a Harness skill', inputSchema: { type: 'object' },
      }],
    }])
    expect(client.requests.find(request => request.method === 'thread/start')?.params?.developerInstructions).toContain(
      'For image requests, use built-in image generation directly; never use a Harness tool to load an image skill.',
    )
    expect(client.toolResponse).toEqual({
      success: false,
      contentItems: [{ type: 'inputText', text: 'Tool execution is delegated to DeepSeek Harness.' }],
    })
  })

  it('preserves a maximum-length Harness tool name inside the namespace', async () => {
    const name = 'x'.repeat(128)
    const client = new FakeClient()
    client.account = { type: 'chatgpt' }
    client.toolRequest = { namespace: 'dsh', tool: name, arguments: {} }
    const adapter = new OpenAIAccountAdapter(client as unknown as AppServerClient)
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      provider: PROVIDER_ID,
      model: 'gpt-test',
      messages: [],
      tools: [{ name, description: 'Boundary tool', parameters: { type: 'object' } }],
    })) chunks.push(chunk)
    expect(chunks).toContainEqual(expect.objectContaining({
      type: 'block-end', block: expect.objectContaining({ type: 'tool-call', name }),
    }))
    expect(JSON.stringify(client.requests.find(request => request.method === 'thread/start')?.params?.dynamicTools)).not.toContain('dsh__')
  })

  it('rejects a tool call from the wrong namespace', async () => {
    const client = new FakeClient()
    client.account = { type: 'chatgpt' }
    client.toolRequest = { namespace: 'other', tool: 'skill', arguments: {} }
    const adapter = new OpenAIAccountAdapter(client as unknown as AppServerClient)
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      provider: PROVIDER_ID,
      model: 'gpt-test',
      messages: [],
      tools: [{ name: 'skill', description: 'Load a Harness skill', parameters: { type: 'object' } }],
    })) chunks.push(chunk)
    expect(client.toolHandlerError).toEqual(expect.objectContaining({
      message: 'OpenAI 账号运行时返回了未知工具调用',
    }))
    expect(chunks).not.toContainEqual(expect.objectContaining({
      type: 'block-end', block: expect.objectContaining({ type: 'tool-call' }),
    }))
  })

  it('fails closed on unsupported generation controls', async () => {
    const client = new FakeClient()
    client.account = { type: 'chatgpt' }
    const adapter = new OpenAIAccountAdapter(client as unknown as AppServerClient)
    await expect(async () => {
      for await (const _chunk of adapter.stream({
        provider: PROVIDER_ID, model: 'gpt-test', messages: [], temperature: 0.2,
      })) { /* drain */ }
    }).rejects.toThrow('不支持 temperature')
    expect(client.requests).toHaveLength(0)
  })

  it('rejects non-official login URLs before showing them or committing a connection', async () => {
    const client = new FakeClient()
    client.authUrl = 'https://example.invalid/collect'
    let flow: AuthorizationFlow | undefined
    const modifyRecord = vi.fn()
    registerAuthorization({
      authorization: { registerFlow: (value: AuthorizationFlow) => { flow = value; return () => undefined } },
      credentials: { modifyRecord },
    } as unknown as Context, client as unknown as AppServerClient)
    const notify = vi.fn()
    await expect(flow!.run({
      method: 'browser', signal: new AbortController().signal, notify,
      prompt: async () => { throw new Error('unexpected prompt') },
    })).rejects.toThrow('登录入口无效')
    expect(notify).not.toHaveBeenCalled()
    expect(modifyRecord).not.toHaveBeenCalled()
  })

  it('cancels the official login request when the user aborts', async () => {
    const client = new FakeClient()
    client.completeLogin = false
    let flow: AuthorizationFlow | undefined
    const modifyRecord = vi.fn()
    registerAuthorization({
      authorization: { registerFlow: (value: AuthorizationFlow) => { flow = value; return () => undefined } },
      credentials: { modifyRecord },
    } as unknown as Context, client as unknown as AppServerClient)
    const controller = new AbortController()
    await expect(flow!.run({
      method: 'browser', signal: controller.signal,
      notify: () => { controller.abort(new DOMException('Aborted', 'AbortError')) },
      prompt: async () => { throw new Error('unexpected prompt') },
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(client.requests).toContainEqual({
      method: 'account/login/cancel',
      params: { loginId: '11111111-1111-4111-8111-111111111111' },
    })
    expect(modifyRecord).not.toHaveBeenCalled()
  })

  it('rejects a symlink returned as a generated image', async () => {
    const client = new FakeClient()
    client.account = { type: 'chatgpt' }
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-home-'))
    client.codexHome = codexHome
    const output = join(codexHome, 'generated_images')
    await mkdir(output)
    const target = join(output, 'target.png')
    client.generatedPath = join(output, 'generated.png')
    await writeFile(target, PNG)
    await symlink(target, client.generatedPath)
    const saveImage = vi.fn()
    const adapter = new OpenAIAccountAdapter(client as unknown as AppServerClient, {
      imageLimits: {
        maxImageBytes: 1024, maxImagesPerMessage: 4, maxMessageImageBytes: 4096,
        maxImagePixels: 4_000_000, maxImageDimension: 4096, mediaTypes: ['image/png'],
      },
      readImageRequest: vi.fn(),
      saveImage,
    })
    try {
      await expect(async () => {
        for await (const _chunk of adapter.stream({
          provider: PROVIDER_ID,
          model: 'gpt-test',
          messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '生成图片' }] })],
        })) { /* drain */ }
      }).rejects.toThrow('图片产物读取失败')
      expect(saveImage).not.toHaveBeenCalled()
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('rejects a generated image outside the runtime-owned image root', async () => {
    const client = new FakeClient()
    client.account = { type: 'chatgpt' }
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-home-'))
    client.codexHome = codexHome
    await mkdir(join(codexHome, 'generated_images'))
    const outside = await mkdtemp(join(tmpdir(), 'dsh-openai-outside-'))
    client.generatedPath = join(outside, 'outside.png')
    const saveImage = vi.fn()
    const adapter = new OpenAIAccountAdapter(client as unknown as AppServerClient, {
      imageLimits: {
        maxImageBytes: 1024, maxImagesPerMessage: 4, maxMessageImageBytes: 4096,
        maxImagePixels: 4_000_000, maxImageDimension: 4096, mediaTypes: ['image/png'],
      },
      readImageRequest: vi.fn(),
      saveImage,
    })
    try {
      await expect(async () => {
        for await (const _chunk of adapter.stream({
          provider: PROVIDER_ID,
          model: 'gpt-test',
          messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '生成图片' }] })],
        })) { /* drain */ }
      }).rejects.toThrow('图片产物读取失败')
      expect(saveImage).not.toHaveBeenCalled()
    } finally {
      await rm(codexHome, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})

function model(): Record<string, unknown> {
  return {
    id: 'gpt-test', model: 'gpt-test', displayName: 'GPT Test', description: 'fixture', hidden: false,
    inputModalities: ['text', 'image'], defaultReasoningEffort: 'medium', supportedReasoningEfforts: [],
  }
}
