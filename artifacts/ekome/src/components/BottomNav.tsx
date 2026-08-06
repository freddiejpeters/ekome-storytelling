import { Link, useLocation } from 'wouter';
import { Home, Search, BookOpen } from 'lucide-react';
import { cn } from '@/lib/utils';

const TABS = [
  { href: '/', icon: Home, label: 'Home' },
  { href: '/memories', icon: Search, label: 'Search' },
  { href: '/stories', icon: BookOpen, label: 'Stories' },
] as const;

export function BottomNav() {
  const [location] = useLocation();

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 bg-card/95 backdrop-blur-md border-t border-border">
      <div className="mx-auto max-w-xl flex items-center justify-around pb-2">
        {TABS.map(({ href, icon: Icon, label }) => {
          const active = href === '/' ? location === '/' : location.startsWith(href);
          return (
            <Link key={href} href={href}>
              <button
                className={cn(
                  'flex flex-col items-center gap-1 px-8 py-3 transition-colors',
                  active
                    ? 'text-primary'
                    : 'text-muted-foreground/50 hover:text-muted-foreground',
                )}
              >
                <Icon className={cn('h-5 w-5', active && 'stroke-[2.5]')} />
                <span className={cn('text-[10px] font-medium tracking-wide uppercase', active && 'font-semibold')}>
                  {label}
                </span>
              </button>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
