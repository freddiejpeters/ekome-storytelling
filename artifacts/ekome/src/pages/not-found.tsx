import { Link } from 'wouter';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <div className="min-h-[100dvh] w-full bg-background flex items-center justify-center px-6">
      <div className="text-center animate-fade-in-up max-w-md">
        <h1 className="font-serif text-6xl md:text-7xl mb-4 text-foreground">404</h1>
        <p className="text-muted-foreground text-lg mb-8">
          This page doesn't exist
        </p>
        <Link href="/" data-testid="link-home">
          <Button size="lg" className="rounded-xl">
            Return home
          </Button>
        </Link>
      </div>
    </div>
  );
}
