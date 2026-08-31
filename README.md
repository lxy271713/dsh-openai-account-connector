# DSH OpenAI Account Connector

`dsh-openai-account-connector` connects official OpenAI account sign-in, the live GPT model catalog, and image generation to DeepSeek Harness's single model directory. The user signs in only on the official OpenAI browser page. The plugin has no token input and never reads, copies, logs, or returns an OAuth token.

After connection, the Connector registers the `openai-codex` route in `ctx.llm`. The native DSH composer lists the app-server model catalog and receives text or durable Harness image blocks from the same selected route. Generated files pass path-containment, symlink, file-type, and byte-limit checks before entering the Harness attachment store.

## Requirements and installation

This release requires DSH Desktop 2.0.3 with the authorization-target work after Harness commit `732a504` and `llm-pi-ai.delegatedProviders`. Install the Provider-neutral account surface once, then install this Provider-specific Connector:

```sh
dsh plugin --profile desktop add --save-exact dsh-account-authorization@0.1.0
dsh plugin --profile desktop add --save-exact dsh-openai-account-connector@0.1.0
```

The account-surface bundle owns the Harness authorization registry and shared UI. This Connector bundle owns only the OpenAI flow and adapter, and assigns `openai-codex` to that adapter so the generic pi-ai adapter and this adapter never own the same route. Removing this Connector therefore cannot remove another Provider's account surface.

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

The app-server image completion item and dynamic-tool protocol are experimental, so the Connector probes live image capability and fails closed on protocol drift. The app-server protocol does not expose DSH's `temperature`, `maxTokens`, or `stop` controls; requests that set them, including auxiliary title requests, fail explicitly instead of parsing Harness-owned title prompts or silently ignoring controls. Image turns publish the first completed image only after the runtime confirms the turn was interrupted. Because app-server does not expose a stable image-creation id, whole-turn retries are disabled for this Provider route, including text requests; transient failures therefore surface to the user instead of being retried. Harness attachments currently have no staging transaction; cancellation immediately after a successful attachment save may leave one unreferenced content-addressed object for the attachment retention policy. Additional Providers require independent Connector packages rather than branches in this UI or in Harness core.
