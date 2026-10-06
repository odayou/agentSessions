import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { installExternalLinkHandler } from './lib'
import './styles.css'

// 外链统一走系统浏览器（桌面版必需；浏览器 dev 模式行为不变）
installExternalLinkHandler()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)