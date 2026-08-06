import { Router, type IRouter } from "express";
import { eq, desc, sql, and } from "drizzle-orm";
import { db, conversations, messages, stories, memories, storyRevisions } from "@workspace/db";
import {
  CreateConversationBody,
  UpdateConversationBody,
  UpdateConversationParams,
  GetConversationParams,
  DeleteConversationParams,
  ListConversationsQueryParams,
  SendMessageBody,
  SendMessageParams,
  TranscribeAudioBody,
  TranscribeAudioParams,
  GenerateStoryBody,
  GenerateStoryParams,
  GetStoryParams,
  UpdateStoryBody,
  UpdateStoryParams,
  DeleteStoryParams,
  UpdateStoryByIdParams,
  UpdateStoryByIdBody,
  DeleteStoryByIdParams,
  SynthesizeSpeechBody,
  ListMemoriesQueryParams,
  SearchMemoryBody,
} from "@workspace/api-zod";
import { openai } from "@workspace/integrations-openai-ai-server";
import { speechToText, textToSpeech } from "@workspace/integrations-openai-ai-server/audio";

const router: IRouter = Router();

const MODEL = "gpt-5.6-terra";

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseId(raw: string | string[]): number {
  return parseInt(Array.isArray(raw) ? raw[0] : raw, 10);
}

function getTimeOfDay(): string {
  const h = new Date().getHours();
  if (h < 6) return "late night";
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  if (h < 21) return "evening";
  return "night";
}

async function getMemoryContext(): Promise<string> {
  const memoryRows = await db
    .select()
    .from(memories)
    .orderBy(desc(memories.createdAt))
    .limit(60);
  if (memoryRows.length === 0) return "";
  const grouped: Record<string, string[]> = {};
  for (const m of memoryRows) {
    if (!grouped[m.type]) grouped[m.type] = [];
    grouped[m.type].push(m.content);
  }
  const sections = Object.entries(grouped)
    .map(([type, items]) => `${type}: ${items.join(" · ")}`)
    .join("\n");
  return `\n\n— What you know about this person —\n${sections}`;
}

function buildSystemPrompt(memoryContext: string, convTitle: string): string {
  return `You are eKoMe — a close friend who genuinely remembers and cares. You feel like the person who always has time to listen and who actually remembers what you told them last week.

Your voice:
- Warm, curious, occasionally funny — not formal, not clinical
- Speak the way a real friend talks: natural, sometimes brief, occasionally playful
- Ask ONE question at a time, and only when it genuinely follows from what they said
- Never say "That sounds like...", "I hear that...", "It's great that...", "It's completely valid to feel..." — that's therapist-speak, not friend-speak
- Don't summarise what they just said back to them
- Don't give unsolicited advice or life coaching
- Keep responses short unless they clearly want a longer response — friends don't lecture
- Match their energy: if they're venting, listen; if they're excited, be excited; if they're brief, be brief
- Your responses will be spoken aloud. Write for the ear. No markdown, no bullet points, no lists.

Memory:
- You remember things naturally. If something relevant comes to mind, weave it in the way a friend would: "Didn't you mention you were going to..." or "Wait, isn't that the same project as..."
- Never say "Based on our previous conversations..." — just remember, like a person would
- Never invent things they haven't told you${memoryContext}

This conversation: "${convTitle}"`;
}

// ─── Conversations ───────────────────────────────────────────────────────────

router.get("/openai/conversations", async (req, res): Promise<void> => {
  const params = ListConversationsQueryParams.safeParse(req.query);
  const q = params.success ? params.data.q : undefined;
  const rows = await db
    .select({
      id: conversations.id,
      title: conversations.title,
      topic: conversations.topic,
      summary: conversations.summary,
      peopleMentioned: conversations.peopleMentioned,
      placesMentioned: conversations.placesMentioned,
      titleLocked: conversations.titleLocked,
      messageCount: sql<number>`cast(count(${messages.id}) as int)`,
      createdAt: conversations.createdAt,
      updatedAt: conversations.updatedAt,
    })
    .from(conversations)
    .leftJoin(messages, eq(messages.conversationId, conversations.id))
    .groupBy(conversations.id)
    .orderBy(desc(conversations.updatedAt));

  if (q) {
    const lower = q.toLowerCase();
    res.json(
      rows.filter(
        (r) =>
          r.title.toLowerCase().includes(lower) ||
          r.summary?.toLowerCase().includes(lower) ||
          r.topic?.toLowerCase().includes(lower) ||
          r.peopleMentioned?.toLowerCase().includes(lower) ||
          r.placesMentioned?.toLowerCase().includes(lower),
      ),
    );
    return;
  }
  res.json(rows);
});

router.post("/openai/conversations", async (req, res): Promise<void> => {
  const parsed = CreateConversationBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [conv] = await db.insert(conversations).values({ title: parsed.data.title }).returning();
  res.status(201).json({ ...conv, messageCount: 0 });
});

router.get("/openai/conversations/:id", async (req, res): Promise<void> => {
  const params = GetConversationParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const id = params.data.id;
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
  if (!conv) { res.status(404).json({ error: "Conversation not found" }); return; }
  const msgs = await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt);
  const [story] = await db.select().from(stories).where(eq(stories.conversationId, id));
  res.json({ ...conv, messages: msgs, story: story ?? null });
});

router.patch("/openai/conversations/:id", async (req, res): Promise<void> => {
  const params = UpdateConversationParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const body = UpdateConversationBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const id = params.data.id;
  const updateData: Record<string, unknown> = {};
  if (body.data.title !== undefined) updateData.title = body.data.title;
  if (body.data.topic !== undefined) updateData.topic = body.data.topic;
  if (body.data.summary !== undefined) updateData.summary = body.data.summary;
  if (body.data.peopleMentioned !== undefined) updateData.peopleMentioned = body.data.peopleMentioned;
  if (body.data.placesMentioned !== undefined) updateData.placesMentioned = body.data.placesMentioned;
  if (body.data.titleLocked !== undefined) updateData.titleLocked = body.data.titleLocked;
  const [updated] = await db.update(conversations).set(updateData).where(eq(conversations.id, id)).returning();
  if (!updated) { res.status(404).json({ error: "Conversation not found" }); return; }
  const [{ count }] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(messages)
    .where(eq(messages.conversationId, id));
  res.json({ ...updated, messageCount: count });
});

router.delete("/openai/conversations/:id", async (req, res): Promise<void> => {
  const params = DeleteConversationParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const [deleted] = await db.delete(conversations).where(eq(conversations.id, params.data.id)).returning();
  if (!deleted) { res.status(404).json({ error: "Conversation not found" }); return; }
  res.status(204).send();
});

// ─── Messages (list) ─────────────────────────────────────────────────────────

router.get("/openai/conversations/:id/messages", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  const msgs = await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt);
  res.json(msgs);
});

// ─── Save transcript without triggering AI (used by realtime mode) ───────────

router.post("/openai/conversations/:id/transcript", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  const { role, content } = req.body as { role?: string; content?: string };
  if (!role || !content?.trim()) { res.status(400).json({ error: "role and content required" }); return; }

  // Deduplicate: check if the same content was just saved
  const recent = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(desc(messages.createdAt))
    .limit(4);
  const isDup = recent.some((m) => m.role === role && m.content.trim() === content.trim());
  if (isDup) { res.json({ saved: false, reason: "duplicate" }); return; }

  const [saved] = await db.insert(messages).values({ conversationId: id, role, content: content.trim() }).returning();
  await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, id));

  if (role === "user") {
    extractMemories(id, content, "").catch(() => {});
    const [{ count }] = await db.select({ count: sql<number>`cast(count(*) as int)` }).from(messages).where(eq(messages.conversationId, id));
    if (count % 8 === 1 || count === 1) {
      const allMsgs = await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt);
      updateConversationMeta(id, allMsgs).catch(() => {});
    }
  }
  res.json({ saved: true, id: saved.id });
});

// ─── Realtime session (WebRTC ephemeral token) ────────────────────────────────

router.post("/openai/realtime/session", async (req, res): Promise<void> => {
  const conversationId = req.body?.conversationId ? parseInt(req.body.conversationId) : null;

  let contextInstructions = "";
  try {
    const memCtx = await getMemoryContext();
    if (conversationId) {
      const [conv] = await db.select().from(conversations).where(eq(conversations.id, conversationId));
      const basePrompt = buildSystemPrompt(memCtx, conv?.title ?? "");
      const msgs = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(messages.createdAt)
        .limit(30);

      if (msgs.length === 0) {
        contextInstructions =
          basePrompt +
          "\n\nBegin by immediately speaking your opening question. Sound warm and natural — go straight to the question. Do not greet with hello or hi. Just ask.";
      } else {
        const recent = msgs
          .slice(-12)
          .map((m) => `${m.role === "user" ? "Person" : "You"}: ${m.content}`)
          .join("\n");
        contextInstructions =
          basePrompt +
          `\n\nRecent conversation (for context — do not reference or repeat these lines directly):\n${recent}`;
      }
    } else {
      contextInstructions =
        buildSystemPrompt(memCtx, "") +
        `\n\nBegin immediately with your opening question. It is ${getTimeOfDay()}.`;
    }
  } catch {
    contextInstructions = buildSystemPrompt("", "");
  }

  const baseUrl = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL!.replace(/\/$/, "");
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY!;

  try {
    const sessionResp = await fetch(`${baseUrl}/realtime/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "OpenAI-Beta": "realtime=v1",
      },
      body: JSON.stringify({
        model: "gpt-4o-realtime-preview",
        voice: "nova",
        instructions: contextInstructions,
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 700,
          create_response: true,
        },
        max_response_output_tokens: 500,
      }),
    });

    if (!sessionResp.ok) {
      const errText = await sessionResp.text().catch(() => "");
      res.status(503).json({ error: "Realtime unavailable", detail: errText, status: sessionResp.status });
      return;
    }

    const session = (await sessionResp.json()) as {
      client_secret?: { value: string; expires_at: number };
      id?: string;
    };
    const ephemeralKey = session.client_secret?.value;
    if (!ephemeralKey) {
      res.status(503).json({ error: "No ephemeral key returned" });
      return;
    }
    res.json({ ephemeralKey, model: "gpt-4o-realtime-preview" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(503).json({ error: `Realtime session failed: ${msg}` });
  }
});

// ─── Conversation opener (PTT mode) ──────────────────────────────────────────

router.post("/openai/conversations/:id/open", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  const existing = await db.select().from(messages).where(eq(messages.conversationId, id)).limit(1);
  if (existing.length > 0) { res.status(409).json({ error: "Already has messages" }); return; }

  const memoryContext = await getMemoryContext();
  const timeOfDay = getTimeOfDay();
  const memorySnippet = memoryContext
    ? `You know things about this person:${memoryContext}\n\nUse this naturally if it fits. Don't force it.`
    : "This might be a first conversation.";

  const openerPrompt = `You are eKoMe. Generate a single natural opening question to begin a conversation. It's ${timeOfDay}.

${memorySnippet}

Rules:
- ONE question only. No greeting preamble — go straight to the question.
- Sound like a friend, not a chatbot
- 1-2 sentences maximum, written to be spoken aloud (no markdown)

Just write the question. Nothing else.`;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  let fullResponse = "";
  try {
    const stream = await openai.chat.completions.create({
      model: MODEL,
      max_completion_tokens: 150,
      messages: [{ role: "user", content: openerPrompt }],
      stream: true,
    });
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) { fullResponse += content; res.write(`data: ${JSON.stringify({ content })}\n\n`); }
    }
    await db.insert(messages).values({ conversationId: id, role: "assistant", content: fullResponse.trim() });
    await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, id));
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  } catch {
    res.write(`data: ${JSON.stringify({ error: "Could not start conversation" })}\n\n`);
  }
  res.end();
});

// ─── Send message and stream AI response ─────────────────────────────────────

router.post("/openai/conversations/:id/messages", async (req, res): Promise<void> => {
  const params = SendMessageParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const body = SendMessageBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const id = params.data.id;
  const userContent = body.data.content;

  await db.insert(messages).values({ conversationId: id, role: "user", content: userContent });
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
  const history = await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt);
  const memoryContext = await getMemoryContext();
  const systemPrompt = buildSystemPrompt(memoryContext, conv?.title || "");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const chatMessages = [
    { role: "system" as const, content: systemPrompt },
    ...history.slice(0, -1).map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    { role: "user" as const, content: userContent },
  ];

  let fullResponse = "";
  try {
    const stream = await openai.chat.completions.create({
      model: MODEL,
      max_completion_tokens: 4096,
      messages: chatMessages,
      stream: true,
    });
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) { fullResponse += content; res.write(`data: ${JSON.stringify({ content })}\n\n`); }
    }
    await db.insert(messages).values({ conversationId: id, role: "assistant", content: fullResponse });
    await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, id));
    extractMemories(id, userContent, fullResponse).catch(() => {});
    const userMsgCount = history.filter((m) => m.role === "user").length;
    if (userMsgCount === 0 || userMsgCount % 8 === 0) {
      updateConversationMeta(id, history.concat([
        { id: 0, conversationId: id, role: "user", content: userContent, createdAt: new Date() },
        { id: 0, conversationId: id, role: "assistant", content: fullResponse, createdAt: new Date() },
      ])).catch(() => {});
    }
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  } catch {
    res.write(`data: ${JSON.stringify({ error: "Response failed — please try again" })}\n\n`);
  }
  res.end();
});

// ─── Transcribe audio ────────────────────────────────────────────────────────

router.post("/openai/conversations/:id/transcribe", async (req, res): Promise<void> => {
  const params = TranscribeAudioParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const body = TranscribeAudioBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  try {
    const audioBuffer = Buffer.from(body.data.audio, "base64");
    const rawMime = (body.data.mimeType ?? "audio/webm").split(";")[0];
    const ext = rawMime.split("/")[1] ?? "webm";
    const allowedFormats = ["wav", "mp3", "webm", "mp4", "ogg", "m4a"] as const;
    type AudioFormat = (typeof allowedFormats)[number];
    const format: AudioFormat = (allowedFormats as readonly string[]).includes(ext) ? (ext as AudioFormat) : "webm";
    const text = await speechToText(audioBuffer, format);
    res.json({ text });
  } catch {
    res.status(500).json({ error: "Transcription failed — please try again" });
  }
});

// ─── Text-to-Speech ──────────────────────────────────────────────────────────

router.post("/openai/tts", async (req, res): Promise<void> => {
  const body = SynthesizeSpeechBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const { text, voice = "nova" } = body.data;
  try {
    // Use gpt-audio via chat.completions — the integration proxy supports this
    // (openai.audio.speech.create / tts-1 is NOT supported by the proxy)
    const audioBuffer = await textToSpeech(
      text,
      voice as "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer",
      "wav"
    );
    if (!audioBuffer.length) {
      res.status(502).json({ error: "Empty audio response from provider" });
      return;
    }
    res.setHeader("Content-Type", "audio/wav");
    res.send(audioBuffer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: "Speech synthesis failed", detail: msg });
  }
});

// ─── Stories (by conversation) ────────────────────────────────────────────────

router.post("/openai/conversations/:id/story", async (req, res): Promise<void> => {
  const params = GenerateStoryParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const body = GenerateStoryBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const id = params.data.id;
  const { perspective, tone, format } = body.data;

  const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
  if (!conv) { res.status(404).json({ error: "Conversation not found" }); return; }
  const msgs = await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt);
  const userMessages = msgs.filter((m) => m.role === "user");
  const fullTranscript = msgs.map((m) => `[${m.role === "user" ? "Person" : "eKoMe"}] ${m.content}`).join("\n\n");
  const userVoice = userMessages.map((m) => m.content).join("\n\n");

  const perspectiveLabel = perspective === "first_person" ? "first person (I, me, my)" : "third person (he/she/they)";
  const formatDetails: Record<string, string> = {
    short_story: "a short story (300–500 words)",
    journal_entry: "a journal entry (250–400 words)",
    long_form_chapter: "a long-form chapter or essay (700–1200 words)",
  };
  const toneGuidance: Record<string, string> = {
    reflective: "Meditative and honest. Find the deeper meaning in what was shared.",
    warm: "Tender and affectionate. Make the reader feel the closeness of the moment.",
    funny: "Lightly humorous and self-aware. Find the absurdity or joy in the mundane.",
    adventurous: "Vivid and kinetic. Make ordinary moments feel like scenes from a great novel.",
    concise: "Sharp and precise. Every sentence earns its place. No filler.",
  };

  const storyPrompt = `You are a gifted literary writer. Transform the following conversation into ${formatDetails[format] ?? "a short story"}, written in ${perspectiveLabel}.

Tone: ${toneGuidance[tone] ?? ""}

Rules:
- Stay completely faithful to what was actually said. Do NOT invent names, events, places, or facts.
- Preserve the speaker's authentic voice and personality.
- Transform scattered thoughts into a flowing, shaped narrative.
- Do not include meta-commentary. Begin immediately with the narrative. No title, no preamble.

What the person said:
${userVoice}

Full conversation for context:
${fullTranscript}

Conversation title: "${conv.title}"`;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  let fullContent = "";
  try {
    const stream = await openai.chat.completions.create({
      model: MODEL,
      max_completion_tokens: 8192,
      messages: [{ role: "user", content: storyPrompt }],
      stream: true,
    });
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) { fullContent += content; res.write(`data: ${JSON.stringify({ content })}\n\n`); }
    }

    const [existing] = await db.select().from(stories).where(eq(stories.conversationId, id));
    if (existing) {
      // Save previous version as a revision before overwriting
      if (existing.content?.trim()) {
        await db.insert(storyRevisions).values({
          storyId: existing.id,
          content: existing.content,
          perspective: existing.perspective,
          tone: existing.tone,
          format: existing.format,
        });
      }
      await db.update(stories).set({ content: fullContent, perspective, tone, format }).where(eq(stories.id, existing.id));
    } else {
      await db.insert(stories).values({ conversationId: id, content: fullContent, perspective, tone, format });
    }
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  } catch {
    res.write(`data: ${JSON.stringify({ error: "Story generation failed — please try again" })}\n\n`);
  }
  res.end();
});

router.get("/openai/conversations/:id/story", async (req, res): Promise<void> => {
  const params = GetStoryParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const [story] = await db.select().from(stories).where(eq(stories.conversationId, params.data.id));
  if (!story) { res.status(404).json({ error: "Story not found" }); return; }
  res.json(story);
});

router.patch("/openai/conversations/:id/story", async (req, res): Promise<void> => {
  const params = UpdateStoryParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const body = UpdateStoryBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const [existing] = await db.select().from(stories).where(eq(stories.conversationId, params.data.id));
  if (!existing) { res.status(404).json({ error: "Story not found" }); return; }
  const [updated] = await db.update(stories).set({ content: body.data.content }).where(eq(stories.id, existing.id)).returning();
  res.json(updated);
});

router.delete("/openai/conversations/:id/story", async (req, res): Promise<void> => {
  const params = DeleteStoryParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const [deleted] = await db.delete(stories).where(eq(stories.conversationId, params.data.id)).returning();
  if (!deleted) { res.status(404).json({ error: "Story not found" }); return; }
  res.status(204).send();
});

// Story revisions list
router.get("/openai/conversations/:id/story/revisions", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  const [story] = await db.select({ id: stories.id }).from(stories).where(eq(stories.conversationId, id));
  if (!story) { res.json([]); return; }
  const revisions = await db
    .select()
    .from(storyRevisions)
    .where(eq(storyRevisions.storyId, story.id))
    .orderBy(desc(storyRevisions.createdAt));
  res.json(revisions);
});

// ─── Stories (global list + by ID) ───────────────────────────────────────────

router.get("/openai/stories", async (req, res): Promise<void> => {
  const rows = await db
    .select({
      id: stories.id,
      conversationId: stories.conversationId,
      conversationTitle: conversations.title,
      title: stories.title,
      content: stories.content,
      perspective: stories.perspective,
      tone: stories.tone,
      format: stories.format,
      createdAt: stories.createdAt,
      updatedAt: stories.updatedAt,
    })
    .from(stories)
    .innerJoin(conversations, eq(stories.conversationId, conversations.id))
    .orderBy(desc(stories.updatedAt));
  res.json(rows);
});

router.patch("/openai/stories/:id", async (req, res): Promise<void> => {
  const params = UpdateStoryByIdParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const body = UpdateStoryByIdBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const updateData: Record<string, unknown> = {};
  if (body.data.title !== undefined) updateData.title = body.data.title;
  if (body.data.content !== undefined) updateData.content = body.data.content;
  const [updated] = await db.update(stories).set(updateData).where(eq(stories.id, params.data.id)).returning();
  if (!updated) { res.status(404).json({ error: "Story not found" }); return; }
  res.json(updated);
});

router.delete("/openai/stories/:id", async (req, res): Promise<void> => {
  const params = DeleteStoryByIdParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const [deleted] = await db.delete(stories).where(eq(stories.id, params.data.id)).returning();
  if (!deleted) { res.status(404).json({ error: "Story not found" }); return; }
  res.status(204).send();
});

// ─── Memories ────────────────────────────────────────────────────────────────

router.get("/openai/memories", async (req, res): Promise<void> => {
  const params = ListMemoriesQueryParams.safeParse(req.query);
  const type = params.success ? params.data.type : undefined;
  let query = db.select().from(memories).orderBy(desc(memories.createdAt)).$dynamic();
  if (type) query = query.where(eq(memories.type, type));
  res.json(await query);
});

router.post("/openai/search", async (req, res): Promise<void> => {
  const body = SearchMemoryBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }
  const query = body.data.query;
  const lower = query.toLowerCase();

  const allConvs = await db
    .select({
      id: conversations.id, title: conversations.title, topic: conversations.topic,
      summary: conversations.summary, peopleMentioned: conversations.peopleMentioned,
      placesMentioned: conversations.placesMentioned, titleLocked: conversations.titleLocked,
      createdAt: conversations.createdAt, updatedAt: conversations.updatedAt,
      messageCount: sql<number>`cast(count(${messages.id}) as int)`,
    })
    .from(conversations)
    .leftJoin(messages, eq(messages.conversationId, conversations.id))
    .groupBy(conversations.id);

  const matchedConvs = allConvs.filter((c) =>
    c.title.toLowerCase().includes(lower) ||
    c.summary?.toLowerCase().includes(lower) ||
    c.topic?.toLowerCase().includes(lower) ||
    c.peopleMentioned?.toLowerCase().includes(lower) ||
    c.placesMentioned?.toLowerCase().includes(lower),
  );
  const allMemories = await db.select().from(memories);
  const matchedMemories = allMemories.filter((m) => m.content.toLowerCase().includes(lower));

  let answer = "Nothing found for that search.";
  if (matchedConvs.length > 0 || matchedMemories.length > 0) {
    const context = [
      matchedConvs.length > 0 ? `Conversations: ${matchedConvs.map((c) => `"${c.title}" (${c.summary ?? c.topic ?? ""})`).join("; ")}` : "",
      matchedMemories.length > 0 ? `Memories: ${matchedMemories.map((m) => `[${m.type}] ${m.content}`).join("; ")}` : "",
    ].filter(Boolean).join("\n");
    try {
      const resp = await openai.chat.completions.create({
        model: MODEL,
        max_completion_tokens: 300,
        messages: [{ role: "user", content: `Answer naturally and concisely using only this info:\n${context}\n\nQuestion: ${query}` }],
      });
      answer = resp.choices[0]?.message?.content ?? answer;
    } catch {
      answer = `Found ${matchedConvs.length} conversation(s) and ${matchedMemories.length} memory item(s).`;
    }
  }
  res.json({ answer, conversations: matchedConvs, memories: matchedMemories });
});

// ─── Background helpers ──────────────────────────────────────────────────────

async function extractMemories(conversationId: number, userMessage: string, _assistantResponse: string): Promise<void> {
  const resp = await openai.chat.completions.create({
    model: MODEL,
    max_completion_tokens: 512,
    messages: [{
      role: "user",
      content: `Extract memorable facts from this message. Only genuinely specific facts worth remembering.

Types: person, place, event, idea, goal, relationship, project, preference, other.

Rules:
- Specific facts only. "Feeling stressed" → no. "Has job interview at Google on Friday" → yes.
- Keep content concise (one clear sentence per item)
- Return [] if nothing qualifies

Person said: ${userMessage}

Return ONLY a valid JSON array: [{"type": "...", "content": "..."}]`,
    }],
  });
  const text = resp.choices[0]?.message?.content?.trim() ?? "[]";
  try {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return;
    const items = JSON.parse(match[0]) as Array<{ type: string; content: string }>;
    for (const item of items) {
      if (!item.type || !item.content) continue;
      const existing = await db.select({ id: memories.id }).from(memories)
        .where(and(eq(memories.type, item.type), eq(memories.content, item.content))).limit(1);
      if (existing.length === 0) {
        await db.insert(memories).values({ conversationId, type: item.type, content: item.content });
      }
    }
  } catch { /* silent */ }
}

async function updateConversationMeta(conversationId: number, msgs: Array<{ role: string; content: string }>): Promise<void> {
  const [conv] = await db.select({ titleLocked: conversations.titleLocked }).from(conversations).where(eq(conversations.id, conversationId));
  const transcript = msgs.slice(0, 20).map((m) => `${m.role === "user" ? "Person" : "eKoMe"}: ${m.content}`).join("\n");
  const resp = await openai.chat.completions.create({
    model: MODEL,
    max_completion_tokens: 200,
    messages: [{
      role: "user",
      content: `Given this conversation, return a JSON object with:
- "title": a short evocative title (3–6 words). Like a great journal entry heading. e.g. "Leaving the agency"${conv?.titleLocked ? " (skip — will be ignored)" : ""}
- "topic": one-line topic (max 10 words)
- "summary": 1–2 sentences capturing the essence
- "peopleMentioned": comma-separated names, or null
- "placesMentioned": comma-separated places, or null

Conversation:
${transcript}

Return ONLY valid JSON.`,
    }],
  });
  const text = resp.choices[0]?.message?.content?.trim() ?? "{}";
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return;
    const meta = JSON.parse(match[0]) as { title?: string; topic?: string; summary?: string; peopleMentioned?: string; placesMentioned?: string };
    const updateData: Record<string, unknown> = {
      topic: meta.topic ?? undefined,
      summary: meta.summary ?? undefined,
      peopleMentioned: meta.peopleMentioned ?? undefined,
      placesMentioned: meta.placesMentioned ?? undefined,
      updatedAt: new Date(),
    };
    if (!conv?.titleLocked && meta.title) updateData.title = meta.title;
    await db.update(conversations).set(updateData).where(eq(conversations.id, conversationId));
  } catch { /* silent */ }
}

export default router;
