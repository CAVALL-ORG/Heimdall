import { useEffect, useMemo, useState } from 'react';
import { Editor } from 'ketcher-react';
import { RemoteStructServiceProvider } from 'ketcher-core';
import { StandaloneStructServiceProvider } from 'ketcher-standalone';
import 'ketcher-react/dist/index.css';
import { ketcherAgentBridge } from './bridge';

type RuntimeMode = 'standalone' | 'remote';

function getRuntimeMode(): RuntimeMode {
  const fromQuery = new URLSearchParams(window.location.search).get('mode');
  if (fromQuery === 'remote') {
    return 'remote';
  }
  if (import.meta.env.VITE_KETCHER_MODE === 'remote') {
    return 'remote';
  }
  return 'standalone';
}

function getRemoteApiPath() {
  const params = new URLSearchParams(window.location.search);
  return (
    params.get('api_path') ??
    import.meta.env.VITE_KETCHER_REMOTE_API_PATH ??
    'http://127.0.0.1:8002/v2/'
  );
}

async function createStructServiceProvider(): Promise<any> {
  if (getRuntimeMode() === 'remote') {
    return new RemoteStructServiceProvider(getRemoteApiPath());
  }
  return new StandaloneStructServiceProvider();
}

export function App() {
  const [provider, setProvider] = useState<any | null>(null);
  const [errorText, setErrorText] = useState<string>('');
  const buttons = useMemo<any>(() => ({}), []);

  useEffect(() => {
    createStructServiceProvider().then(setProvider).catch((error) => {
      setErrorText(error instanceof Error ? error.message : String(error));
    });
  }, []);

  useEffect(() => {
    window.__ketcherAgent = ketcherAgentBridge;
  }, []);

  const errorHandler = (message: string) => {
    setErrorText(message);
  };

  if (!provider) {
    return <div>Initializing Ketcher agent runtime...</div>;
  }

  return (
    <div style={{ height: '100vh', width: '100vw' }}>
      <Editor
        staticResourcesUrl="/"
        structServiceProvider={provider}
        disableMacromoleculesEditor
        buttons={buttons}
        errorHandler={errorHandler}
        onInit={(ketcher: any) => {
          window.ketcher = ketcher;
          window.__ketcherAgent = ketcherAgentBridge;
          ketcherAgentBridge.initializeEventSubscriptions(ketcher);
        }}
      />
      {errorText ? (
        <div
          data-testid="runtime-error"
          style={{
            position: 'fixed',
            bottom: 8,
            right: 8,
            zIndex: 9999,
            background: '#fff4f4',
            border: '1px solid #ffb3b3',
            padding: '8px 10px',
            fontSize: 12,
            maxWidth: 380,
          }}
        >
          {errorText}
        </div>
      ) : null}
    </div>
  );
}

declare global {
  interface Window {
    ketcher?: any;
  }
}
