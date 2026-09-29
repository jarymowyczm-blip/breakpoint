/**
 * Entry point.
 *
 * Mounts the app and removes the static boot splash from `index.html` once React
 * has painted, so there is never a flash of unstyled or empty page.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

const container = document.getElementById('root');
const root = createRoot(container);

root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Fade the static splash out rather than ripping it away.
requestAnimationFrame(() => {
  const boot = document.getElementById('boot');
  if (!boot) return;
  boot.style.opacity = '0';
  setTimeout(() => boot.remove(), 420);
});

// A failed render should say so instead of leaving a black screen.
window.addEventListener('error', (event) => {
  const boot = document.getElementById('boot');
  if (!boot || !event.error) return;
  boot.style.opacity = '1';
  boot.innerHTML = `
    <h1 style="color:#e2574c">STARTUP ERROR</h1>
    <p style="max-width:520px;white-space:pre-wrap;text-transform:none;letter-spacing:0;color:#8b98a8">
      ${String(event.error.message || event.error)}
    </p>
    <p>See the browser console for the full stack.</p>
  `;
});
