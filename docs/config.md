# Config and custom routing

By default tokens and routing config are stored in:

```text
~/.codexapiuse/accounts.json
```

Set `CODEXAPIUSE_HOME` to use a different config directory.

The config file is written with `0600` permissions, but it contains OAuth refresh tokens. Treat it like a password file.

## Example config

```json
{
  "version": 1,
  "nextId": 2,
  "accounts": [
    {
      "id": 1,
      "name": "work",
      "access": "...",
      "refresh": "...",
      "expires": 1790000000000,
      "accountId": "chatgpt-account-id",
      "createdAt": "2026-05-05T00:00:00.000Z",
      "updatedAt": "2026-05-05T00:00:00.000Z"
    }
  ],
  "routes": {
    "work-gpt-5.5-low": {
      "account": "work",
      "model": "gpt-5.5",
      "reasoning": "low"
    },
    "my-short-model": "work:gpt-5.5:medium"
  },
  "defaults": {
    "models": ["gpt-5.5"],
    "reasoning": ["minimal", "low", "medium", "high", "xhigh"]
  }
}
```

Custom route values can be objects:

```json
"work-gpt-5.5-low": { "account": "work", "model": "gpt-5.5", "reasoning": "low" }
```

or compact strings:

```json
"work-gpt-5.5-low": "work:gpt-5.5:low"
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
