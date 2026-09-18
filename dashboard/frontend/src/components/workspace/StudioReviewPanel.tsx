import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Menu, MenuTrigger, MenuPopover, MenuList, MenuItem, TabList, Tab } from '@fluentui/react-components';
import { Check, ChevronDown, Play, RotateCcw } from 'lucide-react';
import { rewriteSegment } from '../../localWorkspaceApi';
import type { CharacterFrameSelection, NarrationSegment, SegmentReviewState, StudioReviewDocument, VideoLanguage } from '../../localWorkspaceApi';
import { useUiPreferences } from '../../uiPreferences';
import EvidencePanel from './EvidencePanel';
import { duration } from './workspaceUtils';
import './studio-review.css';

import { reviewRiskLabel } from './reviewLabels';
interface Props {
  jobId: string; segments: NarrationSegment[]; savedSegments: NarrationSegment[]; language: VideoLanguage;
  dirty: boolean; disabled: boolean; review: StudioReviewDocument | null; reviewLoading: boolean; reviewError: string;
  onRefresh: () => void; onReview: (index: number, state: SegmentReviewState) => Promise<void>;
  onChange: (index: number, text: string) => void; onSeek: (time: number) => void; onSourceSeek: (time: number) => void;
  onCreateCharacter: (frame: CharacterFrameSelection) => void; onEvidenceDirty: (index: number, dirty: boolean) => void;
  onEvidenceBusy: (index: number, busy: boolean) => void; evidenceEpoch: number; onReviewRefresh: () => void;
  onBusyChange?: (busy: boolean) => void;
}

export default function StudioReviewPanel(props: Props) {
  const { t } = useUiPreferences();
  const [filter, setFilter] = useState('all');
  const [working, setWorking] = useState<number | null>(null);
  const [actionError, setActionError] = useState('');
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const onBusyChange = props.onBusyChange;
  useEffect(() => { onBusyChange?.(working !== null); }, [working, onBusyChange]);
  useEffect(() => () => { onBusyChange?.(false); }, [onBusyChange]);
  const { segments, review, disabled, dirty } = props;
  const rows = segments.map(segment => {
    const saved = props.savedSegments.find(item => item.segment_index === segment.segment_index);
    const metadata = review?.segments.find(item => item.segment_index === segment.segment_index);
    const changed = segment.dvi_text !== saved?.dvi_text;
    const units = props.language === 'zh-CN' ? (segment.dvi_text.match(/[\p{Script=Han}]|[A-Za-z0-9]+/gu)?.length ?? 0) : (segment.dvi_text.trim().match(/\S+/g)?.length ?? 0);
    const available = metadata?.available_seconds ?? segment.silence_duration;
    const speech = changed ? units / (props.language === 'zh-CN' ? 3.8 : 2.15) : metadata?.speech_seconds ?? segment.audio_duration ?? units / (props.language === 'zh-CN' ? 3.8 : 2.15);
    const risks = [...(metadata?.risks ?? [])];
    if (changed && speech > available + .03 && !risks.includes('duration_conflict')) risks.push('duration_conflict');
    if (!segment.dvi_text.trim() && !risks.includes('empty_text')) risks.push('empty_text');
    const conflict = risks.some(risk => ['duration_conflict', 'dialogue_overlap', 'narration_overlap', 'name_spoiler'].includes(risk));
    const uncertain = risks.some(risk => ['uncertain_visual_evidence', 'unverified_visual_evidence', 'unverified_transcript', 'uncertain_transcript', 'evidence_feedback'].includes(risk));
    const state = changed ? 'modified' : metadata?.state ?? 'draft';
    return { segment, metadata, changed, state, available, speech, risks, conflict, uncertain };
  });
  const counts = { all: rows.length, pending: rows.filter(row => row.state !== 'approved').length, conflicts: rows.filter(row => row.conflict).length, uncertain: rows.filter(row => row.uncertain && row.state !== 'approved').length, approved: rows.filter(row => row.state === 'approved').length };
  const filtered = rows.filter(row => filter === 'all' || filter === 'pending' && row.state !== 'approved' || filter === 'conflicts' && row.conflict || filter === 'uncertain' && row.uncertain && row.state !== 'approved' || filter === 'approved' && row.state === 'approved');
  const labels: Record<string, string> = { draft: t('AI 草稿', 'AI draft'), modified: t('已修改', 'Modified'), approved: t('已批准', 'Approved'), needs_rewrite: t('需要重写', 'Needs rewrite') };
  async function action(index: number, state: SegmentReviewState) {
    setWorking(index); setActionError('');
    try { await props.onReview(index, state); } catch (reason) { if (active.current) setActionError(reason instanceof Error ? reason.message : t('保存失败，请重试。', 'Save failed. Retry.')); }
    finally { if (active.current) setWorking(null); }
  }
  async function rewrite(segment: NarrationSegment, kind: 'shorten' | 'objective' | 'atmosphere') {
    setWorking(segment.segment_index); setActionError('');
    try { const result = await rewriteSegment(props.jobId, segment.segment_index, segment.dvi_text, kind); if (active.current) props.onChange(segment.segment_index, result.text); }
    catch (reason) { if (active.current) setActionError(reason instanceof Error ? reason.message : t('改写失败，请重试。', 'Rewrite failed. Retry.')); }
    finally { if (active.current) setWorking(null); }
  }
  return <div className="ve-review">
    <div className="ve-review-summary"><strong>{t('待审校', 'To review')} {counts.pending} / {counts.all}</strong><span>{t('时长或对白冲突', 'Timing conflicts')} {counts.conflicts}</span><span>{t('不确定信息', 'Uncertain')} {counts.uncertain}</span><span>{t('已批准', 'Approved')} {counts.approved}</span></div>
    <TabList size="small" selectedValue={filter} onTabSelect={(_, data) => setFilter(String(data.value))} aria-label={t('审校筛选', 'Review filters')} className="ve-review-filters">{[['all', t('全部', 'All')], ['pending', t('待审校', 'To review')], ['conflicts', t('冲突', 'Conflicts')], ['uncertain', t('待核实', 'Uncertain')], ['approved', t('已批准', 'Approved')]].map(([key, label]) => <Tab key={key} value={key}>{label} {counts[key as keyof typeof counts]}</Tab>)}</TabList>
    {(props.reviewError || actionError) && <div role="alert" className="ws-alert">{actionError || props.reviewError}<Button size="small" onClick={props.onRefresh} disabled={working !== null}>{t('重新检查', 'Recheck')}</Button></div>}
    {props.reviewLoading && <p className="ve-review-note" role="status">{t('正在检查保存版本…', 'Checking the saved version…')}</p>}
    {dirty && <p className="ve-review-note">{t('修改后的口述稿需重新配音保存为新版本，之后再批准。预计时长仅供参考。', 'Revoice changed narration into a new version before approval. Estimated durations are a guide.')}</p>}
    <div className="ve-review-queue">{rows.map(row => { const { segment, state, risks, available, speech, metadata, changed } = row; return <article key={segment.segment_index} hidden={!filtered.includes(row)} className={'ve-review-segment ' + (state === 'approved' ? 'is-approved' : '')}>
      <div className="ve-review-segment-head"><button type="button" onClick={() => props.onSeek(segment.start_time)}>{String(segment.segment_index + 1).padStart(2, '0')} <span>{duration(segment.start_time)}–{duration(segment.end_time)}</span></button><Badge appearance="tint" color={state === 'approved' ? 'success' : state === 'needs_rewrite' ? 'warning' : 'informative'}>{labels[state]}</Badge></div>
      <label className="ws-sr-only" htmlFor={'segment-text-' + segment.segment_index}>{t('口述稿 ', 'Narration ') + (segment.segment_index + 1)}</label><textarea id={'segment-text-' + segment.segment_index} value={segment.dvi_text} disabled={disabled || working !== null} maxLength={2000} rows={3} onChange={event => props.onChange(segment.segment_index, event.target.value)} />
      <div className="ve-review-timing"><span>{t('可用窗口', 'Available')} <b>{available.toFixed(2)}s</b></span><span>{changed || metadata?.timing_source !== 'measured' ? t('预计播报', 'Estimated speech') : t('实测播报', 'Measured speech')} <b>{speech.toFixed(2)}s</b></span><span className={speech > available + .03 ? 've-review-conflict' : ''}>{t('剩余时间', 'Margin')} <b>{(available - speech).toFixed(2)}s</b></span></div>
      {risks.length > 0 && <div className="ve-review-risks">{risks.map(risk => <span key={risk}>{reviewRiskLabel(risk, t)}</span>)}</div>}
      <EvidencePanel key={props.jobId + ':' + props.evidenceEpoch + ':' + segment.segment_index} jobId={props.jobId} segmentIndex={segment.segment_index} disabled={disabled || working !== null} descriptionChanged={changed} onSeek={props.onSourceSeek} onCreateCharacter={props.onCreateCharacter} onDirtyChange={props.onEvidenceDirty} onBusyChange={props.onEvidenceBusy} onSaved={props.onReviewRefresh} defaultOpen />
      <div className="ve-review-actions"><Button size="small" icon={<Play size={13} />} onClick={() => props.onSeek(segment.start_time)}>{t('定位试听', 'Preview')}</Button><Menu><MenuTrigger disableButtonEnhancement><Button size="small" disabled={disabled || working !== null || !segment.dvi_text.trim()} icon={<ChevronDown size={13} />} iconPosition="after">{t('改写', 'Rewrite')}</Button></MenuTrigger><MenuPopover><MenuList><MenuItem onClick={() => void rewrite(segment, 'shorten')}>{t('缩短到可用时间', 'Shorten to fit')}</MenuItem><MenuItem onClick={() => void rewrite(segment, 'objective')}>{t('改为客观描述', 'Make objective')}</MenuItem><MenuItem onClick={() => void rewrite(segment, 'atmosphere')}>{t('增加氛围细节', 'Add atmosphere')}</MenuItem></MenuList></MenuPopover></Menu><Button size="small" appearance="subtle" disabled={disabled || dirty || working !== null || !metadata} onClick={() => void action(segment.segment_index, 'needs_rewrite')} icon={<RotateCcw size={13} />}>{t('待重写', 'Needs rewrite')}</Button><Button size="small" appearance={state === 'approved' ? 'secondary' : 'primary'} disabled={disabled || dirty || working !== null || props.reviewLoading || !!props.reviewError || !metadata || (!segment.dvi_text.trim()) || (state !== 'approved' && metadata.high_risk)} onClick={() => void action(segment.segment_index, state === 'approved' ? 'draft' : 'approved')} icon={<Check size={13} />}>{working === segment.segment_index ? t('处理中', 'Working') : state === 'approved' ? t('撤销批准', 'Revoke approval') : t('批准', 'Approve')}</Button></div>
    </article>; })}</div>
    {!filtered.length && <p className="ve-review-empty">{t('此筛选下没有段落。', 'No segments match this filter.')}<Button appearance="subtle" onClick={() => setFilter('all')}>{t('显示全部', 'Show all')}</Button></p>}
  </div>;
}
