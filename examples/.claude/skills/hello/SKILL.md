---
name: hello
description: Greet a caller and echo back a short, structured summary of their message.
params:
  required:
    - name: name
      type: string
      description: Who to greet.
  optional:
    - name: message
      type: string
      description: An optional message to summarize in one line.
output:
  type: object
  properties:
    greeting:
      type: string
    summary:
      type: string
  required:
    - greeting
    - summary
---

# Hello

A minimal example skill. It proves the round trip: HTTP request → agent run → schema-validated JSON.

## How to proceed

1. Build a friendly greeting addressed to `name`.
2. If `message` is provided, write a one-line `summary` of it. Otherwise set `summary` to an empty string.
3. Return exactly:

```json
{
  "greeting": "Hello, <name>!",
  "summary": "<one-line summary or empty string>"
}
```

This skill needs no tools beyond the read-only sandbox. To let a skill write files or run
commands, drop a `.mcp.json` sidecar next to this file (see the README, "MCP & tools").
