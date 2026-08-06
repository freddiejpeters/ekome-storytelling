import type { WebSocketServer, WebSocket } from "ws";
import { db, conversations, messages, memories } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { openai } from "@workspace/integrations-openai-ai-server";

const MODEL = "gpt-5.6-terra";

// ─── Memory context (smart — avoids repeating same memories) ──────────────────

export async function getSmartMemoryContext(conversationId: number): Promise<string> {
  const [memoryRows, recentConvs] = await Promise.all([
    db.select().from(memories).orderBy(desc(memories.createdAt)).limit(80),
    db.select({ id: conversations.id, title: conversations.title })
      .from(conversations)
      .orderBy(desc(conversations.updatedAt))
      .limit(6),
  ]);

  if (memoryRows.length === 0) return "";

  // Gather recent conversation titles to know what was recently discussed
  const recentTopics = recentConvs
    .filter((c) => c.id !== conversationId)
    .map((c) => c.title.toLowerCase())
    .join(", ");

  // Group memories by type; for each type keep the most recent ones
  const grouped: Record<string, string[]> = {};
  for (const m of memoryRows) {
    if (!grouped[m.type]) grouped[m.type] = [];
    if (grouped[m.type].length < 5) grouped[m.type].push(m.content);
  }

  const sections = Object.entries(grouped)
    .map(([type, items]) => `${type}: ${items.join(" · ")}`)
    .join("\n");

  const recentNote = recentTopics
    ? `\n\n— Recently discussed (do NOT use these as conversation openers again) —\n${recentTopics}`
    : "";

  return `\n\n— What you know about this person —\n${sections}${recentNote}`;
}

// ─── System prompt ────────────────────────────────────────────────────────────

export function buildSystemPrompt(memoryContext: string, convTitle: string): string {
  return `You are eKoMe — a close friend who genuinely remembers and cares.

Voice rules (critical — this is spoken audio, not text):
- 1 to 3 short sentences per turn. That's roughly 5–15 seconds of speech. Never more.
- One question at a time. Only ask it if it genuinely follows from what they said.
- Match their energy. If they're brief, be brief. If they're expansive, stay engaged but concise.
- Never summarise what they just said back to them.
- Never use therapist phrases: "I hear that", "That sounds like", "It's valid to feel", "It's great that".
- Never give unsolicited advice or life-coach them.
- No markdown, no bullet points, no lists. Write entirely for the ear.
- Don't end every turn with a question. Leave conversational space.

Memory:
- Remember things naturally, the way a friend would — only when genuinely relevant.
- Never say "Based on our previous conversations". Just remember, like a person.
- Never invent things they haven't told you.
- Vary which memories you reference. Don't fixate on the same detail.

Memory hygiene (important):
- If the person mentions testing the app, debugging, complaining about the interface, or discussing how eKoMe works — do NOT treat that as biographical memory worth keeping.
- Ignore and do not reference: requests to change the UI, comments about latency, voice settings, or technical implementation.${memoryContext}

This conversation: "${convTitle}"`;
}

// ─── Save messages to DB ──────────────────────────────────────────────────────

async function saveMessages(
  conversationId: number,
  userText: string,
  assistantText: string
): Promise<void> {
  try {
    if (userText.trim()) {
      // Dedup: don't save if already present
      const recent = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(desc(messages.createdAt))
        .limit(10);
      const alreadySaved = recent.some(
        (m) => m.role === "user" && m.content.trim() === userText.trim()
      );
      if (!alreadySaved) {
        await db
          .insert(messages)
          .values({ conversationId, role: "user", content: userText.trim() });
      }
    }
    if (assistantText.trim()) {
      await db
        .insert(messages)
        .values({ conversationId, role: "assistant", content: assistantText.trim() });
    }
    await db
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, conversationId));
  } catch (e) {
    console.error("[ws-llm] Failed to save messages:", e);
  }
}

// ─── WebSocket custom LLM handler ────────────────────────────────────────────

type ElevenLabsMsg =
  | {
      type: "conversation_initiation_client_data";
      custom_llm_extra_body?: Record<string, unknown>;
    }
  | {
      type: "user_transcript";
      user_transcription_event: { user_transcript: string };
    }
  | { type: "interruption"; interruption_event: { event_id: number } }
  | { type: string };

export function setupWsLlm(wss: WebSocketServer): void {
  wss.on("connection", (ws: WebSocket) => {
    let conversationId: number | null = null;
    let userTurnStart = 0;

    ws.on("message", async (raw: Buffer) => {
      let msg: ElevenLabsMsg;
      try {
        msg = JSON.parse(raw.toString()) as ElevenLabsMsg;
      } catch {
        return;
      }

      switch (msg.type) {
        case "conversation_initiation_client_data": {
          const extra = (msg as { type: string; custom_llm_extra_body?: Record<string, unknown> })
            .custom_llm_extra_body;
          if (extra?.conversationId) conversationId = Number(extra.conversationId);
          console.log(`[ws-llm] session started, conversationId=${conversationId}`);
          break;
        }

        case "interruption":
          // ElevenLabs handles the actual audio interruption; nothing for us to do
          break;

        case "user_transcript": {
          const userText = (
            msg as {
              type: string;
              user_transcription_event: { user_transcript: string };
            }
          ).user_transcription_event.user_transcript?.trim();

          if (!userText || !conversationId) break;

          userTurnStart = Date.now();
          console.log(`[ws-llm] user said: "${userText.slice(0, 60)}"`);

          try {
            const [conv] = await db
              .select()
              .from(conversations)
              .where(eq(conversations.id, conversationId));
            const history = await db
              .select()
              .from(messages)
              .where(eq(messages.conversationId, conversationId))
              .orderBy(messages.createdAt);

            const memoryContext = await getSmartMemoryContext(conversationId);
            const systemPrompt = buildSystemPrompt(memoryContext, conv?.title ?? "");

            const chatMessages = [
              { role: "system" as const, content: systemPrompt },
              ...history.map((m) => ({
                role: m.role as "user" | "assistant",
                content: m.content,
              })),
              { role: "user" as const, content: userText },
            ];

            let fullResponse = "";
            let firstTokenAt = 0;

            const stream = await openai.chat.completions.create({
              model: MODEL,
              max_completion_tokens: 350,
              messages: chatMessages,
              stream: true,
            });

            for await (const chunk of stream) {
              const content = chunk.choices[0]?.delta?.content;
              if (content) {
                if (!fullResponse) {
                  firstTokenAt = Date.now();
                  console.log(`[ws-llm] first token: ${firstTokenAt - userTurnStart}ms`);
                }
                fullResponse += content;
                if (ws.readyState === 1 /* OPEN */) {
                  ws.send(
                    JSON.stringify({
                      type: "agent_response",
                      agent_response_event: { agent_response: content },
                    })
                  );
                }
              }
            }

            console.log(`[ws-llm] response complete in ${Date.now() - userTurnStart}ms`);

            // Save to DB (fire-and-forget)
            saveMessages(conversationId, userText, fullResponse).catch(() => {});
          } catch (err) {
            console.error("[ws-llm] LLM error:", err);
            if (ws.readyState === 1) {
              ws.send(
                JSON.stringify({
                  type: "agent_response",
                  agent_response_event: {
                    agent_response: "Sorry, I lost my train of thought for a moment.",
                  },
                })
              );
            }
          }
          break;
        }

        default:
          break;
      }
    });

    ws.on("error", (err) => console.error("[ws-llm] socket error:", err));
    ws.on("close", () => {
      console.log(`[ws-llm] session closed, conversationId=${conversationId}`);
      conversationId = null;
    });
  });
}
