import { useState, useRef, useEffect, useCallback } from 'react';
import { Link, useLocation } from 'wouter';
import {
  useListConversations,
  useCreateConversation,
  useUpdateConversation,
  useDeleteConversation,
  getListConversationsQueryKey,
  getGetConversationQueryKey,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Search, Mic, Pencil, Check, X, MoreVertical, Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { formatDistanceToNow, format, isToday, isYesterday } from 'date-fns';
import { cn } from '@/lib/utils';

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return 'Still up?';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  if (hour < 21) return 'Good evening';
  return 'Good night';
}

function formatConvDate(dateStr: string): string {
  const date = new Date(dateStr);
  if (isToday(date)) return formatDistanceToNow(date, { addSuffix: true });
  if (isYesterday(date)) return 'Yesterday';
  return format(date, 'MMM d');
}

function isDefaultTitle(t: string) {
  return t === 'New conversation' || t.startsWith('Conversation ');
}

// ─── Swipe-to-delete card ────────────────────────────────────────────────────

interface ConvCardProps {
  conv: {
    id: number;
    title: string;
    summary?: string | null;
    topic?: string | null;
    messageCount: number;
    updatedAt?: string | null;
    createdAt: string;
  };
  onDelete: (id: number, title: string) => void;
  editingId: number | null;
  titleDraft: string;
  onStartEdit: (e: React.MouseEvent, id: number, title: string) => void;
  onSaveTitle: (id: number) => void;
  onCancelEdit: () => void;
  onTitleDraftChange: (v: string) => void;
  titleInputRef: React.RefObject<HTMLInputElement | null>;
}

function ConvCard({
  conv, onDelete,
  editingId, titleDraft, onStartEdit, onSaveTitle, onCancelEdit, onTitleDraftChange, titleInputRef,
}: ConvCardProps) {
  const swipeXRef = useRef(0);
  const touchStartXRef = useRef(0);
  const isDraggingRef = useRef(false);
  const cardInnerRef = useRef<HTMLDivElement>(null);
  const [swipeX, setSwipeX] = useState(0);

  const resetSwipe = useCallback(() => {
    setSwipeX(0);
    swipeXRef.current = 0;
  }, []);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartXRef.current = e.touches[0].clientX;
    isDraggingRef.current = false;
  };
  const handleTouchMove = (e: React.TouchEvent) => {
    const dx = e.touches[0].clientX - touchStartXRef.current;
    if (dx < -4) {
      isDraggingRef.current = true;
      swipeXRef.current = Math.max(dx, -80);
      setSwipeX(swipeXRef.current);
    } else if (dx > 4 && swipeXRef.current < 0) {
      swipeXRef.current = Math.min(swipeXRef.current + dx * 0.5, 0);
      setSwipeX(swipeXRef.current);
    }
  };
  const handleTouchEnd = () => {
    if (swipeXRef.current < -50) { setSwipeX(-72); swipeXRef.current = -72; }
    else resetSwipe();
  };

  return (
    <div className="relative overflow-hidden rounded-xl">
      {/* Swipe delete reveal (touch) */}
      <button
        onClick={(e) => { e.preventDefault(); onDelete(conv.id, conv.title); resetSwipe(); }}
        className={cn(
          'absolute right-0 top-0 bottom-0 w-[72px] flex items-center justify-center bg-destructive text-destructive-foreground transition-opacity',
          swipeX < -50 ? 'opacity-100' : 'opacity-0 pointer-events-none',
        )}
      >
        <Trash2 className="h-4 w-4" />
      </button>

      <div
        ref={cardInnerRef}
        style={{ transform: `translateX(${swipeX}px)`, transition: isDraggingRef.current ? 'none' : 'transform 0.22s ease' }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onClick={() => { if (Math.abs(swipeX) > 10) resetSwipe(); }}
      >
        <Link
          href={`/conversations/${conv.id}`}
          onClick={(e) => { if (Math.abs(swipeXRef.current) > 10) e.preventDefault(); }}
        >
          <div className="bg-card border border-card-border rounded-xl px-5 py-4 hover:shadow-md transition-all duration-200 hover:-translate-y-px group">
            <div className="flex items-start justify-between gap-2">
              {editingId === conv.id ? (
                <form
                  onSubmit={(e) => { e.preventDefault(); onSaveTitle(conv.id); }}
                  className="flex-1 flex items-center gap-1.5 min-w-0"
                >
                  <input
                    ref={titleInputRef}
                    value={titleDraft}
                    onChange={(e) => onTitleDraftChange(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onCancelEdit(); } }}
                    onBlur={() => onSaveTitle(conv.id)}
                    className="flex-1 min-w-0 text-[15px] font-medium bg-transparent border-b border-primary outline-none text-foreground"
                    maxLength={80}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <button type="submit" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onSaveTitle(conv.id); }} className="text-primary shrink-0">
                    <Check className="h-3.5 w-3.5" />
                  </button>
                  <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onCancelEdit(); }} className="text-muted-foreground hover:text-foreground shrink-0">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </form>
              ) : (
                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                  <h3 className="font-medium text-[15px] text-foreground line-clamp-1 leading-snug">
                    {isDefaultTitle(conv.title) ? 'Untitled conversation' : conv.title}
                  </h3>
                  <button
                    onClick={(e) => onStartEdit(e, conv.id, isDefaultTitle(conv.title) ? '' : conv.title)}
                    className="opacity-0 group-hover:opacity-100 transition-opacity shrink-0 text-muted-foreground/50 hover:text-muted-foreground"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                </div>
              )}

              <div className="flex items-center gap-1 shrink-0">
                <span className="text-xs text-muted-foreground">
                  {formatConvDate(conv.updatedAt ?? conv.createdAt)}
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      onClick={(e) => e.preventDefault()}
                      className="opacity-0 group-hover:opacity-100 transition-opacity p-1 -mr-1 text-muted-foreground/50 hover:text-muted-foreground rounded"
                    >
                      <MoreVertical className="h-3.5 w-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-40">
                    <DropdownMenuItem onClick={(e) => onStartEdit(e as unknown as React.MouseEvent, conv.id, isDefaultTitle(conv.title) ? '' : conv.title)}>
                      <Pencil className="h-3.5 w-3.5 mr-2" />Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={(e) => { e.preventDefault(); onDelete(conv.id, conv.title); }}
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-2" />Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            {(conv.summary || conv.topic) && editingId !== conv.id && (
              <p className="text-sm text-muted-foreground mt-1.5 line-clamp-2 leading-relaxed">
                {conv.summary || conv.topic}
              </p>
            )}
            {conv.messageCount > 0 && editingId !== conv.id && (
              <p className="text-xs text-muted-foreground/60 mt-2">
                {conv.messageCount} {conv.messageCount === 1 ? 'message' : 'messages'}
              </p>
            )}
          </div>
        </Link>
      </div>
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function Home() {
  const [, setLocation] = useLocation();
  const [searchQuery, setSearchQuery] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const titleInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  // Optimistic deletion: IDs removed from UI immediately
  const [removedIds, setRemovedIds] = useState<Set<number>>(new Set());
  const deleteTimersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const { data: conversations, isLoading } = useListConversations(
    searchQuery ? { q: searchQuery } : undefined,
  );
  const createConversation = useCreateConversation();
  const updateConversation = useUpdateConversation();
  const deleteConversation = useDeleteConversation();

  const audioCtxRef = useRef<AudioContext | null>(null);
  const unlockAudio = useCallback(() => {
    if (typeof AudioContext === 'undefined' && typeof (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext === 'undefined') return;
    if (!audioCtxRef.current) {
      const Ctx = (AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
      audioCtxRef.current = new Ctx();
    }
    if (audioCtxRef.current.state === 'suspended') audioCtxRef.current.resume();
    (window as unknown as { __ekoAudioCtx?: AudioContext }).__ekoAudioCtx = audioCtxRef.current;
  }, []);

  useEffect(() => () => {
    deleteTimersRef.current.forEach((t) => clearTimeout(t));
  }, []);

  const handleDelete = useCallback((id: number, title: string) => {
    // Immediately remove from UI
    setRemovedIds((prev) => new Set([...prev, id]));

    // Show toast with undo
    const displayTitle = isDefaultTitle(title) ? 'Untitled conversation' : `"${title}"`;
    toast(`${displayTitle} deleted`, {
      action: {
        label: 'Undo',
        onClick: () => {
          // Restore immediately
          setRemovedIds((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
          const t = deleteTimersRef.current.get(id);
          if (t) { clearTimeout(t); deleteTimersRef.current.delete(id); }
        },
      },
      duration: 4000,
      onDismiss: () => {
        // If timer is still running, let it fire
      },
    });

    // Actual delete after 4 seconds
    const timer = setTimeout(() => {
      deleteConversation.mutate(
        { id },
        { onSettled: () => queryClient.invalidateQueries({ queryKey: getListConversationsQueryKey() }) },
      );
      setRemovedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      deleteTimersRef.current.delete(id);
    }, 4000);
    deleteTimersRef.current.set(id, timer);
  }, [deleteConversation, queryClient]);

  const handleBeginConversation = () => {
    unlockAudio();
    createConversation.mutate(
      { data: { title: 'New conversation' } },
      {
        onSuccess: (conv) => {
          queryClient.invalidateQueries({ queryKey: getListConversationsQueryKey() });
          setLocation(`/conversations/${conv.id}`);
        },
      },
    );
  };

  const startEdit = (e: React.MouseEvent, id: number, currentTitle: string) => {
    e.preventDefault();
    e.stopPropagation();
    setEditingId(id);
    setTitleDraft(currentTitle);
    setTimeout(() => titleInputRef.current?.focus(), 0);
  };

  const saveTitle = (id: number) => {
    const title = titleDraft.trim();
    if (!title) { setEditingId(null); return; }
    updateConversation.mutate(
      { id, data: { title, titleLocked: true } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListConversationsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetConversationQueryKey(id) });
          setEditingId(null);
        },
      },
    );
    setEditingId(null);
  };

  const visibleConversations = (conversations ?? []).filter((c) => !removedIds.has(c.id));

  return (
    <div className="min-h-[100dvh] w-full bg-background pb-24">
      <div className="mx-auto max-w-xl px-5 py-14 md:py-20">

        <header className="mb-14 animate-fade-in-up">
          <h1 className="font-serif text-4xl md:text-5xl tracking-tight text-foreground mb-2">
            {getGreeting()}
          </h1>
          <p className="text-muted-foreground text-base">What would you like to talk about?</p>
        </header>

        <div className="mb-14 animate-fade-in-up" style={{ animationDelay: '0.08s' }}>
          <button
            data-testid="button-begin-conversation"
            onClick={handleBeginConversation}
            disabled={createConversation.isPending}
            className={
              'w-full h-[72px] rounded-2xl bg-primary text-primary-foreground flex items-center justify-center gap-3 ' +
              'text-base font-medium shadow-lg shadow-primary/20 ' +
              'hover:shadow-xl hover:shadow-primary/25 hover:scale-[1.01] active:scale-[0.99] ' +
              'transition-all duration-200 disabled:opacity-70 disabled:cursor-not-allowed disabled:scale-100'
            }
          >
            <Mic className="h-5 w-5 shrink-0" />
            {createConversation.isPending ? 'Starting...' : 'Begin a conversation'}
          </button>
        </div>

        <div className="mb-6 animate-fade-in-up" style={{ animationDelay: '0.16s' }}>
          <div className="relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/60" />
            <Input
              type="search"
              placeholder="Search your conversations..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-11 h-11 rounded-xl bg-card border-card-border text-sm placeholder:text-muted-foreground/50"
            />
          </div>
        </div>

        <div className="space-y-2">
          {isLoading ? (
            [...Array(3)].map((_, i) => (
              <div key={i} className="h-24 bg-card rounded-xl border border-card-border animate-pulse" />
            ))
          ) : visibleConversations.length > 0 ? (
            visibleConversations.map((conv, index) => (
              <div key={conv.id} className="animate-fade-in-up" style={{ animationDelay: `${0.2 + index * 0.04}s` }}>
                <ConvCard
                  conv={conv}
                  onDelete={handleDelete}
                  editingId={editingId}
                  titleDraft={titleDraft}
                  onStartEdit={startEdit}
                  onSaveTitle={saveTitle}
                  onCancelEdit={() => setEditingId(null)}
                  onTitleDraftChange={setTitleDraft}
                  titleInputRef={titleInputRef}
                />
              </div>
            ))
          ) : (
            <div className="text-center py-20 animate-fade-in-up" style={{ animationDelay: '0.2s' }}>
              <p className="text-muted-foreground">
                {searchQuery ? 'No conversations found' : 'Your conversations will appear here'}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
