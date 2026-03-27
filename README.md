[![NPM Version](https://img.shields.io/npm/v/mcp-claude-code-conversation-history)](https://www.npmjs.com/package/mcp-claude-code-conversation-history)
[![NPM Downloads](https://img.shields.io/npm/dm/mcp-claude-code-conversation-history)](https://www.npmjs.com/package/mcp-claude-code-conversation-history)
[![CI Status](https://github.com/Stefan-Nitu/mcp-claude-code-conversation-history/actions/workflows/ci.yml/badge.svg)](https://github.com/Stefan-Nitu/mcp-claude-code-conversation-history/actions/workflows/ci.yml)
[![MIT Licensed](https://img.shields.io/npm/l/mcp-claude-code-conversation-history)](https://github.com/Stefan-Nitu/mcp-claude-code-conversation-history/blob/main/LICENSE)

# MCP Claude Code Conversation History

A Model Context Protocol (MCP) server that gives Claude Code access to its own conversation history. Search, browse, and read past conversations across all projects using BM25 keyword search.

## Overview

Every Claude Code session starts fresh — you can't ask "what did we discuss about auth last week?" or "show me that refactoring conversation". Your conversation history sits in JSONL files on disk, invisible to Claude.

MCP Claude Code Conversation History indexes those files and exposes them through a single MCP tool, so Claude can search and read its own past conversations.

**Key Features:**
- **BM25 Search** - Keyword search with relevance ranking via [MiniSearch](https://github.com/lucaongo/minisearch)
- **Cross-Project** - Search across all Claude Code projects at once
- **Background Indexing** - Server starts immediately, indexes in the background
- **Zero Config** - Reads directly from `~/.claude/projects/`, no setup needed

## Installation

### Via npm (Recommended)

```bash
npm install -g mcp-claude-code-conversation-history
```

### From Source

```bash
git clone https://github.com/Stefan-Nitu/mcp-claude-code-conversation-history.git
cd mcp-claude-code-conversation-history
bun install
bun run build
```

> Requires Bun v1.3.8+ (development) and Node.js v20+ (runtime)

### Add a CLAUDE.md hint

MCP tools are deferred (loaded on-demand), so Claude may not use them automatically. Add this to your project's `CLAUDE.md` to ensure it does:

```markdown
## Conversation History

You have access to past conversation history via MCP. Always use it when the user asks about previous work, past sessions, or anything from a prior conversation.
```

## Quick Start

### With Claude Code

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "mcp-claude-code-conversation-history": {
      "command": "npx",
      "args": ["-y", "mcp-claude-code-conversation-history"]
    }
  }
}
```

Or if installed globally:

```json
{
  "mcpServers": {
    "mcp-claude-code-conversation-history": {
      "command": "mcp-claude-code-conversation-history"
    }
  }
}
```

Restart Claude Code to pick up the new server.

### With Claude Desktop

Add to your Claude Desktop configuration file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "mcp-claude-code-conversation-history": {
      "command": "npx",
      "args": ["-y", "mcp-claude-code-conversation-history"]
    }
  }
}
```

### With MCP Inspector

Test the server interactively:

```bash
npx @modelcontextprotocol/inspector npx -y mcp-claude-code-conversation-history
```

## Available Actions

The server exposes **1 tool** (`claude_code_conversation_history`) with **4 actions**:

| Action | Description | Required Params | Optional Params |
|--------|-------------|-----------------|-----------------|
| **stats** | Overview of all conversations and projects | — | — |
| **list** | Browse conversations by project/date | — | `project`, `after`, `before`, `limit` |
| **search** | BM25 keyword search across all history | `query` | `project`, `limit` |
| **read** | Read full conversation by session ID | `session_id` | `offset`, `limit` |

### Parameters Reference

| Parameter | Type | Description |
|-----------|------|-------------|
| `action` | `string` | **Required.** One of: `search`, `list`, `read`, `stats` |
| `query` | `string` | Search keywords (required for `search`) |
| `session_id` | `string` | Session ID from search/list results (required for `read`) |
| `project` | `string` | Filter by project name (partial match) |
| `after` | `string` | Only show conversations after this ISO date |
| `before` | `string` | Only show conversations before this ISO date |
| `limit` | `number` | Maximum number of results |
| `offset` | `number` | Skip first N messages (for `read` pagination) |

## Example Usage

### Get an overview

```json
{ "action": "stats" }
```

Returns total conversations, messages, and per-project breakdown.

### Browse recent conversations in a project

```json
{ "action": "list", "project": "my-app", "limit": 5 }
```

### Search for a topic

```json
{ "action": "search", "query": "authentication migration", "limit": 5 }
```

Returns ranked results with matching message snippets.

### Read a full conversation

```json
{ "action": "read", "session_id": "abc-123-def", "limit": 20 }
```

Use `session_id` from search or list results. Supports pagination with `offset`/`limit`.

## Response Format

All actions return structured JSON:

```json
{
  "action": "search",
  "query": "auth",
  "results": [
    {
      "sessionId": "abc-123",
      "project": "-Users-me-Projects-my-app",
      "cwd": "/Users/me/Projects/my-app",
      "score": 42.5,
      "matches": [
        {
          "type": "user",
          "content": "fix the authentication bug...",
          "timestamp": "2026-03-20T10:00:00.000Z"
        }
      ]
    }
  ]
}
```

## How It Works

1. On startup, reads Claude Code's JSONL conversation files from `~/.claude/projects/`
2. Parses user and assistant messages, filtering noise (thinking blocks, tool calls, system messages, meta content)
3. Deduplicates streamed assistant messages
4. Indexes all messages with MiniSearch (BM25 ranking)
5. Server starts immediately — indexing happens in the background
6. If called before indexing completes, returns progress status

## Development

### Project Structure

```
mcp-claude-code-conversation-history/
├── src/
│   ├── index.ts                     # MCP server entry point
│   ├── types.ts                     # Shared type definitions
│   ├── core/
│   │   ├── conversation-parser.ts   # JSONL parsing and content extraction
│   │   ├── conversation-store.ts    # Conversation discovery and loading
│   │   └── search-index.ts          # BM25 search via MiniSearch
│   ├── tools/
│   │   ├── definitions.ts           # Zod schema for tool parameters
│   │   └── handler.ts               # Action routing and response formatting
│   └── utils/
│       └── logger.ts                # Pino logger (stderr only)
├── tests/
│   ├── conversation-parser.test.ts
│   ├── conversation-store.test.ts
│   ├── search-index.test.ts
│   └── tools.test.ts
└── docs/                            # Architecture & testing docs
```

### Testing

```bash
# Run all tests
bun test

# Run in watch mode
bun test --watch

# Type checking
bun run typecheck

# Linting
bun run lint

# Full check (typecheck + lint)
bun run check
```

### Requirements

- **Node.js** >= 20.0.0
- Claude Code conversation files in `~/.claude/projects/`

## Troubleshooting

### Server Not Starting

If the tool doesn't appear in Claude Code:

1. Check `~/.claude.json` has the correct MCP server configuration
2. Restart Claude Code after adding the configuration
3. Check stderr logs for error messages

### No Conversations Found

If stats shows 0 conversations:

1. Verify `~/.claude/projects/` exists and contains JSONL files
2. Check that you have Claude Code conversation history
3. The server only indexes top-level JSONL files (subagent files are skipped)

### Search Not Finding Expected Results

BM25 search works best with specific nouns and terms:

1. Use specific keywords, not generic phrases
2. Try different terms that might appear in the conversation
3. Use the `project` filter to narrow results
4. Check `list` action to confirm the conversation exists

## Contributing

1. Fork the repository
2. Create a feature branch
3. **Write tests first** (TDD approach)
4. Implement the feature
5. Ensure all tests pass (`bun test`)
6. Run linting (`bun run lint`)
7. Submit a pull request

## License

MIT

## Related Projects

- [Model Context Protocol](https://modelcontextprotocol.io) - MCP specification and documentation
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) - SDK used by this server
- [MCP Refactor TypeScript](https://github.com/Stefan-Nitu/mcp-refactor-typescript) - MCP server for TypeScript refactoring
