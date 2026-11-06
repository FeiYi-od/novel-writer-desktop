import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ConfirmProvider } from './ConfirmDialog';
import './style.css';
import './pages.css';
import './characters.css';
import './ai.css';
import './shelf-polish.css';
import './accessibility-polish.css';
import './design-tokens.css';
import './liquid-glass-material.css';
import './writing-polish.css';
import './liquid-glass.css';
import './liquid-glass-models.css';
import './liquid-glass-studio.css';
import './liquid-glass-workspaces.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><ConfirmProvider><App /></ConfirmProvider></React.StrictMode>);
