import { Router, type IRouter } from "express";
import healthRouter from "./health";
import openaiRouter from "./openai/conversations";
import elevenLabsRouter from "./elevenlabs";
import llmRouter from "./llm";

const router: IRouter = Router();

router.use(healthRouter);
router.use(openaiRouter);
router.use(elevenLabsRouter);
// OpenAI-compatible Chat Completions endpoint for ElevenLabs custom LLM
router.use(llmRouter);

export default router;
