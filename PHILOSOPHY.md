# Philosophy

`codexapiuse` exists to do one job well: expose ChatGPT Codex OAuth accounts as a small local OpenAI-compatible API that is easy to use from terminals, editors, and agent CLIs.

It is intentionally simple. The goal is not to become a universal AI gateway, router, billing layer, dashboard, or provider abstraction framework. Projects like CLIProxyAPI are better fits when you need a broad multi-provider proxy with routing, registries, load balancing, management APIs, and many protocol translators.

`codexapiuse` takes a more Unix-like approach:

- keep the moving parts small
- use plain local files for configuration
- expose predictable HTTP endpoints
- make model IDs readable and stable
- support multiple accounts without requiring a control plane
- avoid background magic beyond token refresh and the local server
- compose cleanly with other tools instead of replacing them

Multi-account support is a core reason this exists. Each logged-in Codex account can expose its own model aliases, such as `work-gpt-5.5-medium` or `personal-gpt-5.5-high`, so clients can choose the account and reasoning level directly through the model name.

The project favors terminal-first workflows:

```bash
cau quickstart
cau models
cau serve bg
```

After that, any OpenAI-compatible client can point at:

```text
http://127.0.0.1:3145/v1
```

That is the intended shape of the tool: small enough to understand, easy enough to run locally, and specific enough to stay reliable.

Features should earn their place by making this core workflow better. If a feature turns `codexapiuse` into a general-purpose proxy platform, it probably belongs somewhere else.
