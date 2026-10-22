import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css' // <-- ESTA LINHA É OBRIGATÓRIA PARA O TAILWIND FUNCIONAR!

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then((reg) => console.log('Service Worker registado com sucesso:', reg.scope))
      .catch((err) => console.log('Falha ao registar Service Worker:', err));
  });
}