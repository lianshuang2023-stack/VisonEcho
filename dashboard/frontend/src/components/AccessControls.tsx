import { LogIn, LogOut, UserRound } from 'lucide-react';
import { useAccessSession } from '../accessSession';
import { useUiPreferences } from '../uiPreferences';

export default function AccessControls({ disabled = false }: { disabled?: boolean }) {
  const { session, busy, openAccess } = useAccessSession();
  const { t } = useUiPreferences();
  if (session.mode !== 'hosted' || !session.user) return null;
  const blocked = disabled || busy;
  return <div className={'ve-access-controls' + (session.user.kind === 'guest' ? ' is-guest' : '')} title={disabled ? t('返回作品列表后切换账号', 'Return to the video list to switch accounts') : undefined}>
    <span><UserRound size={14} />{session.user.kind === 'guest' ? t('访客试用', 'Guest trial') : session.user.username}</span>
    {session.user.kind === 'guest' ? <><button type="button" disabled={blocked} onClick={() => openAccess('register')}>{t('注册保存作品', 'Register to keep videos')}</button><button type="button" disabled={blocked} onClick={() => openAccess('login')}><LogIn size={13} />{t('登录', 'Log in')}</button></> : null}
    {session.user.kind === 'account' && <button type="button" disabled={blocked} onClick={() => openAccess('logout')}><LogOut size={13} />{t('退出', 'Log out')}</button>}
  </div>;
}
