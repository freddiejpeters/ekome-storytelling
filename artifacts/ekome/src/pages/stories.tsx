import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import {
  useListStories,
  useDeleteStoryById,
  useUpdateStoryById,
  getListStoriesQueryKey,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Loader2, BookOpen, Trash2, Pencil, Check, X } from 'lucide-react';
import { format, isToday, isYesterday, formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils';

function formatStoryDate(dateStr: string): string {
  const date = new Date(dateStr);
  if (isToday(date)) return formatDistanceToNow(date, { addSuffix: true });
  if (isYesterday(date)) return 'Yesterday';
  return format(date, 'MMM d, yyyy');
}

function toneLabel(tone: string): string {
  const labels: Record<string, string> = {
    reflective: 'Reflective', warm: 'Warm', funny: 'Funny',
    adventurous: 'Adventurous', concise: 'Concise',
  };
  return labels[tone] ?? tone;
}

export default function Stories() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [editingTitleId, setEditingTitleId] = useState<number | null>(null);
  const [titleDraft, setTitleDraft] = useState('');

  const { data: stories, isLoading } = useListStories();
  const deleteStory = useDeleteStoryById();
  const updateStory = useUpdateStoryById();

  const handleDelete = (id: number) => {
    deleteStory.mutate({ id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListStoriesQueryKey() });
        setConfirmDeleteId(null);
      },
    });
  };

  const startEditTitle = (e: React.MouseEvent, id: number, currentTitle: string | null | undefined, convTitle: string) => {
    e.preventDefault();
    e.stopPropagation();
    setEditingTitleId(id);
    setTitleDraft(currentTitle ?? convTitle);
  };

  const saveTitle = (e: React.FormEvent | React.MouseEvent, id: number) => {
    e.preventDefault();
    e.stopPropagation();
    const title = titleDraft.trim();
    updateStory.mutate({ id, data: { title } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListStoriesQueryKey() });
        setEditingTitleId(null);
      },
    });
  };

  if (isLoading) {
    return (
      <div className="min-h-[100dvh] w-full bg-background flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] w-full bg-background">
      <header className="border-b border-border bg-card/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="mx-auto max-w-2xl px-5 py-4">
          <Link href="/" className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors w-fit">
            <ChevronLeft className="h-4 w-4" />
            <span className="text-sm">Home</span>
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-2xl px-5 py-12">
        <div className="mb-12 animate-fade-in-up">
          <h1 className="font-serif text-3xl md:text-4xl mb-2 text-foreground">Stories</h1>
          <p className="text-muted-foreground text-sm">Everything you've turned into narrative</p>
        </div>

        {!stories || stories.length === 0 ? (
          <div className="text-center py-24 animate-fade-in-up">
            <BookOpen className="h-10 w-10 text-muted-foreground/30 mx-auto mb-4" />
            <p className="text-muted-foreground">No stories yet.</p>
            <p className="text-sm text-muted-foreground/60 mt-1">
              Open a conversation and tap <span className="font-medium">Story me</span>.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {stories.map((story, index) => {
              const displayTitle = story.title || story.conversationTitle;
              const isEditing = editingTitleId === story.id;
              const isConfirmingDelete = confirmDeleteId === story.id;
              const excerpt = story.content.slice(0, 160).replace(/\n+/g, ' ');

              return (
                <div
                  key={story.id}
                  className="bg-card border border-card-border rounded-xl overflow-hidden animate-fade-in-up hover:shadow-md transition-all duration-200"
                  style={{ animationDelay: `${0.05 * index}s` }}
                >
                  {/* Card header */}
                  <div className="px-5 pt-5 pb-3">
                    <div className="flex items-start justify-between gap-3">
                      {isEditing ? (
                        <form onSubmit={(e) => saveTitle(e, story.id)} className="flex-1 flex items-center gap-1.5 min-w-0">
                          <input
                            autoFocus
                            value={titleDraft}
                            onChange={(e) => setTitleDraft(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Escape') setEditingTitleId(null); }}
                            className="flex-1 min-w-0 font-serif text-lg bg-transparent border-b border-primary outline-none text-foreground"
                            maxLength={100}
                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
                          />
                          <button type="submit" onClick={(e) => saveTitle(e, story.id)} className="text-primary shrink-0">
                            <Check className="h-4 w-4" />
                          </button>
                          <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setEditingTitleId(null); }} className="text-muted-foreground shrink-0">
                            <X className="h-4 w-4" />
                          </button>
                        </form>
                      ) : (
                        <div className="flex items-center gap-2 min-w-0 flex-1 group">
                          <h2 className="font-serif text-lg text-foreground leading-snug line-clamp-1">{displayTitle}</h2>
                          <button
                            onClick={(e) => startEditTitle(e, story.id, story.title, story.conversationTitle)}
                            className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground/50 hover:text-muted-foreground shrink-0"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      )}
                      <span className="text-xs text-muted-foreground whitespace-nowrap shrink-0 mt-1">{formatStoryDate(story.updatedAt)}</span>
                    </div>

                    {story.title && (
                      <p className="text-xs text-muted-foreground/60 mt-0.5">
                        From: {story.conversationTitle}
                      </p>
                    )}
                  </div>

                  {/* Story excerpt — clickable */}
                  <Link href={`/conversations/${story.conversationId}/story`}>
                    <div className="px-5 pb-4">
                      <p className="text-sm text-muted-foreground leading-relaxed line-clamp-3 font-serif italic">
                        {excerpt}{story.content.length > 160 ? '…' : ''}
                      </p>
                    </div>
                  </Link>

                  {/* Card footer */}
                  <div className="px-5 pb-4 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground/60 capitalize bg-muted px-2 py-0.5 rounded-full">
                        {toneLabel(story.tone ?? '')}
                      </span>
                    </div>

                    <div className="flex items-center gap-3">
                      {isConfirmingDelete ? (
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">Delete?</span>
                          <button
                            onClick={() => handleDelete(story.id)}
                            disabled={deleteStory.isPending}
                            className="text-xs text-destructive font-medium hover:text-destructive/80"
                          >
                            Yes
                          </button>
                          <button
                            onClick={() => setConfirmDeleteId(null)}
                            className="text-xs text-muted-foreground hover:text-foreground"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <>
                          <Link
                            href={`/conversations/${story.conversationId}/story`}
                            className="text-xs text-primary font-medium hover:text-primary/80 transition-colors"
                            onClick={(e) => e.stopPropagation()}
                          >
                            Open
                          </Link>
                          <button
                            onClick={(e) => { e.preventDefault(); setConfirmDeleteId(story.id); }}
                            className="text-muted-foreground/40 hover:text-destructive transition-colors"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
