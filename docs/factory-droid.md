# Factory AI Droid setup

`codexapiuse` works as a local OpenAI-compatible backend for Factory AI Droid.

## 1. Start `codexapiuse`

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
```

List models:

```bash
cau models
```

Example model IDs:

```text
work-gpt-5.5-medium
personal-gpt-5.5-medium
```

## 2. Add a Factory custom model

Create a custom OpenAI-compatible model in Factory:

```text
Provider: OpenAI / OpenAI-compatible
Base URL: http://127.0.0.1:3145/v1
API key: anything
Model: work-gpt-5.5-medium
```

Use the account/model/reasoning alias from `cau models` as the model name.

To use another account, create another custom model:

```text
Model: personal-gpt-5.5-medium
```

## Optional local API key

By default, local endpoints accept any API key. To require one:

```bash
export CODEXAPIUSE_API_KEY='some-local-secret'
cau serve bg --port 3145
```

Then configure Factory with:

```text
API key: some-local-secret
```

## Recommended Droid settings

Use OpenAI-compatible mode:

```text
Provider: OpenAI / OpenAI-compatible
Base URL: http://127.0.0.1:3145/v1
```

`/v1/responses` is preferred when available because `codexapiuse` forwards `prompt_cache_key` as Codex session headers, which helps upstream prompt caching across long agent sessions.
