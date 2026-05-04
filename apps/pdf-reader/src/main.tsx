import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import '@ulms/ui/styles/tokens.css';
import '@ulms/ui/styles/shell.css';
import './app.css';

const root = createRoot(document.getElementById('root')!);
root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);
