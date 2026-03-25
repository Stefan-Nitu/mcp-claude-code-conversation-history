import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConversationStore } from "../src/core/conversation-store.ts";
import { SearchIndex } from "../src/core/search-index.ts";
import { createHandler } from "../src/tools/handler.ts";

const TEST_DIR = join(import.meta.dir, ".test-projects");

const makeLine = (overrides: Record<string, unknown>) =>
  JSON.stringify({
    type: "user",
    message: { role: "user", content: "test" },
    timestamp: "2026-03-25T12:00:00.000Z",
    uuid: "uuid-1",
    sessionId: "session-1",
    cwd: "/Users/test/project",
    isMeta: false,
    parentUuid: null,
    ...overrides,
  });

function setupFixture(projectDir: string, sessionId: string, lines: string[]) {
  mkdirSync(join(TEST_DIR, projectDir), { recursive: true });
  writeFileSync(
    join(TEST_DIR, projectDir, `${sessionId}.jsonl`),
    lines.join("\n"),
  );
}

describe("claude_code_conversation_history tool", () => {
  let store: ConversationStore;
  let index: SearchIndex;
  let handler: ReturnType<typeof createHandler>;

  beforeEach(async () => {
    mkdirSync(TEST_DIR, { recursive: true });

    setupFixture("-Users-test-Projects-auth", "sess-auth", [
      makeLine({
        uuid: "u1",
        timestamp: "2026-03-20T10:00:00.000Z",
        message: {
          role: "user",
          content: "fix the authentication bug in login",
        },
      }),
      makeLine({
        type: "assistant",
        uuid: "u2",
        timestamp: "2026-03-20T10:01:00.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "I found the issue in the auth middleware" },
          ],
        },
      }),
    ]);

    setupFixture("-Users-test-Projects-ui", "sess-ui", [
      makeLine({
        uuid: "u3",
        timestamp: "2026-03-22T10:00:00.000Z",
        cwd: "/Users/test/Projects/ui",
        message: { role: "user", content: "align the CSS buttons properly" },
      }),
      makeLine({
        type: "assistant",
        uuid: "u4",
        timestamp: "2026-03-22T10:01:00.000Z",
        cwd: "/Users/test/Projects/ui",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "I'll fix the button alignment" }],
        },
      }),
      makeLine({
        uuid: "u5",
        timestamp: "2026-03-22T10:02:00.000Z",
        cwd: "/Users/test/Projects/ui",
        message: { role: "user", content: "also fix the header spacing" },
      }),
    ]);

    store = new ConversationStore(TEST_DIR);
    await store.load();
    index = new SearchIndex();
    index.buildFrom(store.getAllConversations());
    handler = createHandler(store, index);
    handler.setReady();
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe("action: search", () => {
    it("returns matching conversations with snippets", () => {
      // Act
      const result = handler.handle({
        action: "search",
        query: "authentication",
      });

      // Assert
      const parsed = JSON.parse(result);
      expect(parsed.results.length).toBeGreaterThan(0);
      expect(parsed.results[0].sessionId).toBe("sess-auth");
      expect(parsed.results[0].matches.length).toBeGreaterThan(0);
    });

    it("filters by project", () => {
      // Act
      const result = handler.handle({
        action: "search",
        query: "fix",
        project: "ui",
      });

      // Assert
      const parsed = JSON.parse(result);
      expect(
        parsed.results.every((r: { project: string }) =>
          r.project.includes("ui"),
        ),
      ).toBe(true);
    });

    it("respects limit parameter", () => {
      // Act
      const result = handler.handle({
        action: "search",
        query: "fix",
        limit: 1,
      });

      // Assert
      const parsed = JSON.parse(result);
      expect(parsed.results.length).toBe(1);
    });

    it("returns empty results for no matches", () => {
      // Act
      const result = handler.handle({
        action: "search",
        query: "nonexistent_xyz",
      });

      // Assert
      const parsed = JSON.parse(result);
      expect(parsed.results).toHaveLength(0);
    });

    it("returns error when query is missing", () => {
      // Act
      const result = handler.handle({ action: "search" });

      // Assert
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain("query");
    });
  });

  describe("action: list", () => {
    it("returns conversations sorted by recency", () => {
      // Act
      const result = handler.handle({ action: "list" });

      // Assert
      const parsed = JSON.parse(result);
      expect(parsed.conversations).toHaveLength(2);
      expect(parsed.conversations[0].sessionId).toBe("sess-ui");
    });

    it("filters by project", () => {
      // Act
      const result = handler.handle({ action: "list", project: "auth" });

      // Assert
      const parsed = JSON.parse(result);
      expect(parsed.conversations).toHaveLength(1);
      expect(parsed.conversations[0].sessionId).toBe("sess-auth");
    });

    it("filters by date", () => {
      // Act
      const result = handler.handle({
        action: "list",
        after: "2026-03-21T00:00:00.000Z",
      });

      // Assert
      const parsed = JSON.parse(result);
      expect(parsed.conversations).toHaveLength(1);
      expect(parsed.conversations[0].sessionId).toBe("sess-ui");
    });

    it("respects limit", () => {
      // Act
      const result = handler.handle({ action: "list", limit: 1 });

      // Assert
      const parsed = JSON.parse(result);
      expect(parsed.conversations).toHaveLength(1);
    });
  });

  describe("action: read", () => {
    it("includes contentLength on each message", () => {
      // Act
      const result = handler.handle({ action: "read", session_id: "sess-ui" });

      // Assert
      const parsed = JSON.parse(result);
      expect(parsed.messages[0].contentLength).toBe(
        "align the CSS buttons properly".length,
      );
    });

    it("truncates long messages to 500 chars by default", async () => {
      // Arrange
      const longContent = "word ".repeat(200);
      setupFixture("-Users-test-Projects-longread", "sess-longread", [
        makeLine({
          uuid: "u-lr1",
          cwd: "/Users/test/Projects/longread",
          message: { role: "user", content: longContent },
        }),
      ]);
      const s = new ConversationStore(TEST_DIR);
      await s.load();
      const idx = new SearchIndex();
      idx.buildFrom(s.getAllConversations());
      const h = createHandler(s, idx);
      h.setReady();

      // Act
      const result = h.handle({
        action: "read",
        session_id: "sess-longread",
      });

      // Assert
      const parsed = JSON.parse(result);
      expect(parsed.messages[0].content.length).toBeLessThanOrEqual(500);
      expect(parsed.messages[0].contentLength).toBe(longContent.length);
    });

    it("does not truncate short messages", () => {
      // Act
      const result = handler.handle({ action: "read", session_id: "sess-ui" });

      // Assert
      const parsed = JSON.parse(result);
      expect(parsed.messages[0].content).toBe("align the CSS buttons properly");
    });

    it("returns full content when limit is 1", async () => {
      // Arrange
      const longContent = "word ".repeat(200);
      setupFixture("-Users-test-Projects-focus", "sess-focus", [
        makeLine({
          uuid: "u-f1",
          cwd: "/Users/test/Projects/focus",
          message: { role: "user", content: longContent },
        }),
      ]);
      const s = new ConversationStore(TEST_DIR);
      await s.load();
      const idx = new SearchIndex();
      idx.buildFrom(s.getAllConversations());
      const h = createHandler(s, idx);
      h.setReady();

      // Act
      const result = h.handle({
        action: "read",
        session_id: "sess-focus",
        offset: 0,
        limit: 1,
      });

      // Assert
      const parsed = JSON.parse(result);
      expect(parsed.messages).toHaveLength(1);
      expect(parsed.messages[0].content).toBe(longContent);
    });

    describe("query param (grep mode)", () => {
      let h: ReturnType<typeof createHandler>;

      beforeEach(async () => {
        // Arrange — 7 messages, "scaling" appears in messages 2 and 5 (0-indexed)
        setupFixture("-Users-test-Projects-grep", "sess-grep", [
          makeLine({
            uuid: "g0",
            cwd: "/Users/test/Projects/grep",
            timestamp: "2026-03-25T12:00:00.000Z",
            message: { role: "user", content: "hello, let's start" },
          }),
          makeLine({
            type: "assistant",
            uuid: "g1",
            cwd: "/Users/test/Projects/grep",
            timestamp: "2026-03-25T12:01:00.000Z",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "sure, what's up?" }],
            },
          }),
          makeLine({
            uuid: "g2",
            cwd: "/Users/test/Projects/grep",
            timestamp: "2026-03-25T12:02:00.000Z",
            message: {
              role: "user",
              content: "we have a scaling problem",
            },
          }),
          makeLine({
            type: "assistant",
            uuid: "g3",
            cwd: "/Users/test/Projects/grep",
            timestamp: "2026-03-25T12:03:00.000Z",
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "I see, let me look at the code" },
              ],
            },
          }),
          makeLine({
            uuid: "g4",
            cwd: "/Users/test/Projects/grep",
            timestamp: "2026-03-25T12:04:00.000Z",
            message: { role: "user", content: "what about caching?" },
          }),
          makeLine({
            type: "assistant",
            uuid: "g5",
            cwd: "/Users/test/Projects/grep",
            timestamp: "2026-03-25T12:05:00.000Z",
            message: {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "scaling can be solved with dynamic tools",
                },
              ],
            },
          }),
          makeLine({
            uuid: "g6",
            cwd: "/Users/test/Projects/grep",
            timestamp: "2026-03-25T12:06:00.000Z",
            message: { role: "user", content: "sounds good, let's do it" },
          }),
        ]);
        const s = new ConversationStore(TEST_DIR);
        await s.load();
        const idx = new SearchIndex();
        idx.buildFrom(s.getAllConversations());
        h = createHandler(s, idx);
        h.setReady();
      });

      it("returns matching messages with surrounding context", () => {
        // Act
        const result = h.handle({
          action: "read",
          session_id: "sess-grep",
          query: "scaling",
        });

        // Assert
        const parsed = JSON.parse(result);
        const indices = parsed.messages.map((m: { index: number }) => m.index);
        // match at index 2: context should include 0,1,2,3,4
        // match at index 5: context should include 3,4,5,6
        // merged: 0,1,2,3,4,5,6
        expect(indices).toEqual([0, 1, 2, 3, 4, 5, 6]);
      });

      it("marks which messages matched the query", () => {
        // Act
        const result = h.handle({
          action: "read",
          session_id: "sess-grep",
          query: "scaling",
        });

        // Assert
        const parsed = JSON.parse(result);
        const matched = parsed.messages.filter(
          (m: { match: boolean }) => m.match,
        );
        expect(matched).toHaveLength(2);
        expect(matched[0].content).toContain("scaling problem");
        expect(matched[1].content).toContain("scaling can be solved");
      });

      it("includes message index from original conversation", () => {
        // Act
        const result = h.handle({
          action: "read",
          session_id: "sess-grep",
          query: "caching",
        });

        // Assert
        const parsed = JSON.parse(result);
        const matched = parsed.messages.find(
          (m: { match: boolean }) => m.match,
        );
        expect(matched.index).toBe(4);
      });

      it("returns empty messages array when query has no matches", () => {
        // Act
        const result = h.handle({
          action: "read",
          session_id: "sess-grep",
          query: "nonexistent_xyz",
        });

        // Assert
        const parsed = JSON.parse(result);
        expect(parsed.messages).toHaveLength(0);
      });

      it("truncates long content in grep results", async () => {
        // Arrange
        const longContent = `scaling ${"details ".repeat(200)}`;
        setupFixture("-Users-test-Projects-greplong", "sess-greplong", [
          makeLine({
            uuid: "gl1",
            cwd: "/Users/test/Projects/greplong",
            message: { role: "user", content: longContent },
          }),
        ]);
        const s = new ConversationStore(TEST_DIR);
        await s.load();
        const idx = new SearchIndex();
        idx.buildFrom(s.getAllConversations());
        const h2 = createHandler(s, idx);
        h2.setReady();

        // Act
        const result = h2.handle({
          action: "read",
          session_id: "sess-greplong",
          query: "scaling",
        });

        // Assert
        const parsed = JSON.parse(result);
        expect(parsed.messages[0].content.length).toBeLessThanOrEqual(500);
        expect(parsed.messages[0].contentLength).toBe(longContent.length);
      });
    });

    it("returns error for unknown session", () => {
      // Act
      const result = handler.handle({
        action: "read",
        session_id: "nonexistent",
      });

      // Assert
      const parsed = JSON.parse(result);
      expect(parsed.error).toBeDefined();
    });

    it("supports pagination with offset and limit", () => {
      // Act
      const result = handler.handle({
        action: "read",
        session_id: "sess-ui",
        offset: 1,
        limit: 1,
      });

      // Assert
      const parsed = JSON.parse(result);
      expect(parsed.messages).toHaveLength(1);
      expect(parsed.messages[0].content).toContain("button alignment");
    });

    it("returns error when session_id is missing", () => {
      // Act
      const result = handler.handle({ action: "read" });

      // Assert
      const parsed = JSON.parse(result);
      expect(parsed.error).toContain("session_id");
    });
  });

  describe("action: stats", () => {
    it("returns overall stats", () => {
      // Act
      const result = handler.handle({ action: "stats" });

      // Assert
      const parsed = JSON.parse(result);
      expect(parsed.totalConversations).toBe(2);
      expect(parsed.totalMessages).toBe(5);
      expect(parsed.projects.length).toBe(2);
    });

    it("includes per-project breakdown", () => {
      // Act
      const result = handler.handle({ action: "stats" });

      // Assert
      const parsed = JSON.parse(result);
      const uiProject = parsed.projects.find((p: { project: string }) =>
        p.project.includes("ui"),
      );
      expect(uiProject).toBeDefined();
      expect(uiProject.conversationCount).toBe(1);
      expect(uiProject.messageCount).toBe(3);
    });
  });

  describe("compact output", () => {
    it("uses basename of cwd as project name in list", () => {
      // Act
      const result = handler.handle({ action: "list" });

      // Assert
      const parsed = JSON.parse(result);
      const uiConv = parsed.conversations.find(
        (c: { sessionId: string }) => c.sessionId === "sess-ui",
      );
      expect(uiConv.project).toBe("ui");
    });

    it("uses basename of cwd as project name in search", () => {
      // Act
      const result = handler.handle({
        action: "search",
        query: "CSS buttons",
      });

      // Assert
      const parsed = JSON.parse(result);
      const uiResult = parsed.results.find(
        (r: { sessionId: string }) => r.sessionId === "sess-ui",
      );
      expect(uiResult.project).toBe("ui");
    });

    it("uses basename of cwd as project name in stats", () => {
      // Act
      const result = handler.handle({ action: "stats" });

      // Assert
      const parsed = JSON.parse(result);
      const uiProject = parsed.projects.find(
        (p: { project: string }) => p.project === "ui",
      );
      expect(uiProject).toBeDefined();
    });

    it("uses basename of cwd as project name in read", () => {
      // Act
      const result = handler.handle({
        action: "read",
        session_id: "sess-ui",
      });

      // Assert
      const parsed = JSON.parse(result);
      expect(parsed.project).toBe("ui");
    });

    it("cleans project name from raw dir name when cwd is empty", async () => {
      // Arrange
      setupFixture("-Users-test-Projects-nocwd", "sess-nocwd", [
        makeLine({
          uuid: "u-nocwd",
          cwd: undefined,
          message: { role: "user", content: "test no cwd" },
        }),
      ]);
      const s = new ConversationStore(TEST_DIR);
      await s.load();
      const idx = new SearchIndex();
      idx.buildFrom(s.getAllConversations());
      const h = createHandler(s, idx);
      h.setReady();

      // Act
      const result = h.handle({ action: "list", project: "nocwd" });

      // Assert
      const parsed = JSON.parse(result);
      expect(parsed.conversations[0].project).toBe("nocwd");
    });

    it("excludes cwd from list output", () => {
      // Act
      const result = handler.handle({ action: "list" });

      // Assert
      const parsed = JSON.parse(result);
      for (const conv of parsed.conversations) {
        expect(conv.cwd).toBeUndefined();
      }
    });

    it("excludes cwd from search output", () => {
      // Act
      const result = handler.handle({ action: "search", query: "fix" });

      // Assert
      const parsed = JSON.parse(result);
      for (const r of parsed.results) {
        expect(r.cwd).toBeUndefined();
      }
    });

    it("includes cwd in read output", () => {
      // Act
      const result = handler.handle({
        action: "read",
        session_id: "sess-ui",
      });

      // Assert
      const parsed = JSON.parse(result);
      expect(parsed.cwd).toBe("/Users/test/Projects/ui");
    });

    it("uses full ISO timestamps in list output", () => {
      // Act
      const result = handler.handle({ action: "list" });

      // Assert
      const parsed = JSON.parse(result);
      for (const conv of parsed.conversations) {
        expect(conv.startedAt).toContain("T");
        expect(conv.lastMessageAt).toContain("T");
      }
    });

    it("keeps full ISO timestamps in read output", () => {
      // Act
      const result = handler.handle({
        action: "read",
        session_id: "sess-ui",
      });

      // Assert
      const parsed = JSON.parse(result);
      expect(parsed.startedAt).toContain("T");
      expect(parsed.lastMessageAt).toContain("T");
    });

    it("truncates search match content to 200 chars", async () => {
      // Arrange
      const longContent = "x".repeat(300);
      setupFixture("-Users-test-Projects-long", "sess-long", [
        makeLine({
          uuid: "u-long",
          cwd: "/Users/test/Projects/long",
          message: { role: "user", content: longContent },
        }),
      ]);
      const s = new ConversationStore(TEST_DIR);
      await s.load();
      const idx = new SearchIndex();
      idx.buildFrom(s.getAllConversations());
      const h = createHandler(s, idx);
      h.setReady();

      // Act
      const result = h.handle({ action: "search", query: "xxx" });

      // Assert
      const parsed = JSON.parse(result);
      const longResult = parsed.results.find(
        (r: { sessionId: string }) => r.sessionId === "sess-long",
      );
      expect(longResult).toBeDefined();
      for (const m of longResult.matches) {
        expect(m.content.length).toBeLessThanOrEqual(200);
      }
    });

    it("caps search matches to 5 per result", async () => {
      // Arrange — create a conversation with 10 matching messages
      const lines = Array.from({ length: 10 }, (_, i) =>
        makeLine({
          uuid: `u-many-${i}`,
          cwd: "/Users/test/Projects/many",
          timestamp: `2026-03-25T${String(10 + i).padStart(2, "0")}:00:00.000Z`,
          message: { role: "user", content: `searchable keyword ${i}` },
        }),
      );
      setupFixture("-Users-test-Projects-many", "sess-many", lines);
      const s = new ConversationStore(TEST_DIR);
      await s.load();
      const idx = new SearchIndex();
      idx.buildFrom(s.getAllConversations());
      const h = createHandler(s, idx);
      h.setReady();

      // Act
      const result = h.handle({
        action: "search",
        query: "searchable keyword",
      });

      // Assert
      const parsed = JSON.parse(result);
      const manyResult = parsed.results.find(
        (r: { sessionId: string }) => r.sessionId === "sess-many",
      );
      expect(manyResult).toBeDefined();
      expect(manyResult.matches.length).toBeLessThanOrEqual(5);
    });

    it("truncates list preview to 150 chars", async () => {
      // Arrange
      const longMessage = "a]".repeat(100);
      setupFixture("-Users-test-Projects-longprev", "sess-longprev", [
        makeLine({
          uuid: "u-longprev",
          cwd: "/Users/test/Projects/longprev",
          message: { role: "user", content: longMessage },
        }),
      ]);
      const s = new ConversationStore(TEST_DIR);
      await s.load();
      const idx = new SearchIndex();
      idx.buildFrom(s.getAllConversations());
      const h = createHandler(s, idx);
      h.setReady();

      // Act
      const result = h.handle({ action: "list", project: "longprev" });

      // Assert
      const parsed = JSON.parse(result);
      expect(parsed.conversations[0].preview.length).toBeLessThanOrEqual(150);
    });

    it("applies default limit of 20 to list when none specified", async () => {
      // Arrange
      for (let i = 0; i < 25; i++) {
        setupFixture("-Users-test-Projects-bulk", `sess-bulk-${i}`, [
          makeLine({
            uuid: `u-bulk-${i}`,
            cwd: "/Users/test/Projects/bulk",
            timestamp: `2026-03-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`,
            message: { role: "user", content: `bulk message ${i}` },
          }),
        ]);
      }
      const s = new ConversationStore(TEST_DIR);
      await s.load();
      const idx = new SearchIndex();
      idx.buildFrom(s.getAllConversations());
      const h = createHandler(s, idx);
      h.setReady();

      // Act
      const result = h.handle({ action: "list", project: "bulk" });

      // Assert
      const parsed = JSON.parse(result);
      expect(parsed.conversations).toHaveLength(20);
    });

    it("explicit limit overrides default in list", async () => {
      // Arrange
      for (let i = 0; i < 25; i++) {
        setupFixture("-Users-test-Projects-bulk2", `sess-bulk2-${i}`, [
          makeLine({
            uuid: `u-bulk2-${i}`,
            cwd: "/Users/test/Projects/bulk2",
            timestamp: `2026-03-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`,
            message: { role: "user", content: `bulk2 message ${i}` },
          }),
        ]);
      }
      const s = new ConversationStore(TEST_DIR);
      await s.load();
      const idx = new SearchIndex();
      idx.buildFrom(s.getAllConversations());
      const h = createHandler(s, idx);
      h.setReady();

      // Act
      const result = h.handle({ action: "list", project: "bulk2", limit: 5 });

      // Assert
      const parsed = JSON.parse(result);
      expect(parsed.conversations).toHaveLength(5);
    });

    it("returns raw project name when no cwd and no -Projects- in name", async () => {
      // Arrange
      setupFixture("plain-dir", "sess-plain", [
        makeLine({
          uuid: "u-plain",
          cwd: undefined,
          message: { role: "user", content: "test plain" },
        }),
      ]);
      const s = new ConversationStore(TEST_DIR);
      await s.load();
      const idx = new SearchIndex();
      idx.buildFrom(s.getAllConversations());
      const h = createHandler(s, idx);
      h.setReady();

      // Act
      const result = h.handle({ action: "list", project: "plain" });

      // Assert
      const parsed = JSON.parse(result);
      expect(parsed.conversations[0].project).toBe("plain-dir");
    });

    it("cleans project name in stats when conversation has no cwd", async () => {
      // Arrange
      setupFixture("-Users-test-Projects-nocwd-stats", "sess-nocwd-s", [
        makeLine({
          uuid: "u-nocwd-s",
          cwd: undefined,
          message: { role: "user", content: "test stats nocwd" },
        }),
      ]);
      const s = new ConversationStore(TEST_DIR);
      await s.load();
      const idx = new SearchIndex();
      idx.buildFrom(s.getAllConversations());
      const h = createHandler(s, idx);
      h.setReady();

      // Act
      const result = h.handle({ action: "stats" });

      // Assert
      const parsed = JSON.parse(result);
      const proj = parsed.projects.find(
        (p: { project: string }) => p.project === "nocwd-stats",
      );
      expect(proj).toBeDefined();
    });
  });

  describe("indexing in progress", () => {
    it("returns indexing status when not ready", () => {
      // Arrange
      const notReadyHandler = createHandler(store, index);

      // Act
      const result = notReadyHandler.handle({
        action: "search",
        query: "test",
      });

      // Assert
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe("indexing");
      expect(parsed.message).toContain("indexing");
    });

    it("includes progress info when available", () => {
      // Arrange
      const notReadyHandler = createHandler(store, index);
      notReadyHandler.setProgress(42, 117);

      // Act
      const result = notReadyHandler.handle({ action: "stats" });

      // Assert
      const parsed = JSON.parse(result);
      expect(parsed.status).toBe("indexing");
      expect(parsed.progress).toBe("42/117 conversations indexed");
    });

    it("works normally after setReady", () => {
      // Arrange
      const h = createHandler(store, index);
      h.setReady();

      // Act
      const result = h.handle({ action: "stats" });

      // Assert
      const parsed = JSON.parse(result);
      expect(parsed.totalConversations).toBeDefined();
      expect(parsed.status).toBeUndefined();
    });
  });
});
