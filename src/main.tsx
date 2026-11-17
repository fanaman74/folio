import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import App from './App';
import Landing from './Landing';
import './styles.css';
import './landing.css';
import './theme.css';

// Dark is the default; a saved choice wins.
try { if (localStorage.getItem('folio-theme') === 'light') document.documentElement.classList.add('light'); } catch { /* storage unavailable */ }

// The intro lives at the root; the converter keeps its own path so it can be linked directly.
const page = window.location.pathname.replace(/\/+$/, '') === '/convert' ? <App /> : <Landing />;
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode>{page}</React.StrictMode>);
