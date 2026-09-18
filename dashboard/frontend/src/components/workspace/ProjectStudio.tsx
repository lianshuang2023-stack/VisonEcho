import { useUiPreferences } from '../../uiPreferences';
import { dateTime, duration, errorMessage } from './workspaceUtils';
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CircleCheck, Clock3, Download, FileText, History, Languages, LoaderCircle, MessageSquareText, Pencil, Play, Plus, RefreshCw, Save, Subtitles, Trash2, Volume2, Users, Settings2, Columns2, MoreHorizontal, X } from 'lucide-react';
import { fetchExecutionStatus, fetchInputVideoUrl } from '../../api';
import { calibrateTranscript, exportUrl, generateNarration, getNarration, getProject, getTranscript, getTranscriptCalibration, outputUrl, patchProject, renderNarration, saveTranscript } from '../../localWorkspaceApi';
import type { NarrationEditor, NarrationSegment, ProjectDetail, Transcript, TranscriptCalibration, DialogueLanguage, VideoLanguage } from '../../localWorkspaceApi';
import type { ExecutionStatus, SpeechLanguage } from '../../types';
import { Alert, Loading, Modal } from './WorkspaceShared';
import { defaultSpeechLanguages, dialogueLanguageLabel, languageLabel, voiceLabel, voicesForLanguage } from './speechOptions';
import { sourceCues, toSourceTime } from './timeline';
import StudioReviewPanel from './StudioReviewPanel';
import StudioQualityReport from './StudioQualityReport';
import StudioExportMenu from './StudioExportMenu';
import { useStudioReview } from './useStudioReview';
import CharacterPanel from './CharacterPanel';
import type { CharacterPanelHandle } from './CharacterPanel';
import type { NarrationReplacement } from './characterUtils';
import type { CharacterFrameSelection } from '../../localWorkspaceApi';
import { Button, Drawer, DrawerBody, DrawerHeader, DrawerHeaderTitle, Menu, MenuTrigger, MenuPopover, MenuList, MenuItem } from '@fluentui/react-components';
import { toOutputTime } from './timeline';
import ComparisonPreview from './ComparisonPreview';
import StudioProgress from './StudioProgress';
import './studio-workflow.css';
import { activeSubtitleCues, hasSpeakerMetadata, invalidSubtitleCues, speakerLabel, subtitleSpeakerOptions } from './subtitleDisplay';
import './subtitle-speakers.css';

const emptyTranscript: Transcript = { cues: [], revision: 0 };
export type StudioIntent = 'generate' | 'review' | 'progress' | 'error' | 'result';
type StudioNavigationIntent = StudioIntent | 'export';
type StudioStage = 'prepare' | 'generate' | 'review' | 'quality';
const failedStatuses: ExecutionStatus['status'][] = ['FAILED', 'TIMED_OUT', 'ABORTED'];

export default function ProjectStudio({ projectId, processingReady, speechReady = processingReady, speechLanguages = defaultSpeechLanguages, initialIntent, backLabel, onBack, onSetup }: { projectId: string; processingReady: boolean; speechReady?: boolean; speechLanguages?: SpeechLanguage[]; initialIntent?: StudioIntent; backLabel?: string; onBack: () => void; onSetup: () => void }) {
  const { t, language: uiLanguage } = useUiPreferences();
  const [stageChoice, setStageChoice] = useState<StudioStage | null>(initialIntent === 'progress' || initialIntent === 'error' ? 'generate' : null);
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [resourcesMounted, setResourcesMounted] = useState(false);
  const resourceTriggerRef = useRef<HTMLButtonElement>(null);
  const resourceWasOpen = useRef(false);
  const openResources = () => { setResourcesMounted(true); setResourcesOpen(true); };
  useEffect(() => {
    if (!resourcesOpen && resourceWasOpen.current) resourceTriggerRef.current?.focus({ preventScroll: true });
    resourceWasOpen.current = resourcesOpen;
  }, [resourcesOpen]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [comparisonOpen, setComparisonOpen] = useState(false);
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
  const [newCueId, setNewCueId] = useState<string | null>(null);
  const [editorLoading, setEditorLoading] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [characterDirty, setCharacterDirty] = useState(false);
  const [characterSaving, setCharacterSaving] = useState(false);
  const [evidenceDirty, setEvidenceDirty] = useState<Record<number, boolean>>({});
  const [evidenceSaving, setEvidenceSaving] = useState<Record<number, boolean>>({});
  const [evidenceEpoch, setEvidenceEpoch] = useState(0);
  const [editorError, setEditorError] = useState('');
  const [transcriptError, setTranscriptError] = useState('');
  const [versionReload, setVersionReload] = useState(0);
  const [reviewActionBusy, setReviewActionBusy] = useState(false);
  const studioReview = useStudioReview(resultId, String(versionReload) + ':' + transcript.revision);
  const [tab, setTab] = useState<'description' | 'dialogue'>('description');
  const [language, setLanguage] = useState<VideoLanguage>('en-US');
  const [dialogueLanguage, setDialogueLanguage] = useState<DialogueLanguage>('auto');
  const [voice, setVoice] = useState('en-US-JennyNeural');
  const [detectCharacters, setDetectCharacters] = useState(true);
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
  const pendingSourceSeek = useRef<number | null>(null);
  const pendingOutputSeek = useRef<number | null>(null);
  const characterRef = useRef<CharacterPanelHandle>(null);
  const pendingCharacterFrame = useRef<CharacterFrameSelection | null>(null);
  const settingsRef = useRef<HTMLElement>(null);
  const generationLanguageRef = useRef<HTMLSelectElement>(null);
  const editorPanelRef = useRef<HTMLElement>(null);
  const progressRef = useRef<HTMLElement>(null);
  const playerPanelRef = useRef<HTMLElement>(null);
  const appliedNavigation = useRef('');
  const initialized = useRef(false);
  const latestRequest = useRef(0);
  const selectionInitialized = useRef(false);
  const dialogueSelectionInitialized = useRef(false);
  const characterDetectionSelectionInitialized = useRef(false);
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
  const evidenceHasEdits = Object.values(evidenceDirty).some(Boolean);
  const auxiliarySaving = characterSaving || Object.values(evidenceSaving).some(Boolean);
  const dirty = narrationDirty || subtitleDirty || characterDirty || evidenceHasEdits;
  const running = execution?.status === 'RUNNING';
  const executionFailed = Boolean(execution && failedStatuses.includes(execution.status));
  const calibrating = calibration?.status === 'RUNNING';
  const busy = running || calibrating || reconciling || auxiliarySaving || reviewActionBusy || studioReview.saving;
  const canExport = Boolean(resultId);
  const reviewComplete = !dirty && !studioReview.error && (studioReview.review?.review_complete ?? editor?.reviewed ?? false);
  const displayedCues = useMemo(() => source === 'original' ? sourceCues(transcript.cues, editor?.insertions) : transcript.cues, [source, transcript.cues, editor?.insertions]);
  const activeCues = useMemo(() => activeSubtitleCues(displayedCues, currentTime), [displayedCues, currentTime]);
  const speakerMetadata = hasSpeakerMetadata(transcript.cues);
  const speakerOptions = subtitleSpeakerOptions(transcript.cues);
  const chosenExecution = detail?.executions.find(job => job.execution_arn === resultId);
  const outputCurrentTime = source === 'original' ? toOutputTime(currentTime, editor?.insertions) : currentTime;
  const stage: StudioStage = running || reconciling ? 'generate' : stageChoice ?? (resultId ? (reviewComplete ? 'quality' : 'review') : (executionFailed ? 'generate' : 'prepare'));
  const seek = (time: number) => { if (videoRef.current) { const target = source === 'original' ? toSourceTime(time, editor?.insertions) : time; videoRef.current.currentTime = target; setCurrentTime(target); } };
  const guard = (action: () => void) => { if (auxiliarySaving || reconciling || reviewActionBusy || studioReview.saving) return; if (dirty) setDiscardAction(() => action); else action(); };
  // Closing a resource view does not navigate or discard any draft. Keep its
  // editor and task polling mounted while hiding the entire closed drawer.
  const closeResources = () => setResourcesOpen(false);
  const markEvidenceDirty = useCallback((index: number, value: boolean) => setEvidenceDirty(previous => previous[index] === value ? previous : { ...previous, [index]: value }), []);
  const markEvidenceSaving = useCallback((index: number, value: boolean) => setEvidenceSaving(previous => previous[index] === value ? previous : { ...previous, [index]: value }), []);
  const seekEvidence = (sourceTime: number) => {
    if (!Number.isFinite(sourceTime)) return;
    const target = Math.max(0, Math.min(sourceTime, detail?.project.duration ?? sourceTime));
    pendingSourceSeek.current = target;
    if (source === 'original' && videoRef.current && videoRef.current.readyState >= 1) {
      videoRef.current.currentTime = target; setCurrentTime(target); pendingSourceSeek.current = null;
    }
    setSource('original'); setMediaError(false);
  };
  const createCharacter = (frame: CharacterFrameSelection) => { pendingCharacterFrame.current = frame; openResources(); };
  const attachCharacterPanel = (panel: CharacterPanelHandle | null) => { characterRef.current = panel; if (panel && pendingCharacterFrame.current) { const frame = pendingCharacterFrame.current; pendingCharacterFrame.current = null; window.setTimeout(() => panel.createFromFrame(frame), 0); } };
  const applyCharacterNames = (replacements: NarrationReplacement[]) => {
    setSegments(previous => previous.map(segment => {
      const replacement = replacements.find(item => item.segmentIndex === segment.segment_index && item.before === segment.dvi_text);
      return replacement ? { ...segment, dvi_text: replacement.after } : segment;
    }));
    setNotice(t('称呼已应用到口述稿草稿，请重新配音保存为新版本。', 'Names applied to the script draft. Revoice to save a new version.'));
  };
  const navigateTo = (intent: StudioNavigationIntent) => {
    if (intent === 'generate') { if (resultId) setSettingsOpen(true); else setStageChoice('prepare'); }
    if (intent === 'review') setStageChoice('review');
    if (intent === 'progress' || intent === 'error') setStageChoice('generate');
    setRequestedNavigation(previous => ({ intent, request: (previous?.request ?? 0) + 1 }));
  };
  const changeLanguage = (next: VideoLanguage) => {
    selectionInitialized.current = true;
    setLanguage(next);
    setVoice(voicesForLanguage(speechLanguages, next)[0]?.id ?? '');
  };

  const refreshDetail = useCallback(async (selectNew = false) => {
    const data = await getProject(projectId);
    setDetail(data);
    const latestGeneration = data.executions.find(execution => execution.kind !== 'render' && typeof execution.detect_characters === 'boolean');
    if (!characterDetectionSelectionInitialized.current && latestGeneration) { setDetectCharacters(latestGeneration.detect_characters!); characterDetectionSelectionInitialized.current = true; }
    if (!initialized.current || selectNew) {
      if (!selectionInitialized.current && !data.latest_result_id && /[\u3400-\u9fff]/.test(data.project.title + data.project.filename)) { setLanguage('zh-CN'); setVoice('zh-CN-XiaoxiaoNeural'); }
      if (selectNew) setStageChoice('review');
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
        setExecutionError('');
        if (next.status !== 'RUNNING') {
          setReconciling(true);
          await refreshDetail(next.status === 'SUCCEEDED');
          if (!active) return;
          setExecution(next); setReconciling(false);
          if (next.status === 'SUCCEEDED') { announceGeneration(); setVersionReload(value => value + 1); }
          return;
        }
        setExecution(next);
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
    if (!dirty && !calibrating && !auxiliarySaving) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, calibrating, auxiliarySaving]);

  // Card actions navigate after their target has loaded; they never start a cloud task.
  const navigationIntent = requestedNavigation?.intent ?? initialIntent;
  const navigationKey = projectId + ':' + (requestedNavigation?.request ?? 0);
  useEffect(() => {
    if (!navigationIntent || loading || !detail || appliedNavigation.current === navigationKey) return;
    if (navigationIntent === 'generate' && resultId && !settingsOpen) { setSettingsOpen(true); return; }
    if ((navigationIntent === 'progress' || navigationIntent === 'error') && stage !== 'generate') { setStageChoice('generate'); return; }
    if (navigationIntent === 'review' && stage !== 'review') { setStageChoice('review'); return; }
    let section: HTMLElement | null = null;
    let control: HTMLElement | null = null;
    if (navigationIntent === 'review' && resultId) {
      if (editorLoading || (!editor && !editorError)) return;
      if (tab !== 'description') { setTab('description'); return; }
      section = editorPanelRef.current;
      control = editorPanelRef.current?.querySelector('textarea:not(:disabled)') ?? null;
    } else if (navigationIntent === 'result' && (resultId || originalUrl)) {
      section = playerPanelRef.current;
      control = videoRef.current;
    } else if (navigationIntent === 'export' && resultId) {
      setStageChoice('quality'); section = editorPanelRef.current;
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
  }, [navigationIntent, navigationKey, loading, detail, resultId, originalUrl, editorLoading, editor, editorError, tab, stage, settingsOpen]);

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
      const result = confirmation === 'render' ? await renderNarration(resultId, segments, renderVoice) : await generateNarration(projectId, language, voice, narrationMode, dialogueLanguage, detectCharacters);
      setExecution({ execution_arn: result.execution_arn, start_date: result.start_date, stop_date: null, status: 'RUNNING', steps: [], error: null, cause: null });
      setConfirmation(null); setSettingsOpen(false); setStageChoice('generate'); setNotice(t("任务已开始。", "Task started."));
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
  const invalidCues = invalidSubtitleCues(transcript.cues, resultDuration);
  const addSubtitle = () => {
    if (resultDuration <= 0 || busy || starting || saving || editorLoading || transcriptError || detail?.project.archived) return;
    const id = 'cue-' + crypto.randomUUID();
    const start = Math.max(0, Math.min(outputCurrentTime, Math.max(0, resultDuration - .01)));
    const end = Math.min(resultDuration, start + 2);
    setTranscript(previous => ({ ...previous, cues: [...previous.cues, { id, start, end, text: '', speaker: null }].sort((a, b) => a.start - b.start) }));
    setNewCueId(id);
  };
  const videoUrl = source === 'described' && resultId ? outputUrl(resultId) : originalUrl;
  const processingFailure = !running && (executionFailed || detail?.project.status === 'failed');
  const failureReason = execution?.cause || execution?.error || detail?.project.last_error || (execution?.status === 'TIMED_OUT' ? t("任务已超时，请检查服务连接后重试。", "The task timed out. Check the service connection and retry.") : execution?.status === 'ABORTED' ? t("任务已中止，可以重新生成。", "The task was stopped. You can generate again.") : t("处理未完成，请检查服务配置后重试。", "Processing did not finish. Check service settings and retry."));
  const narrationWindowTooShort = execution?.error === 'DescriptionWindowTooShort' || /too long for its narration window|DescriptionWindowTooShort/i.test(failureReason);
  const dialogueNotRecognizedFailure = /detected audio but could not recognize dialogue|InitialSilenceTimeout/i.test(failureReason);
  const readableFailure = narrationWindowTooShort ? t('口述稿长于当前对白空隙。请选择扩展口述，在暂停画面时加入解说。', 'Narration exceeds the dialogue gap. Choose extended narration to add description while the picture pauses.') : dialogueNotRecognizedFailure ? t('音轨存在，但未识别到可靠对白。可能仅有音乐、环境音，或对白语言选择不正确。请核对原声，调整语言或确认无对白后重试。', 'Audio is present, but no reliable dialogue was recognized. It may contain only music or ambience, or the selected dialogue language may be incorrect. Check the audio, adjust the language or confirm there is no dialogue, then retry.') : failureReason;
  const visualNarrationAdded = Boolean(editor?.segments.some(segment => segment.pass && segment.dvi_text.trim()));
  const subtitleSkipSummary = editor?.dialogue_reason === 'user_declared_no_dialogue'
    ? t('已选择无对白，已跳过字幕。', 'No dialogue was selected. Subtitles were skipped.')
    : t('未检测到可转写对白，已跳过字幕。', 'No transcribable dialogue detected. Subtitles were skipped.');
  const dialogueNotice = editor?.dialogue_status === 'no_speech'
    ? subtitleSkipSummary + (visualNarrationAdded ? t('画面解说已生成。', ' Visual narration was generated.') : t('原片已保留，此版本暂未加入画面解说。', ' The source video is retained; this version has no visual narration.'))
    : editor?.dialogue_status === 'unrecognized'
      ? editor.narration_mode === 'extended' && visualNarrationAdded
        ? t('音轨存在，但未识别到可靠对白。已跳过字幕并在原片结束后补充解说，保留原声，请人工核对。', 'Audio is present, but no reliable dialogue was recognized. Subtitles were skipped and narration added after the video, preserving the original audio. Please review it manually.')
        : t('音轨存在，但未识别到可靠对白。已保留原声，暂未加入解说，请核对对白语言或确认无对白后重新生成。', 'Audio is present, but no reliable dialogue was recognized. The original audio is preserved without added narration. Check the dialogue language or confirm no dialogue before generating again.')
      : '';

  const dialogueReasonLabels: Record<string, string> = {
    no_audio_track: t('原片没有音轨', 'The source has no audio track'),
    silent_audio: t('音轨为静音', 'The audio track is silent'),
    initial_silence_timeout: t('语音服务未在起始等待时间内检测到对白', 'The speech service did not detect dialogue during the initial listening period'),
    no_recognized_dialogue: t('未返回可转写的对白', 'No transcribable dialogue was returned'),
    speech_not_recognized: t('检测到声音，但未可靠识别为对白', 'Sound was detected but could not be reliably transcribed'),
    user_declared_no_dialogue: t('已选择无对白，仅音乐或环境音', 'No dialogue was selected; music or ambience only'),
  };
  const dialogueReason = editor?.dialogue_reason ? dialogueReasonLabels[editor.dialogue_reason] : '';

  if (loading) return <Loading text={t("正在打开视频…", "Opening video…")} />;
  if (!detail) return <main className="ws-studio" id="visionecho-content" tabIndex={-1}><button className="ws-button ghost" onClick={onBack}><ArrowLeft size={16} />{backLabel || t("返回视频列表", "Back to videos")}</button><Alert>{error || t("视频不存在。", "Video not found.")}</Alert><button className="ws-button secondary" onClick={() => { setLoading(true); setError(''); void refreshDetail().catch(reason => setError(errorMessage(reason, uiLanguage))).finally(() => setLoading(false)); }}>{t("重新加载", "Reload")}</button></main>;

  const settingsPanel = (<section className="ws-settings-panel ws-studio-target" ref={settingsRef} tabIndex={-1} aria-label={t("生成设置", "Generation settings")}>
        <div className="ws-section-title"><h2>{resultId ? t("新版本设置", "New version settings") : t("生成设置", "Generation settings")}</h2></div>
        <div className="ws-settings-grid">
          <label className="ws-field"><span><Subtitles size={14} />{t("原片对白语言", "Original dialogue language")}</span><select aria-label={t("原片对白语言", "Original dialogue language")} value={dialogueLanguage} disabled={busy || starting || detail.project.archived} onChange={event => { dialogueSelectionInitialized.current = true; setDialogueLanguage(event.target.value as DialogueLanguage); }}><option value="auto">{dialogueLanguageLabel('auto', uiLanguage)}</option><option value="none">{t("无对白（仅音乐/环境音）", "No dialogue (music / ambience)")}</option>{speechLanguages.map(option => <option key={option.id} value={option.id}>{languageLabel(option.id, uiLanguage)}</option>)}</select></label>
          <label className="ws-field"><span><Languages size={14} />{t("解说语言", "Narration language")}</span><select ref={generationLanguageRef} aria-label={t("解说语言", "Narration language")} value={language} disabled={busy || starting || detail.project.archived} onChange={event => changeLanguage(event.target.value as VideoLanguage)}>{speechLanguages.map(option => <option key={option.id} value={option.id}>{languageLabel(option.id, uiLanguage)}</option>)}</select></label>
          <label className="ws-field"><span><Volume2 size={14} />{t("解说音色", "Narration voice")}</span><select aria-label={t("新版本解说音色", "New version narration voice")} value={voice} disabled={busy || starting || detail.project.archived} onChange={event => setVoice(event.target.value)}>{!validVoice && <option value={voice} disabled>{t("请选择可用音色", "Select an available voice")}</option>}{voices.map(option => <option key={option.id} value={option.id}>{voiceLabel(option, uiLanguage)}</option>)}</select></label>
        </div>
        <label className="ws-field ve-narration-mode">{t("口述方式", "Narration mode")}<select aria-label={t("口述方式", "Narration mode")} value={narrationMode} disabled={busy || starting} onChange={event => setNarrationMode(event.target.value as typeof narrationMode)}><option value="auto">{t("自动 · 选择合适的时间安排", "Auto · choose suitable narration timing")}</option><option value="standard">{t("自然间隙 · 保持原时长", "Natural gaps · keep original duration")}</option><option value="extended">{t("扩展口述 · 暂停画面加入解说", "Extended · pause the picture for narration")}</option></select><small>{t("扩展口述会延长成片，不覆盖原对白。", "Extended audio description lengthens the video and preserves the original dialogue.")}</small></label>
        <label className="ve-detect-setting"><input type="checkbox" checked={detectCharacters} disabled={busy || starting || detail.project.archived} onChange={event => { characterDetectionSelectionInitialized.current = true; setDetectCharacters(event.target.checked); }} />{t("自动识别人物", "Detect characters automatically")}<small>{t("识别角色并统一称呼", "Recognize characters and use consistent names")}</small></label>
        <div className="ws-generate-row"><button className="ws-button primary" disabled={busy || starting || detail.project.archived || !validVoice} onClick={() => { if (!processingReady) { onSetup(); return; } guard(() => { setSettingsOpen(false); setSegments(savedSegments); setRenderVoice(editor?.voice ?? ''); setTranscript(previous => ({ ...previous, cues: savedCues })); setConfirmation('generate'); }); }}>{busy ? <LoaderCircle size={17} className="ws-spin" /> : <Play size={17} />}{calibrating ? t("正在校准字幕", "Calibrating subtitles") : running ? t("正在生成", "Generating") : !processingReady ? t("检查服务配置", "Check service settings") : resultId ? t("生成一个新版本", "Generate new version") : t("生成口述解说", "Generate audio description")}</button></div>
      </section>);
  const displayExecution = execution ?? chosenExecution ?? null;
  const progressPanel = (<section className="ws-progress-panel ws-studio-target" ref={progressRef} tabIndex={-1} aria-label={t("制作进度", "Production progress")} aria-live="polite"><div className="ws-progress-title">{running ? <LoaderCircle size={18} className="ws-spin" /> : displayExecution?.status === 'SUCCEEDED' ? <CircleCheck size={18} /> : <RefreshCw size={18} />}<strong>{running ? t("正在制作新版本", "Generating new version") : displayExecution?.status === 'SUCCEEDED' ? t("新版本已就绪", "New version ready") : displayExecution?.status === 'TIMED_OUT' ? t("任务已超时", "Task timed out") : displayExecution?.status === 'ABORTED' ? t("任务已中止", "Task stopped") : t("本次处理未完成", "Processing incomplete")}</strong>{displayExecution && <span>{dateTime(displayExecution.start_date, uiLanguage)}</span>}</div><StudioProgress execution={displayExecution} />{processingFailure && <><Alert>{readableFailure}</Alert>{dialogueNotRecognizedFailure && <button className="ws-button primary" disabled={busy || detail.project.archived} onClick={() => { setDialogueLanguage('none'); dialogueSelectionInitialized.current = true; navigateTo('generate'); }}>{t('确认无对白并重试', 'Continue without dialogue')}</button>}{narrationWindowTooShort && <button className="ws-button primary" disabled={busy || detail.project.archived} onClick={() => { setNarrationMode('extended'); navigateTo('generate'); }}>{t('使用扩展口述重试', 'Retry with extended narration')}</button>}<button className="ws-button secondary" disabled={busy || detail.project.archived} onClick={() => navigateTo('generate')}>{t("调整设置后重试", "Adjust settings and retry")}</button></>}{executionError && <Alert>{t("进度连接暂时中断，正在自动重连。", "Progress connection interrupted. Reconnecting automatically. ")}{executionError}</Alert>}</section>);

  return <main className={"ws-studio ve-studio-flow stage-" + stage} id="visionecho-content" tabIndex={-1}>
    <button className="ws-back" disabled={busy} onClick={() => guard(onBack)}><ArrowLeft size={16} />{backLabel || (detail.project.archived ? t("返回归档视频", "Back to archived videos") : t("返回视频列表", "Back to videos"))}</button>
    <header className="ws-studio-heading ve-studio-heading">
      <div className="ve-studio-heading-main">
        <h1 title={detail.project.title}>{detail.project.title}</h1>
        <div className="ve-studio-metadata">{detail.executions.length > 0 && <div className="ws-version-bar"><History size={17} /><div><span>{t("历史版本", "Version history")}</span><select aria-label={t("选择历史版本", "Select version")} value={resultId} disabled={busy || starting || saving} onChange={event => { const value = event.target.value; guard(() => { setResultId(value); setMediaError(false); setNotice(''); }); }}>{!resultId && <option value="">{t("暂无已完成版本", "No completed versions")}</option>}{detail.executions.map((job, index) => <option value={job.execution_arn} key={job.execution_arn} disabled={job.status !== 'SUCCEEDED'}>V{detail.executions.length - index} · {job.kind === 'render' ? t("重新配音", "Revoice") : t("自动生成", "Generated")} · {dateTime(job.start_date, uiLanguage)}{job.status === 'SUCCEEDED' ? '' : job.status === 'RUNNING' ? t(" · 处理中", " · Processing") : t(" · 失败", " · Failed")}</option>)}</select></div></div>}<span>{duration(detail.project.duration)}</span><span>{detail.project.size_mb.toFixed(1)} MB</span>{detail.project.archived && <span>{t('已归档', 'Archived')}</span>}</div>
      </div>
      <div className="ve-studio-top-actions"><StudioExportMenu compact jobId={resultId} dirty={dirty} transcriptUnavailable={!!transcriptError} narrationUnavailable={!!editorError} /></div>
    </header>
    <div className="ve-studio-navigation">
    <nav className="ve-studio-stage-nav" aria-label={t('制作流程', 'Production workflow')}>{([
      ['prepare', t('准备', 'Prepare')], ['generate', t('生成', 'Generate')], ['review', t('校对', 'Review')], ['quality', t('导出', 'Export')],
    ] as [StudioStage, string][]).map(([value, label], index) => <button key={value} type="button" aria-current={stage === value ? 'step' : undefined} disabled={(value === 'review' || value === 'quality') && !resultId || value === 'generate' && !execution && !resultId && !processingFailure || busy && value !== 'generate'} onClick={() => { if (value === 'prepare' && resultId) { setSettingsOpen(true); return; } setStageChoice(value); }}><span>{index + 1}</span>{label}</button>)}</nav>
      <Menu positioning="below-end"><MenuTrigger disableButtonEnhancement><Button ref={resourceTriggerRef} appearance="subtle" className="ve-project-options" aria-label={t('项目选项', 'Project options')} title={t('项目选项', 'Project options')} icon={<MoreHorizontal size={18} />} disabled={starting || saving}>{t('项目选项', 'Project options')}</Button></MenuTrigger><MenuPopover><MenuList>
        <MenuItem icon={<Users size={16} />} onClick={openResources}>{t('项目资源', 'Project resources')}</MenuItem>
        <MenuItem icon={<Pencil size={16} />} onClick={() => { setTitle(detail.project.title); setRenameOpen(true); setRenameError(''); }}>{t('编辑视频名称', 'Edit video name')}</MenuItem>
        {resultId && <MenuItem icon={<Settings2 size={16} />} disabled={busy || detail.project.archived} onClick={() => setSettingsOpen(true)}>{t('生成新版本', 'New version')}</MenuItem>}
      </MenuList></MenuPopover></Menu>
    </div>
    {error && <Alert>{error}<button className="ws-text-button" onClick={() => setError('')}>{t("关闭", "Close")}</button></Alert>}
    <span className="ws-sr-only" role="status">{notice}</span>
    {editor?.outcome === 'subtitles_only' && <Alert>{transcript.cues.length === 0 ? t("本版本保留了原片，未生成字幕或口述配音。请核对对白语言或选择扩展口述后重试。", "This version retains the source video without subtitles or narration. Check the dialogue language or choose extended narration and retry.") : t("本版本只生成了字幕，没有口述配音。对白过于密集时，请使用“自动”或“扩展口述”重新生成；新版本会暂停画面插入解说，保留原对白。", "This version has subtitles only. For dense dialogue, generate again using Auto or Extended audio description to pause the picture for narration while preserving the original dialogue.")}</Alert>}
    {editor?.narration_mode === 'extended' && <div className="ws-notice" role="status">{t("扩展口述版：原片 ", "Extended audio description: source ")}{duration(detail.project.duration)}{t("，成片 ", ", output ")}{duration(resultDuration)}{t("。解说在暂停画面时播放。", ". Narration plays while the picture is paused.")}</div>}
    {calibration && calibration.status !== 'SUCCEEDED' && <section className="ws-calibration-status" aria-live="polite">{calibrating ? <><LoaderCircle size={15} className="ws-spin" /><span>{calibrationTimedOut ? t("字幕校准仍未确认完成，请继续检查任务结果。", "Subtitle calibration has not finished yet. Continue checking the task.") : t("正在重新识别对白、校准文本与时间码…", "Transcribing dialogue and calibrating text and timestamps…")}</span></> : calibration.status === 'FAILED' ? <Alert>{calibration.error || t("字幕校准失败，请重试。原字幕已保留。", "Subtitle calibration failed. Retry; the original subtitles are preserved.")}</Alert> : null}{calibrationError && <Alert>{t("校准进度连接暂时中断，字幕将保留。", "Calibration progress is temporarily unavailable. Subtitles are preserved. ")}{calibrationError}</Alert>}{calibrationTimedOut && calibrating && <button className="ws-button secondary" onClick={() => { calibrationStartedAt.current = Date.now(); setCalibrationTimedOut(false); setCalibrationPollKey(value => value + 1); }}>{t("继续检查校准结果", "Check calibration again")}</button>}</section>}
    {detail.project.archived && <Alert>{t("视频已归档。取消归档后可继续编辑。", "This video is archived. Restore it to continue editing.")}</Alert>}
    <div className="ws-studio-grid"><div className="ws-video-column">
      <section className="ws-player-panel ws-studio-target" ref={playerPanelRef} tabIndex={-1} aria-label={t("视频预览", "Video preview")}><div className="ws-panel-heading"><div className="ws-source-tabs"><button className={source === 'original' ? 'active' : ''} onClick={() => { setSource('original'); setMediaError(false); }}>{t("原始视频", "Original video")}</button><button className={source === 'described' ? 'active' : ''} disabled={!resultId} onClick={() => { setSource('described'); setMediaError(false); }}><Volume2 size={14} />{t("口述解说版", "Audio description")}</button></div></div>
        <div className="ws-player-stage">{videoUrl ? <><video key={videoUrl} ref={videoRef} tabIndex={0} src={videoUrl} controls playsInline preload="metadata" onTimeUpdate={event => setCurrentTime(event.currentTarget.currentTime)} onLoadedMetadata={event => { const target = source === 'original' ? pendingSourceSeek.current : pendingOutputSeek.current; if (target !== null) { event.currentTarget.currentTime = target; pendingSourceSeek.current = null; pendingOutputSeek.current = null; if (source === 'described') void event.currentTarget.play().catch(() => {}); } setCurrentTime(target ?? 0); setMediaError(false); }} onError={() => setMediaError(true)} aria-label={source === 'original' ? t("原始视频播放器", "Original video player") : t("口述解说视频播放器", "Audio description video player")} />{showSubtitles && activeCues.length > 0 && <div className="ws-subtitle-overlay ve-speaker-subtitles" aria-live="off">{activeCues.map(cue => <div key={cue.id}>{speakerMetadata && <span className="ve-subtitle-speaker">{speakerLabel(cue.speaker, t)}: </span>}{cue.text}</div>)}</div>}</> : <Loading text={t("正在加载视频…", "Loading video…")} />}{mediaError && <div className="ws-video-error"><Alert>{t("视频无法播放，请刷新后重试。", "Video cannot be played. Reload and try again.")}</Alert></div>}</div>
        <div className="ws-player-footer">{resultId && <Button size="small" appearance="subtle" icon={<Columns2 size={14} />} onClick={() => { videoRef.current?.pause(); setComparisonOpen(true); }}>{t('原声 / 口述', 'Original / Described')}</Button>}<span><Clock3 size={13} />{duration(currentTime)} / {duration(playerDuration)}</span><button className={showSubtitles ? 'active' : ''} onClick={() => setShowSubtitles(value => !value)} disabled={!transcript.cues.length} aria-pressed={showSubtitles}><Subtitles size={16} />{t("对白字幕", "Dialogue subtitles")}</button></div>
        {dialogueNotice && <div className="ws-notice" role="note"><div>{dialogueNotice}{dialogueReason && <small style={{ display: 'block', marginTop: 4 }}>{t('原因：', 'Reason: ') + dialogueReason}</small>}</div></div>}
      </section>




      {resultId && <section className="ve-studio-timeline" aria-label={t('视频时间轴', 'Video timeline')}><div><strong>{t('时间轴', 'Timeline')}</strong><span>{t('成片 ', 'Output ')}{duration(outputCurrentTime)} / {duration(resultDuration)}</span></div><label className="ws-sr-only" htmlFor="studio-scrub">{t('预览时间', 'Preview time')}</label><input id="studio-scrub" type="range" min={0} max={Math.max(0.1, resultDuration)} step={0.1} value={Math.min(outputCurrentTime, resultDuration)} onChange={event => seek(Number(event.target.value))} /><div className="ve-studio-timeline-lanes">{[['dialogue', t('对白', 'Dialogue'), transcript.cues.map(cue => ({ id: cue.id, start: cue.start, end: cue.end, text: cue.text }))], ['narration', t('口述', 'Narration'), segments.filter(item => item.pass).map(item => ({ id: String(item.segment_index), start: item.start_time, end: item.end_time, text: item.dvi_text }))]].map(([kind, label, entries]) => <div className="ve-studio-timeline-lane" key={kind as string}><span>{label as string}</span><div>{(entries as { id: string; start: number; end: number; text: string }[]).map(item => <button type="button" key={item.id} className={kind as string} aria-label={(label as string) + ' ' + duration(item.start) + ' ' + item.text} title={item.text} style={{ left: item.start / resultDuration * 100 + '%', width: Math.max(.6, (item.end - item.start) / resultDuration * 100) + '%' }} onClick={() => seek(item.start)} />)}</div></div>)}</div></section>}
    </div><div className="ve-studio-work-column">
      {stage === 'prepare' && !resultId && settingsPanel}
      {stage === 'generate' && progressPanel}
      {stage === 'quality' && resultId && <div className="ws-settings-panel"><StudioQualityReport dirty={dirty} jobId={resultId} transcriptError={transcriptError} editorError={editorError} /><Button appearance="subtle" onClick={() => setStageChoice('review')}>{t('返回审校', 'Return to review')}</Button></div>}
      <div hidden={stage !== 'review'} inert={stage !== 'review'}>    <section className="ws-editor-panel ws-studio-target" ref={editorPanelRef} tabIndex={-1} aria-label={t("校对文本", "Review text")}><div className="ws-editor-tabs" role="tablist" aria-label={t("视频文本编辑", "Video text editor")}><button role="tab" disabled={auxiliarySaving || reconciling || reviewActionBusy || studioReview.saving} aria-selected={tab === 'description'} className={tab === 'description' ? 'active' : ''} onClick={() => setTab('description')}><Volume2 size={16} />{t("口述解说", "Audio description")}<span>{segments.length}</span></button><button role="tab" disabled={auxiliarySaving || reconciling || reviewActionBusy || studioReview.saving} aria-selected={tab === 'dialogue'} className={tab === 'dialogue' ? 'active' : ''} onClick={() => { if (evidenceHasEdits) guard(() => { setEvidenceDirty({}); setTab('dialogue'); }); else setTab('dialogue'); }}><MessageSquareText size={16} />{t("对白字幕", "Dialogue subtitles")}<span>{transcript.cues.length}</span></button></div>
      {resultId && <div className="ws-editor-subheading">{tab === 'dialogue' && <button className="ws-text-button" disabled={busy || starting || saving || editorLoading || !!transcriptError || detail.project.archived || resultDuration <= 0} onClick={addSubtitle}><Plus size={13} />{t("添加字幕", "Add subtitle")}</button>}{(tab === 'description' ? narrationDirty : subtitleDirty) && <strong>{t("未保存", "Unsaved")}</strong>}{resultId && <button className="ws-icon-button" aria-label={t("重新加载当前版本文本", "Reload current version text")} title={t("重新加载当前版本文本", "Reload current version text")} disabled={editorLoading || busy || starting || saving} onClick={() => guard(() => setVersionReload(value => value + 1))}><RefreshCw size={13} /></button>}</div>}
      {tab === 'dialogue' && transcript.quality?.diarization_available && <p className="ve-dialogue-help">{t("说话人由音频区分，可手动调整；同时抢话可能漏识别，请核对原声。", "Speaker labels are audio-based and editable. Overlapping speech may be missed; check the original audio.")}</p>}
      {!resultId ? <div className="ws-editor-empty"><span><FileText size={30} strokeWidth={1.2} /></span><h3>{t("暂无文本", "No text yet")}</h3><p>{t("生成后可编辑口述稿与字幕。", "Generate a version to edit narration and subtitles.")}</p></div> : editorLoading ? <Loading text={t("正在加载文本…", "Loading text…")} /> : (tab === 'description' ? editorError : transcriptError) ? <div className="ws-editor-empty"><Alert>{tab === 'description' ? editorError : transcriptError}</Alert><button className="ws-button secondary" onClick={() => guard(() => setVersionReload(value => value + 1))}>{t("重新加载文本", "Reload text")}</button></div> : <>
        <div className="ws-cue-list" role="tabpanel" aria-label={tab === 'description' ? t("口述稿编辑", "Narration editor") : t("对白字幕编辑", "Dialogue subtitle editor")}>
          {tab === 'description' ? <StudioReviewPanel key={resultId + ':' + versionReload} jobId={resultId} segments={segments} savedSegments={savedSegments} language={versionLanguage} dirty={dirty} disabled={busy || starting || saving || detail.project.archived} review={studioReview.review} reviewLoading={studioReview.loading} reviewError={studioReview.error} onRefresh={() => void studioReview.refresh()} onReview={studioReview.update} onChange={(index, text) => setSegments(previous => previous.map(item => item.segment_index === index ? { ...item, dvi_text: text } : item))} onSeek={time => { setSource('described'); pendingSourceSeek.current = null; if (source === 'described' && videoRef.current) { videoRef.current.currentTime = time; void videoRef.current.play().catch(() => {}); } else pendingOutputSeek.current = time; }} onSourceSeek={seekEvidence} onCreateCharacter={createCharacter} onEvidenceDirty={markEvidenceDirty} onEvidenceBusy={markEvidenceSaving} evidenceEpoch={evidenceEpoch} onReviewRefresh={() => void studioReview.refresh()} onBusyChange={setReviewActionBusy} /> : transcript.cues.length ? transcript.cues.map((cue, index) => <article className={'ws-cue ws-dialogue-cue ' + (activeCues.some(active => active.id === cue.id) ? 'current' : '')} key={cue.id}><div className="ws-cue-head"><span className="ws-cue-index">{String(index + 1).padStart(2, '0')}</span><button onClick={() => seek(cue.start)} aria-label={t("跳转到字幕 ", "Jump to subtitle ") + (index + 1)}><Play size={11} fill="currentColor" />{duration(cue.start)} <span>—</span> {duration(cue.end)}</button></div><div className="ve-cue-speaker-row"><label>{t("说话人", "Speaker")}<select aria-label={t("字幕 ", "Subtitle ") + (index + 1) + t(" 说话人", " speaker")} value={cue.speaker ?? ''} disabled={busy || starting || saving || detail.project.archived} onChange={event => changeCue(index, { speaker: event.target.value || null })}><option value="">{speakerLabel(null, t)}</option>{speakerOptions.map(speaker => <option key={speaker} value={speaker}>{speakerLabel(speaker, t)}</option>)}</select></label>{cue.low_confidence && <small className="ws-validation-error">{t("识别待核对", "Check recognition")}</small>}<button className="ws-icon-button" aria-label={t("删除字幕 ", "Remove subtitle ") + (index + 1)} disabled={busy || starting || saving || detail.project.archived} onClick={() => setTranscript(previous => ({ ...previous, cues: previous.cues.filter(item => item.id !== cue.id) }))}><Trash2 size={13} /></button></div><textarea ref={node => { if (node && newCueId === cue.id) { node.focus(); node.scrollIntoView?.({ block: 'nearest' }); setNewCueId(null); } }} aria-label={t("对白字幕 ", "Dialogue subtitle ") + (index + 1)} value={cue.text} disabled={busy || starting || saving || detail.project.archived} onChange={event => changeCue(index, { text: event.target.value })} /><div className="ws-cue-time-fields"><label>{t("开始 ", "Start ")}<input aria-label={t("字幕 ", "Subtitle ") + (index + 1) + t(" 开始秒数", " start seconds")} type="number" min={0} step={0.01} value={Number.isFinite(cue.start) ? cue.start : ''} disabled={busy || starting || saving || detail.project.archived} onChange={event => changeCue(index, { start: event.target.value === '' ? NaN : Number(event.target.value) })} /></label><span>→</span><label>{t("结束 ", "End ")}<input aria-label={t("字幕 ", "Subtitle ") + (index + 1) + t(" 结束秒数", " end seconds")} type="number" min={0} step={0.01} value={Number.isFinite(cue.end) ? cue.end : ''} disabled={busy || starting || saving || detail.project.archived} onChange={event => changeCue(index, { end: event.target.value === '' ? NaN : Number(event.target.value) })} /></label><span>{t("秒", "s")}</span></div></article>) : <div className="ws-inline-empty"><Subtitles size={25} /><h3>{editor?.dialogue_status === 'unrecognized' ? t('对白未可靠识别', 'Dialogue could not be reliably transcribed') : editor?.dialogue_status === 'no_speech' ? t('没有可转写对白', 'No transcribable dialogue') : t('暂无对白字幕', 'No dialogue subtitles available')}</h3>{dialogueReason && <p>{dialogueReason}</p>}</div>}
        </div>
        <div className="ws-editor-actions">{tab === 'description' ? <><p>{languageLabel(versionLanguage, uiLanguage)}{chosenExecution ? ' · ' + dateTime(chosenExecution.start_date, uiLanguage) : ''}</p><label className="ws-field ws-render-voice"><span><Volume2 size={14} />{t("此版本配音音色", "Voice for this version")}</span><select aria-label={t("此版本配音音色", "Voice for this version")} value={renderVoice} disabled={busy || starting || detail.project.archived} onChange={event => setRenderVoice(event.target.value)}>{!validRenderVoice && <option value={renderVoice} disabled>{renderVoice || t("请选择音色", "Select a voice")}</option>}{versionVoices.map(option => <option key={option.id} value={option.id}>{voiceLabel(option, uiLanguage)}</option>)}</select></label><button className="ws-button primary" disabled={!segments.length || !narrationDirty || !validRenderVoice || busy || starting || subtitleDirty || characterDirty || evidenceHasEdits || detail.project.archived} onClick={() => { if (!speechReady) { onSetup(); return; } setConfirmation('render'); }}><Volume2 size={16} />{t("重新配音并保存新版本", "Revoice and save version")}</button>{subtitleDirty && <small>{t("请先保存对白字幕。", "Save dialogue subtitles first.")}</small>}{(characterDirty || evidenceHasEdits) && <small>{t("请先保存或撤销人物卡及画面纠错。", "Save or discard character and visual correction edits first.")}</small>}</> : <>{invalidCues && <p className="ws-validation-error">{t("请检查时间范围、字幕顺序及空白文本。只有不同且已确定的说话人可以同时出现。", "Check time ranges, subtitle order and empty text. Only different known speakers may overlap.")}</p>}<button className="ws-button primary" disabled={!subtitleDirty || invalidCues || saving || busy || starting || detail.project.archived} onClick={() => void saveSubtitles()}>{saving ? <LoaderCircle size={16} className="ws-spin" /> : <Save size={16} />}{saving ? t("正在保存…", "Saving…") : t("保存对白字幕", "Save dialogue subtitles")}</button><button className="ws-button secondary ws-calibrate-button" disabled={subtitleDirty || busy || starting || saving || detail.project.archived} onClick={() => { if (!speechReady) { onSetup(); return; } setConfirmation('calibrate'); }}>{calibrating ? <LoaderCircle size={16} className="ws-spin" /> : <RefreshCw size={16} />}{calibrating ? t("正在校准字幕…", "Calibrating subtitles…") : t("重新校准字幕", "Recalibrate subtitles")}</button><small>{subtitleDirty ? t("请先保存当前字幕。", "Save the current subtitles first.") : t("校准语言：", "Calibration language: ") + dialogueLanguageLabel(dialogueLanguage, uiLanguage)}</small>{transcript.quality?.review_required && <small className="ws-validation-error" role="note">{t("部分对白识别置信度较低，请核对原声。", "Some dialogue has low recognition confidence. Check the original audio.")}</small>}{canExport && !transcriptError && <div className="ws-subtitle-downloads"><a href={exportUrl(resultId, 'dialogue', 'srt')} download><Download size={13} />SRT</a><a href={exportUrl(resultId, 'dialogue', 'vtt')} download><Download size={13} />VTT</a></div>}<small>{t("修改仅更新字幕预览与下载。", "Edits update subtitle preview and downloads only.")}</small></>}</div>
      </>}
    </section></div></div></div>
    {resourcesMounted && <Drawer type="overlay" position="end" size="medium" unmountOnClose={false} modalType={resourcesOpen ? 'modal' : 'non-modal'} open={resourcesOpen} hidden={!resourcesOpen} inert={!resourcesOpen} style={!resourcesOpen ? { display: 'none' } : undefined} onOpenChange={(_event, data) => { if (!data.open) closeResources(); }}>
      <DrawerHeader><DrawerHeaderTitle action={<Button appearance="subtle" aria-label={t('关闭项目资源', 'Close project resources')} icon={<X size={18} />} onClick={closeResources} />}>{t('项目资源', 'Project resources')}</DrawerHeaderTitle></DrawerHeader>
      <DrawerBody className="ws-app ve-studio-resource-drawer"><CharacterPanel defaultOpen key={projectId} refreshKey={versionReload} automaticDetection={editor?.character_detection} ref={attachCharacterPanel} projectId={projectId} jobId={resultId} segments={segments} disabled={busy || starting || saving || editorLoading || detail.project.archived} onDirtyChange={setCharacterDirty} onBusyChange={setCharacterSaving} onApply={applyCharacterNames} onSaved={() => void studioReview.refresh()} /></DrawerBody>
    </Drawer>}
    <Drawer type="overlay" position="end" size="medium" open={settingsOpen && Boolean(resultId)} onOpenChange={(_event, data) => { if (!data.open && !starting) setSettingsOpen(false); }}>
      <DrawerHeader><DrawerHeaderTitle action={<Button appearance="subtle" aria-label={t('关闭生成设置', 'Close generation settings')} icon={<X size={18} />} disabled={starting} onClick={() => setSettingsOpen(false)} />}>{t('新版本设置', 'New version settings')}</DrawerHeaderTitle></DrawerHeader>
      <DrawerBody className="ws-app ve-studio-settings-drawer">{settingsPanel}</DrawerBody>
    </Drawer>
    {comparisonOpen && <ComparisonPreview video={detail.project} onClose={() => setComparisonOpen(false)} onEdit={() => { setComparisonOpen(false); setStageChoice('review'); }} />}
    {confirmation && <Modal title={confirmation === 'calibrate' ? t("重新校准对白字幕", "Recalibrate dialogue subtitles") : confirmation === 'render' ? t("重新配音并生成新版本", "Revoice and create a new version") : t("开始生成口述解说", "Generate audio description")} onClose={() => setConfirmation(null)} busy={starting}><p className="ws-confirm-copy">{confirmation === 'calibrate' ? dialogueLanguage === 'none' ? t("已选择无对白，将清除此版本已保存的对白字幕，不调用语音识别。口述配音与原片保持不变。", "No dialogue is selected. Saved dialogue subtitles for this version will be cleared without speech recognition. Narration and the source video stay unchanged.") : t("将把原片音频发送至 Azure Speech，按选定语言重新识别对白，校准字幕文字和时间码。完成后将覆盖此版本已保存的对白字幕，现有解说配音保留。", "Original audio will be sent to Azure Speech to transcribe dialogue in the selected language and calibrate text and timestamps. This replaces saved dialogue subtitles for this version and preserves existing narration.") : confirmation === 'render' ? t("将使用当前口述稿和选定音色重新合成语音，并混合到原始视频中。口述稿语言保持不变。", "The current script and selected voice will be synthesized and mixed with the original video. The script language stays unchanged.") : dialogueLanguage === 'none' ? t("已选择无对白，将跳过字幕识别。画面仍会发送至 Azure 生成口述稿，并调用语音合成生成配音。", "No dialogue is selected, so transcription will be skipped. Frames will still be sent to Azure for descriptions and speech synthesis will generate narration.") : t("将提取画面与音频发送至 Azure，生成口述稿和配音。自动模式在无足够对白间隙时暂停画面加入解说，成片会变长。", "Video frames and audio will be sent to Azure to generate narration and speech. In Auto mode, the picture pauses for narration when dialogue gaps are insufficient, extending the output.")}</p>{confirmation === 'generate' && detectCharacters && <p className="ws-confirm-copy">{t("同时识别明显的影视、动画角色并统一称呼，其余人物按外观区分，不推断真实身份。", "Also recognize distinctive film and animated characters and use consistent names. Other people are described by appearance without inferring real identities.")}</p>}<div className="ws-confirm-facts"><span>{t("当前视频", "Current video")}<strong>{detail.project.title}</strong></span>{confirmation !== 'render' && <span>{t("原片对白语言", "Original dialogue language")}<strong>{dialogueLanguageLabel(dialogueLanguage, uiLanguage)}</strong></span>}{confirmation !== 'calibrate' && <span>{t("解说语言", "Narration language")}<strong>{languageLabel(confirmation === 'render' ? versionLanguage : language, uiLanguage)}</strong></span>}{confirmation !== 'calibrate' && <span>{t("解说音色", "Narration voice")}<strong>{confirmation === 'render' ? renderVoiceName : voiceName}</strong></span>}{confirmation === 'render' && <span>{t("解说段落", "Narration segments")}<strong>{segments.length}{t(" 段", " segments")}</strong></span>}<span>{t("保存方式", "Save mode")}<strong>{confirmation === 'calibrate' ? t("替换此版本的对白字幕", "Replace subtitles for this version") : t("新建版本，保留历史", "Create a version and keep history")}</strong></span></div>{!(confirmation === 'calibrate' && dialogueLanguage === 'none') && <Alert>{t("将调用 Azure 云服务并按用量计费，实际金额以 Azure 账单为准。", "Azure cloud services charge by usage. Refer to your Azure bill for actual costs.")}</Alert>}<div className="ws-modal-actions"><button className="ws-button secondary" disabled={starting} onClick={() => setConfirmation(null)}>{confirmation === 'calibrate' ? t("取消校准", "Cancel calibration") : t("暂不生成", "Cancel")}</button><button className="ws-button primary" disabled={starting} onClick={() => void start()}>{starting ? <LoaderCircle size={16} className="ws-spin" /> : <Play size={16} />}{starting ? t("正在提交…", "Submitting…") : t("确认并开始", "Confirm and start")}</button></div></Modal>}
    {discardAction && <Modal title={t("有未保存的编辑", "Unsaved edits")} onClose={() => setDiscardAction(null)}><p className="ws-modal-intro">{t("继续会放弃当前版本中尚未保存的", "Continuing will discard unsaved changes to ")}{characterDirty || evidenceHasEdits ? t('人物卡或画面纠错', 'character cards or visual corrections') : narrationDirty && subtitleDirty ? t("口述稿、音色和字幕", "the script, voice and subtitles") : narrationDirty ? t("口述稿或音色", "the script or voice") : t("字幕", "subtitles")}{t("修改。", " in this version.")}</p><div className="ws-modal-actions"><button className="ws-button secondary" onClick={() => setDiscardAction(null)}>{t("继续编辑", "Continue editing")}</button><button className="ws-button danger" onClick={() => { const action = discardAction; setDiscardAction(null); setEvidenceDirty({}); setEvidenceEpoch(value => value + 1); characterRef.current?.discard(); setCharacterDirty(false); action(); }}>{t("放弃修改并继续", "Discard changes and continue")}</button></div></Modal>}
    {renameOpen && <Modal title={t("编辑视频名称", "Edit video name")} onClose={() => setRenameOpen(false)} busy={renaming}><form onSubmit={event => { event.preventDefault(); void rename(); }}><label className="ws-field">{t("视频名称", "Video name")}<input value={title} maxLength={120} onChange={event => setTitle(event.target.value)} /></label>{renameError && <Alert>{renameError}</Alert>}<div className="ws-modal-actions"><button type="button" className="ws-button secondary" onClick={() => setRenameOpen(false)} disabled={renaming}>{t("取消", "Cancel")}</button><button className="ws-button primary" disabled={renaming || !title.trim()}>{renaming ? t("保存中…", "Saving…") : t("保存名称", "Save name")}</button></div></form></Modal>}
  </main>;
}
