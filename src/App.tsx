import { Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { useApp } from './state'
import Header from './components/Header'
import Login from './pages/Login'
import Home from './pages/Home'
import Library from './pages/Library'
import Detail from './pages/Detail'
import Player from './pages/Player'

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
        <Route path="/play/:id" element={<Player />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
