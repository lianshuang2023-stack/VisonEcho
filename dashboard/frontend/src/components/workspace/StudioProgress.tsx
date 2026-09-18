import { Check, CircleAlert, LoaderCircle } from 'lucide-react';
import type { ExecutionStatus, ProjectExecution } from '../../types';
import { useUiPreferences } from '../../uiPreferences';

export default function StudioProgress({ execution }: { execution: ExecutionStatus | null }) {
  const { t } = useUiPreferences();
  const groups = [
    { name: t('准备视频', 'Prepare video'), steps: ['ValidateInput'] },
    { name: t('对白与时间', 'Dialogue & timing'), steps: ['TranscribeVideo', 'SilenceDetection', 'ExtractSilenceSegments', 'DetectSilence'] },
    { name: t('画面与人物', 'Scenes & characters'), steps: ['AnalyzeSilenceSegments', 'AnalyzeSegments', 'DetectCharacters'] },
    { name: t('口述稿与配音', 'Script & narration'), steps: ['GenerateDVI', 'SynthesizeAudio'] },
    { name: t('合成与保存', 'Mix & save'), steps: ['MixAudioTracks', 'RecordSummary'] },
  ];
  const steps = execution?.steps ?? [];
  const knownSteps = new Set(steps.map(step => step.name));
  const isRender = (execution as ProjectExecution | null)?.kind === 'render' || (knownSteps.has('SynthesizeAudio') && knownSteps.has('MixAudioTracks') && knownSteps.has('RecordSummary') && !knownSteps.has('TranscribeVideo') && !knownSteps.has('GenerateDVI'));
  const fullPlan = knownSteps.has('ValidateInput') && knownSteps.has('RecordSummary');
  const validCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && Number.isInteger(value);
  return <ol className="ve-studio-progress-groups">{groups.map((group, index) => {
    const members = steps.filter(step => group.steps.includes(step.name));
    const completed = members.filter(step => step.status === 'succeeded').length;
    const laterStarted = steps.some(step => groups.slice(index + 1).some(later => later.steps.includes(step.name)) && step.status !== 'pending');
    const complete = members.length > 0 && completed === members.length && (fullPlan || execution?.status === 'SUCCEEDED' || laterStarted);
    const skipped = isRender && !members.length && (index === 1 || index === 2);
    const status = members.some(step => step.status === 'failed') ? 'failed' : complete ? 'succeeded' : skipped ? 'skipped' : members.some(step => step.status === 'running') || completed > 0 ? 'running' : 'pending';
    const progress = [...members].reverse().find(step => step.status === 'running' && validCount(step.detail?.completed_segments) && validCount(step.detail?.num_segments) && step.detail!.completed_segments! <= step.detail!.num_segments!);
    const frames = members.find(step => validCount(step.detail?.frame_count))?.detail?.frame_count;
    return <li key={index} className={status}><span className="ve-studio-progress-icon">{status === 'succeeded' ? <Check size={16} /> : status === 'running' ? <LoaderCircle size={16} className="ws-spin" /> : status === 'failed' ? <CircleAlert size={16} /> : skipped ? '—' : index + 1}</span><div><strong>{group.name}</strong><p>{status === 'running' ? t('处理中', 'In progress') : status === 'succeeded' ? t('已完成', 'Complete') : status === 'failed' ? t('处理失败', 'Failed') : skipped ? t('沿用已有结果', 'Using saved results') : t('等待处理', 'Waiting')}{members.length > 0 && <span> · {completed}/{members.length} {t('步骤完成', 'steps complete')}</span>}</p>{progress && <p>{progress.detail!.completed_segments}/{progress.detail!.num_segments} {t('段处理完成', 'segments processed')}</p>}{frames !== undefined && <p>{frames} {t('帧画面', 'frames')}</p>}</div></li>;
  })}</ol>;
}
