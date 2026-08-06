import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, Link } from 'wouter';
import {
  useGetConversation,
  useUpdateConversation,
  getGetConversationQueryKey,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useConversation } from '@11labs/react';
import {
  Mic, Square, ChevronLeft, Send,
  VolumeX, Volume2, PhoneOff, Keyboard, Check, X, Pencil,
  ChevronDown,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_VOICE_ID = 'onwK4e9ZLuTAKqWW03F9'; // Daniel — British, calm

const VOICE_OPTIONS = [
  { id: 'onwK4e9ZLuTAKqWW03F9', name: 'Daniel · British (default)' },
  { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George · British, warm' },
  { id: 'cjVigY5qzO86Huf0OWal', name: 'Eric · Smooth' },
  { id: 'CwhRBWXzGAHq8TQ4Fs17', name: 'Roger · Laid-back' },
] as const;

// ─── Types ───────────────────────────────────────────────────────────────────

type Mode = 'detecting' | 'elevenlabs' | 'ptt';
type OrbState = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'idle' | 'recording' | 'processing' | 'playing';

interface LocalMsg {
  tempId: string;
  role: 'user' | 'assistant';
  content: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function detectMimeType(): string {
  for (const t of ['audio/webm', 'audio/mp4', 'audio/ogg']) {
    try { if (MediaRecorder.isTypeSupported(t)) return t; } catch { /**/ }
  }
  return '';
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function isDefaultTitle(t: string) {
  return t === 'New conversation' || t.startsWith('Conversation ');
}

function orbStateLabel(s: OrbState, mode: Mode): string {
  if (s === 'connecting') return 'Connecting';
  if (s === 'listening' || s === 'recording') return 'Listening';
  if (s === 'thinking' || s === 'processing') return 'Thinking';
  if (s === 'speaking' || s === 'playing') return 'Speaking';
  if (s === 'idle') return mode === 'ptt' ? 'Tap to speak' : 'Ready';
  return '';
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function Conversation() {
  const params = useParams();
  const queryClient = useQueryClient();
  const id = params.id ? parseInt(params.id) : null;

  const { data: conversation, isLoading } = useGetConversation(id!, {
    query: { enabled: !!id, queryKey: getGetConversationQueryKey(id!), refetchOnWindowFocus: false },
  });
  const updateConversation = useUpdateConversation();

  // ── Mode & orb state ──────────────────────────────────────────────────────
  const [mode, setMode]           = useState<Mode>('detecting');
  const [orbState, setOrbState]   = useState<OrbState>('connecting');

  // ── Messages ──────────────────────────────────────────────────────────────
  const [localMessages, setLocalMessages] = useState<LocalMsg[]>([]);
  const [streamingText, setStreamingText] = useState('');

  // ── Controls ──────────────────────────────────────────────────────────────
  const [isMuted, setIsMuted]         = useState(false);
  const [showTextInput, setShowTextInput] = useState(false);
  const [textInput, setTextInput]     = useState('');
  const [showTranscript, setShowTranscript] = useState(false);
  const [error, setError]             = useState<string | null>(null);

  // ── Title ─────────────────────────────────────────────────────────────────
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft]   = useState('');
  const titleInputRef                 = useRef<HTMLInputElement>(null);

  // ── Dev ───────────────────────────────────────────────────────────────────
  const [selectedVoiceId, setSelectedVoiceId] = useState(() =>
    import.meta.env.DEV ? (localStorage.getItem('ekome-voice-id') ?? DEFAULT_VOICE_ID) : DEFAULT_VOICE_ID
  );
  const [showDevPanel, setShowDevPanel] = useState(false);
  const [devInfo, setDevInfo]         = useState<{ mode?: string; reason?: string; latencyMs?: number }>({});
  const [elFailed, setElFailed]       = useState(false);

  // ── Refs ──────────────────────────────────────────────────────────────────
  const audioCtxRef       = useRef<AudioContext | null>(null);
  const ttsSourceRef      = useRef<AudioBufferSourceNode | null>(null);
  const mediaRecorderRef  = useRef<MediaRecorder | null>(null);
  const savedBlobRef      = useRef<{ blob: Blob; mimeType: string } | null>(null);
  const inFlightRef       = useRef(false);
  const openerFiredRef    = useRef(false);
  const isMutedRef        = useRef(false);
  const turnEndMsRef      = useRef(0);
  const transcriptEndRef  = useRef<HTMLDivElement>(null);

  useEffect(() => { isMutedRef.current = isMuted; }, [isMuted]);

  useEffect(() => {
    if (isEditingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [isEditingTitle]);

  // ── Clear local messages once in DB ───────────────────────────────────────
  useEffect(() => {
    if (!conversation?.messages?.length) return;
    const dbContents = new Set(conversation.messages.map((m) => m.content.trim()));
    setLocalMessages((prev) => prev.filter((m) => !dbContents.has(m.content.trim())));
  }, [conversation?.messages]);

  useEffect(() => {
    if (showTranscript) {
      transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [conversation?.messages, localMessages, streamingText, showTranscript]);

  // ── Audio unlock ──────────────────────────────────────────────────────────
  const unlockAudio = useCallback(() => {
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtxRef.current) audioCtxRef.current = new Ctx();
      if (audioCtxRef.current.state === 'suspended') audioCtxRef.current.resume();
      (window as unknown as { __ekoAudioCtx?: AudioContext }).__ekoAudioCtx = audioCtxRef.current;
    } catch { /**/ }
  }, []);

  useEffect(() => {
    const inherited = (window as unknown as { __ekoAudioCtx?: AudioContext }).__ekoAudioCtx;
    if (inherited && !audioCtxRef.current) audioCtxRef.current = inherited;
  }, []);

  // ── TTS (PTT mode) — uses ElevenLabs British voice ────────────────────────
  const speakText = useCallback(async (text: string, voiceId?: string) => {
    if (isMutedRef.current || !text.trim()) return;
    if (!audioCtxRef.current) unlockAudio();
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch { /**/ } }

    setOrbState('playing');

    try {
      const resp = await fetch('/api/elevenlabs/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voiceId: voiceId ?? selectedVoiceId }),
      });
      if (!resp.ok) { setOrbState('idle'); return; }
      const arrayBuffer = await resp.arrayBuffer();
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
      ttsSourceRef.current?.stop();
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      ttsSourceRef.current = source;
      source.onended = () => { ttsSourceRef.current = null; setOrbState('idle'); };
      source.start(0);
    } catch {
      setOrbState('idle');
    }
  }, [unlockAudio, selectedVoiceId]);

  const stopTts = useCallback(() => {
    ttsSourceRef.current?.stop();
    ttsSourceRef.current = null;
    setOrbState('idle');
  }, []);

  // ── SSE helper ────────────────────────────────────────────────────────────
  const consumeSSE = useCallback(async (
    response: Response,
    onChunk: (c: string) => void,
    onDone: () => void,
    onError: (msg: string) => void,
  ) => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const data = JSON.parse(line.slice(6));
          if (data.error) { onError(data.error); return; }
          if (data.done) { onDone(); return; }
          if (data.content) onChunk(data.content);
        } catch { /**/ }
      }
    }
  }, []);

  // ── PTT: opener ───────────────────────────────────────────────────────────
  const streamOpener = useCallback(async (convId: number) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setStreamingText('');
    let full = '';
    setOrbState('thinking');
    try {
      const resp = await fetch(`/api/openai/conversations/${convId}/open`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
      });
      if (!resp.ok || resp.status === 409) { inFlightRef.current = false; setOrbState('idle'); return; }
      await consumeSSE(
        resp,
        (c) => { full += c; setStreamingText(full); setOrbState('thinking'); },
        async () => {
          queryClient.invalidateQueries({ queryKey: getGetConversationQueryKey(convId) });
          setStreamingText('');
          inFlightRef.current = false;
          await speakText(full);
        },
        () => { setStreamingText(''); inFlightRef.current = false; setOrbState('idle'); },
      );
    } catch {
      setStreamingText('');
      inFlightRef.current = false;
      setOrbState('idle');
    }
  }, [consumeSSE, queryClient, speakText]);

  // ── PTT: send message ─────────────────────────────────────────────────────
  const streamAIResponse = useCallback(async (userMessage: string) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setOrbState('thinking');
    setStreamingText('');
    let full = '';
    try {
      const resp = await fetch(`/api/openai/conversations/${id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: userMessage }),
      });
      if (!resp.ok) throw new Error('Response failed');
      await consumeSSE(
        resp,
        (c) => { full += c; setStreamingText(full); },
        async () => {
          queryClient.invalidateQueries({ queryKey: getGetConversationQueryKey(id!) });
          setStreamingText('');
          inFlightRef.current = false;
          await speakText(full);
        },
        (msg) => { setError(msg); setStreamingText(''); setOrbState('idle'); inFlightRef.current = false; },
      );
    } catch {
      setError('Something went wrong. Please try again.');
      setStreamingText('');
      setOrbState('idle');
      inFlightRef.current = false;
    }
  }, [id, consumeSSE, queryClient, speakText]);

  // ── PTT: recording ────────────────────────────────────────────────────────
  const transcribeAudio = useCallback(async (blob: Blob, mimeType: string) => {
    setOrbState('processing');
    try {
      const base64 = await blobToBase64(blob);
      const resp = await fetch(`/api/openai/conversations/${id}/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio: base64, mimeType }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: 'Transcription failed' })) as { error?: string };
        setError(err.error ?? 'Transcription failed');
        setOrbState('idle');
        return;
      }
      const { text } = await resp.json() as { text: string };
      if (!text?.trim()) {
        setError("Couldn't hear anything. Try speaking closer to the microphone.");
        setOrbState('idle');
        return;
      }
      setLocalMessages((prev) => [...prev, { tempId: Date.now().toString(), role: 'user', content: text.trim() }]);
      await streamAIResponse(text.trim());
    } catch {
      setError('Transcription failed. Please try again.');
      setOrbState('idle');
    }
  }, [id, streamAIResponse]);

  const startRecording = useCallback(async () => {
    unlockAudio();
    setError(null);
    savedBlobRef.current = null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const preferredMime = detectMimeType();
      let mr: MediaRecorder;
      let actualMime = preferredMime;
      try {
        mr = preferredMime ? new MediaRecorder(stream, { mimeType: preferredMime }) : new MediaRecorder(stream);
        actualMime = mr.mimeType || preferredMime;
      } catch {
        mr = new MediaRecorder(stream);
        actualMime = mr.mimeType || 'audio/webm';
      }
      mediaRecorderRef.current = mr;
      const chunks: Blob[] = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: actualMime });
        savedBlobRef.current = { blob, mimeType: actualMime };
        await transcribeAudio(blob, actualMime);
      };
      mr.start();
      setOrbState('recording');
    } catch {
      setError('Microphone access denied. Allow microphone access and try again.');
      setOrbState('idle');
    }
  }, [unlockAudio, transcribeAudio]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && orbState === 'recording') {
      mediaRecorderRef.current.stop();
      setOrbState('processing');
    }
  }, [orbState]);

  const handleOrbPress = useCallback(() => {
    if (mode !== 'ptt') return;
    if (orbState === 'playing') { stopTts(); return; }
    if (orbState === 'recording') { stopRecording(); return; }
    if (orbState === 'idle') startRecording();
  }, [mode, orbState, stopTts, stopRecording, startRecording]);

  const handleTextSend = useCallback((isEL: boolean) => {
    const text = textInput.trim();
    if (!text || inFlightRef.current) return;
    unlockAudio();
    if (orbState === 'playing') stopTts();
    setTextInput('');
    setLocalMessages((prev) => [...prev, { tempId: Date.now().toString(), role: 'user', content: text }]);
    if (isEL) {
      (elConv as { sendUserMessage?: (t: string) => void }).sendUserMessage?.(text);
    } else {
      streamAIResponse(text);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textInput, orbState, stopTts, streamAIResponse, unlockAudio]);

  // ── ElevenLabs hook ───────────────────────────────────────────────────────
  const elConv = useConversation({
    onConnect: () => {
      setMode('elevenlabs');
      setOrbState('listening');
      if (import.meta.env.DEV) setDevInfo((p) => ({ ...p, mode: 'elevenlabs', reason: undefined }));
    },
    onDisconnect: () => {
      if (mode === 'elevenlabs') {
        setMode('ptt');
        setOrbState('idle');
      }
    },
    onMessage: ({ message, source }: { message: string; source: string }) => {
      const role = source === 'user' ? 'user' : 'assistant';
      if (source === 'user') {
        turnEndMsRef.current = Date.now();
        setOrbState('thinking');
      }
      if (message?.trim()) {
        setLocalMessages((prev) => [...prev, { tempId: `${source}-${Date.now()}`, role, content: message.trim() }]);
      }
      if (source === 'ai') {
        queryClient.invalidateQueries({ queryKey: getGetConversationQueryKey(id!) });
      }
    },
    onModeChange: ({ mode: elMode }: { mode: string }) => {
      if (elMode === 'speaking' || elMode === 'interruptible_speaking') {
        setOrbState('speaking');
        if (turnEndMsRef.current && import.meta.env.DEV) {
          setDevInfo((p) => ({ ...p, latencyMs: Date.now() - turnEndMsRef.current }));
          turnEndMsRef.current = 0;
        }
      } else if (elMode === 'listening') {
        setOrbState('listening');
      }
    },
    onError: (msg: string) => {
      const reason = typeof msg === 'string' ? msg : 'Connection error';
      if (import.meta.env.DEV) console.warn('[ElevenLabs] error:', reason);
      if (import.meta.env.DEV) setDevInfo((p) => ({ ...p, mode: 'ptt', reason }));
      setElFailed(true);
      setMode('ptt');
      setOrbState('idle');
      if (!openerFiredRef.current && (conversation?.messages?.length ?? 0) === 0) {
        openerFiredRef.current = true;
        if (id) streamOpener(id);
      }
    },
  });

  // ── ElevenLabs: start session ─────────────────────────────────────────────
  const startElevenLabs = useCallback(async () => {
    if (!id || !conversation) return;
    unlockAudio();
    setOrbState('connecting');

    try {
      const resp = await fetch('/api/elevenlabs/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: id }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${resp.status}`);
      }
      const { signedUrl, firstMessage } = await resp.json() as { signedUrl: string; firstMessage: string };

      // Show opener text immediately
      if (firstMessage?.trim()) {
        setLocalMessages((prev) => {
          const already = prev.some((m) => m.content.trim() === firstMessage.trim());
          if (already) return prev;
          return [...prev, { tempId: `opener-${Date.now()}`, role: 'assistant', content: firstMessage.trim() }];
        });
      }

      await (elConv.startSession as (opts: {
        signedUrl?: string;
        overrides?: { agent?: { firstMessage?: string }; tts?: { voiceId?: string } };
        customLlmExtraBody?: Record<string, unknown>;
      }) => Promise<string>)({
        signedUrl,
        overrides: {
          agent: { firstMessage: firstMessage || '' },
          tts: { voiceId: selectedVoiceId },
        },
        customLlmExtraBody: { conversationId: id },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (import.meta.env.DEV) setDevInfo({ mode: 'ptt', reason: msg });
      setElFailed(true);
      setMode('ptt');
      setOrbState('idle');
      if (!openerFiredRef.current && (conversation?.messages?.length ?? 0) === 0) {
        openerFiredRef.current = true;
        streamOpener(id);
      }
    }
  }, [id, conversation, unlockAudio, elConv, selectedVoiceId, streamOpener]);

  // ── Mode detection on load ────────────────────────────────────────────────
  useEffect(() => {
    if (!id || !conversation || mode !== 'detecting') return;
    startElevenLabs();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, conversation?.id, mode]);

  // PTT: auto-opener
  useEffect(() => {
    if (!id || !conversation || mode !== 'ptt' || openerFiredRef.current || inFlightRef.current) return;
    if ((conversation.messages?.length ?? 0) > 0) return;
    openerFiredRef.current = true;
    streamOpener(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, conversation?.id, mode]);

  // ── Cleanup ───────────────────────────────────────────────────────────────
  useEffect(() => () => {
    elConv.endSession().catch(() => {});
    ttsSourceRef.current?.stop();
    mediaRecorderRef.current?.stop();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Title ─────────────────────────────────────────────────────────────────
  const startEditTitle = () => { setTitleDraft(conversation?.title ?? ''); setIsEditingTitle(true); };
  const saveTitle = () => {
    const title = titleDraft.trim();
    if (!title || !id) { setIsEditingTitle(false); return; }
    updateConversation.mutate(
      { id, data: { title, titleLocked: true } },
      { onSuccess: () => queryClient.invalidateQueries({ queryKey: getGetConversationQueryKey(id) }) },
    );
    setIsEditingTitle(false);
  };

  // ── Loading / not found ───────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="h-[100dvh] w-full bg-background flex items-center justify-center">
        <div className="w-20 h-20 rounded-full bg-primary/20 animate-orb-pulse" />
      </div>
    );
  }
  if (!conversation) {
    return (
      <div className="h-[100dvh] w-full bg-background flex items-center justify-center">
        <p className="text-muted-foreground">Conversation not found</p>
      </div>
    );
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  const allMessages = [...(conversation.messages ?? [])];
  const dbContents = new Set(allMessages.map((m) => m.content.trim()));
  const filteredLocal = localMessages.filter((m) => !dbContents.has(m.content.trim()));
  const allDisplayed = [...allMessages, ...filteredLocal];
  const hasMessages  = allDisplayed.length > 0 || !!streamingText;
  const showTitle    = conversation.title && !isDefaultTitle(conversation.title);
  const isEL        = mode === 'elevenlabs';
  const isPTT       = mode === 'ptt';

  // Caption: show the most recently spoken text
  const lastMsg      = allDisplayed[allDisplayed.length - 1];
  const captionText  = streamingText || lastMsg?.content || '';
  const captionRole  = streamingText ? 'assistant' : (lastMsg?.role ?? 'assistant');
  const extraCount   = allDisplayed.length > 1 ? allDisplayed.length - 1 : 0;

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="h-[100dvh] w-full bg-background flex flex-col overflow-hidden select-none">

      {/* ── Header ── */}
      <header className="shrink-0 px-4 pt-safe pt-3 pb-3 flex items-center gap-2">
        <Link href="/" className="flex items-center gap-0.5 text-muted-foreground hover:text-foreground transition-colors -ml-1 shrink-0">
          <ChevronLeft className="h-5 w-5" />
          <span className="text-sm">Home</span>
        </Link>

        <div className="flex-1 min-w-0 px-2 text-center">
          {isEditingTitle ? (
            <div className="flex items-center justify-center gap-1.5">
              <input
                ref={titleInputRef}
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveTitle(); if (e.key === 'Escape') setIsEditingTitle(false); }}
                className="min-w-0 w-48 text-sm font-medium bg-transparent border-b border-primary outline-none text-center text-foreground"
                maxLength={80}
              />
              <button onClick={saveTitle}><Check className="h-3.5 w-3.5 text-primary" /></button>
              <button onClick={() => setIsEditingTitle(false)}><X className="h-3.5 w-3.5 text-muted-foreground" /></button>
            </div>
          ) : showTitle ? (
            <button onClick={startEditTitle} className="group flex items-center justify-center gap-1 max-w-full">
              <span className="text-sm font-medium text-foreground/70 truncate">{conversation.title}</span>
              <Pencil className="h-3 w-3 text-muted-foreground/0 group-hover:text-muted-foreground/40 shrink-0 transition-colors" />
            </button>
          ) : (
            <button onClick={startEditTitle} className="text-sm text-muted-foreground/30 hover:text-muted-foreground/60 transition-colors">
              Add a title
            </button>
          )}
        </div>

        {hasMessages ? (
          <Link
            href={`/conversations/${id}/story`}
            className="text-sm font-medium text-primary hover:text-primary/70 transition-colors shrink-0"
          >
            Story me
          </Link>
        ) : (
          <div className="w-16 shrink-0" /> /* spacer to keep title centred */
        )}
      </header>

      {/* ── Call area ── */}
      <div className="flex-1 flex flex-col items-center justify-center gap-6 px-6 min-h-0">

        {/* Orb */}
        <VoiceOrb
          state={orbState}
          onPress={isPTT ? handleOrbPress : undefined}
        />

        {/* Status label */}
        <p className={cn(
          'text-[11px] font-medium tracking-[0.18em] uppercase transition-all duration-500 select-none',
          (orbState === 'listening' || orbState === 'recording') ? 'text-primary' : 'text-muted-foreground/40',
        )}>
          {orbStateLabel(orbState, mode)}
        </p>

        {/* Caption — latest spoken content, tap to open transcript */}
        <button
          onClick={() => allDisplayed.length > 0 && setShowTranscript(true)}
          className={cn(
            'w-full max-w-xs text-center transition-all duration-500',
            captionText ? 'opacity-100' : 'opacity-0 pointer-events-none',
          )}
          tabIndex={captionText ? 0 : -1}
          aria-label="View full transcript"
        >
          {captionText && (
            <p className={cn(
              'text-[15px] italic leading-relaxed line-clamp-3',
              captionRole === 'user' ? 'text-foreground/50' : 'text-foreground/75',
            )}>
              {captionText}
              {streamingText && (
                <span className="not-italic inline-block w-1 h-3.5 bg-muted-foreground/40 animate-pulse ml-1 align-middle rounded-sm" />
              )}
            </p>
          )}
          {extraCount > 0 && !streamingText && (
            <p className="text-[11px] text-muted-foreground/30 mt-2 tracking-wide">
              {extraCount} earlier {extraCount === 1 ? 'message' : 'messages'} · tap to view
            </p>
          )}
        </button>

      </div>

      {/* ── Bottom zone ── */}
      <div className="shrink-0 px-5 pb-safe pb-8 pt-4 max-w-md mx-auto w-full space-y-4">

        {/* Error */}
        {error && (
          <div className="flex items-center gap-2 text-destructive text-xs bg-destructive/5 border border-destructive/10 rounded-xl px-3 py-2">
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} className="opacity-60 hover:opacity-100 shrink-0 text-base leading-none">✕</button>
          </div>
        )}

        {/* Fallback notice — only when EL actually failed */}
        {isPTT && elFailed && (
          <p className="text-center text-[11px] text-muted-foreground/40 tracking-wide">
            Live conversation unavailable — using tap-to-talk
          </p>
        )}

        {/* Text input (collapsed by default) */}
        {showTextInput && (
          <div className="flex gap-2 items-end animate-fade-in-up">
            <textarea
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleTextSend(isEL); }
              }}
              placeholder="Type a message…"
              rows={2}
              autoFocus
              className="flex-1 resize-none bg-card border border-border rounded-xl px-4 py-3 text-[15px] text-foreground placeholder:text-muted-foreground/30 focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <button
              onClick={() => handleTextSend(isEL)}
              disabled={!textInput.trim()}
              className="p-3 rounded-xl bg-primary text-primary-foreground disabled:opacity-30 hover:bg-primary/90 transition-colors"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Primary control row */}
        <div className="flex items-center justify-center gap-10">
          <ControlButton
            icon={isMuted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
            label={isMuted ? 'Unmute' : 'Mute'}
            active={isMuted}
            onClick={() => {
              const next = !isMuted;
              setIsMuted(next);
              (elConv as { setVolume?: (o: { volume: number }) => void }).setVolume?.({ volume: next ? 0 : 1 });
            }}
          />

          {/* End button */}
          {isEL ? (
            <button
              onClick={() => {
                elConv.endSession().catch(() => {});
                setMode('ptt');
                setOrbState('idle');
              }}
              className="w-16 h-16 rounded-full bg-destructive/85 text-white flex items-center justify-center shadow-lg hover:bg-destructive active:scale-95 transition-all"
              aria-label="End conversation"
            >
              <PhoneOff className="h-5 w-5" />
            </button>
          ) : (
            <Link
              href="/"
              className="w-16 h-16 rounded-full bg-muted/60 text-muted-foreground flex items-center justify-center shadow hover:bg-muted active:scale-95 transition-all"
              aria-label="Leave conversation"
            >
              <PhoneOff className="h-5 w-5" />
            </Link>
          )}

          <ControlButton
            icon={<Keyboard className="h-5 w-5" />}
            label="Type"
            active={showTextInput}
            onClick={() => setShowTextInput((v) => !v)}
          />
        </div>

        {/* Dev panel (DEV only) */}
        {import.meta.env.DEV && (
          <div className="border-t border-border/20 pt-3">
            <button
              onClick={() => setShowDevPanel((v) => !v)}
              className="w-full text-[10px] font-mono text-muted-foreground/30 hover:text-muted-foreground/50 transition-colors uppercase tracking-widest text-center"
            >
              {showDevPanel ? '▲ hide dev' : '▼ dev'}
            </button>
            {showDevPanel && (
              <div className="mt-3 space-y-2 animate-fade-in-up">
                <div className="flex items-center gap-2">
                  <label className="text-[10px] font-mono text-muted-foreground/50 shrink-0">Voice</label>
                  <select
                    value={selectedVoiceId}
                    onChange={(e) => { setSelectedVoiceId(e.target.value); localStorage.setItem('ekome-voice-id', e.target.value); }}
                    className="flex-1 text-[10px] font-mono bg-card border border-border rounded-lg px-2 py-1 text-foreground"
                  >
                    {VOICE_OPTIONS.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                </div>
                <div className="text-[10px] font-mono text-muted-foreground/40 space-y-0.5">
                  <div>mode: {devInfo.mode ?? mode}</div>
                  {devInfo.reason && <div className="text-amber-600/60">⚠ {devInfo.reason.slice(0, 100)}</div>}
                  {devInfo.latencyMs != null && devInfo.latencyMs > 0 && <div>turn→speech: {devInfo.latencyMs}ms</div>}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Full transcript drawer ── */}
      {showTranscript && (
        <div className="fixed inset-0 bg-background/98 backdrop-blur-sm z-30 flex flex-col">
          <div className="flex items-center justify-between px-5 py-4 border-b border-border/40">
            <span className="text-sm font-medium">Transcript</span>
            <button onClick={() => setShowTranscript(false)} className="p-1.5 text-muted-foreground hover:text-foreground transition-colors">
              <ChevronDown className="h-5 w-5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-5">
            <div className="mx-auto max-w-sm space-y-4">
              {allMessages.map((msg) => (
                <FullMessage key={msg.id} role={msg.role} content={msg.content} date={new Date(msg.createdAt)} />
              ))}
              {filteredLocal.map((msg) => (
                <FullMessage key={msg.tempId} role={msg.role} content={msg.content} pending />
              ))}
              {streamingText && (
                <FullMessage role="assistant" content={streamingText} streaming />
              )}
              <div ref={transcriptEndRef} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function VoiceOrb({ state, onPress }: { state: OrbState; onPress?: () => void }) {
  const isInteractive = !!onPress;
  const isListening   = state === 'listening' || state === 'recording';
  const isSpeaking    = state === 'speaking' || state === 'playing';
  const isThinking    = state === 'thinking' || state === 'processing';
  const isConnecting  = state === 'connecting';
  const isIdle        = state === 'idle';

  const Wrapper = isInteractive ? 'button' : 'div';

  return (
    <div className="relative flex items-center justify-center">
      {/* Outer ping — listening */}
      {isListening && (
        <span className="absolute rounded-full bg-primary/12 animate-orb-ping" style={{ width: 196, height: 196 }} />
      )}
      {/* Soft glow — speaking */}
      {isSpeaking && (
        <span className="absolute rounded-full bg-primary/8 animate-orb-pulse" style={{ width: 210, height: 210 }} />
      )}

      <Wrapper
        {...(isInteractive ? { onClick: onPress as React.MouseEventHandler } : {})}
        className={cn(
          'relative w-40 h-40 rounded-full flex items-center justify-center',
          'shadow-2xl transition-all duration-700',
          isConnecting && 'bg-muted/40 text-muted-foreground/40 animate-orb-pulse',
          isListening  && 'bg-primary text-primary-foreground animate-orb-breathe shadow-primary/20',
          isThinking   && 'bg-primary/55 text-primary-foreground',
          isSpeaking   && 'bg-primary text-primary-foreground shadow-primary/25',
          isIdle       && 'bg-primary/80 text-primary-foreground',
          isInteractive && !isConnecting && 'cursor-pointer hover:scale-105 active:scale-95',
        )}
      >
        {isSpeaking ? (
          <WaveBars />
        ) : isThinking ? (
          <div className="w-8 h-8 border-[2.5px] border-current/25 border-t-current/80 rounded-full animate-spin" />
        ) : state === 'recording' ? (
          <Square className="h-7 w-7 fill-current" />
        ) : isConnecting ? (
          <div className="w-7 h-7 border-2 border-current/15 border-t-current/50 rounded-full animate-spin" />
        ) : (
          <Mic className="h-8 w-8" />
        )}
      </Wrapper>
    </div>
  );
}

function WaveBars() {
  return (
    <div className="flex items-end gap-[3.5px] h-9">
      {[0.9, 1.3, 0.7, 1.1, 0.85].map((dur, i) => (
        <div
          key={i}
          className="w-[3.5px] rounded-full bg-current animate-wave-bar"
          style={{ animationDelay: `${i * 0.08}s`, animationDuration: `${dur}s` }}
        />
      ))}
    </div>
  );
}

function ControlButton({ icon, label, onClick, active }: {
  icon: React.ReactNode; label: string; onClick: () => void; active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex flex-col items-center gap-1.5 transition-colors select-none',
        active ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      <div className={cn(
        'w-12 h-12 rounded-full flex items-center justify-center transition-all',
        active ? 'bg-primary/12 scale-105' : 'bg-muted/50 hover:bg-muted',
      )}>
        {icon}
      </div>
      <span className="text-[11px] tracking-wide">{label}</span>
    </button>
  );
}

function FullMessage({ role, content, date, pending, streaming }: {
  role: string; content: string; date?: Date; pending?: boolean; streaming?: boolean;
}) {
  return (
    <div className={cn('animate-fade-in-up', role === 'user' ? 'flex justify-end' : 'flex justify-start')}>
      <div className={cn(
        'max-w-[85%] px-4 py-3 rounded-2xl',
        role === 'user'
          ? cn('bg-primary/70 text-primary-foreground rounded-br-sm', pending && 'opacity-60')
          : 'bg-card border border-border text-card-foreground rounded-bl-sm',
      )}>
        <p className="text-[15px] leading-relaxed whitespace-pre-wrap">
          {content}
          {streaming && (
            <span className="inline-block w-1.5 h-4 bg-muted-foreground/40 animate-pulse ml-0.5 align-middle rounded-sm" />
          )}
        </p>
        {date && <p className="text-[11px] mt-1.5 opacity-35 text-right">{format(date, 'h:mm a')}</p>}
      </div>
    </div>
  );
}
