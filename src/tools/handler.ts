import { basename } from "node:path";
import type { ConversationStore } from "../core/conversation-store.js";
import type { SearchIndex } from "../core/search-index.js";

type Args = Record<string, unknown>;

const DEFAULT_LIST_LIMIT = 20;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_MATCHES_PER_RESULT = 5;
const PREVIEW_MAX = 150;
const MATCH_CONTENT_MAX = 200;
const READ_CONTENT_MAX = 500;
const READ_CONTEXT_MESSAGES = 2;

function cleanProjectName(cwd: string, rawProject: string): string {
  if (cwd) return basename(cwd);
  // Fallback: strip the home directory prefix from the raw project dir name
  const idx = rawProject.lastIndexOf("-Projects-");
  if (idx !== -1) return rawProject.slice(idx + "-Projects-".length);
  return rawProject;
}

export function createHandler(store: ConversationStore, index: SearchIndex) {
  let ready = false;
  let progressCurrent = 0;
  let progressTotal = 0;

  return {
    setReady() {
      ready = true;
    },

    setProgress(current: number, total: number) {
      progressCurrent = current;
      progressTotal = total;
    },

    handle(args: Args): string {
      if (!ready) {
        const response: Record<string, unknown> = {
          status: "indexing",
          message:
            "Still indexing conversation history, please try again shortly.",
        };
        if (progressTotal > 0) {
          response.progress = `${progressCurrent}/${progressTotal} conversations indexed`;
        }
        return JSON.stringify(response);
      }

      const action = args.action as string;

      switch (action) {
        case "search":
          return handleSearch(args, index);
        case "list":
          return handleList(args, store);
        case "read":
          return handleRead(args, store, index);
        case "stats":
          return handleStats(store);
        default:
          return JSON.stringify({ error: `Unknown action: ${action}` });
      }
    },
  };
}

function handleSearch(args: Args, index: SearchIndex): string {
  const query = args.query as string | undefined;
  if (!query) {
    return JSON.stringify({ error: "query is required for search action" });
  }

  const results = index.search(query, {
    project: args.project as string | undefined,
    limit: (args.limit as number | undefined) ?? DEFAULT_SEARCH_LIMIT,
  });

  return JSON.stringify({
    action: "search",
    query,
    results: results.map((r) => ({
      sessionId: r.sessionId,
      project: cleanProjectName(r.cwd, r.project),
      score: Math.round(r.score * 100) / 100,
      matches: r.matches.slice(0, MAX_MATCHES_PER_RESULT).map((m) => ({
        type: m.type,
        content: m.content.slice(0, MATCH_CONTENT_MAX),
        timestamp: m.timestamp,
      })),
    })),
  });
}

function handleList(args: Args, store: ConversationStore): string {
  const conversations = store.listConversations({
    project: args.project as string | undefined,
    after: args.after as string | undefined,
    before: args.before as string | undefined,
    limit: (args.limit as number | undefined) ?? DEFAULT_LIST_LIMIT,
  });

  return JSON.stringify({
    action: "list",
    conversations: conversations.map((c) => ({
      sessionId: c.sessionId,
      project: cleanProjectName(c.cwd, c.project),
      startedAt: c.startedAt,
      lastMessageAt: c.lastMessageAt,
      messageCount: c.messageCount,
      preview: c.preview.slice(0, PREVIEW_MAX),
    })),
  });
}

function handleRead(
  args: Args,
  store: ConversationStore,
  index: SearchIndex,
): string {
  const sessionId = args.session_id as string | undefined;
  if (!sessionId) {
    return JSON.stringify({ error: "session_id is required for read action" });
  }

  const conversation = store.getConversation(sessionId);
  if (!conversation) {
    return JSON.stringify({ error: `Conversation not found: ${sessionId}` });
  }

  const query = args.query as string | undefined;
  const allMessages = conversation.messages;

  if (query) {
    return handleReadGrep(conversation, allMessages, query, index);
  }

  return handleReadBrowse(conversation, allMessages, args);
}

function handleReadBrowse(
  conversation: {
    sessionId: string;
    project: string;
    cwd: string;
    startedAt: string;
    lastMessageAt: string;
    messageCount: number;
  },
  allMessages: Array<{
    type: "user" | "assistant";
    content: string;
    timestamp: string;
    uuid: string;
  }>,
  args: Args,
): string {
  let messages = allMessages;
  const offset = args.offset as number | undefined;
  const limit = args.limit as number | undefined;

  if (offset !== undefined) {
    messages = messages.slice(offset);
  }
  if (limit !== undefined) {
    messages = messages.slice(0, limit);
  }

  const fullContent = limit === 1;

  return JSON.stringify({
    action: "read",
    sessionId: conversation.sessionId,
    project: cleanProjectName(conversation.cwd, conversation.project),
    cwd: conversation.cwd,
    startedAt: conversation.startedAt,
    lastMessageAt: conversation.lastMessageAt,
    totalMessages: conversation.messageCount,
    messages: messages.map((m) => ({
      type: m.type,
      content:
        fullContent || m.content.length <= READ_CONTENT_MAX
          ? m.content
          : m.content.slice(0, READ_CONTENT_MAX),
      contentLength: m.content.length,
      timestamp: m.timestamp,
    })),
  });
}

function handleReadGrep(
  conversation: {
    sessionId: string;
    project: string;
    cwd: string;
    startedAt: string;
    lastMessageAt: string;
    messageCount: number;
  },
  allMessages: Array<{
    type: "user" | "assistant";
    content: string;
    timestamp: string;
    uuid: string;
  }>,
  query: string,
  index: SearchIndex,
): string {
  const matchingIndices = new Set<number>();
  const terms = index.tokenize(query);

  for (let i = 0; i < allMessages.length; i++) {
    const msgTerms = index.tokenize(allMessages[i]!.content);
    if (terms.some((t) => msgTerms.some((mt) => mt.includes(t)))) {
      matchingIndices.add(i);
    }
  }

  if (matchingIndices.size === 0) {
    return JSON.stringify({
      action: "read",
      sessionId: conversation.sessionId,
      project: cleanProjectName(conversation.cwd, conversation.project),
      totalMessages: conversation.messageCount,
      query,
      messages: [],
    });
  }

  const includeIndices = new Set<number>();
  for (const idx of matchingIndices) {
    for (
      let i = Math.max(0, idx - READ_CONTEXT_MESSAGES);
      i <= Math.min(allMessages.length - 1, idx + READ_CONTEXT_MESSAGES);
      i++
    ) {
      includeIndices.add(i);
    }
  }

  const sortedIndices = [...includeIndices].sort((a, b) => a - b);

  return JSON.stringify({
    action: "read",
    sessionId: conversation.sessionId,
    project: cleanProjectName(conversation.cwd, conversation.project),
    totalMessages: conversation.messageCount,
    query,
    messages: sortedIndices.map((i) => {
      const m = allMessages[i]!;
      return {
        index: i,
        type: m.type,
        content:
          m.content.length <= READ_CONTENT_MAX
            ? m.content
            : m.content.slice(0, READ_CONTENT_MAX),
        contentLength: m.content.length,
        match: matchingIndices.has(i),
        timestamp: m.timestamp,
      };
    }),
  });
}

function handleStats(store: ConversationStore): string {
  const stats = store.getStats();

  return JSON.stringify({
    action: "stats",
    totalConversations: stats.totalConversations,
    totalMessages: stats.totalMessages,
    projects: stats.projects.map((p) => ({
      project: cleanProjectName(p.cwd, p.project),
      conversationCount: p.conversationCount,
      messageCount: p.messageCount,
      firstConversation: p.firstConversation,
      lastConversation: p.lastConversation,
    })),
  });
}
