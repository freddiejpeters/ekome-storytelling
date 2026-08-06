import { useState, useEffect } from 'react';
import { useParams, Link, useLocation } from 'wouter';
import {
  useGetStory,
  useUpdateStory,
  getGetStoryQueryKey,
  getGetConversationQueryKey,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Loader2, Edit3, Check, RotateCcw, MessageCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

type Perspective = 'first_person' | 'third_person';
type Tone = 'reflective' | 'warm' | 'funny' | 'adventurous' | 'concise';
type Format = 'short_story' | 'journal_entry' | 'long_form_chapter';

const TONES: { value: Tone; label: string; hint: string }[] = [
  { value: 'reflective', label: 'Reflective', hint: 'Honest and meditative' },
  { value: 'warm', label: 'Warm', hint: 'Tender and affectionate' },
  { value: 'funny', label: 'Funny', hint: 'Lightly humorous' },
  { value: 'adventurous', label: 'Adventurous', hint: 'Vivid and kinetic' },
  { value: 'concise', label: 'Concise', hint: 'Sharp and precise' },
];

const FORMATS: { value: Format; label: string; hint: string }[] = [
  { value: 'short_story', label: 'Short story', hint: '300–500 words' },
  { value: 'journal_entry', label: 'Journal entry', hint: '250–400 words' },
  { value: 'long_form_chapter', label: 'Long-form chapter', hint: '700–1200 words' },
];

export default function Story() {
  const params = useParams();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const id = params.id ? parseInt(params.id) : null;

  const { data: story, isLoading } = useGetStory(id!, {
    query: { enabled: !!id, queryKey: getGetStoryQueryKey(id!), retry: false },
  });
  const updateStory = useUpdateStory();

  const [perspective, setPerspective] = useState<Perspective>('first_person');
  const [tone, setTone] = useState<Tone>('reflective');
  const [format, setFormat] = useState<Format>('short_story');
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedContent, setGeneratedContent] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [editedContent, setEditedContent] = useState('');
  const [isConfiguring, setIsConfiguring] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  // Revision protection dialog
  const [showRevisionDialog, setShowRevisionDialog] = useState(false);
  const [pendingRegenAction, setPendingRegenAction] = useState<'same' | 'change' | null>(null);

  useEffect(() => {
    if (story) {
      setGeneratedContent(story.content);
      setEditedContent(story.content);
      if (story.perspective) setPerspective(story.perspective as Perspective);
      if (story.tone) setTone(story.tone as Tone);
      if (story.format) setFormat(story.format as Format);
    }
  }, [story]);

  // When user confirms revision action
  useEffect(() => {
    if (pendingRegenAction === 'same') {
      setPendingRegenAction(null);
      setShowRevisionDialog(false);
      handleGenerate();
    } else if (pendingRegenAction === 'change') {
      setPendingRegenAction(null);
      setShowRevisionDialog(false);
      setIsConfiguring(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRegenAction]);

  const handleGenerate = async () => {
    setIsGenerating(true);
    setGeneratedContent('');
    setEditedContent('');
    setIsConfiguring(false);
    setGenerateError(null);

    try {
      const response = await fetch(`/api/openai/conversations/${id}/story`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ perspective, tone, format }),
      });
      if (!response.ok) throw new Error('Generation failed');

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullContent = '';

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
            if (data.error) { setGenerateError(data.error); setIsGenerating(false); return; }
            if (data.done) {
              setIsGenerating(false);
              setEditedContent(fullContent);
              queryClient.invalidateQueries({ queryKey: getGetStoryQueryKey(id!) });
              queryClient.invalidateQueries({ queryKey: getGetConversationQueryKey(id!) });
              return;
            }
            if (data.content) { fullContent += data.content; setGeneratedContent(fullContent); }
          } catch { /* skip malformed */ }
        }
      }
    } catch {
      setGenerateError('Story generation failed. Please try again.');
      setIsGenerating(false);
    }
  };

  // Called when user presses "Story me / Regenerate"
  const handleRegenerateRequest = () => {
    const hasExistingContent = !!(generatedContent || story?.content);
    if (hasExistingContent && !isConfiguring) {
      setShowRevisionDialog(true);
    } else {
      handleGenerate();
    }
  };

  const handleSave = () => {
    updateStory.mutate(
      { id: id!, data: { content: editedContent } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetStoryQueryKey(id!) });
          setIsEditing(false);
          setGeneratedContent(editedContent);
        },
      }
    );
  };

  const hasContent = !!(generatedContent || story?.content);
  const showConfig = !hasContent || isConfiguring;

  if (isLoading) {
    return (
      <div className="min-h-[100dvh] w-full bg-background flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] w-full bg-background">

      {/* Revision protection dialog */}
      <Dialog open={showRevisionDialog} onOpenChange={setShowRevisionDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Regenerate your story?</DialogTitle>
            <DialogDescription>
              Your current story will be saved as a previous version before the new one is created.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 mt-2">
            <Button
              onClick={() => setPendingRegenAction('same')}
              className="w-full"
            >
              Same style — update now
            </Button>
            <Button
              variant="outline"
              onClick={() => setPendingRegenAction('change')}
              className="w-full"
            >
              Change style first
            </Button>
            <Button
              variant="ghost"
              onClick={() => setShowRevisionDialog(false)}
              className="w-full text-muted-foreground"
            >
              Cancel
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Header */}
      <header className="border-b border-border bg-card/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="mx-auto max-w-3xl px-5 py-4 flex items-center justify-between gap-3">
          {/* Back → Stories library */}
          <Link
            href="/stories"
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors shrink-0"
          >
            <ChevronLeft className="h-4 w-4" />
            <span className="text-sm">Stories</span>
          </Link>

          <div className="flex items-center gap-2 flex-wrap justify-end">
            {hasContent && !isConfiguring && !isGenerating && (
              <>
                <Button
                  onClick={handleRegenerateRequest}
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 text-muted-foreground hover:text-foreground"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Regenerate
                </Button>
                {isEditing ? (
                  <Button
                    onClick={handleSave}
                    disabled={updateStory.isPending}
                    size="sm"
                    className="gap-1.5"
                  >
                    <Check className="h-3.5 w-3.5" />
                    {updateStory.isPending ? 'Saving...' : 'Save'}
                  </Button>
                ) : (
                  <Button
                    onClick={() => { setIsEditing(true); setEditedContent(generatedContent || story?.content || ''); }}
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                  >
                    <Edit3 className="h-3.5 w-3.5" />
                    Edit
                  </Button>
                )}
              </>
            )}
            {isConfiguring && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsConfiguring(false)}
                className="text-muted-foreground"
              >
                Cancel
              </Button>
            )}
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-5 py-12">

        {/* Config picker */}
        {showConfig && (
          <div className="animate-fade-in-up space-y-10">
            <div>
              <h1 className="font-serif text-3xl md:text-4xl mb-2 text-foreground">
                {isConfiguring ? 'Choose a new style' : 'Create your story'}
              </h1>
              <p className="text-muted-foreground">
                {isConfiguring
                  ? 'Your current story will be saved before the new version is created'
                  : "Choose how you'd like this conversation remembered"}
              </p>
            </div>

            <div className="space-y-8">
              <div>
                <Label className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3 block">
                  Perspective
                </Label>
                <RadioGroup
                  value={perspective}
                  onValueChange={(val) => setPerspective(val as Perspective)}
                  className="grid grid-cols-2 gap-2"
                >
                  {[
                    { value: 'first_person', label: 'First person', hint: 'I, me, my' },
                    { value: 'third_person', label: 'Third person', hint: 'they, them' },
                  ].map((opt) => (
                    <label
                      key={opt.value}
                      htmlFor={opt.value}
                      className={cn(
                        'flex flex-col p-4 rounded-xl border cursor-pointer transition-all',
                        perspective === opt.value ? 'border-primary bg-primary/5' : 'border-card-border bg-card hover:bg-accent/30'
                      )}
                    >
                      <RadioGroupItem value={opt.value} id={opt.value} className="sr-only" />
                      <span className="font-medium text-sm text-foreground">{opt.label}</span>
                      <span className="text-xs text-muted-foreground mt-0.5">{opt.hint}</span>
                    </label>
                  ))}
                </RadioGroup>
              </div>

              <div>
                <Label className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3 block">
                  Tone
                </Label>
                <RadioGroup
                  value={tone}
                  onValueChange={(val) => setTone(val as Tone)}
                  className="grid grid-cols-2 gap-2 sm:grid-cols-3"
                >
                  {TONES.map((opt) => (
                    <label
                      key={opt.value}
                      htmlFor={`tone-${opt.value}`}
                      className={cn(
                        'flex flex-col p-4 rounded-xl border cursor-pointer transition-all',
                        tone === opt.value ? 'border-primary bg-primary/5' : 'border-card-border bg-card hover:bg-accent/30'
                      )}
                    >
                      <RadioGroupItem value={opt.value} id={`tone-${opt.value}`} className="sr-only" />
                      <span className="font-medium text-sm text-foreground">{opt.label}</span>
                      <span className="text-xs text-muted-foreground mt-0.5">{opt.hint}</span>
                    </label>
                  ))}
                </RadioGroup>
              </div>

              <div>
                <Label className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3 block">
                  Format
                </Label>
                <RadioGroup
                  value={format}
                  onValueChange={(val) => setFormat(val as Format)}
                  className="grid grid-cols-1 gap-2 sm:grid-cols-3"
                >
                  {FORMATS.map((opt) => (
                    <label
                      key={opt.value}
                      htmlFor={`format-${opt.value}`}
                      className={cn(
                        'flex flex-col p-4 rounded-xl border cursor-pointer transition-all',
                        format === opt.value ? 'border-primary bg-primary/5' : 'border-card-border bg-card hover:bg-accent/30'
                      )}
                    >
                      <RadioGroupItem value={opt.value} id={`format-${opt.value}`} className="sr-only" />
                      <span className="font-medium text-sm text-foreground">{opt.label}</span>
                      <span className="text-xs text-muted-foreground mt-0.5">{opt.hint}</span>
                    </label>
                  ))}
                </RadioGroup>
              </div>
            </div>

            {generateError && (
              <p className="text-sm text-destructive bg-destructive/5 border border-destructive/20 rounded-xl px-4 py-3">
                {generateError}
              </p>
            )}

            <Button
              onClick={handleGenerate}
              disabled={isGenerating}
              size="lg"
              className="w-full h-14 text-base rounded-xl"
            >
              {isGenerating ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Writing your story...</>
              ) : isConfiguring ? 'Generate new version' : 'Generate story'}
            </Button>
          </div>
        )}

        {/* Story content */}
        {!showConfig && (
          <div className="animate-fade-in-up">
            {isGenerating ? (
              <div className="font-serif text-lg md:text-xl leading-[1.8] text-foreground whitespace-pre-wrap">
                {generatedContent}
                <span className="inline-block w-0.5 h-5 bg-primary/50 animate-pulse ml-0.5 align-text-bottom" />
              </div>
            ) : isEditing ? (
              <textarea
                value={editedContent}
                onChange={(e) => setEditedContent(e.target.value)}
                className="w-full min-h-[60vh] p-0 bg-transparent text-foreground resize-none focus:outline-none font-serif text-lg md:text-xl leading-[1.8]"
                autoFocus
              />
            ) : (
              <div className="font-serif text-lg md:text-xl leading-[1.8] text-foreground whitespace-pre-wrap">
                {generatedContent || story?.content}
              </div>
            )}
          </div>
        )}

        {/* Continue conversation */}
        {hasContent && !isGenerating && (
          <div className="mt-16 pt-8 border-t border-border flex flex-col sm:flex-row items-center gap-4">
            <Button
              onClick={() => setLocation(`/conversations/${id}`)}
              className="w-full sm:w-auto gap-2"
            >
              <MessageCircle className="h-4 w-4" />
              Continue conversation
            </Button>
            <Link
              href={`/conversations/${id}`}
              className="text-sm text-muted-foreground/60 hover:text-muted-foreground transition-colors"
            >
              View source conversation
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
