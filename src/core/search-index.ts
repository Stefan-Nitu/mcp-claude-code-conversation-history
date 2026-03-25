import MiniSearch from "minisearch";
import type { Conversation, SearchResult } from "../types.js";

interface IndexedDocument {
  id: string;
  sessionId: string;
  project: string;
  cwd: string;
  content: string;
  messageType: "user" | "assistant";
  timestamp: string;
}

interface SearchOptions {
  project?: string;
  limit?: number;
}

export class SearchIndex {
  private index: MiniSearch<IndexedDocument>;
  private conversationMessages = new Map<string, Conversation>();

  constructor() {
    this.index = new MiniSearch<IndexedDocument>({
      fields: ["content"],
      storeFields: [
        "sessionId",
        "project",
        "cwd",
        "content",
        "messageType",
        "timestamp",
      ],
      tokenize: (text) => this.tokenize(text),
      searchOptions: {
        fuzzy: 0.2,
        prefix: true,
      },
    });
  }

  tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(/[\s_\-/.,;:!?'"()[\]{}]+/)
      .filter((w) => w.length > 1);
  }

  buildFrom(conversations: Conversation[]): void {
    this.conversationMessages.clear();

    const documents: IndexedDocument[] = [];
    let docId = 0;

    for (const conv of conversations) {
      this.conversationMessages.set(conv.sessionId, conv);

      for (const msg of conv.messages) {
        documents.push({
          id: String(docId++),
          sessionId: conv.sessionId,
          project: conv.project,
          cwd: conv.cwd,
          content: msg.content,
          messageType: msg.type,
          timestamp: msg.timestamp,
        });
      }
    }

    this.index.addAll(documents);
  }

  search(query: string, options: SearchOptions = {}): SearchResult[] {
    if (!query.trim()) return [];

    const rawResults = this.index.search(query);
    if (rawResults.length === 0) return [];

    // Group by session, aggregate scores
    const sessionScores = new Map<
      string,
      { score: number; matchingDocs: IndexedDocument[] }
    >();

    for (const result of rawResults) {
      const doc = result as unknown as {
        sessionId: string;
        project: string;
        score: number;
      };
      const sessionId = doc.sessionId;
      const existing = sessionScores.get(sessionId);

      const matchDoc: IndexedDocument = {
        id: result.id as string,
        sessionId: (result as unknown as IndexedDocument).sessionId,
        project: (result as unknown as IndexedDocument).project,
        cwd: (result as unknown as IndexedDocument).cwd,
        content: (result as unknown as IndexedDocument).content,
        messageType: (result as unknown as IndexedDocument).messageType,
        timestamp: (result as unknown as IndexedDocument).timestamp,
      };

      if (existing) {
        existing.score += result.score;
        existing.matchingDocs.push(matchDoc);
      } else {
        sessionScores.set(sessionId, {
          score: result.score,
          matchingDocs: [matchDoc],
        });
      }
    }

    let results: SearchResult[] = Array.from(sessionScores.entries()).map(
      ([sessionId, data]) => {
        const conv = this.conversationMessages.get(sessionId)!;
        return {
          sessionId,
          project: conv.project,
          cwd: conv.cwd,
          score: data.score,
          matches: data.matchingDocs.map((doc) => ({
            type: doc.messageType,
            content: doc.content,
            timestamp: doc.timestamp,
          })),
        };
      },
    );

    if (options.project) {
      const projectFilter = options.project.toLowerCase();
      results = results.filter(
        (r) =>
          r.project.toLowerCase().includes(projectFilter) ||
          r.cwd.toLowerCase().includes(projectFilter),
      );
    }

    results.sort((a, b) => b.score - a.score);

    const limit = options.limit ?? 10;
    return results.slice(0, limit);
  }
}
