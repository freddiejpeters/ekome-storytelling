import { useState, useRef } from 'react';
import { Link } from 'wouter';
import { useListMemories } from '@workspace/api-client-react';
import { ChevronLeft, Search, Loader2, X } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';

const CATEGORIES = [
  { key: 'person', label: 'People' },
  { key: 'place', label: 'Places' },
  { key: 'event', label: 'Events' },
  { key: 'project', label: 'Projects' },
  { key: 'goal', label: 'Goals' },
  { key: 'idea', label: 'Ideas' },
];

interface SearchResult {
  answer: string;
  conversations: Array<{
    id: number;
    title: string;
    summary?: string | null;
    updatedAt: string;
  }>;
  memories: Array<{
    id: number;
    conversationId: number;
    type: string;
    content: string;
  }>;
}

export default function Memories() {
  const [selectedType, setSelectedType] = useState<string | undefined>(undefined);
  const [searchQuery, setSearchQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: memories, isLoading } = useListMemories(
    selectedType ? { type: selectedType } : undefined,
  );

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = searchQuery.trim();
    if (!q) return;
    setIsSearching(true);
    setSearchError(null);
    setSearchResult(null);
    setSubmittedQuery(q);
    try {
      const resp = await fetch('/api/openai/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q }),
      });
      if (!resp.ok) throw new Error('Search failed');
      const data = await resp.json();
      setSearchResult(data);
    } catch {
      setSearchError('Search failed. Please try again.');
    } finally {
      setIsSearching(false);
    }
  };

  const clearSearch = () => {
    setSearchQuery('');
    setSubmittedQuery('');
    setSearchResult(null);
    setSearchError(null);
    inputRef.current?.focus();
  };

  const showBrowse = !submittedQuery;

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

        {/* Title */}
        <div className="mb-8 animate-fade-in-up">
          <h1 className="font-serif text-3xl md:text-4xl mb-2 text-foreground">Memories</h1>
          <p className="text-muted-foreground text-sm">Ask a question, or browse what eKoMe knows</p>
        </div>

        {/* Search bar */}
        <form onSubmit={handleSearch} className="mb-8 animate-fade-in-up" style={{ animationDelay: '0.05s' }}>
          <div className="relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/60" />
            <input
              ref={inputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Ask anything — 'Who did I meet in Berlin?' or 'What projects am I working on?'"
              className="w-full pl-11 pr-10 h-12 rounded-xl bg-card border border-card-border text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary"
            />
            {searchQuery && (
              <button type="button" onClick={clearSearch} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-muted-foreground">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </form>

        {/* Search results */}
        {isSearching && (
          <div className="flex items-center gap-2 text-muted-foreground text-sm mb-8">
            <Loader2 className="h-4 w-4 animate-spin" />
            Searching...
          </div>
        )}

        {searchError && (
          <div className="text-sm text-destructive bg-destructive/5 border border-destructive/20 rounded-xl px-4 py-3 mb-8">
            {searchError}
          </div>
        )}

        {searchResult && (
          <div className="mb-10 animate-fade-in-up space-y-6">
            {/* AI answer */}
            <div className="bg-card border border-card-border rounded-xl px-5 py-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Answer</p>
              <p className="text-[15px] text-foreground leading-relaxed">{searchResult.answer}</p>
            </div>

            {/* Matched conversations */}
            {searchResult.conversations.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-3 px-1">Conversations</p>
                <div className="space-y-2">
                  {searchResult.conversations.map((conv) => (
                    <Link key={conv.id} href={`/conversations/${conv.id}`}>
                      <div className="bg-card border border-card-border rounded-xl px-4 py-3.5 hover:shadow-sm transition-all">
                        <p className="text-[15px] font-medium text-foreground">{conv.title}</p>
                        {conv.summary && <p className="text-sm text-muted-foreground mt-0.5 line-clamp-1">{conv.summary}</p>}
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            )}

            {/* Matched memories */}
            {searchResult.memories.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-3 px-1">
                  Related memories
                </p>
                <div className="space-y-2">
                  {searchResult.memories.slice(0, 8).map((mem) => (
                    <Link key={mem.id} href={`/conversations/${mem.conversationId}`}>
                      <div className="bg-card border border-card-border rounded-xl px-4 py-3 hover:shadow-sm transition-all">
                        <span className="text-xs text-primary font-medium uppercase tracking-wider">{mem.type}</span>
                        <p className="text-sm text-foreground mt-0.5">{mem.content}</p>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            )}

            {searchResult.conversations.length === 0 && searchResult.memories.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">
                Nothing found for "{submittedQuery}"
              </p>
            )}

            <button onClick={clearSearch} className="text-sm text-muted-foreground/60 hover:text-muted-foreground transition-colors">
              ← Clear search
            </button>
          </div>
        )}

        {/* Browse categories */}
        {showBrowse && (
          <div className="animate-fade-in-up" style={{ animationDelay: '0.1s' }}>
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-3 px-1">Browse</p>
            <div className="flex flex-wrap gap-2 mb-8">
              <button
                onClick={() => setSelectedType(undefined)}
                className={cn(
                  'px-4 py-2 rounded-full text-sm font-medium transition-all',
                  !selectedType ? 'bg-primary text-primary-foreground' : 'bg-card border border-card-border hover:bg-accent',
                )}
              >
                All
              </button>
              {CATEGORIES.map((cat) => (
                <button
                  key={cat.key}
                  onClick={() => setSelectedType(selectedType === cat.key ? undefined : cat.key)}
                  className={cn(
                    'px-4 py-2 rounded-full text-sm font-medium transition-all',
                    selectedType === cat.key ? 'bg-primary text-primary-foreground' : 'bg-card border border-card-border hover:bg-accent',
                  )}
                >
                  {cat.label}
                </button>
              ))}
            </div>

            {isLoading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground/40" />
              </div>
            ) : !memories || memories.length === 0 ? (
              <div className="text-center py-16">
                <p className="text-muted-foreground">
                  {selectedType ? `No ${selectedType} memories yet` : 'No memories yet. Start a conversation.'}
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {memories.map((memory, index) => (
                  <Link
                    key={memory.id}
                    href={`/conversations/${memory.conversationId}`}
                    className="block animate-fade-in-up"
                    style={{ animationDelay: `${0.02 * index}s` }}
                  >
                    <div className="bg-card border border-card-border rounded-xl px-4 py-3.5 hover:shadow-sm transition-all group">
                      <div className="flex items-start gap-3">
                        <span className="text-xs text-primary font-medium uppercase tracking-wider mt-0.5 shrink-0 w-20 truncate">
                          {memory.type}
                        </span>
                        <p className="text-sm text-foreground leading-relaxed flex-1">{memory.content}</p>
                        <span className="text-xs text-muted-foreground/50 shrink-0 mt-0.5">
                          {format(new Date(memory.createdAt), 'MMM d')}
                        </span>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
