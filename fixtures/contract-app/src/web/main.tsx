import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  const [notes, setNotes] = useState<number | null>(null);
  useEffect(() => {
    fetch('/api/health')
      .then((res) => res.json() as Promise<{ notes: number }>)
      .then((body) => setNotes(body.notes));
  }, []);
  return (
    <main>
      <h1>Contract app</h1>
      <p>{notes === null ? 'Loading…' : `${notes} notes`}</p>
    </main>
  );
}

const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
