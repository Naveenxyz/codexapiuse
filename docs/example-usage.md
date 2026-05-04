# Example local API usage

Start the local gateway first:

```bash
cau serve bg
cau models
```

Pick a model ID from `cau models`, for example:

```text
work-gpt-5.5-medium
```

## Chat Completions

```bash
#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3145/v1}"
API_KEY="${API_KEY:-anything}"
MODEL="${MODEL:-work-gpt-5.5-medium}"

curl -sS "$BASE_URL/chat/completions" \
  -H "authorization: Bearer $API_KEY" \
  -H "content-type: application/json" \
  -d @- <<JSON
{
  "model": "$MODEL",
  "messages": [
    { "role": "system", "content": "Be concise." },
    { "role": "user", "content": "Write a one sentence hello from codexapiuse." }
  ]
}
JSON
```

## Streaming Chat Completions

```bash
#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3145/v1}"
API_KEY="${API_KEY:-anything}"
MODEL="${MODEL:-work-gpt-5.5-medium}"

curl -N "$BASE_URL/chat/completions" \
  -H "authorization: Bearer $API_KEY" \
  -H "content-type: application/json" \
  -d @- <<JSON
{
  "model": "$MODEL",
  "stream": true,
  "messages": [
    { "role": "user", "content": "Count from 1 to 5." }
  ]
}
JSON
```

## Responses API

```bash
#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3145/v1}"
API_KEY="${API_KEY:-anything}"
MODEL="${MODEL:-work-gpt-5.5-medium}"

curl -sS "$BASE_URL/responses" \
  -H "authorization: Bearer $API_KEY" \
  -H "content-type: application/json" \
  -d @- <<JSON
{
  "model": "$MODEL",
  "input": "Explain codexapiuse in one sentence.",
  "prompt_cache_key": "local-example-session"
}
JSON
```

If you set `CODEXAPIUSE_API_KEY` when starting the server, use that value as `API_KEY`.
