import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Route, Switch, Router as WouterRouter, useLocation } from 'wouter';
import { Toaster as SonnerToaster } from 'sonner';
import Home from '@/pages/home';
import Conversation from '@/pages/conversation';
import Story from '@/pages/story';
import Stories from '@/pages/stories';
import Memories from '@/pages/memories';
import NotFound from '@/pages/not-found';
import { BottomNav } from '@/components/BottomNav';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
  },
});

function Router() {
  const [location] = useLocation();
  const showNav = !location.startsWith('/conversations/');

  return (
    <>
      <Switch>
        <Route path="/" component={Home} />
        <Route path="/conversations/:id" component={Conversation} />
        <Route path="/conversations/:id/story" component={Story} />
        <Route path="/stories" component={Stories} />
        <Route path="/memories" component={Memories} />
        <Route component={NotFound} />
      </Switch>
      {showNav && <BottomNav />}
    </>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
        <SonnerToaster position="bottom-center" offset={80} />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
