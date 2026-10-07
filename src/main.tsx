import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AppProvider } from './state'
import App from './App'
import './styles.css'

// 应用保存的主题色(设置面板写入)
const savedAccent = localStorage.getItem('ewp/accent')
if (savedAccent) document.body.dataset.accent = savedAccent

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <AppProvider>
        <App />
      </AppProvider>
    </BrowserRouter>
  </React.StrictMode>,
)
