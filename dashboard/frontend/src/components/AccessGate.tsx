import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Clapperboard, Languages, LoaderCircle, Moon, Sun } from 'lucide-react';
import { accessRequest, AccessSessionContext, uploadLimitLabel } from '../accessSession';
import type { AccessSession } from '../accessSession';
import { useUiPreferences } from '../uiPreferences';
import { Alert, Loading, Modal } from './workspace/WorkspaceShared';
import '../workspace.css';
import '../ui-theme.css';
import './access.css';

type FormMode = 'login' | 'register';
function AccessForm({ mode, guest, busy, error, onSubmit, onMode }: { mode: FormMode; guest: boolean; busy: boolean; error: string; onSubmit: (username: string, password: string) => void; onMode: (mode: FormMode) => void }) {
  const { t } = useUiPreferences();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  return <form className="ve-access-form" onSubmit={event => { event.preventDefault(); onSubmit(username.trim(), password); }}>
    {guest && <p className="ve-access-note">{mode === 'register' ? t('注册后保留当前试用作品。', 'Registration keeps the videos in this trial workspace.') : t('登录已有账号会切换到该账号的作品，试用作品不会导入。', 'Logging in switches to that account’s videos. Trial videos are not imported.')}</p>}
    <label className="ws-field">{t('用户名', 'Username')}<input aria-label={t("用户名", "Username")} name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required minLength={3} maxLength={32} pattern={'[A-Za-z0-9_\\-]{3,32}'} disabled={busy} value={username} onChange={event => setUsername(event.target.value)} /><small>{t('3–32 位字母、数字、下划线或连字符', '3–32 letters, numbers, underscores or hyphens')}</small></label>
    <label className="ws-field">{t('密码', 'Password')}<input aria-label={t("密码", "Password")} type="password" name="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} required minLength={12} maxLength={128} disabled={busy} value={password} onChange={event => setPassword(event.target.value)} /><small>{t('12–128 位字符', '12–128 characters')}</small></label>
    {error && <Alert>{error}</Alert>}
    <button className="ws-button primary" disabled={busy || !username.trim() || password.length < 12}>{busy ? <LoaderCircle size={16} className="ws-spin" /> : null}{mode === 'register' ? t('创建账号', 'Create account') : t('登录', 'Log in')}</button>
    <button type="button" className="ws-text-button" disabled={busy} onClick={() => { setPassword(''); onMode(mode === 'login' ? 'register' : 'login'); }}>{mode === 'login' ? t('还没有账号？注册', 'New here? Create an account') : t('已有账号？登录', 'Already have an account? Log in')}</button>
  </form>;
}

export default function AccessGate({ children }: { children: ReactNode }) {
  const { t, language, theme, setLanguage, setTheme } = useUiPreferences();
  const [session, setSession] = useState<AccessSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [formMode, setFormMode] = useState<FormMode>('login');
  const [dialog, setDialog] = useState<FormMode | 'logout' | null>(null);
  const [workspaceEpoch, setWorkspaceEpoch] = useState(0);
  const requestVersion = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { const requests = requestVersion; mounted.current = true; return () => { mounted.current = false; requests.current++; }; }, []);
  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    try {
      const next = await accessRequest();
      if (!mounted.current || version !== requestVersion.current) return;
      setSession(next); setLoadError('');
    } catch (reason) {
      if (!mounted.current || version !== requestVersion.current) return;
      setLoadError(reason instanceof Error ? reason.message : 'Unable to load the workspace.');
    } finally { if (mounted.current && version === requestVersion.current) setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (session?.mode !== 'hosted' || busy) return;
    const check = () => { if (document.visibilityState !== 'hidden') void refresh(); };
    window.addEventListener('focus', check);
    window.addEventListener('visionecho-access-expired', check);
    const timer = window.setInterval(check, 60_000);
    return () => { window.removeEventListener('focus', check); window.removeEventListener('visionecho-access-expired', check); window.clearInterval(timer); };
  }, [session?.mode, busy, refresh]);

  async function authenticate(path: '/guest' | '/login' | '/register' | '/logout', payload: Record<string, string> = {}) {
    requestVersion.current++;
    setBusy(true); setError('');
    if (path === '/logout') setSession(null);
    try {
      const next = await accessRequest(path, payload);
      if (!mounted.current) return;
      setWorkspaceEpoch(value => value + 1); setSession(next); setDialog(null); setLoadError('');
    } catch (reason) {
      if (!mounted.current) return;
      setError(reason instanceof Error ? reason.message : t('操作失败，请重试。', 'The operation failed. Please retry.'));
      if (path === '/logout') { setDialog(null); setLoadError(t('退出状态未确认，请重新检查。', 'Logout could not be confirmed. Check the session again.')); }
    } finally { if (mounted.current) setBusy(false); }
  }
  const openAccess = (mode: FormMode | 'logout') => { if (loadError) return; setError(''); setDialog(mode); };
  const hasWorkspace = Boolean(session && (session.mode === 'local' || session.user));
  const workspaceKey = session?.mode === 'local' ? 'local' : (session?.user?.id ?? 'anonymous') + ':' + session?.user?.kind + ':' + workspaceEpoch;

  if (loading) return <div className="ws-app ve-atelier ve-access-shell"><Loading text={t('正在打开工作区…', 'Opening workspace…')} /></div>;
  if (!hasWorkspace) return <div className="ws-app ve-atelier ve-access-shell">
    <header className="ve-access-header"><a className="ws-brand" href="#"><Clapperboard size={24} /><span>VisionEcho</span></a><div className="ve-header-controls"><button className="ve-preference-button" aria-label={t('切换页面为英文', 'Switch interface to Chinese')} onClick={() => setLanguage(language === 'en' ? 'zh-CN' : 'en')}><Languages size={17} />{language === 'en' ? '中文' : 'EN'}</button><button className="ve-preference-button" aria-label={theme === 'light' ? t('切换到暗色', 'Switch to dark theme') : t('切换到亮色', 'Switch to light theme')} onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}</button></div></header>
    <main className="ve-access-card"><div className="ve-access-title"><Clapperboard size={28} /><h1>{t('口述电影工作台', 'Audio description studio')}</h1><p>{t('上传视频，制作属于你的口述作品。', 'Upload a video and create your audio-described version.')}</p></div>
      {loadError ? <><Alert>{loadError}</Alert><button className="ws-button secondary" disabled={busy} onClick={() => { setLoading(true); void refresh(); }}>{t('重新检查连接', 'Check connection again')}</button></> : <>
        <div className="ve-access-tabs"><button type="button" aria-pressed={formMode === 'login'} disabled={busy} onClick={() => { setFormMode('login'); setError(''); }}>{t('登录', 'Log in')}</button><button type="button" aria-pressed={formMode === 'register'} disabled={busy} onClick={() => { setFormMode('register'); setError(''); }}>{t('注册', 'Register')}</button></div>
        <AccessForm key={formMode} mode={formMode} guest={false} busy={busy} error={error} onMode={mode => { setFormMode(mode); setError(''); }} onSubmit={(username, password) => void authenticate(formMode === 'register' ? '/register' : '/login', { username, password })} />
        <div className="ve-access-trial"><button type="button" className="ws-button secondary" disabled={busy} onClick={() => void authenticate('/guest')}>{t('先试用一下', 'Try as a guest')}</button>{session && <p>{t('访客试用 · 视频最长 ', 'Guest trial · Up to ')}{session.limits.max_video_seconds}{t(' 秒 · ', ' seconds · ')}{uploadLimitLabel(session.limits.max_upload_mb)} · {session.limits.guest_generations_remaining ?? '—'}{t(' 次 AI 处理', ' AI operations')}</p>}</div>
      </>}
    </main>
  </div>;

  return <AccessSessionContext.Provider value={{ session: session!, busy: busy || Boolean(loadError), openAccess, refresh }}>
    <div hidden={Boolean(loadError)} inert={Boolean(loadError)}><Fragment key={workspaceKey}>{children}</Fragment></div>
    {loadError && <div className="ws-app ve-atelier ve-access-shell"><main className="ve-access-card"><h1>{t('工作区连接暂时中断', 'Workspace connection interrupted')}</h1><p className="ve-access-note">{t('当前草稿已保留。重新验证会话后继续编辑。', 'Your current drafts are retained. Verify the session again to continue editing.')}</p><Alert>{loadError}</Alert><button className="ws-button secondary" disabled={busy} onClick={() => void refresh()}>{t('重新检查连接', 'Check connection again')}</button></main></div>}
    {dialog && !loadError && <div className="ws-app ve-atelier ve-access-modal"><Modal title={dialog === 'logout' ? t('退出工作区', 'Log out of workspace') : dialog === 'register' ? t('注册保存作品', 'Register to keep videos') : t('登录账号', 'Log in to an account')} busy={busy} onClose={() => setDialog(null)}>
      {dialog === 'logout' ? <><p className="ve-access-note">{session?.user?.kind === 'guest' ? t('退出后将无法继续访问此访客工作区。注册可保存当前作品。', 'You will lose access to this guest workspace after logout. Register to keep these videos.') : t('退出后，需要重新登录才能访问作品。', 'Log in again to access your videos after logout.')}</p>{error && <Alert>{error}</Alert>}<div className="ws-modal-actions"><button className="ws-button secondary" disabled={busy} onClick={() => setDialog(null)}>{t('取消', 'Cancel')}</button><button className="ws-button primary" disabled={busy} onClick={() => void authenticate('/logout')}>{t('确认退出', 'Log out')}</button></div></> : <AccessForm key={dialog} mode={dialog} guest={session?.user?.kind === 'guest'} busy={busy} error={error} onMode={setDialog} onSubmit={(username, password) => void authenticate(dialog === 'register' ? '/register' : '/login', { username, password })} />}
    </Modal></div>}
  </AccessSessionContext.Provider>;
}
