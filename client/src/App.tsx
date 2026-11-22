import { HomePage } from './pages/HomePage';
import { RunPage } from './pages/RunPage';
import { useRoute } from './lib/router';

export function App() {
  const route = useRoute();

  switch (route.name) {
    case 'home':
      return <HomePage />;
    case 'run':
      return <RunPage key={route.appId} appId={route.appId} />;
    default:
      return null;
  }
}
