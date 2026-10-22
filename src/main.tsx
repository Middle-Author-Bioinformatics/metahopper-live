import { createRoot } from 'react-dom/client';
import { Amplify } from 'aws-amplify';
import outputs from '../amplify_outputs.json';
import '@aws-amplify/ui-react/styles.css';
import App from './App';
import './style.css';

Amplify.configure(outputs);
createRoot(document.getElementById('root')!).render(<App />);
