import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { EmbyApi, loadAuth, saveAuth } from './api/emby'
import type { AuthInfo } from './api/emby'

interface AppState {
  auth: AuthInfo | null
  api: EmbyApi
  signIn: (a: AuthInfo) => void
  signOut: () => void
}

const Ctx = createContext<AppState | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthInfo | null>(loadAuth())
  const authRef = useRef<AuthInfo | null>(auth)

  const signIn = useCallback((a: AuthInfo) => {
    authRef.current = a
    saveAuth(a)
    setAuth(a)
  }, [])

  const signOut = useCallback(() => {
    authRef.current = null
    saveAuth(null)
    setAuth(null)
  }, [])

  const api = useMemo(
    () =>
      new EmbyApi(
        () => authRef.current,
        // 收到 401 时清掉本地会话,路由守卫会把用户带回登录页
        () => signOut(),
      ),
    [signOut],
  )

  const value = useMemo(() => ({ auth, api, signIn, signOut }), [auth, api, signIn, signOut])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useApp(): AppState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useApp 必须在 AppProvider 内使用')
  return v
}
