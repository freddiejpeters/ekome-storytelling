/**
 * OpenAI-compatible Chat Completions endpoint for ElevenLabs custom LLM.
 * ElevenLabs calls POST /api/llm/v1/chat/completions with the conversation history.
 * We inject memory context, call OpenAI, and stream back in OpenAI SSE format.
 */
import { Router, type IRouter } from "express";
import { db, conversations, messages } from "@workspace/db";
import { eq } from "drizzle-orm";
import { openai } from "@workspace/integrations-openai-ai-server";
import { getSmartMemoryContext, buildSystemPrompt } from "../lib/ws-llm.js";

const router: IRouter = Router();

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionsBody {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  // ElevenLabs forwards customLlmExtraBody fields to us at the top level
  conversationId?: number | string;
  [key: string]: unknown;
}

// Save user message + assistant response to DB (fire-and-forget)
async function persistMessages(
  conversationId: number,
  userText: string,
  assistantText: string
): Promise<void> {
  try {
    // Only save the latest user message (the last one in the array)
    if (userText.trim()) {
      await db.insert(messages).values({
        conversationId,
        role: "user",
        content: userText.trim(),
      });
    }
    if (assistantText.trim()) {
      await db.insert(messages).values({
        conversationId,
        role: "assistant",
        content: assistantText.trim(),
      });
    }
    await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, conversationId));
  } catch (e) {
    console.error("[LLM] DB persist error:", e);
  }
}

// POST /api/llm/v1/chat/completions
router.post("/llm/v1/chat/completions", async (req, res): Promise<void> => {
  const body = req.body as ChatCompletionsBody;
  const { messages: incomingMessages = [], stream = true } = body;

  // ElevenLabs puts customLlmExtraBody fields at the top level of the request body
  const conversationId = body.conversationId != null ? Number(body.conversationId) : null;

  console.log(`[LLM] Request — conversationId=${conversationId}, msgs=${incomingMessages.length}`);

  // Build our smart system prompt with memory context
  let systemContent: string | null = null;
  if (conversationId) {
    try {
      const [conv] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversationId));
      const memCtx = await getSmartMemoryContext(conversationId);
      systemContent = buildSystemPrompt(memCtx, conv?.title ?? "");
    } catch (e) {
      console.error("[LLM] Failed to build memory context:", e);
    }
  }

  // Inject our system prompt (replace any system message ElevenLabs sent)
  let chatMessages: ChatMessage[] = incomingMessages.filter((m) => m.role !== "system");
  if (systemContent) {
    chatMessages = [{ role: "system", content: systemContent }, ...chatMessages];
  }

  // Find the latest user message (for DB persistence)
  const latestUserMsg = [...incomingMessages].reverse().find((m) => m.role === "user");

  const startMs = Date.now();

  if (stream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    let fullResponse = "";
    let firstChunkMs = 0;

    try {
      const openaiStream = await openai.chat.completions.create({
        model: "gpt-5.6-terra",
        max_completion_tokens: 180, // ~5-15 seconds of speech; keep responses concise
        messages: chatMessages,
        stream: true,
      });

      for await (const chunk of openaiStream) {
        const content = chunk.choices[0]?.delta?.content;
        if (content) {
          if (!fullResponse) {
            firstChunkMs = Date.now() - startMs;
            console.log(`[LLM] First token: ${firstChunkMs}ms`);
          }
          fullResponse += content;
        }
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }

      res.write("data: [DONE]\n\n");
      res.end();

      console.log(`[LLM] Done in ${Date.now() - startMs}ms, len=${fullResponse.length}`);

      // Save to DB (async)
      if (conversationId && fullResponse && latestUserMsg) {
        persistMessages(conversationId, latestUserMsg.content, fullResponse).catch(() => {});
      }
    } catch (err) {
      console.error("[LLM] Stream error:", err);
      if (!res.headersSent) res.status(500).end();
      else res.end();
    }
  } else {
    // Non-streaming fallback
    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-5.6-terra",
        max_completion_tokens: 350,
        messages: chatMessages,
      });
      res.json(completion);
    } catch (err) {
      console.error("[LLM] Non-stream error:", err);
      res.status(500).json({ error: "LLM request failed" });
    }
  }
});

export default router;
