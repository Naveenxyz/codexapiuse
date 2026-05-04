# codexapiuse

Terminal-first manager for multiple ChatGPT Codex OAuth accounts, exposed through a simple local OpenAI-compatible API.

This is intentionally simple: **no auto-rotation, no quota-aware routing, no clever switching**. You choose the account, model, and reasoning level by choosing the model ID.

## Install

```bash
npm install -g codexapiuse
```

Both commands are available:

```bash
codexapiuse help
cau help
```

## Quick start

Guided setup:

```bash
cau quickstart
```

Manual setup:

```bash
cau add work
cau add personal
cau login work
cau login personal
cau serve bg
cau status
cau models
```

Then configure any OpenAI-compatible client:

```text
Base URL: http://127.0.0.1:3145/v1
API key: anything, unless CODEXAPIUSE_API_KEY is set
Model: work-gpt-5.5-medium
```

To use another account, choose its model alias explicitly:

```text
personal-gpt-5.5-medium
```

There is no automatic rotation. If `work` is low on quota, choose a `personal-*` model yourself.

## Guided quickstart behavior

`cau quickstart`:

1. Creates or loads `~/.codexapiuse/accounts.json`.
2. Shows existing accounts, if any.
3. Asks whether to add accounts.
4. Asks whether to login to each account one by one.
5. Prints skipped login commands like `cau login work`.
6. Asks whether to start the local API server in the background.
7. Prints client settings and useful commands.

Each accepted login happens sequentially, so finish one browser OAuth flow before starting the next.

## Model IDs

For every logged-in account, `codexapiuse` exposes account-name aliases:

```text
<account-name>-<codex-model>-<reasoning>
```

Example account named `work`:

```text
work-gpt-5.5-low
work-gpt-5.5-medium
work-gpt-5.5-high
```

Reasoning aliases follow pi's Codex provider: `minimal`, `low`, `medium`, `high`, and `xhigh` where the upstream model supports it.

## API endpoints

Base URL:

```text
http://127.0.0.1:3145/v1
```

Endpoints:

```text
GET  /v1/models
POST /v1/chat/completions
POST /v1/responses
```

Both streaming and non-streaming Chat Completions are supported. `/v1/responses` is also supported for Factory/Droid OpenAI-compatible custom models.

## Factory AI Droid

See [docs/factory-droid.md](docs/factory-droid.md).

Short version:

```text
Provider: OpenAI / OpenAI-compatible
Base URL: http://127.0.0.1:3145/v1
API key: anything
Model: work-gpt-5.5-medium
```

## Commands

```text
cau help                  Show help
cau quickstart            Guided setup
cau add <name>            Add a named Codex account slot
cau login [id|name]       Login selected account through ChatGPT OAuth
cau list                  List accounts and current Codex usage
cau models                Print logged-in model IDs only
cau serve [--host --port] Start local API server in the foreground
cau serve bg [--host --port]
                          Start API server in the background
cau status                Show background server status
cau stop                  Stop background server
cau doctor                Check config, aliases, and server health
cau config                Create/migrate config and print accounts.json path
cau remove <id|name>      Remove an account from local config
cau limits                Alias for list
```

## More docs

- [Factory AI Droid setup](docs/factory-droid.md)
- [Example local API usage](docs/example-usage.md)
- [Config and custom routing](docs/config.md)

## Token refresh and storage

`codexapiuse` stores OAuth refresh tokens and automatically refreshes an account token when it is expired. It also does one refresh/retry on Codex `401`/`403`. It does **not** switch accounts automatically.

By default tokens and routing config are stored in:

```text
~/.codexapiuse/accounts.json
```

The config file is written with `0600` permissions, but it contains OAuth refresh tokens. Treat it like a password file.

## Notes

- OAuth uses ChatGPT/Codex OAuth with a localhost callback on port `1455`.
- For `/v1/responses`, `prompt_cache_key` is forwarded both in the body and as Codex session headers so upstream prompt caching can work.
- Reasoning usage and reasoning summary events are forwarded when Codex emits them.
