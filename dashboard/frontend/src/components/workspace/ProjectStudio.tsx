import { useUiPreferences } from '../../uiPreferences';
import { dateTime, duration, errorMessage } from './workspaceUtils';
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronDown, CircleCheck, Clapperboard, Clock3, Download, FileText, History, Languages, LoaderCircle, MessageSquareText, Pencil, Play, RefreshCw, Save, Subtitles, Volume2 } from 'lucide-react';
import { fetchExecutionStatus, fetchInputVideoUrl } from '../../api';
import { calibrateTranscript, exportUrl, generateNarration, getNarration, getProject, getTranscript, getTranscriptCalibration, outputUrl, patchProject, renderNarration, saveTranscript } from '../../localWorkspaceApi';
import type { NarrationEditor, NarrationSegment, ProjectDetail, Transcript, TranscriptCalibration, DialogueLanguage, VideoLanguage } from '../../localWorkspaceApi';
import type { ExecutionStatus, SpeechLanguage } from '../../types';
import { Alert, Loading, Modal } from './WorkspaceShared';
import { defaultSpeechLanguages, dialogueLanguageLabel, languageLabel, voiceLabel, voicesForLanguage } from './speechOptions';
import { sourceCues, toSourceTime } from './timeline';

const emptyTranscript: Transcript = { cues: [], revision: 0 };
export type StudioIntent = 'generate' | 'review' | 'progress' | 'error' | 'result';
type StudioNavigationIntent = StudioIntent | 'export';
const failedStatuses: ExecutionStatus['status'][] = ['FAILED', 'TIMED_OUT', 'ABORTED'];

export default function ProjectStudio({ projectId, processingReady, speechReady = processingReady, speechLanguages = defaultSpeechLanguages, initialIntent, backLabel, onBack, onSetup }: { projectId: string; processingReady: boolean; speechReady?: boolean; speechLanguages?: SpeechLanguage[]; initialIntent?: StudioIntent; backLabel?: string; onBack: () => void; onSetup: () => void }) {
  const { t, language: uiLanguage } = useUiPreferences();
  const stepLabels: Record<string, string> = {
    SilenceDetection: t("寻找解说时间", "Finding narration windows"), ValidateInput: t("检查视频", "Checking video"), TranscribeVideo: t("识别对白", "Transcribing dialogue"), ExtractSilenceSegments: t("寻找解说时间", "Finding narration windows"), DetectSilence: t("寻找解说时间", "Finding narration windows"),
    AnalyzeSilenceSegments: t("理解画面与撰稿", "Analyzing scenes and writing"), AnalyzeSegments: t("理解画面与撰稿", "Analyzing scenes and writing"), GenerateDVI: t("生成口述稿", "Writing audio description"),
    SynthesizeAudio: t("合成解说语音", "Synthesizing narration"), MixAudioTracks: t("混音与导出", "Mixing and exporting"), RecordSummary: t("保存项目版本", "Saving version"),
  };
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const announceGeneration = useEffectEvent(() => setNotice(t("新版本已生成。", "New version generated.")));
  const announceCalibration = useEffectEvent(() => setNotice(t("字幕已校准，预览与下载已更新。", "Subtitles calibrated. Preview and downloads updated.")));
  const localizeAsyncError = useEffectEvent((reason: unknown) => errorMessage(reason, uiLanguage));
  const [originalUrl, setOriginalUrl] = useState('');
  const [source, setSource] = useState<'original' | 'described'>('original');
  const [resultId, setResultId] = useState('');
  const [editor, setEditor] = useState<NarrationEditor | null>(null);
  const [segments, setSegments] = useState<NarrationSegment[]>([]);
  const [savedSegments, setSavedSegments] = useState<NarrationSegment[]>([]);
  const [transcript, setTranscript] = useState<Transcript>(emptyTranscript);
  const [savedCues, setSavedCues] = useState(emptyTranscript.cues);
  const [editorLoading, setEditorLoading] = useState(false);
  const [editorError, setEditorError] = useState('');
  const [transcriptError, setTranscriptError] = useState('');
  const [versionReload, setVersionReload] = useState(0);
  const [tab, setTab] = useState<'description' | 'dialogue'>('description');
  const [language, setLanguage] = useState<VideoLanguage>('en-US');
  const [dialogueLanguage, setDialogueLanguage] = useState<DialogueLanguage>('auto');
  const [voice, setVoice] = useState('en-US-JennyNeural');
  const [narrationMode, setNarrationMode] = useState<'auto' | 'standard' | 'extended'>('auto');
  const [renderVoice, setRenderVoice] = useState('');
  const [currentTime, setCurrentTime] = useState(0);
  const [showSubtitles, setShowSubtitles] = useState(true);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [confirmation, setConfirmation] = useState<'generate' | 'render' | 'calibrate' | null>(null);
  const [discardAction, setDiscardAction] = useState<(() => void) | null>(null);
  const [execution, setExecution] = useState<ExecutionStatus | null>(null);
  const [executionError, setExecutionError] = useState('');
  const [calibration, setCalibration] = useState<TranscriptCalibration | null>(null);
  const [calibrationError, setCalibrationError] = useState('');
  const [calibrationTimedOut, setCalibrationTimedOut] = useState(false);
  const [calibrationPollKey, setCalibrationPollKey] = useState(0);
  const [renameOpen, setRenameOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [renameError, setRenameError] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [mediaError, setMediaError] = useState(false);
  const [requestedNavigation, setRequestedNavigation] = useState<{ intent: StudioNavigationIntent; request: number } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const settingsRef = useRef<HTMLElement>(null);
  const generationLanguageRef = useRef<HTMLSelectElement>(null);
  const editorPanelRef = useRef<HTMLElement>(null);
  const firstNarrationRef = useRef<HTMLTextAreaElement>(null);
  const progressRef = useRef<HTMLElement>(null);
  const playerPanelRef = useRef<HTMLElement>(null);
  const exportRef = useRef<HTMLDetailsElement>(null);
  const appliedNavigation = useRef('');
  const initialized = useRef(false);
  const latestRequest = useRef(0);
  const selectionInitialized = useRef(false);
  const dialogueSelectionInitialized = useRef(false);
  const calibrationStartedAt = useRef(0);
  const voices = voicesForLanguage(speechLanguages, language);
  const versionLanguage = editor?.language ?? 'en-US';
  const versionVoices = voicesForLanguage(speechLanguages, versionLanguage);
  const validVoice = voices.some(option => option.id === voice);
  const validRenderVoice = versionVoices.some(option => option.id === renderVoice);
  const voiceName = voiceLabel(voices.find(option => option.id === voice) ?? { id: voice, label: voice }, uiLanguage);
  const renderVoiceName = voiceLabel(versionVoices.find(option => option.id === renderVoice) ?? { id: renderVoice, label: renderVoice }, uiLanguage);
  const voiceDirty = Boolean(editor && renderVoice !== editor.voice);
  const narrationDirty = voiceDirty || JSON.stringify(segments.map(s => s.dvi_text)) !== JSON.stringify(savedSegments.map(s => s.dvi_text));
  const subtitleDirty = JSON.stringify(transcript.cues) !== JSON.stringify(savedCues);
  const dirty = narrationDirty || subtitleDirty;
  const running = execution?.status === 'RUNNING';
  const executionFailed = Boolean(execution && failedStatuses.includes(execution.status));
  const calibrating = calibration?.status === 'RUNNING';
  const busy = running || calibrating;
  const displayedCues = useMemo(() => source === 'original' ? sourceCues(transcript.cues, editor?.insertions) : transcript.cues, [source, transcript.cues, editor?.insertions]);
  const activeCue = useMemo(() => displayedCues.find(cue => currentTime >= cue.start && currentTime < cue.end), [displayedCues, currentTime]);
  const chosenExecution = detail?.executions.find(job => job.execution_arn === resultId);
  const activeSegment = segments.find(segment => currentTime >= segment.start_time && currentTime < segment.end_time);
  const seek = (time: number) => { if (videoRef.current) { const target = source === 'original' ? toSourceTime(time, editor?.insertions) : time; videoRef.current.currentTime = target; setCurrentTime(target); } };
  const guard = (action: () => void) => { if (dirty) setDiscardAction(() => action); else action(); };
  const navigateTo = (intent: StudioNavigationIntent) => setRequestedNavigation(previous => ({ intent, request: (previous?.request ?? 0) + 1 }));
  const changeLanguage = (next: VideoLanguage) => {
    selectionInitialized.current = true;
    setLanguage(next);
    setVoice(voicesForLanguage(speechLanguages, next)[0]?.id ?? '');
  };

  const refreshDetail = useCallback(async (selectNew = false) => {
    const data = await getProject(projectId);
    setDetail(data);
    if (!initialized.current || selectNew) {
      initialized.current = true;
      if (!dialogueSelectionInitialized.current && !data.latest_result_id && data.executions[0]?.dialogue_language) {
        setDialogueLanguage(data.executions[0].dialogue_language);
        dialogueSelectionInitialized.current = true;
      }
      if (data.latest_result_id) { setResultId(data.latest_result_id); setSource('described'); }
      const active = data.executions.find(job => job.status === 'RUNNING');
      if (active) setExecution(active);
      else if (data.executions[0] && failedStatuses.includes(data.executions[0].status)) setExecution(data.executions[0]);
    }
    return data;
  }, [projectId]);
  useEffect(() => {
    let active = true;
    Promise.allSettled([refreshDetail(), fetchInputVideoUrl(projectId)]).then(results => {
      if (!active) return;
      if (results[0].status === 'rejected') setError(localizeAsyncError(results[0].reason));
      if (results[1].status === 'fulfilled') setOriginalUrl(results[1].value);
      else setError(localizeAsyncError(results[1].reason));
      setLoading(false);
    });
    return () => { active = false; };
  }, [projectId, refreshDetail]);
  useEffect(() => {
    if (!resultId) return;
    const requests = latestRequest;
    const request = ++requests.current;
    setEditorLoading(true); setEditorError(''); setTranscriptError(''); setEditor(null);
    setSegments([]); setSavedSegments([]); setTranscript(emptyTranscript); setSavedCues([]); setRenderVoice('');
    Promise.allSettled([getNarration(resultId), getTranscript(resultId)]).then(results => {
      if (request !== latestRequest.current) return;
      if (results[0].status === 'fulfilled') {
        const data = results[0].value; setEditor(data); setSegments(data.segments); setSavedSegments(data.segments); setRenderVoice(data.voice);
        if (!selectionInitialized.current) { setLanguage(data.language); setVoice(data.voice); selectionInitialized.current = true; }
        if (!dialogueSelectionInitialized.current) { setDialogueLanguage(data.dialogue_language ?? 'auto'); dialogueSelectionInitialized.current = true; }
      }
      else setEditorError(localizeAsyncError(results[0].reason));
      if (results[1].status === 'fulfilled') { setTranscript(results[1].value); setSavedCues(results[1].value.cues); }
      else setTranscriptError(localizeAsyncError(results[1].reason));
      setEditorLoading(false);
    });
    return () => { requests.current++; };
  }, [resultId, versionReload]);
  useEffect(() => {
    if (!execution?.execution_arn || execution.status !== 'RUNNING') return;
    let active = true;
    let timer: number;
    const poll = async () => {
      try {
        const next = await fetchExecutionStatus(execution.execution_arn);
        if (!active) return;
        setExecution(next); setExecutionError('');
        if (next.status !== 'RUNNING') {
          await refreshDetail(next.status === 'SUCCEEDED');
          if (next.status === 'SUCCEEDED') { announceGeneration(); setVersionReload(value => value + 1); }
          return;
        }
      } catch (reason) { if (active) setExecutionError(localizeAsyncError(reason)); }
      if (active) timer = window.setTimeout(() => void poll(), 2500);
    };
    timer = window.setTimeout(() => void poll(), 1200);
    return () => { active = false; window.clearTimeout(timer); };
  }, [execution?.execution_arn, execution?.status, refreshDetail]);
  useEffect(() => {
    if (!calibration?.calibration_id || calibration.status !== 'RUNNING') return;
    let active = true;
    let timer: number;
    const poll = async () => {
      try {
        const next = await getTranscriptCalibration(calibration.calibration_id);
        if (!active) return;
        if (next.status === 'SUCCEEDED') {
          const data = next.result ?? await getTranscript(resultId);
          if (!active) return;
          setTranscript(data); setSavedCues(data.cues); setTranscriptError('');
          setEditor(previous => previous ? { ...previous, reviewed: false, reviewed_at: null } : previous);
          await refreshDetail();
          announceCalibration();
        }
        setCalibration(next); setCalibrationError('');
        if (next.status !== 'RUNNING') return;
      } catch (reason) { if (active) setCalibrationError(localizeAsyncError(reason)); }
      if (!active) return;
      if (Date.now() - calibrationStartedAt.current >= 15 * 60 * 1000) { setCalibrationTimedOut(true); return; }
      timer = window.setTimeout(() => void poll(), 2000);
    };
    timer = window.setTimeout(() => void poll(), 1200);
    return () => { active = false; window.clearTimeout(timer); };
  }, [calibration?.calibration_id, calibration?.status, calibrationPollKey, resultId, refreshDetail]);
  useEffect(() => {
    if (!dirty && !calibrating) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, calibrating]);

  // Card actions navigate after their target has loaded; they never start a cloud task.
  const navigationIntent = requestedNavigation?.intent ?? initialIntent;
  const navigationKey = projectId + ':' + (requestedNavigation?.request ?? 0);
  useEffect(() => {
    if (!navigationIntent || loading || !detail || appliedNavigation.current === navigationKey) return;
    let section: HTMLElement | null = null;
    let control: HTMLElement | null = null;
    if (navigationIntent === 'review' && resultId) {
      if (editorLoading || (!editor && !editorError)) return;
      if (tab !== 'description') { setTab('description'); return; }
      section = editorPanelRef.current;
      if (!firstNarrationRef.current?.disabled) control = firstNarrationRef.current;
    } else if (navigationIntent === 'result' && (resultId || originalUrl)) {
      section = playerPanelRef.current;
      control = videoRef.current;
    } else if (navigationIntent === 'export' && resultId) {
      section = exportRef.current;
      if (exportRef.current) exportRef.current.open = true;
      control = exportRef.current?.querySelector('summary') ?? null;
    } else if (navigationIntent === 'progress' || navigationIntent === 'error') {
      section = progressRef.current ?? (resultId ? playerPanelRef.current : settingsRef.current);
    } else {
      section = settingsRef.current;
      if (!generationLanguageRef.current?.disabled) control = generationLanguageRef.current;
    }
    if (!section) return;
    appliedNavigation.current = navigationKey;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    section.scrollIntoView?.({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    (control ?? section).focus({ preventScroll: true });
  }, [navigationIntent, navigationKey, loading, detail, resultId, originalUrl, editorLoading, editor, editorError, tab]);

  async function start() {
    if (!confirmation || (confirmation !== 'generate' && !resultId)) return;
    setStarting(true); setError('');
    try {
      if (confirmation === 'calibrate') {
        const result = await calibrateTranscript(resultId, dialogueLanguage, transcript.revision);
        calibrationStartedAt.current = Date.now();
        setCalibration(result); setCalibrationError(''); setCalibrationTimedOut(false);
        setConfirmation(null); setNotice(t("正在校准字幕。", "Calibrating subtitles."));
        return;
      }
      const result = confirmation === 'render' ? await renderNarration(resultId, segments, renderVoice) : await generateNarration(projectId, language, voice, narrationMode, dialogueLanguage);
      setExecution({ execution_arn: result.execution_arn, start_date: result.start_date, stop_date: null, status: 'RUNNING', steps: [], error: null, cause: null });
      setConfirmation(null); setNotice(t("任务已开始。", "Task started."));
      await refreshDetail();
    } catch (reason) { setError(errorMessage(reason, uiLanguage)); setConfirmation(null); }
    finally { setStarting(false); }
  }
  async function saveSubtitles() {
    setSaving(true); setError(''); setNotice('');
    try {
      const data = await saveTranscript(resultId, transcript); setTranscript(data); setSavedCues(data.cues); setNotice(t("字幕已保存，下载已更新。", "Subtitles saved. Downloads updated."));
      setEditor(previous => previous ? { ...previous, reviewed: false, reviewed_at: null } : previous);
      await refreshDetail();
    } catch (reason) { setError(errorMessage(reason, uiLanguage)); }
    finally { setSaving(false); }
  }
  async function rename() {
    if (!title.trim()) return;
    setRenaming(true); setRenameError('');
    try { const updated = await patchProject(projectId, { title: title.trim() }); setDetail(previous => previous ? { ...previous, project: updated } : previous); setRenameOpen(false); }
    catch (reason) { setRenameError(errorMessage(reason, uiLanguage)); }
    finally { setRenaming(false); }
  }
  const changeCue = (index: number, patch: Partial<Transcript['cues'][number]>) => setTranscript(previous => ({ ...previous, cues: previous.cues.map((cue, i) => i === index ? { ...cue, ...patch } : cue) }));
  const resultDuration = editor?.summary?.video_duration || detail?.project.duration || 0;
  const playerDuration = source === 'original' ? detail?.project.duration || 0 : resultDuration;
  const invalidCues = transcript.cues.some((cue, index) => !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.start < 0 || cue.end <= cue.start || (detail && cue.end > resultDuration + 0.01) || !cue.text.trim() || (index > 0 && cue.start < transcript.cues[index - 1].end));
  const videoUrl = source === 'described' && resultId ? outputUrl(resultId) : originalUrl;
  const processingFailure = !running && (executionFailed || detail?.project.status === 'failed');
  const failureReason = execution?.cause || execution?.error || detail?.project.last_error || (execution?.status === 'TIMED_OUT' ? t("任务已超时，请检查服务连接后重试。", "The task timed out. Check the service connection and retry.") : execution?.status === 'ABORTED' ? t("任务已中止，可以重新生成。", "The task was stopped. You can generate again.") : t("处理未完成，请检查服务配置后重试。", "Processing did not finish. Check service settings and retry."));

  if (loading) return <Loading text={t("正在打开视频…", "Opening video…")} />;
  if (!detail) return <main className="ws-studio" id="visionecho-content" tabIndex={-1}><button className="ws-button ghost" onClick={onBack}><ArrowLeft size={16} />{backLabel || t("返回视频列表", "Back to videos")}</button><Alert>{error || t("视频不存在。", "Video not found.")}</Alert><button className="ws-button secondary" onClick={() => { setLoading(true); setError(''); void refreshDetail().catch(reason => setError(errorMessage(reason, uiLanguage))).finally(() => setLoading(false)); }}>{t("重新加载", "Reload")}</button></main>;

  return <main className="ws-studio" id="visionecho-content" tabIndex={-1}>
    <button className="ws-back" disabled={calibrating} onClick={() => guard(onBack)}><ArrowLeft size={16} />{backLabel || (detail.project.archived ? t("返回归档视频", "Back to archived videos") : t("返回视频列表", "Back to videos"))}</button>
    <div className="ws-studio-heading"><div><div className="ws-studio-title"><h1>{detail.project.title}</h1><button className="ws-icon-button" aria-label={t("编辑视频名称", "Edit video name")} onClick={() => { setTitle(detail.project.title); setRenameOpen(true); setRenameError(''); }}><Pencil size={16} /></button><span className={'ws-workflow-badge ' + (running ? 'processing' : processingFailure ? 'failed' : editor?.reviewed ? 'exportable' : resultId ? 'review' : detail.project.status)}>{running ? t("生成中", "Generating") : processingFailure ? t("生成失败", "Generation failed") : editor?.reviewed ? t("可导出", "Ready to export") : resultId ? t("待校对", "Ready for review") : t("待生成", "Ready to generate")}</span>{detail.project.archived && <span className='ws-archive-tag'>{t("已归档", "Archived")}</span>}</div><p>{detail.project.filename} <span>·</span> {duration(detail.project.duration)} <span>·</span> {detail.project.size_mb.toFixed(1)} MB <span>·</span>{t(" 更新于 ", " Updated ")}{dateTime(detail.project.updated_at, uiLanguage)}</p></div>
      {resultId && <details className="ws-export-menu ws-studio-target" ref={exportRef}><summary className="ws-button primary"><Download size={16} />{t("导出文件", "Export files")}<ChevronDown size={14} /></summary><div><a href={outputUrl(resultId) + '?download=true'} download><Clapperboard size={16} />{t("带口述解说的 MP4", "MP4 with audio description")}</a>{!transcriptError && <><a href={exportUrl(resultId, 'dialogue', 'srt')} download><Subtitles size={16} />{t("对白字幕 · SRT", "Dialogue subtitles · SRT")}</a><a href={exportUrl(resultId, 'dialogue', 'vtt')} download><Subtitles size={16} />{t("对白字幕 · VTT", "Dialogue subtitles · VTT")}</a></>}{!editorError && <a href={exportUrl(resultId, 'description', 'txt')} download><FileText size={16} />{t("口述解说稿 · TXT", "Audio description script · TXT")}</a>}{dirty && <small>{t("导出已保存的版本；当前编辑尚未保存。", "Exports use the saved version. Current edits are unsaved.")}</small>}</div></details>}
    </div>
    {error && <Alert>{error}<button className="ws-text-button" onClick={() => setError('')}>{t("关闭", "Close")}</button></Alert>}
    <span className="ws-sr-only" role="status">{notice}</span>
    {editor?.outcome === 'subtitles_only' && <Alert>{t("本版本只生成了字幕，没有口述配音。对白过于密集时，请使用“自动”或“扩展口述”重新生成；新版本会暂停画面插入解说，保留原对白。", "This version has subtitles only. For dense dialogue, generate again using Auto or Extended audio description to pause the picture for narration while preserving the original dialogue.")}</Alert>}
    {editor?.narration_mode === 'extended' && <div className="ws-notice" role="status">{t("扩展口述版：原片 ", "Extended audio description: source ")}{duration(detail.project.duration)}{t("，成片 ", ", output ")}{duration(resultDuration)}{t("。解说在暂停画面时播放。", ". Narration plays while the picture is paused.")}</div>}
    {calibration && calibration.status !== 'SUCCEEDED' && <section className="ws-calibration-status" aria-live="polite">{calibrating ? <><LoaderCircle size={15} className="ws-spin" /><span>{calibrationTimedOut ? t("字幕校准仍未确认完成，请继续检查任务结果。", "Subtitle calibration has not finished yet. Continue checking the task.") : t("正在重新识别对白、校准文本与时间码…", "Transcribing dialogue and calibrating text and timestamps…")}</span></> : calibration.status === 'FAILED' ? <Alert>{calibration.error || t("字幕校准失败，请重试。原字幕已保留。", "Subtitle calibration failed. Retry; the original subtitles are preserved.")}</Alert> : null}{calibrationError && <Alert>{t("校准进度连接暂时中断，字幕将保留。", "Calibration progress is temporarily unavailable. Subtitles are preserved. ")}{calibrationError}</Alert>}{calibrationTimedOut && calibrating && <button className="ws-button secondary" onClick={() => { calibrationStartedAt.current = Date.now(); setCalibrationTimedOut(false); setCalibrationPollKey(value => value + 1); }}>{t("继续检查校准结果", "Check calibration again")}</button>}</section>}
    {detail.project.archived && <Alert>{t("视频已归档。取消归档后可继续编辑。", "This video is archived. Restore it to continue editing.")}</Alert>}
    <div className="ws-studio-grid"><div className="ws-video-column">
      <section className="ws-player-panel ws-studio-target" ref={playerPanelRef} tabIndex={-1} aria-label={t("视频预览", "Video preview")}><div className="ws-panel-heading"><div className="ws-source-tabs"><button className={source === 'original' ? 'active' : ''} onClick={() => { setSource('original'); setMediaError(false); }}>{t("原始视频", "Original video")}</button><button className={source === 'described' ? 'active' : ''} disabled={!resultId} onClick={() => { setSource('described'); setMediaError(false); }}><Volume2 size={14} />{t("口述解说版", "Audio description")}</button></div></div>
        <div className="ws-player-stage">{videoUrl ? <><video key={videoUrl} ref={videoRef} tabIndex={0} src={videoUrl} controls playsInline preload="metadata" onTimeUpdate={event => setCurrentTime(event.currentTarget.currentTime)} onLoadedMetadata={() => { setCurrentTime(0); setMediaError(false); }} onError={() => setMediaError(true)} aria-label={source === 'original' ? t("原始视频播放器", "Original video player") : t("口述解说视频播放器", "Audio description video player")} />{showSubtitles && activeCue && <div className="ws-subtitle-overlay" aria-live="off">{activeCue.text}</div>}</> : <Loading text={t("正在加载视频…", "Loading video…")} />}{mediaError && <div className="ws-video-error"><Alert>{t("视频无法播放，请刷新后重试。", "Video cannot be played. Reload and try again.")}</Alert></div>}</div>
        <div className="ws-player-footer"><span><Clock3 size={13} />{duration(currentTime)} / {duration(playerDuration)}</span><button className={showSubtitles ? 'active' : ''} onClick={() => setShowSubtitles(value => !value)} disabled={!transcript.cues.length} aria-pressed={showSubtitles}><Subtitles size={16} />{t("对白字幕", "Dialogue subtitles")}</button></div>
      </section>
      {detail.executions.length > 0 && <div className="ws-version-bar"><History size={17} /><div><span>{t("历史版本", "Version history")}</span><select aria-label={t("选择历史版本", "Select version")} value={resultId} disabled={busy || starting || saving} onChange={event => { const value = event.target.value; guard(() => { setResultId(value); setMediaError(false); setNotice(''); }); }}>{!resultId && <option value="">{t("暂无已完成版本", "No completed versions")}</option>}{detail.executions.map((job, index) => <option value={job.execution_arn} key={job.execution_arn} disabled={job.status !== 'SUCCEEDED'}>V{detail.executions.length - index} · {job.kind === 'render' ? t("重新配音", "Revoice") : t("自动生成", "Generated")} · {dateTime(job.start_date, uiLanguage)}{job.status === 'SUCCEEDED' ? '' : job.status === 'RUNNING' ? t(" · 处理中", " · Processing") : t(" · 失败", " · Failed")}</option>)}</select></div></div>}
      <section className="ws-settings-panel ws-studio-target" ref={settingsRef} tabIndex={-1} aria-label={t("生成设置", "Generation settings")}>
        <div className="ws-section-title"><h2>{resultId ? t("新版本设置", "New version settings") : t("生成设置", "Generation settings")}</h2></div>
        <div className="ws-settings-grid">
          <label className="ws-field"><span><Subtitles size={14} />{t("原片对白语言", "Original dialogue language")}</span><select aria-label={t("原片对白语言", "Original dialogue language")} value={dialogueLanguage} disabled={busy || starting || detail.project.archived} onChange={event => { dialogueSelectionInitialized.current = true; setDialogueLanguage(event.target.value as DialogueLanguage); }}><option value="auto">{dialogueLanguageLabel('auto', uiLanguage)}</option>{speechLanguages.map(option => <option key={option.id} value={option.id}>{languageLabel(option.id, uiLanguage)}</option>)}</select></label>
          <label className="ws-field"><span><Languages size={14} />{t("解说语言", "Narration language")}</span><select ref={generationLanguageRef} aria-label={t("解说语言", "Narration language")} value={language} disabled={busy || starting || detail.project.archived} onChange={event => changeLanguage(event.target.value as VideoLanguage)}>{speechLanguages.map(option => <option key={option.id} value={option.id}>{languageLabel(option.id, uiLanguage)}</option>)}</select></label>
          <label className="ws-field"><span><Volume2 size={14} />{t("解说音色", "Narration voice")}</span><select aria-label={t("新版本解说音色", "New version narration voice")} value={voice} disabled={busy || starting || detail.project.archived} onChange={event => setVoice(event.target.value)}>{!validVoice && <option value={voice} disabled>{t("请选择可用音色", "Select an available voice")}</option>}{voices.map(option => <option key={option.id} value={option.id}>{voiceLabel(option, uiLanguage)}</option>)}</select></label>
        </div>
        <label className="ws-field ve-narration-mode">{t("口述方式", "Narration mode")}<select aria-label={t("口述方式", "Narration mode")} value={narrationMode} disabled={busy || starting} onChange={event => setNarrationMode(event.target.value as typeof narrationMode)}><option value="auto">{t("自动 · 无间隙时扩展画面", "Auto · extend when no gaps are available")}</option><option value="standard">{t("自然间隙 · 保持原时长", "Natural gaps · keep original duration")}</option><option value="extended">{t("扩展口述 · 暂停画面加入解说", "Extended · pause the picture for narration")}</option></select><small>{t("扩展口述会延长成片，不覆盖原对白。", "Extended audio description lengthens the video and preserves the original dialogue.")}</small></label>
        <div className="ws-generate-row"><button className="ws-button primary" disabled={busy || starting || detail.project.archived || !validVoice} onClick={() => { if (!processingReady) { onSetup(); return; } guard(() => { setSegments(savedSegments); setRenderVoice(editor?.voice ?? ''); setTranscript(previous => ({ ...previous, cues: savedCues })); setConfirmation('generate'); }); }}>{busy ? <LoaderCircle size={17} className="ws-spin" /> : <Play size={17} />}{calibrating ? t("正在校准字幕", "Calibrating subtitles") : running ? t("正在生成", "Generating") : !processingReady ? t("检查服务配置", "Check service settings") : resultId ? t("生成一个新版本", "Generate new version") : t("生成口述解说", "Generate audio description")}</button></div>
      </section>
      {(execution || processingFailure) && <section className="ws-progress-panel ws-studio-target" ref={progressRef} tabIndex={-1} aria-label={t("制作进度", "Production progress")} aria-live="polite"><div className="ws-progress-title">{running ? <LoaderCircle size={18} className="ws-spin" /> : execution?.status === 'SUCCEEDED' ? <CircleCheck size={18} /> : <RefreshCw size={18} />}<strong>{running ? t("正在制作新版本", "Generating new version") : execution?.status === 'SUCCEEDED' ? t("新版本已就绪", "New version ready") : execution?.status === 'TIMED_OUT' ? t("任务已超时", "Task timed out") : execution?.status === 'ABORTED' ? t("任务已中止", "Task stopped") : t("本次处理未完成", "Processing incomplete")}</strong>{execution && <span>{dateTime(execution.start_date, uiLanguage)}</span>}</div>{Boolean(execution?.steps.length) && <ol className="ws-steps">{execution!.steps.map((step, index) => <li className={step.status} key={step.name}><span>{step.status === 'succeeded' ? <Check size={12} /> : step.status === 'running' ? <LoaderCircle size={12} className="ws-spin" /> : index + 1}</span><p>{stepLabels[step.name] || step.name}</p></li>)}</ol>}{processingFailure && <><Alert>{failureReason}</Alert><button className="ws-button secondary" disabled={busy || detail.project.archived} onClick={() => navigateTo('generate')}>{t("调整设置后重试", "Adjust settings and retry")}</button></>}{executionError && <Alert>{t("进度连接暂时中断，正在自动重连。", "Progress connection interrupted. Reconnecting automatically. ")}{executionError}</Alert>}</section>}
    </div>
    <section className="ws-editor-panel ws-studio-target" ref={editorPanelRef} tabIndex={-1} aria-label={t("校对文本", "Review text")}><div className="ws-editor-tabs" role="tablist" aria-label={t("视频文本编辑", "Video text editor")}><button role="tab" aria-selected={tab === 'description'} className={tab === 'description' ? 'active' : ''} onClick={() => setTab('description')}><Volume2 size={16} />{t("口述解说", "Audio description")}<span>{segments.length}</span></button><button role="tab" aria-selected={tab === 'dialogue'} className={tab === 'dialogue' ? 'active' : ''} onClick={() => setTab('dialogue')}><MessageSquareText size={16} />{t("对白字幕", "Dialogue subtitles")}<span>{transcript.cues.length}</span></button></div>
      {resultId && <div className="ws-editor-subheading">{(tab === 'description' ? narrationDirty : subtitleDirty) && <strong>{t("未保存", "Unsaved")}</strong>}{resultId && <button className="ws-icon-button" aria-label={t("重新加载当前版本文本", "Reload current version text")} title={t("重新加载当前版本文本", "Reload current version text")} disabled={editorLoading || busy || starting || saving} onClick={() => guard(() => setVersionReload(value => value + 1))}><RefreshCw size={13} /></button>}</div>}
      {!resultId ? <div className="ws-editor-empty"><span><FileText size={30} strokeWidth={1.2} /></span><h3>{t("暂无文本", "No text yet")}</h3><p>{t("生成后可编辑口述稿与字幕。", "Generate a version to edit narration and subtitles.")}</p></div> : editorLoading ? <Loading text={t("正在加载文本…", "Loading text…")} /> : (tab === 'description' ? editorError : transcriptError) ? <div className="ws-editor-empty"><Alert>{tab === 'description' ? editorError : transcriptError}</Alert><button className="ws-button secondary" onClick={() => guard(() => setVersionReload(value => value + 1))}>{t("重新加载文本", "Reload text")}</button></div> : <>
        <div className="ws-cue-list" role="tabpanel" aria-label={tab === 'description' ? t("口述稿编辑", "Narration editor") : t("对白字幕编辑", "Dialogue subtitle editor")}>
          {tab === 'description' ? segments.length ? segments.map((segment, index) => <article className={'ws-cue ' + (activeSegment?.segment_index === segment.segment_index ? 'current' : '')} key={segment.segment_index}><div className="ws-cue-head"><span className="ws-cue-index">{String(index + 1).padStart(2, '0')}</span><button onClick={() => seek(segment.start_time)} aria-label={t("跳转到解说 ", "Jump to narration ") + (index + 1)}><Play size={11} fill="currentColor" />{duration(segment.start_time)} <span>—</span> {duration(segment.end_time)}</button><span className={segment.pass ? 'ws-cue-pass' : 'ws-cue-skipped'}>{segment.pass ? <><Check size={11} />{t("已配音", "Voiced")}</> : t("未配音", "Not voiced")}</span></div><textarea ref={index === 0 ? firstNarrationRef : undefined} aria-label={t("口述稿 ", "Narration ") + (index + 1)} value={segment.dvi_text} disabled={busy || starting || detail.project.archived} placeholder={t("输入口述稿", "Enter narration")} onChange={event => setSegments(previous => previous.map((item, i) => i === index ? { ...item, dvi_text: event.target.value } : item))} /><div className="ws-cue-foot"><span>{t("可用 ", "Available: ")}{segment.silence_duration.toFixed(1)}{t(" 秒", " s")}{segment.audio_duration ? t(" · 配音 ", " · Voice: ") + segment.audio_duration.toFixed(1) + t(" 秒", " s") : ''}</span><span>{segment.dvi_text.length}{t(" 字符", " characters")}</span></div>{!segment.pass && <p className="ws-cue-reason">{segment.skip_reason || t("未加入成片，可修改后重新配音。", "Not included in the output. Edit and revoice to include it.")}</p>}</article>) : <div className="ws-inline-empty"><Clock3 size={25} /><h3>{t("暂无口述解说", "No audio description yet")}</h3><p>{t("未找到自然对白间隙。自动模式可暂停画面插入口述解说。", "No natural dialogue gaps found. Auto mode can pause the picture to add audio description.")}</p></div> : transcript.cues.length ? transcript.cues.map((cue, index) => <article className={'ws-cue ws-dialogue-cue ' + (activeCue?.id === cue.id ? 'current' : '')} key={cue.id}><div className="ws-cue-head"><span className="ws-cue-index">{String(index + 1).padStart(2, '0')}</span><button onClick={() => seek(cue.start)} aria-label={t("跳转到字幕 ", "Jump to subtitle ") + (index + 1)}><Play size={11} fill="currentColor" />{duration(cue.start)} <span>—</span> {duration(cue.end)}</button></div><textarea aria-label={t("对白字幕 ", "Dialogue subtitle ") + (index + 1)} value={cue.text} disabled={busy || starting || saving || detail.project.archived} onChange={event => changeCue(index, { text: event.target.value })} /><div className="ws-cue-time-fields"><label>{t("开始 ", "Start ")}<input aria-label={t("字幕 ", "Subtitle ") + (index + 1) + t(" 开始秒数", " start seconds")} type="number" min={0} step={0.01} value={Number.isFinite(cue.start) ? cue.start : ''} disabled={busy || starting || saving || detail.project.archived} onChange={event => changeCue(index, { start: event.target.value === '' ? NaN : Number(event.target.value) })} /></label><span>→</span><label>{t("结束 ", "End ")}<input aria-label={t("字幕 ", "Subtitle ") + (index + 1) + t(" 结束秒数", " end seconds")} type="number" min={0} step={0.01} value={Number.isFinite(cue.end) ? cue.end : ''} disabled={busy || starting || saving || detail.project.archived} onChange={event => changeCue(index, { end: event.target.value === '' ? NaN : Number(event.target.value) })} /></label><span>{t("秒", "s")}</span></div></article>) : <div className="ws-inline-empty"><Subtitles size={25} /><h3>{t("未识别到对白", "No dialogue detected")}</h3></div>}
        </div>
        <div className="ws-editor-actions">{tab === 'description' ? <><p>{languageLabel(versionLanguage, uiLanguage)}{chosenExecution ? ' · ' + dateTime(chosenExecution.start_date, uiLanguage) : ''}</p><label className="ws-field ws-render-voice"><span><Volume2 size={14} />{t("此版本配音音色", "Voice for this version")}</span><select aria-label={t("此版本配音音色", "Voice for this version")} value={renderVoice} disabled={busy || starting || detail.project.archived} onChange={event => setRenderVoice(event.target.value)}>{!validRenderVoice && <option value={renderVoice} disabled>{renderVoice || t("请选择音色", "Select a voice")}</option>}{versionVoices.map(option => <option key={option.id} value={option.id}>{voiceLabel(option, uiLanguage)}</option>)}</select></label><button className="ws-button primary" disabled={!segments.length || !narrationDirty || !validRenderVoice || busy || starting || subtitleDirty || detail.project.archived} onClick={() => { if (!speechReady) { onSetup(); return; } setConfirmation('render'); }}><Volume2 size={16} />{t("重新配音并导出", "Revoice and export")}</button>{subtitleDirty && <small>{t("请先保存对白字幕。", "Save dialogue subtitles first.")}</small>}</> : <>{invalidCues && <p className="ws-validation-error">{t("请检查时间范围、字幕顺序及空白文本，字幕时间不能重叠。", "Check time ranges, subtitle order and empty text. Subtitle times cannot overlap.")}</p>}<button className="ws-button primary" disabled={!subtitleDirty || invalidCues || saving || busy || starting || detail.project.archived} onClick={() => void saveSubtitles()}>{saving ? <LoaderCircle size={16} className="ws-spin" /> : <Save size={16} />}{saving ? t("正在保存…", "Saving…") : t("保存对白字幕", "Save dialogue subtitles")}</button><button className="ws-button secondary ws-calibrate-button" disabled={subtitleDirty || busy || starting || saving || detail.project.archived} onClick={() => { if (!speechReady) { onSetup(); return; } setConfirmation('calibrate'); }}>{calibrating ? <LoaderCircle size={16} className="ws-spin" /> : <RefreshCw size={16} />}{calibrating ? t("正在校准字幕…", "Calibrating subtitles…") : t("重新校准字幕", "Recalibrate subtitles")}</button><small>{subtitleDirty ? t("请先保存当前字幕。", "Save the current subtitles first.") : t("校准语言：", "Calibration language: ") + dialogueLanguageLabel(dialogueLanguage, uiLanguage)}</small>{transcript.quality?.review_required && <small className="ws-validation-error" role="note">{t("部分对白识别置信度较低，请核对原声。", "Some dialogue has low recognition confidence. Check the original audio.")}</small>}<div className="ws-subtitle-downloads"><a href={exportUrl(resultId, 'dialogue', 'srt')} download><Download size={13} />SRT</a><a href={exportUrl(resultId, 'dialogue', 'vtt')} download><Download size={13} />VTT</a></div><small>{t("修改仅更新字幕预览与下载。", "Edits update subtitle preview and downloads only.")}</small></>}</div>
      </>}
    </section></div>
    {confirmation && <Modal title={confirmation === 'calibrate' ? t("重新校准对白字幕", "Recalibrate dialogue subtitles") : confirmation === 'render' ? t("重新配音并生成新版本", "Revoice and create a new version") : t("开始生成口述解说", "Generate audio description")} onClose={() => setConfirmation(null)} busy={starting}><p className="ws-confirm-copy">{confirmation === 'calibrate' ? t("将把原片音频发送至 Azure Speech，按选定语言重新识别对白，校准字幕文字和时间码。完成后将覆盖此版本已保存的对白字幕，现有解说配音保留。", "Original audio will be sent to Azure Speech to transcribe dialogue in the selected language and calibrate text and timestamps. This replaces saved dialogue subtitles for this version and preserves existing narration.") : confirmation === 'render' ? t("将使用当前口述稿和选定音色重新合成语音，并混合到原始视频中。口述稿语言保持不变。", "The current script and selected voice will be synthesized and mixed with the original video. The script language stays unchanged.") : t("将提取画面与音频发送至 Azure，生成口述稿和配音。自动模式在无足够对白间隙时暂停画面加入解说，成片会变长。", "Video frames and audio will be sent to Azure to generate narration and speech. In Auto mode, the picture pauses for narration when dialogue gaps are insufficient, extending the output.")}</p><div className="ws-confirm-facts"><span>{t("当前视频", "Current video")}<strong>{detail.project.title}</strong></span>{confirmation !== 'render' && <span>{t("原片对白语言", "Original dialogue language")}<strong>{dialogueLanguageLabel(dialogueLanguage, uiLanguage)}</strong></span>}{confirmation !== 'calibrate' && <span>{t("解说语言", "Narration language")}<strong>{languageLabel(confirmation === 'render' ? versionLanguage : language, uiLanguage)}</strong></span>}{confirmation !== 'calibrate' && <span>{t("解说音色", "Narration voice")}<strong>{confirmation === 'render' ? renderVoiceName : voiceName}</strong></span>}{confirmation === 'render' && <span>{t("解说段落", "Narration segments")}<strong>{segments.length}{t(" 段", " segments")}</strong></span>}<span>{t("保存方式", "Save mode")}<strong>{confirmation === 'calibrate' ? t("替换此版本的对白字幕", "Replace subtitles for this version") : t("新建版本，保留历史", "Create a version and keep history")}</strong></span></div><Alert>{t("将调用 Azure 云服务并按用量计费，实际金额以 Azure 账单为准。", "Azure cloud services charge by usage. Refer to your Azure bill for actual costs.")}</Alert><div className="ws-modal-actions"><button className="ws-button secondary" disabled={starting} onClick={() => setConfirmation(null)}>{confirmation === 'calibrate' ? t("取消校准", "Cancel calibration") : t("暂不生成", "Cancel")}</button><button className="ws-button primary" disabled={starting} onClick={() => void start()}>{starting ? <LoaderCircle size={16} className="ws-spin" /> : <Play size={16} />}{starting ? t("正在提交…", "Submitting…") : t("确认并开始", "Confirm and start")}</button></div></Modal>}
    {discardAction && <Modal title={t("有未保存的编辑", "Unsaved edits")} onClose={() => setDiscardAction(null)}><p className="ws-modal-intro">{t("继续会放弃当前版本中尚未保存的", "Continuing will discard unsaved changes to ")}{narrationDirty && subtitleDirty ? t("口述稿、音色和字幕", "the script, voice and subtitles") : narrationDirty ? t("口述稿或音色", "the script or voice") : t("字幕", "subtitles")}{t("修改。", " in this version.")}</p><div className="ws-modal-actions"><button className="ws-button secondary" onClick={() => setDiscardAction(null)}>{t("继续编辑", "Continue editing")}</button><button className="ws-button danger" onClick={() => { const action = discardAction; setDiscardAction(null); action(); }}>{t("放弃修改并继续", "Discard changes and continue")}</button></div></Modal>}
    {renameOpen && <Modal title={t("编辑视频名称", "Edit video name")} onClose={() => setRenameOpen(false)} busy={renaming}><form onSubmit={event => { event.preventDefault(); void rename(); }}><label className="ws-field">{t("视频名称", "Video name")}<input value={title} maxLength={120} onChange={event => setTitle(event.target.value)} /></label>{renameError && <Alert>{renameError}</Alert>}<div className="ws-modal-actions"><button type="button" className="ws-button secondary" onClick={() => setRenameOpen(false)} disabled={renaming}>{t("取消", "Cancel")}</button><button className="ws-button primary" disabled={renaming || !title.trim()}>{renaming ? t("保存中…", "Saving…") : t("保存名称", "Save name")}</button></div></form></Modal>}
  </main>;
}
