import { useEffect, useId, useState } from 'react';
import { ChevronDown, Image, Save, UserPlus } from 'lucide-react';
import { getSegmentEvidence, saveEvidenceFeedback } from '../../localWorkspaceApi';
import type { CharacterFrameSelection, EvidenceFeedback, EvidenceIssue, SegmentEvidence } from '../../localWorkspaceApi';
import { useUiPreferences } from '../../uiPreferences';
import { Alert, Loading } from './WorkspaceShared';
import { errorMessage } from './workspaceUtils';
import { frameTime } from './evidenceUtils';
import './evidence-characters.css';

interface Props {
  jobId: string; segmentIndex: number; disabled?: boolean; descriptionChanged?: boolean;
  onSeek: (sourceTime: number) => void;
  onCreateCharacter: (frame: CharacterFrameSelection) => void;
  onDirtyChange: (segmentIndex: number, dirty: boolean) => void;
  onBusyChange: (segmentIndex: number, busy: boolean) => void;
  defaultOpen?: boolean; onSaved?: () => void;
}

export default function EvidencePanel({ jobId, segmentIndex, disabled = false, descriptionChanged = false, onSeek, onCreateCharacter, onDirtyChange, onBusyChange, defaultOpen = false, onSaved }: Props) {
  const { t, language } = useUiPreferences();
  const panelId = useId();
  const [open, setOpen] = useState(defaultOpen);
  const [showAllFrames, setShowAllFrames] = useState(false);
  const [evidence, setEvidence] = useState<SegmentEvidence | null>(null);
  const [feedback, setFeedback] = useState<EvidenceFeedback | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const dirty = Boolean(feedback && evidence && JSON.stringify(feedback) !== JSON.stringify(evidence.feedback));
  useEffect(() => { onDirtyChange(segmentIndex, dirty); }, [dirty, onDirtyChange, segmentIndex]);
  useEffect(() => { onBusyChange(segmentIndex, saving); }, [saving, onBusyChange, segmentIndex]);
  useEffect(() => {
    if (!defaultOpen) return;
    let active = true; setLoading(true);
    getSegmentEvidence(jobId, segmentIndex).then(result => { if (active) { setEvidence(result); setFeedback(result.feedback); } }).catch(reason => { if (active) setError(errorMessage(reason)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [defaultOpen, jobId, segmentIndex]);

  async function load() {
    setLoading(true); setError('');
    try {
      const result = await getSegmentEvidence(jobId, segmentIndex);
      setEvidence(result); setFeedback(result.feedback);
    } catch (reason) { setError(errorMessage(reason, language)); }
    finally { setLoading(false); }
  }
  function toggle() {
    setOpen(value => !value);
    if (!open && !evidence && !loading) void load();
  }
  async function save() {
    if (!feedback) return;
    setSaving(true); setError(''); setNotice('');
    try {
      const result = await saveEvidenceFeedback(jobId, segmentIndex, feedback);
      setFeedback(result); setEvidence(previous => previous ? { ...previous, feedback: result } : previous);
      setNotice(t('纠错记录已保存。', 'Correction saved.'));
      onSaved?.();
    } catch (reason) { setError(errorMessage(reason, language)); }
    finally { setSaving(false); }
  }
  const issues: [EvidenceIssue, string][] = [
    ['wrong_person', t('人物有误', 'Wrong person')], ['wrong_action', t('动作有误', 'Wrong action')], ['missing_content', t('内容遗漏', 'Missing content')],
  ];

  return <div className="ve-evidence">
    <button type="button" className="ve-evidence-toggle" aria-expanded={open} aria-controls={panelId} onClick={toggle}><Image size={14} />{t('查看画面依据', 'View visual evidence')}<ChevronDown size={14} />{dirty && <span>{t('未保存', 'Unsaved')}</span>}</button>
    {open && <div id={panelId} className="ve-evidence-body">
      {loading && <Loading text={t('正在加载画面…', 'Loading frames…')} />}
      {evidence && !loading && <>
        <p className="ve-evidence-caption">{evidence.provenance === 'model' ? t('生成时的画面记录', 'Visual records from generation') : t('回看画面，非生成时依据', 'Review frames, not generation evidence')} · {frameTime(evidence.source_start)}–{frameTime(evidence.source_end)}</p>
        {descriptionChanged && <p className="ve-evidence-caption" role="note">{t('当前文字已修改，请对照原片核对。', 'The draft text has changed. Check it against the source video.')}</p>}
        <div className="ve-evidence-frames">{(showAllFrames ? evidence.frames : evidence.frames.slice(0, 3)).map(frame => <figure key={frame.id}>
          <button type="button" className="ve-evidence-frame" aria-label={t('查看原片 ', 'View source at ') + frameTime(frame.timestamp)} onClick={() => onSeek(frame.timestamp)}><img src={frame.url} alt={t('原片画面 ', 'Source frame ') + frameTime(frame.timestamp)} loading="lazy" /><span>{frameTime(frame.timestamp)}</span></button>
          <button type="button" className="ve-evidence-person" disabled={disabled} onClick={() => onCreateCharacter({ job_id: jobId, segment_index: segmentIndex, frame_id: frame.id, timestamp: frame.timestamp, url: frame.url })}><UserPlus size={12} />{t('添加人物', 'Add character')}</button>
        </figure>)}</div>
        {evidence.frames.length > 3 && <button type="button" className="ws-text-button" onClick={() => setShowAllFrames(value => !value)}>{showAllFrames ? t('收起其余画面', 'Show fewer frames') : t('查看其余画面 ', 'View remaining frames ') + (evidence.frames.length - 3)}</button>}
        {evidence.nearby_dialogue && <details className="ve-evidence-caption"><summary>{t('此时已有的原声信息', 'Nearby dialogue context')}</summary>{evidence.nearby_dialogue.length ? evidence.nearby_dialogue.map((cue, index) => <p key={index}>{cue.text}</p>) : <p>{t('此窗口附近没有识别到对白。', 'No dialogue was detected near this window.')}</p>}</details>}
        {evidence.observations.length > 0 ? <ul className="ve-observations">{evidence.observations.map((observation, index) => <li key={index}>{observation.fact}<span>{observation.frame_ids.map(id => evidence.frames.find(frame => frame.id === id)).filter(frame => frame !== undefined).map(frame => <button type="button" key={frame.id} onClick={() => onSeek(frame.timestamp)}>{frameTime(frame.timestamp)}</button>)}</span></li>)}</ul> : <p className="ve-evidence-caption">{t('此版本没有保存逐条画面观察，可对照原片校对。', 'This version has no saved visual observations. Review it against the source video.')}</p>}
        {feedback && <fieldset className="ve-evidence-feedback" disabled={disabled || saving}>
          <legend>{t('标记问题', 'Flag an issue')}</legend>
          <div className="ve-issue-tags">{issues.map(([value, label]) => <label key={value}><input type="checkbox" checked={feedback.issues.includes(value)} onChange={event => { const checked = event.target.checked; setFeedback(previous => previous ? { ...previous, issues: checked ? [...previous.issues, value] : previous.issues.filter(issue => issue !== value) } : previous); }} />{label}</label>)}</div>
          <textarea aria-label={t('画面纠错说明', 'Visual correction note')} value={feedback.note} maxLength={2000} placeholder={t('补充说明（可选）', 'Optional note')} onChange={event => setFeedback(previous => previous ? { ...previous, note: event.target.value } : previous)} />
          <div className="ve-inline-actions"><button type="button" className="ws-button secondary" disabled={!dirty} onClick={() => void save()}><Save size={13} />{saving ? t('保存中…', 'Saving…') : t('保存纠错', 'Save correction')}</button>{dirty && <button type="button" className="ws-text-button" onClick={() => { setFeedback(evidence.feedback); setError(''); }}>{t('撤销修改', 'Discard edits')}</button>}</div>
        </fieldset>}
      </>}
      {error && <Alert>{error}{!evidence && <button className="ws-text-button" type="button" disabled={loading} onClick={() => void load()}>{t('重试', 'Retry')}</button>}{evidence && <span>{t(' 当前修改已保留；重新加载会丢弃本段纠错草稿。', ' Your edits are retained. Reloading discards this correction draft.')}<button className="ws-text-button" type="button" disabled={loading || saving} onClick={() => void load()}>{t('丢弃并重新加载', 'Discard and reload')}</button></span>}</Alert>}
      {notice && <span role="status" className="ve-evidence-caption">{notice}</span>}
    </div>}
  </div>;
}
