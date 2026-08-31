import { Buffer } from 'node:buffer'
import { constants as fsConstants } from 'node:fs'
import { lstat, mkdtemp, open, realpath, rm, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import type {
  AttachmentStore, ImageAttachmentRef, ImageMediaType, SaveImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import {
  LlmAdapter,
  CallId,
  LlmError,
  resolveRetryPolicy,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmReasoningEffortInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
  type ToolSchema,
} from '@deepseek-ai/dsh-llm'
import type { AppServerClient, AppServerInboundRequest, AppServerNotification } from './app-server.ts'
import { AppServerRequestError, isRecord } from './app-server.ts'
import { PROVIDER_ID } from './authorization.ts'

type ConnectorAttachmentStore = Pick<AttachmentStore, 'imageLimits' | 'readImageRequest' | 'saveImage'>

interface CodexModel {
  id: string
  model: string
  displayName: string
  description: string
  hidden: boolean
  inputModalities: string[]
  defaultReasoningEffort: string
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>
}

type CodexUserInput = { type: 'text'; text: string } | { type: 'image'; url: string }

interface ImageBudget { remainingBytes: number }
interface GeneratedImageBudget extends ImageBudget { remainingImages: number }

const MAX_MODEL_PAGES = 10
const IMAGE_CAPABILITY_TIMEOUT_MS = 2_000
const MAX_REQUEST_IMAGE_BYTES = 1024 * 1024
const MAX_REQUEST_IMAGE_PIXELS = 2048 * 2048
const MAX_REQUEST_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024
const TURN_INTERRUPT_TIMEOUT_MS = 2_000
const DSH_TOOL_NAMESPACE = 'dsh'
const NO_WHOLE_TURN_RETRY = resolveRetryPolicy(
  { mode: 'normal', maxRetries: 0 },
  'dsh-openai-account-connector.retryPolicy',
)

/** DSH model adapter backed by the official account-owning Codex app-server. */
export class OpenAIAccountAdapter extends LlmAdapter {
  private imageGenerationCapability: boolean | undefined
  private imageGenerationProbe: Promise<boolean> | null = null

  constructor(
    private readonly client: AppServerClient,
    private readonly attachments?: ConnectorAttachmentStore,
  ) { super() }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'OpenAI' }
  }

  override providerRetryPolicy(provider: string) {
    assertProvider(provider)
    return NO_WHOLE_TURN_RETRY
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    assertProvider(provider)
    await this.assertAccount()
    return (await this.models()).map(model => ({
      provider,
      id: model.model,
      name: model.displayName,
      description: model.description,
      inputModalities: modalities(model.inputModalities),
    }))
  }

  override async resolveModel(provider: string, id: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    assertProvider(provider)
    await this.assertAccount(signal)
    const model = (await this.models(signal)).find(candidate => candidate.model === id)
    if (!model) throw new LlmError(`OpenAI 账号没有提供模型 ${id}`, 'UNKNOWN_MODEL')
    const efforts: LlmReasoningEffortInfo[] = model.supportedReasoningEfforts.map(option => ({
      id: option.reasoningEffort as LlmReasoningEffortInfo['id'],
      name: title(option.reasoningEffort),
      description: option.description,
    }))
    return {
      provider,
      id: model.model,
      name: model.displayName,
      description: model.description,
      inputModalities: modalities(model.inputModalities),
      ...efforts.length === 0 ? {} : {
        reasoning: {
          efforts,
          defaultEffort: model.defaultReasoningEffort as LlmReasoningEffortInfo['id'],
        },
      },
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    assertProvider(options.provider)
    assertSupportedOptions(options)
    options.signal?.throwIfAborted()
    await this.assertAccount(options.signal)
    const supportsImages = options.purpose ? false : await this.supportsImageGeneration(options.signal)
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-openai-account-'))
    try {
      const input = await conversationInput(options, this.attachments)
      const started = await this.client.request<{ thread?: { id?: string } }>('thread/start', {
        model: options.model,
        cwd,
        sandbox: 'workspace-write',
        approvalPolicy: 'never',
        serviceName: 'dsh_openai_account_connector',
        ephemeral: true,
        config: { 'features.image_generation': supportsImages },
        dynamicTools: dynamicTools(options.tools),
        developerInstructions: 'Use DeepSeek Harness dynamic tools for external actions. For image requests, use built-in image generation directly; never use a Harness tool to load an image skill. Generate exactly one image per user request. Do not use built-in shell or filesystem tools. Use image generation only when the user requests an image.',
      }, signalOptions(options.signal))
      const threadId = started.thread?.id
      if (!threadId) throw new LlmError('OpenAI 账号运行时没有返回会话 ID', 'TRANSPORT')
      yield* this.runTurn(threadId, cwd, input, supportsImages, options)
    } finally {
      await rm(cwd, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async *runTurn(
    threadId: string,
    cwd: string,
    input: CodexUserInput[],
    supportsImages: boolean,
    options: GenerateOptions,
  ): AsyncIterable<StreamChunk> {
    const notifications = new NotificationQueue()
    let turnId: string | null = null
    let toolCallClaimed = false
    let unavailableSkillRedirected = false
    const availableSkills = availableSkillNames(options.messages)
    const unsubscribe = this.client.subscribe(message => {
      if (message.params.threadId === threadId) notifications.push(message)
    })
    const unsubscribeRequests = this.client.subscribeRequests(request => {
      if (request.method !== 'item/tool/call' || request.params.threadId !== threadId
        || request.params.turnId !== turnId || toolCallClaimed) return false
      const tool = parseToolCall(request, options.tools)
      if (!unavailableSkillRedirected && tool.tool === 'skill'
        && isRecord(request.params.arguments) && typeof request.params.arguments.name === 'string'
        && !availableSkills.has(request.params.arguments.name)) {
        unavailableSkillRedirected = true
        request.respond({
          success: false,
          contentItems: [{
            type: 'inputText',
            text: 'This Harness skill is unavailable. Do not retry it. Use a suitable built-in tool directly if one matches the user request; otherwise answer without it.',
          }],
        })
        return true
      }
      toolCallClaimed = true
      request.respond({
        success: false,
        contentItems: [{ type: 'inputText', text: 'Tool execution is delegated to DeepSeek Harness.' }],
      })
      notifications.push({ method: 'connector/tool-call', params: { threadId, ...tool } })
      return true
    })
    let interrupting: Promise<unknown> | null = null
    const interrupt = (): void => {
      if (!turnId || interrupting) return
      interrupting = this.client.request('turn/interrupt', { threadId, turnId }).catch(() => undefined)
    }
    const abort = (): void => { notifications.push({ method: 'connector/aborted', params: {} }); interrupt() }
    options.signal?.addEventListener('abort', abort, { once: true })
    try {
      options.signal?.throwIfAborted()
      const started = await this.client.request<{ turn?: { id?: string } }>('turn/start', {
        threadId,
        cwd,
        input,
        model: options.model,
        effort: options.reasoningEffort ?? null,
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false },
      }, signalOptions(options.signal))
      turnId = started.turn?.id ?? null
      if (!turnId) throw new LlmError('OpenAI 账号运行时没有返回请求 ID', 'TRANSPORT')
      if (options.signal?.aborted) abort()

      let output = ''
      let textIndex: number | null = null
      let nextIndex = 0
      let emitted = false
      const completedItems = new Set<string>()
      const generatedImages = generatedImageBudget(this.attachments)
      const closeText = function* (): Generator<StreamChunk> {
        if (textIndex === null) return
        yield { type: 'block-end', index: textIndex, block: { type: 'text', text: output } }
        textIndex = null
        output = ''
      }

      for await (const message of notifications) {
        if (message.method === 'connector/aborted') {
          await interrupting
          yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'OpenAI 请求已取消' } } }
          return
        }
        if (message.method === 'connector/tool-call') {
          yield* closeText()
          const index = nextIndex++
          const id = CallId(String(message.params.callId))
          const name = String(message.params.tool)
          const argumentsText = String(message.params.argumentsText)
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: argumentsText } }
          interrupt()
          await interrupting
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        const messageTurnId = message.method === 'turn/completed' && isRecord(message.params.turn)
          ? message.params.turnId ?? message.params.turn.id
          : message.params.turnId
        if (messageTurnId !== turnId) continue
        if (message.method === 'item/agentMessage/delta' && typeof message.params.delta === 'string') {
          if (textIndex === null) {
            textIndex = nextIndex++
            emitted = true
            yield { type: 'block-start', index: textIndex, blockType: 'text' }
          }
          output += message.params.delta
          yield { type: 'text-delta', index: textIndex, text: message.params.delta }
        }
        if (message.method === 'item/completed' && isRecord(message.params.item)) {
          const item = message.params.item
          if (typeof item.id !== 'string' || item.id.length === 0) {
            throw new LlmError('OpenAI 账号运行时返回了无效完成事件', 'TRANSPORT')
          }
          if (completedItems.has(item.id)) continue
          completedItems.add(item.id)
          if (item.type === 'agentMessage') {
            yield* closeText()
          } else if (item.type === 'imageGeneration') {
            yield* closeText()
            if (!supportsImages) throw new LlmError('OpenAI 账号未声明图片生成能力', 'UNSUPPORTED_CONTENT')
            if (item.status !== 'completed' || typeof item.savedPath !== 'string') {
              throw new LlmError('OpenAI 图片生成没有返回可用产物', 'SERVER')
            }
            interrupting = this.client.request(
              'turn/interrupt', { threadId, turnId },
              { timeoutMs: TURN_INTERRUPT_TIMEOUT_MS, ...signalOptions(options.signal) },
            )
            try {
              await interrupting
            } catch (cause) {
              if (options.signal?.aborted) {
                yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'OpenAI 请求已取消' } } }
                return
              }
              throw new LlmError('OpenAI 图片已完成，但无法确认后续生成已经停止', 'TRANSPORT', { cause })
            }
            if (options.signal?.aborted) {
              yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'OpenAI 请求已取消' } } }
              return
            }
            const attachment = await importGeneratedImage(
              item.savedPath, this.client.getCodexHome(), this.attachments, generatedImages, options.signal,
            )
            const index = nextIndex++
            emitted = true
            yield { type: 'block-start', index, blockType: 'image' }
            yield { type: 'block-end', index, block: { type: 'image', attachment } }
            yield { type: 'finish', reason: { kind: 'stop' } }
            return
          }
        }
        if (message.method !== 'turn/completed') continue
        const turn = isRecord(message.params.turn) ? message.params.turn : null
        if (turn?.status !== 'completed') {
          throw new LlmError('OpenAI 请求失败', 'SERVER')
        }
        yield* closeText()
        if (!emitted) {
          yield { type: 'block-start', index: nextIndex, blockType: 'text' }
          yield { type: 'block-end', index: nextIndex, block: { type: 'text', text: '' } }
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      throw new LlmError('OpenAI 账号通知流意外结束', 'TRANSPORT')
    } finally {
      options.signal?.removeEventListener('abort', abort)
      unsubscribe()
      unsubscribeRequests()
      notifications.close()
    }
  }

  private async assertAccount(signal?: AbortSignal): Promise<void> {
    const result = await this.client.request<{ account?: unknown }>(
      'account/read', { refreshToken: false }, signalOptions(signal),
    )
    if (!isRecord(result.account) || result.account.type !== 'chatgpt') {
      throw new LlmError('OpenAI 尚未登录 ChatGPT 账号，请先连接账号', 'AUTH')
    }
  }

  private async supportsImageGeneration(signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted()
    if (this.imageGenerationCapability !== undefined) return this.imageGenerationCapability
    this.imageGenerationProbe ??= this.client.request<{ imageGeneration?: unknown }>(
      'modelProvider/capabilities/read', {}, { timeoutMs: IMAGE_CAPABILITY_TIMEOUT_MS },
    ).then(result => {
      this.imageGenerationCapability = result.imageGeneration === true
      return this.imageGenerationCapability
    }).catch((error: unknown) => {
      if (error instanceof AppServerRequestError && error.code === -32601) {
        this.imageGenerationCapability = false
        return false
      }
      throw new LlmError('OpenAI 图片能力检查失败', 'TRANSPORT')
    }).finally(() => { this.imageGenerationProbe = null })
    return await abortable(this.imageGenerationProbe, signal)
  }

  private async models(signal?: AbortSignal): Promise<CodexModel[]> {
    const models: CodexModel[] = []
    const cursors = new Set<string>()
    const routeIdentities = new Set<string>()
    let cursor: string | null = null
    for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
      const response: { data?: unknown[]; nextCursor?: unknown } = await this.client.request('model/list', {
        cursor, limit: 100, includeHidden: false,
      }, signalOptions(signal))
      if (!Array.isArray(response.data)) throw new LlmError('OpenAI 模型目录页面无效', 'TRANSPORT')
      for (const value of response.data) {
        const model = parseModel(value)
        if (!model || [model.id, model.model].some(identity => routeIdentities.has(identity))) {
          throw new LlmError('OpenAI 模型目录包含无效、重复或歧义条目', 'TRANSPORT')
        }
        routeIdentities.add(model.id)
        routeIdentities.add(model.model)
        if (!model.hidden) models.push(model)
      }
      const next: unknown = response.nextCursor
      if (next == null) return models
      if (typeof next !== 'string' || next.length === 0 || cursors.has(next)) {
        throw new LlmError('OpenAI 模型目录游标无效', 'TRANSPORT')
      }
      cursors.add(next)
      cursor = next
    }
    throw new LlmError('OpenAI 模型目录超过分页上限', 'TRANSPORT')
  }
}

async function conversationInput(
  options: GenerateOptions,
  attachments: ConnectorAttachmentStore | undefined,
): Promise<CodexUserInput[]> {
  const input: CodexUserInput[] = [{
    type: 'text',
    text: 'You are the model selected in DeepSeek Harness. Answer the latest user request. When the user asks to generate or edit an image, use the available image generation capability and return the result.',
  }]
  if (options.system) appendText(input, `SYSTEM:\n${options.system}`)
  const budget = imageBudget(attachments)
  for (const message of options.messages) {
    appendText(input, `${message.role.toUpperCase()}:`)
    appendInput(input, await contentInput(message.content, attachments, budget, options.signal))
  }
  return input
}

async function contentInput(
  content: GenerateOptions['messages'][number]['content'],
  attachments: ConnectorAttachmentStore | undefined,
  budget: ImageBudget,
  signal?: AbortSignal,
): Promise<CodexUserInput[]> {
  const input: CodexUserInput[] = []
  for (const block of content) {
    if (block.type === 'text' || block.type === 'reasoning') appendText(input, block.text)
    else if (block.type === 'image') input.push(await imageInput(block.attachment, attachments, budget, signal))
    else if (block.type === 'tool-call') {
      appendText(input, `TOOL_CALL ${block.id} ${block.name}: ${block.arguments}`)
    } else if (block.type === 'tool-result') {
      appendText(input, `TOOL_RESULT ${block.toolCallId} ${block.isError === true ? 'ERROR' : 'OK'}:`)
      appendInput(input, await contentInput(block.content, attachments, budget, signal))
    }
  }
  return input
}

async function imageInput(
  ref: ImageAttachmentRef,
  attachments: ConnectorAttachmentStore | undefined,
  budget: ImageBudget,
  signal?: AbortSignal,
): Promise<CodexUserInput> {
  if (!attachments) throw new LlmError('OpenAI 图片输入缺少 Harness 附件服务', 'UNSUPPORTED_CONTENT')
  const stored = await attachments.readImageRequest(ref, {
    maxPixels: Math.min(attachments.imageLimits.maxImagePixels, MAX_REQUEST_IMAGE_PIXELS),
    maxBytes: Math.min(attachments.imageLimits.maxImageBytes, MAX_REQUEST_IMAGE_BYTES),
  }, signal)
  if (stored.bytes > budget.remainingBytes) throw new LlmError('OpenAI 图片输入超过请求上限', 'INVALID_REQUEST')
  budget.remainingBytes -= stored.bytes
  return { type: 'image', url: `data:${stored.mediaType};base64,${Buffer.from(stored.data).toString('base64')}` }
}

function imageBudget(attachments?: ConnectorAttachmentStore): ImageBudget {
  return { remainingBytes: attachments ? Math.min(attachments.imageLimits.maxMessageImageBytes, MAX_REQUEST_IMAGE_TOTAL_BYTES) : 0 }
}

function generatedImageBudget(attachments?: ConnectorAttachmentStore): GeneratedImageBudget {
  return {
    remainingImages: attachments?.imageLimits.maxImagesPerMessage ?? 0,
    remainingBytes: attachments?.imageLimits.maxMessageImageBytes ?? 0,
  }
}

async function importGeneratedImage(
  savedPath: string,
  codexHome: string,
  attachments: ConnectorAttachmentStore | undefined,
  budget: GeneratedImageBudget,
  signal?: AbortSignal,
): Promise<ImageAttachmentRef> {
  signal?.throwIfAborted()
  if (!attachments) throw new LlmError('OpenAI 图片输出缺少 Harness 附件服务', 'UNSUPPORTED_CONTENT')
  if (!isAbsolute(savedPath)) throw new LlmError('OpenAI 图片产物读取失败', 'SERVER')
  let handle: FileHandle | undefined
  try {
    const imageRoot = join(codexHome, 'generated_images')
    const [trustedRoot, rootStat, canonicalPath, before] = await Promise.all([
      realpath(imageRoot), lstat(imageRoot), realpath(savedPath), lstat(savedPath),
    ])
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('unsafe image root')
    const declared = relative(trustedRoot, canonicalPath)
    if (declared === '' || isAbsolute(declared) || declared === '..' || declared.startsWith(`..${sep}`)) {
      throw new Error('untrusted image path')
    }
    if (before.isSymbolicLink()) throw new Error('unsafe image path')
    handle = await open(canonicalPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const stat = await handle.stat()
    if (stat.dev !== before.dev || stat.ino !== before.ino || stat.nlink !== 1 || !stat.isFile() || stat.size <= 0
      || stat.size > attachments.imageLimits.maxImageBytes) throw new Error('invalid image file')
    const data = await readBounded(handle, stat.size, attachments.imageLimits.maxImageBytes)
    const after = await handle.stat()
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || data.byteLength !== stat.size) {
      throw new Error('image changed while reading')
    }
    signal?.throwIfAborted()
    const mediaType = imageMediaType(data)
    if (!mediaType) throw new Error('unsupported image type')
    if (budget.remainingImages <= 0 || data.byteLength > budget.remainingBytes) {
      throw new LlmError('OpenAI 图片输出超过单轮上限', 'SERVER')
    }
    const input: SaveImageAttachment = { data, mediaType, name: basename(canonicalPath) }
    const attachment = await attachments.saveImage(input)
    budget.remainingImages -= 1
    budget.remainingBytes -= data.byteLength
    signal?.throwIfAborted()
    return attachment
  } catch (cause) {
    signal?.throwIfAborted()
    if (cause instanceof LlmError) throw cause
    throw new LlmError('OpenAI 图片产物读取失败', 'SERVER')
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function readBounded(handle: FileHandle, expectedBytes: number, maxBytes: number): Promise<Buffer> {
  const data = Buffer.allocUnsafe(Math.min(expectedBytes, maxBytes) + 1)
  let offset = 0
  while (offset < data.byteLength) {
    const { bytesRead } = await handle.read(data, offset, data.byteLength - offset, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  if (offset > expectedBytes || offset > maxBytes) throw new Error('image exceeds size limit')
  return data.subarray(0, offset)
}

function imageMediaType(data: Uint8Array): ImageMediaType | null {
  if (data.length >= 8 && Buffer.from(data.subarray(0, 8)).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 12 && Buffer.from(data.subarray(0, 4)).toString('ascii') === 'RIFF'
    && Buffer.from(data.subarray(8, 12)).toString('ascii') === 'WEBP') return 'image/webp'
  if (data.length >= 6 && ['GIF87a', 'GIF89a'].includes(Buffer.from(data.subarray(0, 6)).toString('ascii'))) return 'image/gif'
  return null
}

function parseModel(value: unknown): CodexModel | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.model !== 'string') return null
  const efforts = Array.isArray(value.supportedReasoningEfforts) ? value.supportedReasoningEfforts : []
  return {
    id: value.id,
    model: value.model,
    displayName: typeof value.displayName === 'string' ? value.displayName : value.model,
    description: typeof value.description === 'string' ? value.description : '',
    hidden: value.hidden === true,
    inputModalities: Array.isArray(value.inputModalities) ? value.inputModalities.filter(item => typeof item === 'string') : ['text'],
    defaultReasoningEffort: typeof value.defaultReasoningEffort === 'string' ? value.defaultReasoningEffort : 'medium',
    supportedReasoningEfforts: efforts.flatMap(item => !isRecord(item) || typeof item.reasoningEffort !== 'string' ? [] : [{
      reasoningEffort: item.reasoningEffort,
      description: typeof item.description === 'string' ? item.description : '',
    }]),
  }
}

function modalities(values: readonly string[]): Array<'text' | 'image'> {
  return values.filter((value): value is 'text' | 'image' => value === 'text' || value === 'image')
}

function assertProvider(provider: string): void {
  if (provider !== PROVIDER_ID) throw new LlmError(`OpenAI Connector 不拥有 Provider ${provider}`, 'NO_ADAPTER')
}

function assertSupportedOptions(options: GenerateOptions): void {
  if (options.purpose === 'session-title'
    && options.temperature === undefined && options.stop === undefined) return
  if (options.temperature !== undefined || options.maxTokens !== undefined || options.stop !== undefined) {
    throw new LlmError('OpenAI 账号 Connector 不支持 temperature、maxTokens 或 stop 参数', 'INVALID_REQUEST')
  }
}

function signalOptions(signal?: AbortSignal): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal }
}

function dynamicTools(tools: readonly ToolSchema[] | undefined): Array<Record<string, unknown>> {
  if (!tools?.length) return []
  return [{
    type: 'namespace',
    name: DSH_TOOL_NAMESPACE,
    description: 'DeepSeek Harness tools',
    tools: tools.map(tool => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
    })),
  }]
}

function availableSkillNames(messages: GenerateOptions['messages']): Set<string> {
  let names = new Set<string>()
  for (const message of messages) {
    const source: unknown = message.source
    if (!isRecord(source) || source.kind !== 'skill-catalog' || !Array.isArray(source.entries)) continue
    names = new Set<string>()
    for (const entry of source.entries) {
      if (isRecord(entry) && typeof entry.name === 'string') names.add(entry.name)
    }
  }
  return names
}

function parseToolCall(
  request: AppServerInboundRequest,
  tools: readonly ToolSchema[] | undefined,
): { callId: string; tool: string; argumentsText: string } {
  const { params } = request
  const tool = params.namespace === DSH_TOOL_NAMESPACE && typeof params.tool === 'string'
    ? tools?.find(candidate => candidate.name === params.tool)
    : undefined
  if (typeof params.callId !== 'string' || params.callId.length === 0
    || tool === undefined
    || !isRecord(params.arguments)) {
    throw new LlmError('OpenAI 账号运行时返回了未知工具调用', 'TRANSPORT')
  }
  let argumentsText: string
  try { argumentsText = JSON.stringify(params.arguments) }
  catch { throw new LlmError('OpenAI 工具参数无法序列化', 'TRANSPORT') }
  if (argumentsText === undefined) throw new LlmError('OpenAI 工具参数无效', 'TRANSPORT')
  return { callId: params.callId, tool: tool.name, argumentsText }
}

function appendInput(target: CodexUserInput[], values: readonly CodexUserInput[]): void {
  for (const value of values) value.type === 'text' ? appendText(target, value.text) : target.push(value)
}

function appendText(target: CodexUserInput[], text: string): void {
  if (!text) return
  const previous = target.at(-1)
  if (previous?.type === 'text') previous.text += `\n${text}`
  else target.push({ type: 'text', text })
}

function title(value: string): string {
  return value.length > 0 ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  if (!signal) return promise
  return await new Promise<T>((resolvePromise, rejectPromise) => {
    const abort = () => { rejectPromise(signal.reason ?? new DOMException('Aborted', 'AbortError')) }
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(value => {
      signal.removeEventListener('abort', abort)
      resolvePromise(value)
    }, error => {
      signal.removeEventListener('abort', abort)
      rejectPromise(error)
    })
  })
}

class NotificationQueue implements AsyncIterable<AppServerNotification> {
  private values: AppServerNotification[] = []
  private waiters: Array<(value: IteratorResult<AppServerNotification>) => void> = []
  private closed = false

  push(value: AppServerNotification): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value, done: false })
    else if (!this.closed) this.values.push(value)
  }

  close(): void {
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AppServerNotification> {
    while (!this.closed || this.values.length > 0) {
      if (this.values.length > 0) yield this.values.shift()!
      else {
        const next = await new Promise<IteratorResult<AppServerNotification>>(resolveNext => { this.waiters.push(resolveNext) })
        if (next.done) return
        yield next.value
      }
    }
  }
}
