import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/inter';
import App from './App';
import './styles.css';
import './hero.css';

// Documents-to-PDF lives at the root; every other conversion keeps its existing /convert link.
const mode = window.location.pathname.replace(/\/+$/, '') === '/convert' ? 'all' : 'pdf';
ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App mode={mode} /></React.StrictMode>);
