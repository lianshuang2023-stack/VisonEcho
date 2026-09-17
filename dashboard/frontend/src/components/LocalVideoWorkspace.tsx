import { dateTime, duration, errorMessage } from './workspace/workspaceUtils';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Archive, ArrowLeft, Check, ChevronDown, CircleAlert, Clapperboard, FileVideo, Folder, FolderInput, Languages, LoaderCircle, Moon, MoreHorizontal, Pencil, Play, Plus, RefreshCw, RotateCcw, Search, Settings, SlidersHorizontal, Sun, Trash2, Upload, Volume2, X } from 'lucide-react';
import { fetchBackendHealth, uploadVideo } from '../api';
import { createCollection, deleteCollection, deleteVideo, listCollections, listHistoryVideos, listProjects, listTrash, patchProject, renameCollection, restoreCollection, restoreVideo } from '../localWorkspaceApi';
import type { ProjectCollection, ProjectTrash, VideoProject, WorkflowStatus } from '../localWorkspaceApi';
import type { BackendHealth } from '../types';
import { Alert, Loading, Modal } from './workspace/WorkspaceShared';
import ProjectStudio from './workspace/ProjectStudio';
import type { StudioIntent } from './workspace/ProjectStudio';
import ComparisonPreview from './workspace/ComparisonPreview';
import '../workspace.css';
import '../ui-theme.css';
import { useUiPreferences } from '../uiPreferences';
import type { Translate } from '../uiPreferences';
import { uploadLimitLabel, useAccessSession } from '../accessSession';
import AccessControls from './AccessControls';

type NameDialog = { kind: 'create' } | { kind: 'collection'; item: ProjectCollection } | { kind: 'video'; item: VideoProject };
type DeleteTarget = { kind: 'collection'; item: ProjectCollection } | { kind: 'video'; item: VideoProject };
type ArchiveFilter = 'active' | 'archived' | 'all';
type MenuItem = { label: string; icon: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean };
function makeWorkflowInfo(t: Translate): Record<WorkflowStatus, { label: string; action: string }> { return {
  draft: { label: t("待生成", "Not started"), action: t("开始生成", "Generate") },
  processing: { label: t("生成中", "Generating"), action: t("查看进度", "View progress") },
  review: { label: t("待校对", "Needs review"), action: t("继续编辑", "Continue editing") },
  exportable: { label: t("可导出", "Ready to export"), action: t("查看结果", "View result") },
  failed: { label: t("生成失败", "Generation failed"), action: t("查看原因", "View error") },
}; }
function workflowStatus(video: VideoProject): WorkflowStatus {
  return video.workflow_status ?? (video.status === 'ready' ? video.reviewed ? 'exportable' : 'review' : video.status);
}
function ActionMenu({ label, children, items, className = '' }: { label: string; children: ReactNode; items: MenuItem[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')?.focus();
    const close = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  return <div ref={ref} className={'ws-menu ' + className} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }} onKeyDown={event => {
    if (!open) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? []);
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }}>
    <button ref={trigger} type="button" className="ws-menu-trigger" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)} onKeyDown={event => { if (!open && event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); } }}>{children}</button>
    {open && <div className="ws-menu-popover" role="menu" aria-label={label}>{items.map(item => <button key={item.label} type="button" role="menuitem" disabled={item.disabled} className={item.danger ? 'ws-menu-danger' : ''} onClick={() => { setOpen(false); trigger.current?.focus(); item.onSelect(); }}>{item.icon}{item.label}</button>)}</div>}
  </div>;
}

function VideoCard({ video, projectName, onOpen, onCompare, onRename, onMove, onArchive, onDelete }: { video: VideoProject; projectName: string; onOpen: () => void; onCompare: () => void; onRename: () => void; onMove: () => void; onArchive: () => void; onDelete: () => void }) {
  const { t, language: uiLanguage } = useUiPreferences();
  const workflowInfo = makeWorkflowInfo(t);
  const [imageFailed, setImageFailed] = useState(false);
  const status = workflowStatus(video);
  const info = workflowInfo[status] || workflowInfo.draft;
  return <article className="ws-work-card">
    <button className="ws-work-open" onClick={onOpen} aria-label={info.action + '：' + video.title}>
      <span className="ws-work-cover">{video.thumbnail_url && !imageFailed ? <img src={video.thumbnail_url} alt="" loading="lazy" onError={() => setImageFailed(true)} /> : <span className="ws-cover-fallback"><Clapperboard size={36} strokeWidth={1.2} /></span>}<span className="ws-duration">{duration(video.duration)}</span></span>
      <span className="ws-work-body"><strong className="ws-work-title" title={video.title}>{video.title}</strong><span className="ws-work-project"><Folder size={13} />{projectName}<span className="ve-meta-divider">·</span><span>{video.execution_count} {t("个版本", "versions")}</span></span>
        <span className="ws-work-status-line"><span className={'ws-work-status ' + status}>{status === 'processing' && <LoaderCircle size={12} className="ws-spin" />}{status === 'failed' && <CircleAlert size={12} />}{info.label}</span>{video.archived && <span className="ws-work-archived"><Archive size={12} />{t("已归档", "Archived")}</span>}</span>
        {video.narration_available === false && <span className="ws-work-error">{t("仅生成字幕，请重新生成口述版", "Subtitles only. Generate an audio-described version.")}</span>}
        {status === 'failed' && <span className="ws-work-error" title={video.last_error || undefined}>{video.last_error || t("生成未完成，打开作品查看详情并重试。", "Generation did not finish. Open this video for details and retry.")}</span>}
        <span className="ws-work-footer"><span>{dateTime(video.updated_at || video.last_modified, uiLanguage)}</span><span className="ws-work-next">{info.action}<Play size={12} /></span></span>
      </span>
    </button>
    {video.latest_result_id && <button className="ve-compare-trigger" onClick={onCompare} aria-label={t("对比预览：", "Compare: ") + video.title}><Volume2 size={15} /><span>{t("原声 / 口述", "Original / Described")}</span><span>{t("对比预览", "Compare")}</span></button>}
    <ActionMenu label={t("管理视频：", "Manage video: ") + video.title} className="ws-work-menu" items={[
      { label: t("重命名", "Rename"), icon: <Pencil size={14} />, onSelect: onRename },
      { label: t("移动到项目", "Move to project"), icon: <FolderInput size={14} />, onSelect: onMove },
      { label: video.archived ? t("恢复到我的作品", "Restore to My videos") : t("归档", "Archive"), icon: <Archive size={14} />, onSelect: onArchive },
      { label: t("删除视频", "Delete video"), icon: <Trash2 size={14} />, onSelect: onDelete, danger: true },
    ]}><MoreHorizontal size={20} /></ActionMenu>
  </article>;
}

export default function LocalVideoWorkspace() {
  const { session: access } = useAccessSession();
  const { t, language: uiLanguage, theme, setLanguage, setTheme } = useUiPreferences();
  const workflowInfo = useMemo(() => makeWorkflowInfo(t), [t]);
  const collectionName = useCallback(function(item?: { id?: string; title?: string }, fallback = t("未分类", "Uncategorized")) {
  return item?.id === 'default' ? t("未分类", "Uncategorized") : item?.title || fallback;
}, [t]);
  const [view, setView] = useState<'works' | 'trash'>('works');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [initialIntent, setInitialIntent] = useState<StudioIntent | undefined>();
  const [comparisonVideo, setComparisonVideo] = useState<VideoProject | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [collections, setCollections] = useState<ProjectCollection[]>([]);
  const [videos, setVideos] = useState<VideoProject[]>([]);
  const [trash, setTrash] = useState<ProjectTrash>({ collections: [], videos: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [collectionId, setCollectionId] = useState('all');
  const [filter, setFilter] = useState('all');
  const [archiveFilter, setArchiveFilter] = useState<ArchiveFilter>('active');
  const [sort, setSort] = useState('recent');
  const [health, setHealth] = useState<BackendHealth | null>(null);
  const [healthError, setHealthError] = useState('');
  const [healthLoading, setHealthLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showProjects, setShowProjects] = useState(false);
  const [showUpload, setShowUpload] = useState(false);
  const [uploadCollection, setUploadCollection] = useState('default');
  const [uploadCollectionTitle, setUploadCollectionTitle] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [nameDialog, setNameDialog] = useState<NameDialog | null>(null);
  const [title, setTitle] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState('');
  const [moveTarget, setMoveTarget] = useState<VideoProject | null>(null);
  const [moveCollection, setMoveCollection] = useState('');
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [restoring, setRestoring] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);
  const ready = Boolean(health?.configured && health.speech_region_configured && !healthError);
  const isTrash = view === 'trash';
  const activeCollections = useMemo(() => collections.filter(item => !item.deleted), [collections]);
  const totalWorks = activeCollections.reduce((sum, item) => sum + item.video_count, 0);
  const projectName = useCallback((video: VideoProject) => collectionName(activeCollections.find(item => item.id === (video.collection_id || 'default')) ?? { id: video.collection_id || 'default', title: video.collection_title }), [activeCollections, collectionName]);

  const load = useCallback(async (quiet = false) => {
    const current = ++requestId.current;
    if (!quiet) setLoading(true);
    try {
      const [nextCollections, nextVideos, nextTrash] = await Promise.all([
        listCollections(),
        view === 'works' ? archiveFilter === 'all' ? listHistoryVideos() : listProjects(archiveFilter === 'archived') : Promise.resolve([]),
        view === 'trash' ? listTrash() : Promise.resolve({ collections: [], videos: [] }),
      ]);
      if (current === requestId.current) { setCollections(nextCollections); setVideos(nextVideos); setTrash(nextTrash); setError(''); }
    } catch (reason) { if (current === requestId.current) setError(errorMessage(reason)); }
    finally { if (current === requestId.current) setLoading(false); }
  }, [archiveFilter, view]);
  const latestLoad = useRef(load);
  useEffect(() => { latestLoad.current = load; }, [load]);
  const checkHealth = useCallback(async () => {
    setHealthLoading(true); setHealthError('');
    try { setHealth(await fetchBackendHealth()); } catch (reason) { setHealth(null); setHealthError(errorMessage(reason)); }
    finally { setHealthLoading(false); }
  }, []);
  useEffect(() => { const requests = requestId; void load(); return () => { requests.current++; }; }, [load]);
  useEffect(() => { void checkHealth(); }, [checkHealth]);
  const hasProcessing = videos.some(video => workflowStatus(video) === 'processing');
  useEffect(() => {
    if (selectedId || isTrash || !hasProcessing) return;
    const timer = window.setInterval(() => { if (!document.hidden) void load(true); }, 4000);
    return () => window.clearInterval(timer);
  }, [selectedId, isTrash, hasProcessing, load]);
  useEffect(() => {
    if (selectedId) return;
    const onFocus = () => void load(true);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [selectedId, load]);

  const visibleVideos = useMemo(() => videos.filter(video => !video.deleted
    && (archiveFilter === 'all' || Boolean(video.archived) === (archiveFilter === 'archived'))
    && (collectionId === 'all' || (video.collection_id || 'default') === collectionId)
    && (filter === 'all' || workflowStatus(video) === filter)
    && (video.title + ' ' + video.filename + ' ' + projectName(video)).toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => sort === 'name' ? a.title.localeCompare(b.title, 'zh-CN') : Date.parse(b.updated_at || b.last_modified) - Date.parse(a.updated_at || a.last_modified)), [videos, archiveFilter, collectionId, filter, search, projectName, sort]);
  const visibleTrash = useMemo(() => [
    ...trash.collections.map(item => ({ kind: 'collection' as const, item })),
    ...trash.videos.map(item => ({ kind: 'video' as const, item })),
  ].filter(({ item }) => item.title.toLowerCase().includes(search.trim().toLowerCase())).sort((a, b) => sort === 'name' ? a.item.title.localeCompare(b.item.title, 'zh-CN') : Date.parse(b.item.deleted_at || b.item.updated_at) - Date.parse(a.item.deleted_at || a.item.updated_at)), [trash, search, sort]);
  const hasFilters = collectionId !== 'all' || filter !== 'all' || archiveFilter !== 'active';
  const firstUseEmpty = !isTrash && !loading && !error && videos.length === 0 && !search && !hasFilters;

  function openWork(video: VideoProject, intent?: StudioIntent) {
    const intents: Record<WorkflowStatus, StudioIntent> = { draft: 'generate', processing: 'progress', review: 'review', exportable: 'result', failed: 'error' };
    setInitialIntent(intent || intents[workflowStatus(video)]);
    setSelectedId(video.video_id); setNotice('');
  }

  function resetFilters() { setSearch(''); setCollectionId('all'); setFilter('all'); setArchiveFilter('active'); setSort('recent'); }
  function goWorks(nextView: 'works' | 'trash' = 'works') { setSelectedId(null); setView(nextView); resetFilters(); setNotice(''); }
  function openName(dialog: NameDialog) { setNameDialog(dialog); setTitle(dialog.kind === 'create' ? '' : dialog.item.title); setNameError(''); }
  function openDelete(target: DeleteTarget) { setDeleteTarget(target); setDeleteError(''); }
  function openUpload() {
    setUploadCollection(collectionId !== 'all' && activeCollections.some(item => item.id === collectionId) ? collectionId : activeCollections.some(item => item.id === 'default') ? 'default' : '');
    setUploadCollectionTitle(''); setUploadError(''); setShowUpload(true);
  }
  function applyUpdatedVideo(updated: VideoProject) { requestId.current++; setLoading(false); setVideos(items => items.map(item => item.video_id === updated.video_id ? { ...item, ...updated } : item)); }

  async function upload(file: File) {
    if (uploading) return;
    setUploadError('');
    if (!file.name.toLowerCase().endsWith('.mp4')) { setUploadError(t("请选择 MP4 格式的视频。", "Choose an MP4 video.")); return; }
    if (!uploadCollection || (uploadCollection === '__new' && !uploadCollectionTitle.trim())) { setUploadError(uploadCollection === '__new' ? t("请输入项目名称。", "Enter a project name.") : t("请选择所属项目或新建项目。", "Select a project or create one.")); return; }
    if (health?.max_upload_mb && file.size > health.max_upload_mb * 1024 * 1024) { setUploadError(t("视频超过 ", "Video exceeds the ") + health.max_upload_mb + t(" MB 上传限制。", "MB upload limit.")); return; }
    setUploading(true); setUploadProgress(0);
    try {
      let targetCollection = uploadCollection;
      if (targetCollection === '__new') {
        const created = await createCollection(uploadCollectionTitle.trim());
        targetCollection = created.id; setCollections(items => [...items, created]); setUploadCollection(created.id);
      }
      const result = await uploadVideo(file, setUploadProgress, targetCollection);
      setShowUpload(false); setNotice(''); setInitialIntent('generate'); setSelectedId(result.key.slice('input/'.length, -'.mp4'.length)); await latestLoad.current(true);
    } catch (reason) { setUploadError(errorMessage(reason)); }
    finally { setUploading(false); if (inputRef.current) inputRef.current.value = ''; }
  }
  async function archiveVideo(video: VideoProject) {
    setError('');
    try {
      const updated = await patchProject(video.video_id, { archived: !video.archived });
      applyUpdatedVideo({ ...video, ...updated, archived: !video.archived });
      setNotice(video.archived ? t("已恢复到我的作品。", "Restored to My videos.") : t("作品已归档。", "Video archived.")); await latestLoad.current(true);
    } catch (reason) { setError(errorMessage(reason)); }
  }
  async function saveTitle() {
    if (!nameDialog || !title.trim()) return;
    setSavingName(true); setNameError('');
    try {
      if (nameDialog.kind === 'create') {
        const created = await createCollection(title.trim());
        requestId.current++; setLoading(false); setCollections(items => [...items, created]);
      } else if (nameDialog.kind === 'collection') {
        const updated = await renameCollection(nameDialog.item.id, title.trim());
        requestId.current++; setLoading(false); setCollections(items => items.map(item => item.id === nameDialog.item.id ? { ...item, ...updated, title: title.trim() } : item));
      } else {
        const updated = await patchProject(nameDialog.item.video_id, { title: title.trim() });
        applyUpdatedVideo({ ...nameDialog.item, ...updated, title: title.trim() });
      }
      setNameDialog(null); await latestLoad.current(true);
    } catch (reason) { setNameError(errorMessage(reason)); }
    finally { setSavingName(false); }
  }
  async function moveVideo() {
    if (!moveTarget || !moveCollection) return;
    setMoving(true); setMoveError('');
    try {
      const updated = await patchProject(moveTarget.video_id, { collection_id: moveCollection });
      applyUpdatedVideo({ ...moveTarget, ...updated, collection_id: moveCollection });
      setMoveTarget(null); setNotice(t("已移动到所选项目。", "Moved to the selected project.")); await latestLoad.current(true);
    } catch (reason) { setMoveError(errorMessage(reason)); }
    finally { setMoving(false); }
  }
  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true); setDeleteError('');
    try {
      if (deleteTarget.kind === 'collection') {
        await deleteCollection(deleteTarget.item.id);
        requestId.current++; setLoading(false);
        setCollections(items => items.filter(item => item.id !== deleteTarget.item.id));
        setVideos(items => items.filter(item => (item.collection_id || 'default') !== deleteTarget.item.id));
        if (collectionId === deleteTarget.item.id) setCollectionId('all');
      } else {
        await deleteVideo(deleteTarget.item.video_id);
        requestId.current++; setLoading(false); setVideos(items => items.filter(item => item.video_id !== deleteTarget.item.video_id));
      }
      setNotice((deleteTarget.kind === 'collection' ? t("项目", "Project") : t("作品", "Video")) + t("已移到回收站。", " moved to Trash.")); setDeleteTarget(null); await latestLoad.current(true);
    } catch (reason) { setDeleteError(errorMessage(reason)); }
    finally { setDeleting(false); }
  }
  async function restore(target: DeleteTarget) {
    setRestoring(target.kind + ':' + (target.kind === 'collection' ? target.item.id : target.item.video_id)); setError('');
    try {
      if (target.kind === 'collection') await restoreCollection(target.item.id); else await restoreVideo(target.item.video_id);
      requestId.current++; setLoading(false);
      setTrash(items => target.kind === 'collection' ? { ...items, collections: items.collections.filter(item => item.id !== target.item.id) } : { ...items, videos: items.videos.filter(item => item.video_id !== target.item.video_id) });
      setNotice((target.kind === 'collection' ? t("项目", "Project") : t("作品", "Video")) + t("已恢复。", " restored.")); await latestLoad.current(true);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setRestoring(null); }
  }

  return <div className="ws-app ws-workbench ve-atelier">
    <a className="ve-skip-link" href="#visionecho-content">{t("跳到作品内容", "Skip to videos")}</a>
    <header className="ws-workbench-header"><a href="#" className="ws-brand" onClick={event => { event.preventDefault(); if (!selectedId) goWorks(); }} aria-label="VisionEcho"><span className="ws-brand-mark"><Clapperboard size={23} /></span><span>Vision<span className="ws-brand-light">Echo</span></span></a>
      <div className="ve-header-controls">
      <button className="ve-preference-button" aria-label={t('切换页面为英文', 'Switch interface to Chinese')} title={t('页面语言，不影响视频配音', 'Interface language only; narration is unchanged')} onClick={() => setLanguage(uiLanguage === 'en' ? 'zh-CN' : 'en')}><Languages size={17} /><span>{uiLanguage === 'en' ? '中文' : 'EN'}</span></button>
      <button className="ve-preference-button ve-theme-toggle" aria-label={theme === 'light' ? t('切换到暗色', 'Switch to dark theme') : t('切换到亮色', 'Switch to light theme')} title={theme === 'light' ? t('暗色模式', 'Dark mode') : t('亮色模式', 'Light mode')} onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}</button>
      <ActionMenu label={t("工作区菜单", "Workspace menu")} className="ws-workspace-menu" items={[
        { label: t("项目管理", "Manage projects"), icon: <Folder size={15} />, onSelect: () => setShowProjects(true), disabled: Boolean(selectedId) },
        { label: t("设置", "Settings"), icon: <Settings size={15} />, onSelect: () => setShowSettings(true) },
        { label: t("回收站", "Trash"), icon: <Trash2 size={15} />, onSelect: () => goWorks('trash'), disabled: Boolean(selectedId) },
      ]}>{t("工作区", "Workspace")}<ChevronDown size={15} /></ActionMenu><AccessControls disabled={Boolean(selectedId || showUpload || showProjects || showSettings || nameDialog || moveTarget || deleteTarget || comparisonVideo || restoring)} /></div>
    </header>
    {access.user?.kind === 'guest' && <div className="ve-guest-notice"><span>{t("访客试用", "Guest trial")} · {access.limits.max_video_seconds}{t(" 秒", " seconds")} · {uploadLimitLabel(access.limits.max_upload_mb)}</span><span>{t("AI 处理剩余 ", "AI operations remaining: ")}{access.limits.guest_generations_remaining ?? '—'}{t(" 次；注册可保存试用作品。", ". Register to keep trial videos.")}</span></div>}
    {selectedId ? <ProjectStudio key={selectedId} initialIntent={initialIntent} backLabel={t("返回作品", "Back to videos")} projectId={selectedId} processingReady={ready} speechReady={Boolean(health?.speech_region_configured && !healthError)} speechLanguages={health?.languages} onBack={() => { setSelectedId(null); setNotice(''); void load(true); }} onSetup={() => setShowSettings(true)} /> : <main className="ws-works-main" id="visionecho-content">
      {isTrash && <button className="ws-back" onClick={() => goWorks()}><ArrowLeft size={15} />{t("返回作品", "Back to videos")}</button>}
      <div className="ws-works-heading"><h1>{isTrash ? t("回收站", "Trash") : t("我的作品", "My videos")}{isTrash && <span>{trash.collections.length + trash.videos.length}</span>}</h1>{!isTrash && !firstUseEmpty && <button className="ws-button primary" onClick={openUpload}><Upload size={17} />{t("上传视频", "Upload video")}</button>}</div>
      {!isTrash && !loading && !error && <div className="ve-library-scope"><span>{archiveFilter === 'active' ? t("未归档作品", "Active videos") : archiveFilter === 'archived' ? t("归档作品", "Archived videos") : t("全部作品", "All videos")} {t("· 当前显示", "· Showing ")}{visibleVideos.length} {t("个 / 共", " of ")}{totalWorks} {t("个", " total")}</span>{archiveFilter === 'active' && totalWorks > videos.filter(video => !video.deleted && !video.archived).length && <button onClick={() => { setArchiveFilter('all'); setShowFilters(true); }}>{t("查看全部作品", "View all videos")}</button>}</div>}
      {notice && <div className="ws-notice" role="status"><Check size={16} />{notice}<button onClick={() => setNotice('')} aria-label={t("关闭提示", "Dismiss notification")}>×</button></div>}
      {!isTrash && !healthLoading && !ready && <div className="ws-setup-notice" role="alert"><CircleAlert size={17} /><span>{healthError ? t("服务连接失败，暂时无法生成。", "Cannot connect to the service. Generation is unavailable.") : t("完成服务配置后即可生成口述解说。", "Configure the services to generate audio descriptions.")}</span><button className="ws-text-button" onClick={() => setShowSettings(true)}>{t("前往配置", "Open settings")}</button></div>}
      <div className="ws-works-toolbar">
        <label className="ws-search"><Search size={17} /><input aria-label={isTrash ? t("搜索回收站", "Search Trash") : t("搜索视频或项目", "Search videos or projects")} placeholder={isTrash ? t("搜索回收站", "Search Trash") : t("搜索视频或项目", "Search videos or projects")} value={search} onChange={event => setSearch(event.target.value)} /></label>
        {!isTrash && <><label className="ws-toolbar-select"><span className="ws-sr-only">{t("项目筛选", "Filter by project")}</span><select value={collectionId} onChange={event => setCollectionId(event.target.value)}><option value="all">{t("全部项目", "All projects")}</option>{activeCollections.map(item => <option key={item.id} value={item.id}>{collectionName(item)}</option>)}</select></label>
          <label className="ws-toolbar-select"><span className="ws-sr-only">{t("制作状态", "Production status")}</span><select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">{t("全部状态", "All statuses")}</option>{Object.entries(workflowInfo).map(([value, info]) => <option key={value} value={value}>{info.label}</option>)}</select></label>
          <button className={'ws-button secondary ve-filter-toggle' + (showFilters || archiveFilter !== 'active' || sort !== 'recent' ? ' active' : '')} aria-label={t("筛选与排序", "Filters and sorting")} aria-expanded={showFilters} aria-controls="works-extra-filters" onClick={() => setShowFilters(value => !value)}><SlidersHorizontal size={16} />{t("筛选", "Filters")}{(archiveFilter !== 'active' || sort !== 'recent') && <span className="ve-filter-count">{Number(archiveFilter !== 'active') + Number(sort !== 'recent')}</span>}</button></>}
      </div>
      {showFilters && !isTrash && <div className="ve-extra-filters" id="works-extra-filters"><label className="ws-toolbar-select"><span>{t("归档", "Archive")}</span><select aria-label={t("归档筛选", "Archive filter")} value={archiveFilter} onChange={event => setArchiveFilter(event.target.value as ArchiveFilter)}><option value="active">{t("未归档", "Active")}</option><option value="archived">{t("已归档", "Archived")}</option><option value="all">{t("包含归档", "Include archived")}</option></select></label><label className="ws-toolbar-select"><span>{t("排序", "Sort")}</span><select aria-label={t("排序", "Sort")} value={sort} onChange={event => setSort(event.target.value)}><option value="recent">{t("最近编辑", "Recently edited")}</option><option value="name">{t("名称排序", "Name")}</option></select></label><button className="ws-text-button" onClick={resetFilters}>{t("重置筛选", "Reset filters")}</button></div>}
      {!isTrash && (search || hasFilters) && <div className="ve-results-summary" role="status"><span>{t("找到", "Found ")}{visibleVideos.length} {t("个作品", " videos")}</span><button onClick={resetFilters}><X size={12} />{t("清除条件", "Clear filters")}</button></div>}
      {error && <Alert>{error} <button className="ws-text-button" onClick={() => void load()}>{t("重试", "Retry")}</button></Alert>}
      {loading ? <div className="ve-skeleton-grid" role="status" aria-label={t("正在加载作品", "Loading videos")}>{[1,2,3].map(item => <div className="ve-skeleton-card" key={item}><div /><span /><span /></div>)}</div> : isTrash ? (visibleTrash.length ? <div className="ws-trash-list">{visibleTrash.map(target => {
        const itemKey = target.kind + ':' + (target.kind === 'collection' ? target.item.id : target.item.video_id);
        const parentDeleted = target.kind === 'video' && trash.collections.some(item => item.id === target.item.collection_id);
        return <article className="ws-trash-row" key={itemKey}><span className="ws-trash-icon">{target.kind === 'collection' ? <Folder size={23} strokeWidth={1.4} /> : <FileVideo size={23} strokeWidth={1.4} />}</span><div className="ws-trash-info"><h2>{target.item.title}</h2><p>{target.kind === 'collection' ? t("项目 · ", "Project · ") + target.item.video_count + t(" 个视频", "videos") : t("视频 · ", "Video · ") + projectName(target.item)}<span>{t("删除于", "Deleted ")}{dateTime(target.item.deleted_at || target.item.updated_at, uiLanguage)}</span></p></div><button className="ws-button secondary" disabled={Boolean(restoring) || parentDeleted} onClick={() => void restore(target)} aria-label={t("恢复", "Restore ") + (target.kind === 'collection' ? t("项目：", "project: ") : t("视频：", "video: ")) + target.item.title}>{restoring === itemKey ? <LoaderCircle size={15} className="ws-spin" /> : <RotateCcw size={15} />}{parentDeleted ? t("先恢复项目", "Restore project first") : t("恢复", "Restore ")}</button></article>;
      })}</div> : !error && <div className="ws-empty"><span><Trash2 size={34} strokeWidth={1.2} /></span><h2>{search ? t("没有找到匹配的项目或视频", "No matching projects or videos") : t("回收站为空", "Trash is empty")}</h2>{search && <button className="ws-button secondary" onClick={() => setSearch('')}>{t("清除搜索", "Clear search")}</button>}</div>) : visibleVideos.length ? <div className={"ws-works-grid " + (visibleVideos.length <= 2 ? "ve-grid-short" : "")}>{visibleVideos.map(video => <VideoCard key={video.video_id} video={video} projectName={projectName(video)} onOpen={() => openWork(video)} onCompare={() => setComparisonVideo(video)} onRename={() => openName({ kind: 'video', item: video })} onMove={() => { setMoveTarget(video); setMoveCollection(video.collection_id || 'default'); setMoveError(''); }} onArchive={() => void archiveVideo(video)} onDelete={() => openDelete({ kind: 'video', item: video })} />)}</div> : !error && <div className="ws-empty ws-works-empty"><span><FileVideo size={36} strokeWidth={1.2} /></span><h2>{search ? t("没有找到匹配的作品", "No matching videos") : hasFilters ? t("当前筛选下没有作品", "No videos match these filters") : t("上传视频，开始制作口述电影", "Upload a video to create audio description")}</h2><div className="ws-empty-actions">{search && <button className="ws-button secondary" onClick={() => setSearch('')}>{t("清除搜索", "Clear search")}</button>}{hasFilters && <button className="ws-button secondary" onClick={resetFilters}>{t("重置筛选", "Reset filters")}</button>}{!search && !hasFilters && <button className="ws-button primary" onClick={openUpload}><Upload size={17} />{t("上传视频", "Upload video")}</button>}</div></div>}
    </main>}
    {comparisonVideo && <ComparisonPreview video={comparisonVideo} onClose={() => setComparisonVideo(null)} onEdit={() => { const video = comparisonVideo; setComparisonVideo(null); openWork(video, 'review'); }} />}

    {showSettings && <Modal title={t("设置", "Settings")} onClose={() => setShowSettings(false)}><div className="ws-settings-content"><h3>{access.mode === 'hosted' ? t("个人工作区", "Personal workspace") : t("本地工作区", "Local workspace")}</h3><p>{access.mode === 'hosted' ? t("当前会话只显示你的作品与制作版本。", "This session shows only your videos and production versions.") : t("视频与制作版本保存在当前设备。", "Videos and production versions are stored on this device.")}</p><h3>{t("服务配置", "Service configuration")}</h3>{healthLoading ? <Loading text={t("正在检查服务…", "Checking services…")} /> : <><p className={'ws-settings-status ' + (ready ? 'ready' : '')}>{ready ? t("服务已配置", "Services configured") : t("服务待配置", "Setup required")}</p>{healthError && <Alert>{healthError}</Alert>}{health?.issues.length ? <Alert>{health.issues.join('；')}</Alert> : null}<dl className="ws-settings-list"><div><dt>{t("画面理解", "Visual understanding")}</dt><dd>{health?.configured ? t("已配置", "Configured") : t("未配置", "Not configured")}</dd></div><div><dt>{t("语音服务", "Speech service")}</dt><dd>{health?.speech_region_configured ? t("已配置", "Configured") : t("未配置", "Not configured")}</dd></div><div><dt>{t("模型", "Model")}</dt><dd>{health?.model || t("未配置", "Not configured")}</dd></div><div><dt>{t("上传限制", "Upload limit")}</dt><dd>{health?.max_upload_mb ?? '—'} MB{health?.max_video_seconds ? ' / ' + health.max_video_seconds / 60 + t(" 分钟", " minutes") : ''}</dd></div></dl><p className="ws-settings-help">{access.mode === 'hosted' ? t("服务由管理员维护。", "Services are maintained by the administrator.") : t("服务配置由本地后端读取，修改后重新检查。", "The local server loads service settings. Recheck after updating them.")}</p></>}<button className="ws-button secondary" onClick={() => void checkHealth()} disabled={healthLoading}><RefreshCw size={15} className={healthLoading ? 'ws-spin' : ''} />{t("重新检查", "Recheck")}</button></div></Modal>}
    {showProjects && !nameDialog && !deleteTarget && <Modal title={t("项目管理", "Manage projects")} onClose={() => setShowProjects(false)}><div className="ws-collection-manager"><div className="ws-collection-manager-head"><span>{activeCollections.length} {t("个项目", " projects")}</span><button className="ws-button secondary" onClick={() => openName({ kind: 'create' })}><Plus size={16} />{t("新建项目", "New project")}</button></div>{activeCollections.length ? activeCollections.map(item => <div className="ws-collection-row" key={item.id}><Folder size={19} /><div><strong>{collectionName(item)}</strong><span>{item.video_count} {t("个视频", "videos")}</span></div><button className="ws-text-button" onClick={() => { setCollectionId(item.id); setShowProjects(false); setView('works'); }}>{t("查看作品", "View videos")}</button><ActionMenu label={t("管理项目：", "Manage project: ") + collectionName(item)} items={[
      { label: t("重命名", "Rename"), icon: <Pencil size={14} />, onSelect: () => openName({ kind: 'collection', item }), disabled: item.id === 'default' },
      { label: t("删除项目", "Delete project"), icon: <Trash2 size={14} />, onSelect: () => openDelete({ kind: 'collection', item }), danger: true },
    ]}><MoreHorizontal size={19} /></ActionMenu></div>) : <p className="ws-manager-empty">{t("暂无项目，可先上传视频或新建项目。", "No projects yet. Upload a video or create a project.")}</p>}</div></Modal>}
    {showUpload && <Modal title={t("上传视频", "Upload video")} onClose={() => setShowUpload(false)} busy={uploading}><div className="ws-upload-project"><label className="ws-field">{t("所属项目", "Project")}<select disabled={uploading} value={uploadCollection} onChange={event => { setUploadCollection(event.target.value); setUploadError(''); }}>{!activeCollections.some(item => item.id === 'default') && <option value="" disabled>{t("选择项目", "Select a project")}</option>}{activeCollections.some(item => item.id === 'default') && <option value="default">{t("暂不分类", "Uncategorized")}</option>}{activeCollections.filter(item => item.id !== 'default').map(item => <option key={item.id} value={item.id}>{item.title}</option>)}<option value="__new">{t("新建项目…", "New project…")}</option></select></label>{uploadCollection === '__new' && <label className="ws-field">{t("项目名称", "Project name")}<input maxLength={120} disabled={uploading} placeholder={t("输入项目名称", "Enter a project name")} value={uploadCollectionTitle} onChange={event => setUploadCollectionTitle(event.target.value)} /></label>}</div><div className={'ws-dropzone ' + (dragging ? 'dragging' : '')} onDragOver={event => { event.preventDefault(); if (!uploading) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); const file = event.dataTransfer.files[0]; if (file && !uploading) void upload(file); }}><span><Upload size={27} /></span><h3>{uploading ? t("正在上传… ", "Uploading… ") + uploadProgress + '%' : t("将视频拖到这里", "Drop a video here")}</h3><p>{uploading ? t("上传后自动打开作品", "The video opens after upload") : t("或选择 MP4 文件", "or choose an MP4 file")}</p><button className="ws-button secondary" disabled={uploading} onClick={() => inputRef.current?.click()}>{uploading ? <LoaderCircle className="ws-spin" size={16} /> : <FileVideo size={16} />}{uploading ? t("上传中", "Uploading") : t("选择视频", "Choose video")}</button><input type="file" accept="video/mp4,.mp4" ref={inputRef} className="ws-sr-only" aria-label={t("选择 MP4 视频", "Choose MP4 video")} disabled={uploading} onChange={event => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (file) void upload(file); }} />{uploading && <progress max={100} value={uploadProgress} aria-label={t("视频上传进度", "Video upload progress")} />}</div><p className="ws-upload-hint">{t("MP4 · 最大", "MP4 · Up to ")}{health?.max_upload_mb ?? 500} MB{health?.max_video_seconds ? t(" · 最长 ", "· Up to ") + health.max_video_seconds / 60 + t(" 分钟", " minutes") : ''}</p>{uploadError && <Alert>{uploadError}</Alert>}</Modal>}
    {nameDialog && <Modal title={nameDialog.kind === 'create' ? t("新建项目", "New project") : nameDialog.kind === 'collection' ? t("重命名项目", "Rename project") : t("重命名视频", "Rename video")} onClose={() => setNameDialog(null)} busy={savingName}><form onSubmit={event => { event.preventDefault(); void saveTitle(); }}><label className="ws-field">{nameDialog.kind === 'video' ? t("视频名称", "Video name") : t("项目名称", "Project name")}<input autoFocus maxLength={120} placeholder={nameDialog.kind === 'create' ? t("输入项目名称", "Enter a project name") : undefined} value={title} onChange={event => setTitle(event.target.value)} /></label>{nameError && <Alert>{nameError}</Alert>}<div className="ws-modal-actions"><button type="button" className="ws-button secondary" disabled={savingName} onClick={() => setNameDialog(null)}>{t("取消", "Cancel")}</button><button className="ws-button primary" disabled={savingName || !title.trim()}>{savingName ? t("保存中…", "Saving…") : nameDialog.kind === 'create' ? t("创建项目", "Create project") : t("保存名称", "Save name")}</button></div></form></Modal>}
    {moveTarget && <Modal title={t("移动到项目", "Move to project")} onClose={() => setMoveTarget(null)} busy={moving}><form onSubmit={event => { event.preventDefault(); void moveVideo(); }}><label className="ws-field">{t("所属项目", "Project")}<select value={moveCollection} onChange={event => setMoveCollection(event.target.value)}>{activeCollections.map(item => <option key={item.id} value={item.id}>{collectionName(item)}</option>)}</select></label>{moveError && <Alert>{moveError}</Alert>}<div className="ws-modal-actions"><button type="button" className="ws-button secondary" disabled={moving} onClick={() => setMoveTarget(null)}>{t("取消", "Cancel")}</button><button className="ws-button primary" disabled={moving || !moveCollection || moveCollection === (moveTarget.collection_id || 'default')}>{moving ? t("移动中…", "Moving…") : t("移动作品", "Move video")}</button></div></form></Modal>}
    {deleteTarget && <Modal title={deleteTarget.kind === 'collection' ? t("删除项目", "Delete project") : t("删除视频", "Delete video")} onClose={() => setDeleteTarget(null)} busy={deleting}><p className="ws-confirm-copy">{deleteTarget.kind === 'collection' ? '“' + collectionName(deleteTarget.item) + t("”及其中 ", "” and its ") + deleteTarget.item.video_count + t(" 个视频将移到回收站。", " videos will be moved to Trash.") : '“' + deleteTarget.item.title + t("”将移到回收站。", "” will be moved to Trash.")}<br />{t("视频与历史版本可在回收站恢复。", "Videos and previous versions can be restored from Trash.")}</p>{deleteError && <Alert>{deleteError}</Alert>}<div className="ws-modal-actions"><button className="ws-button secondary" disabled={deleting} onClick={() => setDeleteTarget(null)}>{t("取消", "Cancel")}</button><button className="ws-button danger" disabled={deleting} onClick={() => void confirmDelete()}>{deleting ? <LoaderCircle size={15} className="ws-spin" /> : <Trash2 size={15} />}{deleting ? t("正在删除…", "Deleting…") : t("移到回收站", "Move to Trash")}</button></div></Modal>}
  </div>;
}
