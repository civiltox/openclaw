---
summary: "Gemini web search with Google Search grounding"
read_when:
  - You want to use Gemini for web_search
  - You need a GEMINI_API_KEY or models.providers.google.apiKey
  - You want Google Search grounding
title: "Gemini search"
---

OpenClaw supports Gemini models with built-in
[Google Search grounding](https://ai.google.dev/gemini-api/docs/grounding),
which returns AI-synthesized answers backed by live Google Search results with
citations.

## Get an API key

<Steps>
  <Step title="Create a key">
    Go to [Google AI Studio](https://aistudio.google.com/apikey) and create an
    API key.
  </Step>
  <Step title="Store the key">
    Set `GEMINI_API_KEY` in the Gateway environment, reuse
    `models.providers.google.apiKey`, or configure a dedicated web-search key via:

    ```bash
    openclaw configure --section web
    ```

  </Step>
</Steps>

## Config

```json5
{
  plugins: {
    entries: {
      google: {
        config: {
          webSearch: {
            apiKey: "AIza...", // optional if GEMINI_API_KEY or models.providers.google.apiKey is set
            baseUrl: "https://generativelanguage.googleapis.com/v1beta", // optional; falls back to models.providers.google.baseUrl
            model: "gemini-2.5-flash", // default
            headers: {
              // optional; non-secret routing metadata only
              "X-Example-Routing": "staging",
            },
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "gemini",
      },
    },
  },
}
```

**Credential precedence:** Gemini web search uses
`plugins.entries.google.config.webSearch.apiKey` first, then `GEMINI_API_KEY`,
then `models.providers.google.apiKey`. For base URLs, the dedicated
`plugins.entries.google.config.webSearch.baseUrl` wins before
`models.providers.google.baseUrl`. Headers do not chain: only
`plugins.entries.google.config.webSearch.headers` applies to web search.

For a gateway install, put env keys in `~/.openclaw/.env`.

## How it works

Unlike traditional search providers that return a list of links and snippets,
Gemini uses Google Search grounding to produce AI-synthesized answers with
inline citations. The results include both the synthesized answer and the source
URLs.

- Citation URLs from Gemini grounding are automatically resolved from Google
  redirect URLs to direct URLs via a HEAD request through OpenClaw's SSRF-guarded
  fetch path (redirect following, http/https validation).
- Redirect resolution uses strict SSRF defaults, so redirects to
  private/internal targets are blocked.

## Supported parameters

Gemini search supports `query`, `freshness`, `date_after`, and `date_before`.

`count` is accepted for shared `web_search` compatibility, but Gemini grounding
still returns one synthesized answer with citations rather than an N-result
list.

`freshness` accepts `day`, `week`, `month`, `year`, and the shared shortcuts
`pd`, `pw`, `pm`, and `py`. `day`/`pd` adds a recency instruction to the Gemini
query instead of a hard 24-hour range. `week`, `month`, `year`, and explicit
`date_after`/`date_before` ranges set Gemini Google Search grounding's
`timeRangeFilter`. `country`, `language`, and `domain_filter` are not supported.

## Model selection

The default model is `gemini-2.5-flash` (fast and cost-effective). Any Gemini
model that supports grounding can be used via
`plugins.entries.google.config.webSearch.model`.

## Base URL overrides

Set `plugins.entries.google.config.webSearch.baseUrl` when Gemini web search
must route through an operator proxy or custom Gemini-compatible endpoint. If
that is unset, Gemini web search reuses `models.providers.google.baseUrl`. A plain
`https://generativelanguage.googleapis.com` value is normalized to
`https://generativelanguage.googleapis.com/v1beta`; custom proxy paths are kept
as provided after trimming trailing slashes.

## Custom request headers

Set `plugins.entries.google.config.webSearch.headers` when the Gemini endpoint sits
behind a gateway that needs extra request metadata, such as a routing or
service-injection header used to reach a staging backend.

```json5
{
  plugins: {
    entries: {
      google: {
        config: {
          webSearch: {
            baseUrl: "https://gateway.example.com/gemini/v1beta",
            headers: {
              "X-Routing-Target": "${GEMINI_ROUTING_TARGET}",
            },
          },
        },
      },
    },
  },
}
```

<Warning>
  Header values are plain strings stored in your config file. Secret references are
  not supported here, so this is not a place for credentials. Use `webSearch.apiKey`
  for the Gemini key, and prefer a gateway that does not require a secret in a
  header. Values are redacted in config output, but they are still stored in
  plaintext on disk.
</Warning>

Values support `${VAR}` environment substitution like any other config string. A
value whose literal text must be `${VAR}` is not supported, because an unresolved
placeholder cannot be told apart from an escaped one.

**Scope.** These headers apply only to `webSearch`. `models.providers.google.headers`
is deliberately not forwarded: those headers are scoped to the provider's own
`baseUrl` and may carry credentials, while `webSearch.baseUrl` can point somewhere
else entirely, so forwarding them would send provider credentials to a different
origin.

**Entries dropped at request time**, each with a log line naming the header and the
reason:

- a name that is not a valid HTTP token, such as one containing a space;
- a name reserved by the request contract (`Content-Type`, `x-goog-api-key`, and the
  Google API client headers), or a framing or hop-by-hop name such as
  `Content-Length`, `Transfer-Encoding`, `Connection`, and `Host`;
- a non-string or empty value;
- a value still containing an unresolved `${VAR}` because the variable is unset;
- a value with characters outside the HTTP field-value set, which covers control
  bytes and anything above `U+00FF` such as a curly quote, em dash, or CJK text.

Names are validated at request time rather than at config load on purpose: plugin
config validation is fail-closed, so rejecting a header name at startup would
disable every Google capability instead of just the offending header.

Other behavior worth knowing:

- Header names are compared case-insensitively, so two entries differing only in
  case resolve to one value rather than being joined into `"a, b"`.
- Headers apply only to the Gemini search request. Citation URLs are resolved with
  separate HEAD requests to third-party hosts, which never receive these headers.
- Changing headers partitions the search cache, so a routing change does not serve
  results cached from the previous target.
- Custom headers are dropped if a redirect crosses origins, matching the guarded
  fetch redirect policy for sensitive headers.

## Related

- [Web Search overview](/tools/web) -- all providers and auto-detection
- [Brave Search](/tools/brave-search) -- structured results with snippets
- [Perplexity Search](/tools/perplexity-search) -- structured results + content extraction
