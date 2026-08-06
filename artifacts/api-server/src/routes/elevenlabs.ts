import { Router, type IRouter } from "express";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { db, conversations, messages } from "@workspace/db";
import { eq } from "drizzle-orm";
import { openai } from "@workspace/integrations-openai-ai-server";
import { getSmartMemoryContext } from "../lib/ws-llm.js";

const router: IRouter = Router();
const connectors = new ReplitConnectors();

// Cache agent ID (re-created if server URL changes)
let _agentId: string | null = null;
let _agentBaseUrl: string | null = null;

function getLlmBaseUrl(): string {
  const domain = process.env.REPLIT_DEV_DOMAIN;
  if (!domain) throw new Error("REPLIT_DEV_DOMAIN not set");
  return `https://${domain}/api/llm`;
}

async function getOrCreateAgent(llmBaseUrl: string): Promise<string> {
  if (_agentId && _agentBaseUrl === llmBaseUrl) return _agentId;

  console.log("[EL] Creating agent, llmBaseUrl:", llmBaseUrl);

  const resp = await connectors.proxy("elevenlabs", "/v1/convai/agents/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "eKoMe",
      conversation_config: {
        agent: {
          first_message: "",
          prompt: {
            prompt:
              "You are eKoMe, a warm personal memory companion. You speak naturally and conversationally. Keep responses short — 1 to 3 spoken sentences. This is voice, not text.",
            llm: "custom-llm",
            custom_llm: {
              url: llmBaseUrl,
              model_id: "gpt-5.6-terra",
              api_type: "chat_completions",
            },
            tools: [],
          },
          language: "en",
        },
        tts: {
          voice_id: "onwK4e9ZLuTAKqWW03F9", // Daniel — British butler
          model_id: "eleven_turbo_v2",
        },
        // Tuned for reflective conversation: ~1.2 s silence before turn ends
        // (longer than the customer-support default to avoid cutting off mid-thought)
        turn: {
          turn_timeout: 1.2,
          silence_duration_ms: 1200,
          mode: "silence",
        },
      },
      platform_settings: {
        auth: { enable_auth: false },
      },
    }),
  });

  interface AgentCreateResponse { agent_id?: string; detail?: unknown }
  const data = (await resp.json()) as AgentCreateResponse;
  if (!data.agent_id) {
    throw new Error(`Agent creation failed: ${JSON.stringify(data)}`);
  }

  _agentId = data.agent_id;
  _agentBaseUrl = llmBaseUrl;
  console.log("[EL] Agent created:", _agentId);
  return _agentId;
}

// ─── GET /api/elevenlabs/voices ───────────────────────────────────────────────

router.get("/elevenlabs/voices", async (req, res): Promise<void> => {
  try {
    const resp = await connectors.proxy("elevenlabs", "/v1/voices", { method: "GET" });
    interface ELVoice { voice_id: string; name: string; labels?: Record<string, string> }
    interface ELVoicesResponse { voices?: ELVoice[] }
    const data = (await resp.json()) as ELVoicesResponse;
    const curated = [
      "onwK4e9ZLuTAKqWW03F9", // Daniel — British
      "JBFqnCBsd6RMkjVDRZzb", // George — British warm
      "cjVigY5qzO86Huf0OWal", // Eric — smooth
      "CwhRBWXzGAHq8TQ4Fs17", // Roger — laid-back
    ];
    const voices = (data.voices ?? [])
      .filter((v) => curated.includes(v.voice_id))
      .sort((a, b) => curated.indexOf(a.voice_id) - curated.indexOf(b.voice_id))
      .map((v) => ({ voice_id: v.voice_id, name: v.name, labels: v.labels }));
    res.json({ voices });
  } catch {
    res.status(500).json({ error: "Failed to fetch voices" });
  }
});

// ─── POST /api/elevenlabs/session ─────────────────────────────────────────────

router.post("/elevenlabs/session", async (req, res): Promise<void> => {
  const conversationId = req.body?.conversationId ? parseInt(req.body.conversationId) : null;

  try {
    const llmBaseUrl = getLlmBaseUrl();
    const agentId = await getOrCreateAgent(llmBaseUrl);

    // Get signed URL
    const signedResp = await connectors.proxy(
      "elevenlabs",
      `/v1/convai/conversation/get_signed_url?agent_id=${agentId}`,
      { method: "GET" }
    );
    interface SignedUrlResponse { signed_url?: string; detail?: unknown }
    const signedData = (await signedResp.json()) as SignedUrlResponse;
    if (!signedData.signed_url) {
      throw new Error(`No signed URL: ${JSON.stringify(signedData)}`);
    }

    // Generate opener for new conversations
    let firstMessage = "";
    if (conversationId) {
      const existingMsgs = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .limit(1);

      if (existingMsgs.length === 0) {
        const [conv] = await db
          .select()
          .from(conversations)
          .where(eq(conversations.id, conversationId));

        const memCtx = await getSmartMemoryContext(conversationId);
        const h = new Date().getHours();
        const timeOfDay =
          h < 6 ? "late night" : h < 12 ? "morning" : h < 17 ? "afternoon" : h < 21 ? "evening" : "night";

        const openerPrompt = `You are eKoMe. Generate ONE natural opening question to begin a conversation. It is ${timeOfDay}.

${
  memCtx
    ? `You know things about this person:${memCtx}

Choose a DIFFERENT topic than anything in the recently discussed list. Pick something specific from what you know — a project, a goal, a person they mentioned, something they were worried about. Make it feel like you remembered it naturally.`
    : "This might be a first conversation. Ask something warm and open-ended."
}

Rules:
- ONE question only. No greeting preamble.
- 1–2 sentences, written to be spoken aloud.
- Sound like a friend, not a chatbot.
- If they mentioned something they were working on or worried about, ask about that.

Just write the question. Nothing else.`;

        const openerResp = await openai.chat.completions.create({
          model: "gpt-5.6-terra",
          max_completion_tokens: 120,
          messages: [{ role: "user", content: openerPrompt }],
        });
        firstMessage = openerResp.choices[0]?.message?.content?.trim() ?? "";

        // Save opener to DB
        if (firstMessage) {
          await db.insert(messages).values({ conversationId, role: "assistant", content: firstMessage });
          await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, conversationId));
        }
      }
    }

    res.json({ signedUrl: signedData.signed_url, agentId, firstMessage });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[EL] session error:", msg);
    res.status(503).json({ error: `ElevenLabs session failed: ${msg}` });
  }
});

// ─── POST /api/elevenlabs/tts ─────────────────────────────────────────────────

router.post("/elevenlabs/tts", async (req, res): Promise<void> => {
  const voiceId: string = req.body?.voiceId ?? "onwK4e9ZLuTAKqWW03F9";
  const text: string = req.body?.text ?? "";
  if (!text.trim()) { res.status(400).json({ error: "text required" }); return; }

  try {
    const resp = await connectors.proxy(
      "elevenlabs",
      `/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          model_id: "eleven_turbo_v2",
          voice_settings: { stability: 0.45, similarity_boost: 0.75, speed: 1.05 },
        }),
      }
    );
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({})) as { detail?: unknown };
      res.status(resp.status).json({ error: "TTS failed", detail: err });
      return;
    }
    const buf = await resp.arrayBuffer();
    res.setHeader("Content-Type", "audio/mpeg");
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error("[EL TTS]", err);
    res.status(500).json({ error: "TTS request failed" });
  }
});

export default router;
