# codexapiuse

Terminal-first manager for multiple ChatGPT Codex OAuth accounts, exposed through a simple local OpenAI-compatible API.

This first version is intentionally dumb: **no auto-rotation, no quota-aware routing, no clever switching**. You choose the account/model/reasoning by choosing the model ID.

## Token refresh

Yes. `codexapiuse` stores OAuth refresh tokens and automatically refreshes an account token when it is expired. It also does one refresh/retry on Codex `401`/`403`. It does **not** switch accounts automatically.

## Model IDs

For every logged-in account, `codexapiuse` exposes account-name aliases automatically:

```text
<account-name>-<codex-model>-low
<account-name>-<codex-model>-medium
<account-name>-<codex-model>-high
```

Example account named `norms`:

```text
norms-gpt-5.5-low
norms-gpt-5.5-medium
norms-gpt-5.5-high
```

Default upstream Codex models are based on pi's Codex provider list:

```text
gpt-5.1
gpt-5.1-codex-max
gpt-5.1-codex-mini
gpt-5.2
gpt-5.2-codex
gpt-5.3-codex
gpt-5.3-codex-spark
gpt-5.4
gpt-5.4-mini
gpt-5.5
```

Default reasoning aliases follow the pi Codex provider: `minimal`, `low`, `medium`, `high`, and `xhigh` where the upstream model supports it. For example, `gpt-5.1*` models do not expose `xhigh`, while newer `gpt-5.2+` models do.

You can edit the global model/reasoning lists in `accounts.json`.

## Install for development

```bash
npm install
npm run build
npm link
```

Both commands are linked:

```bash
codexapiuse help
cau help
```

## Usage

```bash
cau add norms
cau list
cau login norms
cau serve --port 3145
```

Then configure any OpenAI-compatible client:

```text
Base URL: http://127.0.0.1:3145/v1
API key: anything, unless CODEXAPIUSE_API_KEY is set
Model: norms-gpt-5.5-medium
```

Endpoints:

```text
GET  /v1/models
POST /v1/chat/completions
```

Both streaming and non-streaming Chat Completions are supported. The OpenAI Responses endpoint (`/v1/responses`) is also supported for Factory/Droid's `provider: "openai"` custom models.

## Commands

```text
cau add <name>            Add a named Codex account slot
cau list                  List accounts and current Codex usage
cau models                Print logged-in model IDs only
cau login [id|name]       Login selected account through ChatGPT OAuth
cau remove <id|name>      Remove an account from local config
cau serve [--host --port] Start the local API server
cau config                Create/migrate config and print accounts.json path
cau limits                Alias for list
```

## Local config and custom routing

By default tokens and routing config are stored in one file:

```text
~/.codexapiuse/accounts.json
```

Set `CODEXAPIUSE_HOME` to use a different config directory.

The config file is written with `0600` permissions, but it still contains OAuth refresh tokens. Treat it like a password file.

Example `accounts.json` shape:

```json
{
  "version": 1,
  "nextId": 2,
  "accounts": [
    {
      "id": 1,
      "name": "norms",
      "access": "...",
      "refresh": "...",
      "expires": 1790000000000,
      "accountId": "chatgpt-account-id",
      "createdAt": "2026-05-05T00:00:00.000Z",
      "updatedAt": "2026-05-05T00:00:00.000Z"
    }
  ],
  "routes": {
    "norm-gpt-5.5-low": {
      "account": "norms",
      "model": "gpt-5.5",
      "reasoning": "low"
    },
    "my-short-model": "norms:gpt-5.5:medium"
  },
  "defaults": {
    "models": ["gpt-5.5"],
    "reasoning": ["minimal", "low", "medium", "high", "xhigh"]
  }
}
```

Custom route values can be either objects:

```json
"norm-gpt-5.5-low": { "account": "norms", "model": "gpt-5.5", "reasoning": "low" }
```

or compact strings:

```json
"norm-gpt-5.5-low": "norms:gpt-5.5:low"
```

If a custom route ID conflicts with a default route ID, the first route wins. Use unique names.

## Optional local API key

By default the local server does not require an API key, which is convenient for local-only clients.

To require one:

```bash
export CODEXAPIUSE_API_KEY='some-local-secret'
cau serve
```

Clients must then send either:

```text
Authorization: Bearer some-local-secret
```

or:

```text
x-api-key: some-local-secret
```

## Notes

- OAuth uses ChatGPT/Codex OAuth with a localhost callback on port `1455`.
- The served API supports both `/v1/chat/completions` and `/v1/responses`.
- For `/v1/responses`, `prompt_cache_key` is forwarded both in the body and as Codex session headers so upstream prompt caching can work.
- Reasoning usage (`output_tokens_details.reasoning_tokens`) and reasoning summary events are forwarded when Codex emits them.
- Automatic account switching is intentionally left for later.
