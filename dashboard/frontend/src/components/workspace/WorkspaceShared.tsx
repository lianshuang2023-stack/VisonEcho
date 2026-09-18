import { useUiPreferences } from '../../uiPreferences';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { X, LoaderCircle, CircleCheck, CircleAlert, Clock3 } from 'lucide-react';
import type { VideoProject } from '../../localWorkspaceApi';

export function StatusBadge({ project }: { project: Pick<VideoProject, 'status' | 'archived'> }) {
  const { t } = useUiPreferences();
  const status = project.archived ? 'archived' : project.status;
  const info = { draft: [t("待生成", "Ready to generate"), Clock3], processing: [t("处理中", "Processing"), LoaderCircle], ready: [t("已完成", "Completed"), CircleCheck], failed: [t("处理失败", "Processing failed"), CircleAlert], archived: [t("已归档", "Archived"), Clock3] } as const;
  const [label, Icon] = info[status] ?? info.draft;
  return <span className={'ws-status ' + status}><Icon size={12} className={status === 'processing' ? 'ws-spin' : ''} />{label}</span>;
}
export function Loading({ text }: { text?: string }) {
  const { t } = useUiPreferences();
  return <div className="ws-loading" role="status"><LoaderCircle className="ws-spin" size={22} /><span>{text ?? t("正在加载…", "Loading…")}</span></div>;
}
export function Alert({ children, success = false }: { children: ReactNode; success?: boolean }) {
  return <div className={'ws-alert ' + (success ? 'success' : '')} role={success ? 'status' : 'alert'}>{success ? <CircleCheck size={17} /> : <CircleAlert size={17} />}<div>{children}</div></div>;
}
export function Modal({ title, children, onClose, busy = false }: { title: string; children: ReactNode; onClose: () => void; busy?: boolean }) {
  const { t } = useUiPreferences();
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);
  useEffect(() => { closeRef.current = onClose; busyRef.current = busy; });
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), textarea:not([disabled])') ?? ref.current?.querySelector<HTMLElement>('button:not([disabled])');
    first?.focus();
    const keydown = (event: KeyboardEvent) => {
      // A retained resource drawer can contain an unfinished card editor. Its
      // hidden modal must not keep trapping keys in the main workspace.
      if (!ref.current || ref.current.closest('[hidden], [inert]')) return;
      if (event.key === 'Escape' && !busyRef.current) closeRef.current();
      if (event.key !== 'Tab') return;
      const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]') ?? []);
      if (!nodes.length) return;
      if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0]?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, []);
  return <div className="ws-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div ref={ref} className="ws-modal" role="dialog" aria-modal="true" aria-label={title}>
      <div className="ws-modal-head"><h2>{title}</h2><button className="ws-icon-button" aria-label={t("关闭弹窗", "Close dialog")} disabled={busy} onClick={onClose}><X size={20} /></button></div>
      {children}
    </div>
  </div>;
}
