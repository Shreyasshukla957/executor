---
"apps": patch
"@executor-js/app-templates": patch
---

`mcpRouter` and `graphqlRouter` take the `account` their headers belong to in
place of `accountId`. Headers are accepted only with an account. Pass
`cache: ctx.cache`: an account's catalog is kept in that account's cache scope,
and headers and credentials no longer enter the cache key, so token renewals
and host-limited credential handles keep the cached catalog.

Quick-add MCP apps with OAuth now declare the server's host, so app code only
holds a handle for the token.
