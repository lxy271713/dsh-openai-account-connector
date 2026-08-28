# DSH OpenAI Account Connector

`dsh-openai-account-connector` connects official OpenAI account sign-in, the live GPT model catalog, and image generation to DeepSeek Harness's single model directory. The user signs in only on the official OpenAI browser page. The plugin has no token input and never reads, copies, logs, or returns an OAuth token.

After connection, the Connector registers the `openai-codex` route in `ctx.llm`. The native DSH composer lists the app-server model catalog and receives text or durable Harness image blocks from the same selected route. Generated files pass path-containment, symlink, file-type, and byte-limit checks before entering the Harness attachment store.

## Requirements and installation

This alpha requires a DSH build containing the authorization-target work after Harness commit `732a504` and `llm-pi-ai.delegatedProviders`. Install it with the Provider-neutral `dsh-account-authorization` UI:

```sh
dsh plugin --profile desktop add dsh-account-authorization
dsh plugin --profile desktop add dsh-openai-account-connector
```

The bundle assigns `openai-codex` to this specialized Connector so the generic pi-ai adapter and this adapter never own the same route.

## Security and state ownership

- Codex app-server exclusively owns ChatGPT OAuth storage and refresh.
- Harness credentials store only a non-secret connected marker.
- Harness `ctx.llm` remains the only Provider/model directory.
- Harness attachments own generated image bytes and replay references.
- Each request runs in a new temporary workspace; the Connector does not grant implicit writes to the user's project.
- DSH native tool schemas are exposed as app-server dynamic tools; calls return to the Harness agent loop for execution under the selected DSH permission policy.
- Disconnecting removes only the DSH connection and route. It does not sign the user out of other Codex clients.

## Verification

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm pack:check
```

Unit tests are not release evidence. Publication requires a real DSH Desktop 2.0.3 window proving connection, live model refresh, a short text turn, generated image preview, restart replay, and route removal after disconnect.

## Known limitations

The app-server image completion item and dynamic-tool protocol are experimental, so the Connector probes live image capability and fails closed on protocol drift. The app-server protocol does not expose DSH's `temperature`, `maxTokens`, or `stop` controls; requests that set them fail explicitly. Harness attachments currently have no staging transaction; cancellation immediately after a successful attachment save may leave one unreferenced content-addressed object for the attachment retention policy. Additional Providers require independent Connector packages rather than branches in this UI or in Harness core.
