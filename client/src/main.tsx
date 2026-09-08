import { createRoot } from 'react-dom/client';
import App from './App';
import { initTelegram } from './telegram';
import './styles.css';

initTelegram();

// StrictMode здесь намеренно не используется: двойной прогон эффектов рвёт
// сокет и сервер успевает считать игрока вышедшим из лобби.
createRoot(document.getElementById('root')!).render(<App />);
