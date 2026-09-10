import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { Setup } from './Setup.js';
import './styles.css';

type View = 'chat' | 'setup';

/**
 * Two views, switched by hash so a link to #setup works and a refresh keeps you
 * where you were. A router would be overkill for two screens.
 */
function Root(): JSX.Element {
  const [view, setView] = useState<View>(
    window.location.hash === '#setup' ? 'setup' : 'chat',
  );

  function go(next: View): void {
    window.location.hash = next === 'setup' ? '#setup' : '';
    setView(next);
  }

  return (
    <div className="root">
      <nav className="tabs">
        <button type="button" className={view === 'chat' ? 'active' : ''} onClick={() => go('chat')}>
          Chat
        </button>
        <button type="button" className={view === 'setup' ? 'active' : ''} onClick={() => go('setup')}>
          Setup
        </button>
      </nav>
      {view === 'chat' ? <App /> : <Setup />}
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
