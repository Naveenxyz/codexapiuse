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

## Example `settings.json`

Factory stores custom models in `~/.factory/settings.json` under `customModels`.

Example:

```json
{
  "customModels": [
    {
      "model": "work-gpt-5.5-low",
      "displayName": "work GPT-5.5 Low",
      "baseUrl": "http://127.0.0.1:3145/v1",
      "apiKey": "codexapiuse-local",
      "provider": "openai",
      "maxOutputTokens": 16384,
      "noImageSupport": true
    },
    {
      "model": "work-gpt-5.5-medium",
      "displayName": "work GPT-5.5 Medium",
      "baseUrl": "http://127.0.0.1:3145/v1",
      "apiKey": "codexapiuse-local",
      "provider": "openai",
      "maxOutputTokens": 16384,
      "noImageSupport": true
    },
    {
      "model": "personal-gpt-5.5-medium",
      "displayName": "personal GPT-5.5 Medium",
      "baseUrl": "http://127.0.0.1:3145/v1",
      "apiKey": "codexapiuse-local",
      "provider": "openai",
      "maxOutputTokens": 16384,
      "noImageSupport": true
    }
  ]
}
```

Use any string for `apiKey` unless you start `codexapiuse` with `CODEXAPIUSE_API_KEY`. If you do set `CODEXAPIUSE_API_KEY`, use that same value here.

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
