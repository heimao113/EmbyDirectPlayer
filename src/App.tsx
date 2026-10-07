import { Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { useApp } from './state'
import Header from './components/Header'
import Login from './pages/Login'
import Home from './pages/Home'
import Library from './pages/Library'
import Detail from './pages/Detail'
import PlayerLite from './pages/PlayerLite'
// 官方 AVPlayerUI 播放页实验:UI 不透传 findBestStream,AAC 声道修复无法注入,
// 暂不上线。文件保留在 src/pages/PlayerUIPage.tsx 待 libmedia 修复后评估

function RequireAuth() {
  const { auth } = useApp()
  if (!auth) return <Navigate to="/login" replace />
  return (
    <div className="app-shell">
      <Header />
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<RequireAuth />}>
        <Route path="/" element={<Home />} />
        <Route path="/library/:id" element={<Library />} />
        <Route path="/item/:id" element={<Detail />} />
        <Route path="/play/:id" element={<PlayerLite />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
