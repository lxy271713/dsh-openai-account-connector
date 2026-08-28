import type { Context } from '@deepseek-ai/cordis'
import { credentialKeyScope } from '@deepseek-ai/dsh-credentials'
import type { CredentialRecordEntry } from '@deepseek-ai/dsh-credentials'
import { AppServerClient } from './app-server.ts'
import { OpenAIAccountAdapter } from './adapter.ts'
import { CONNECTION_KEY, PROVIDER_ID, registerAuthorization } from './authorization.ts'

export { OpenAIAccountAdapter } from './adapter.ts'
export { AppServerClient } from './app-server.ts'
export { CONNECTION_KEY, PROVIDER_ID } from './authorization.ts'

export const name = 'openai-account-connector'
export const inject = ['llm', 'attachments']

export interface Config {
  /** Codex executable name or absolute path; defaults to CODEX_BIN, then PATH lookup. */
  executable?: string
}

/** Mount one official account flow and publish its route only while DSH is connected. */
export function apply(ctx: Context, config: Config = {}): void {
  const client = new AppServerClient(config.executable)
  const adapter = new OpenAIAccountAdapter(client, ctx.attachments)
  ctx.effect(function* () { yield () => { client.close() } }, 'openai-account-connector.client')
  ctx.inject(['authorization', 'credentials'], authorized => {
    registerAuthorization(authorized, client)
    let registration: (() => void) | undefined
    let active = true
    let scans = Promise.resolve()
    const publish = (connected: boolean): void => {
      if (connected && registration === undefined) {
        registration = authorized.llm.registerAdapter([PROVIDER_ID], adapter)
      } else if (!connected && registration !== undefined) {
        registration()
        registration = undefined
      }
    }
    const scan = (): void => {
      scans = scans.then(async () => {
        const records = await authorized.credentials.listRecords()
        if (active) publish(hasConnection(records))
      }).catch((error: unknown) => {
        authorized.logger.error('openai-account-connector: keeping previous route after connection scan failed')
        authorized.logger.error(error)
      })
    }
    authorized.on('credentials/record-updated', key => {
      if (key === CONNECTION_KEY) scan()
    })
    authorized.on('llm/adapters-updated', scan)
    authorized.effect(function* () {
      yield () => {
        active = false
        publish(false)
      }
    }, 'openai-account-connector.route')
    scan()
  })
}

function hasConnection(records: readonly CredentialRecordEntry[]): boolean {
  return records.some(record => record.key === CONNECTION_KEY && credentialKeyScope(record.key) === 'llm-codex-app')
}
