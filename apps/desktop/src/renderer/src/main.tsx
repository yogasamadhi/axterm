import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRuntimeClient } from '@workspace/client';
import { App } from './app/app';
import { prepareBundledTerminalFont } from './components/terminal-font';
import { RuntimeI18nProvider } from './i18n/provider';
import '@fontsource/maple-mono/400.css';
import './styles/globals.css';
import './styles/electerm-shell.css';

const client = createRuntimeClient({ resolve: () => window.desktopBootstrap.resolve() });
const queryClient = new QueryClient({
  defaultOptions: { queries: { gcTime: 0, refetchOnWindowFocus: false } },
});
const container = document.getElementById('root');
if (!container) throw new Error('Missing application root');

void prepareBundledTerminalFont(document.fonts).then((terminalFontState) => {
  document.documentElement.dataset.terminalFontState = terminalFontState;
  const root = createRoot(container);
  root.render(
    <QueryClientProvider client={queryClient}>
      <RuntimeI18nProvider client={client}>
        <App client={client} />
      </RuntimeI18nProvider>
    </QueryClientProvider>,
  );
  window.addEventListener(
    'pagehide',
    () => {
      root.unmount();
      client.dispose();
      queryClient.clear();
    },
    { once: true },
  );
});
