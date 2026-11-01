import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './style.css';
import './pages.css';
import './characters.css';
import './ai.css';
import './shelf-polish.css';
import './accessibility-polish.css';
import './writing-polish.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
