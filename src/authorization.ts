import type { Context } from '@deepseek-ai/cordis'
import type { AuthorizationFlow, AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { AppServerClient, AppServerNotification } from './app-server.ts'
import { isRecord } from './app-server.ts'

export const PROVIDER_ID = 'openai-codex'
export const CONNECTION_KEY = credentialKey('llm-codex-app', PROVIDER_ID)
const LOGIN_TIMEOUT_MS = 5 * 60_000

interface LoginStart {
  type: 'chatgpt'
  loginId: string
  authUrl: string
}

/** Register the official browser login without transferring a token through DSH. */
export function registerAuthorization(ctx: Context, client: AppServerClient): void {
  const flow: AuthorizationFlow & { target: { kind: 'llm-provider'; providerId: string } } = {
    key: CONNECTION_KEY,
    label: 'OpenAI',
    target: { kind: 'llm-provider', providerId: PROVIDER_ID },
    methods: [{ id: 'browser', label: '浏览器登录' }],
    async run(session) {
      session.signal.throwIfAborted()
      const current = await client.request<{ account?: unknown }>(
        'account/read', { refreshToken: false }, { signal: session.signal },
      )
      session.signal.throwIfAborted()
      if (!isChatGptAccount(current.account)) await browserLogin(client, session)
      const verified = await client.request<{ account?: unknown }>(
        'account/read', { refreshToken: true }, { signal: session.signal },
      )
      session.signal.throwIfAborted()
      if (!isChatGptAccount(verified.account)) throw new Error('OpenAI 官方登录未返回 ChatGPT 账号')
      await ctx.credentials.modifyRecord(CONNECTION_KEY, async () => ({ kind: 'api-key' }))
    },
  }
  ctx.authorization.registerFlow(flow)
}

function isChatGptAccount(value: unknown): boolean {
  return isRecord(value) && value.type === 'chatgpt'
}

async function browserLogin(client: AppServerClient, session: AuthorizationSession): Promise<void> {
  const queued: AppServerNotification[] = []
  let receive: (message: AppServerNotification) => void = message => { queued.push(message) }
  const unsubscribe = client.subscribe(message => { receive(message) })
  let loginId: string | undefined
  let completed = false
  try {
    const started = parseLoginStart(await client.request('account/login/start', {
      type: 'chatgpt',
      useHostedLoginSuccessPage: true,
      appBrand: 'chatgpt',
    }, { signal: session.signal }))
    loginId = started.loginId
    session.notify({
      message: '请在 OpenAI 官方页面完成登录。',
      url: started.authUrl,
    })
    await new Promise<void>((resolve, reject) => {
      let settled = false
      let timer: NodeJS.Timeout
      const finish = (action: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        session.signal.removeEventListener('abort', abort)
        action()
      }
      const abort = () => { finish(() => { reject(session.signal.reason ?? new DOMException('Aborted', 'AbortError')) }) }
      timer = setTimeout(() => { finish(() => { reject(new Error('OpenAI 官方登录等待超时')) }) }, LOGIN_TIMEOUT_MS)
      receive = (message) => {
        if (message.method !== 'account/login/completed' || message.params.loginId !== started.loginId) return
        finish(() => {
          if (message.params.success === true) resolve()
          else reject(new Error('OpenAI 官方登录未完成'))
        })
      }
      session.signal.addEventListener('abort', abort, { once: true })
      if (session.signal.aborted) abort()
      for (const message of queued.splice(0)) receive(message)
    })
    completed = true
  } finally {
    unsubscribe()
    if (!completed && loginId !== undefined) {
      await client.request('account/login/cancel', { loginId }).catch(() => undefined)
    }
  }
}

function parseLoginStart(value: unknown): LoginStart {
  if (!isRecord(value) || value.type !== 'chatgpt' || typeof value.loginId !== 'string'
    || !/^[0-9a-f-]{36}$/i.test(value.loginId) || typeof value.authUrl !== 'string'
    || !isOfficialLoginUrl(value.authUrl)) {
    throw new Error('OpenAI 官方登录入口无效')
  }
  return { type: 'chatgpt', loginId: value.loginId, authUrl: value.authUrl }
}

function isOfficialLoginUrl(value: string): boolean {
  if (value.length > 4_096) return false
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return false
    return url.hostname === 'openai.com' || url.hostname.endsWith('.openai.com')
      || url.hostname === 'chatgpt.com' || url.hostname.endsWith('.chatgpt.com')
  } catch {
    return false
  }
}
