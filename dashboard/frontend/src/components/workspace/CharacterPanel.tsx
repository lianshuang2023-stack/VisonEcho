import { useEffect, useImperativeHandle, useState } from 'react';
import type { Ref } from 'react';
import { ChevronDown, Pencil, Plus, Users } from 'lucide-react';
import { getCharacters, saveCharacters } from '../../localWorkspaceApi';
import type { CharacterFrameSelection, CharacterLibrary, NarrationSegment, VideoCharacter } from '../../localWorkspaceApi';
import { useUiPreferences } from '../../uiPreferences';
import { Alert, Loading, Modal } from './WorkspaceShared';
import { errorMessage } from './workspaceUtils';
import { frameTime } from './evidenceUtils';
import './evidence-characters.css';
import { proposeCharacterRenames } from './characterUtils';
import type { NarrationReplacement } from './characterUtils';

export interface CharacterPanelHandle { createFromFrame: (frame: CharacterFrameSelection) => void; discard: () => void }
const emptyCharacter = (): VideoCharacter => ({ id: '', appearance: '', preferred_name: '', status: 'unconfirmed', aliases: [], thumbnail: null, occurrences: [] });
const code = (character: VideoCharacter) => 'P-' + character.id.slice(0, 8).toUpperCase();
interface Props {
  projectId: string; jobId: string; segments: NarrationSegment[]; disabled?: boolean;
  ref?: Ref<CharacterPanelHandle>; onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void; onApply: (replacements: NarrationReplacement[]) => void;
}

export default function CharacterPanel({ projectId, jobId, segments, disabled = false, ref, onDirtyChange, onBusyChange, onApply }: Props) {
  const { t, language } = useUiPreferences();
  const [open, setOpen] = useState(false);
  const [library, setLibrary] = useState<CharacterLibrary | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<VideoCharacter | null>(null);
  const [baseline, setBaseline] = useState<VideoCharacter | null>(null);
  const [frame, setFrame] = useState<CharacterFrameSelection | null>(null);
  const [aliases, setAliases] = useState('');
  const [discardOpen, setDiscardOpen] = useState(false);
  const [proposals, setProposals] = useState<NarrationReplacement[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [notice, setNotice] = useState('');
  const draftDirty = Boolean(draft && (JSON.stringify(draft) !== JSON.stringify(baseline) || aliases !== (baseline?.aliases.join(', ') ?? '')));
  useEffect(() => { onDirtyChange(draftDirty); }, [draftDirty, onDirtyChange]);
  useEffect(() => { onBusyChange(saving); }, [saving, onBusyChange]);

  async function load(): Promise<CharacterLibrary | null> {
    setLoading(true); setError('');
    try { const result = await getCharacters(projectId); setLibrary(result); return result; }
    catch (reason) { setError(errorMessage(reason, language)); return null; }
    finally { setLoading(false); }
  }
  function edit(character: VideoCharacter, selectedFrame: CharacterFrameSelection | null = null) {
    const next = { ...character, aliases: [...character.aliases], occurrences: [...character.occurrences] };
    setBaseline(character); setFrame(selectedFrame);
    if (selectedFrame) {
      if (!next.thumbnail) next.thumbnail = selectedFrame;
      if (!next.occurrences.some(item => item.job_id === selectedFrame.job_id && item.segment_index === selectedFrame.segment_index)) next.occurrences.push({ job_id: selectedFrame.job_id, segment_index: selectedFrame.segment_index });
    }
    setDraft(next); setAliases(next.aliases.join(', ')); setError(''); setNotice('');
  }
  function discard() { setDraft(null); setBaseline(null); setFrame(null); setDiscardOpen(false); setProposals([]); }
  async function createFromFrame(selectedFrame: CharacterFrameSelection) {
    setOpen(true);
    const records = library ?? await load();
    if (records) edit(emptyCharacter(), selectedFrame);
  }
  useImperativeHandle(ref, () => ({ createFromFrame: selectedFrame => { void createFromFrame(selectedFrame); }, discard }));
  function close() { if (draftDirty) setDiscardOpen(true); else discard(); }
  function checkNames(character: VideoCharacter) {
    const matches = proposeCharacterRenames(character, character, jobId, segments);
    setProposals(matches); setSelected([]);
    if (!matches.length) setNotice(t('当前口述稿没有需要替换的已知别名。', 'No known aliases need replacement in the current script.'));
  }
  async function save() {
    if (!draft || !library) return;
    const next = { ...draft, appearance: draft.appearance.trim(), preferred_name: draft.preferred_name.trim(), aliases: [...new Set(aliases.replaceAll(String.fromCharCode(10), ',').split(/[,，]/).map(value => value.trim()).filter(Boolean))] };
    if (baseline?.preferred_name && baseline.preferred_name !== next.preferred_name && !next.aliases.includes(baseline.preferred_name)) next.aliases.push(baseline.preferred_name);
    if (next.aliases.length > 20 || next.aliases.some(alias => alias.length > 100)) { setError(t('别名最多 20 个，每个不超过 100 字。', 'Use at most 20 aliases, each at most 100 characters.')); return; }
    setSaving(true); setError('');
    try {
      const result = await saveCharacters(projectId, { revision: library.revision, characters: next.id ? library.characters.map(item => item.id === next.id ? next : item) : [...library.characters, next] });
      const replacements = baseline?.id ? proposeCharacterRenames(baseline, next, jobId, segments) : [];
      setLibrary(result); setDraft(null); setBaseline(null); setFrame(null);
      setProposals(replacements); setSelected([]);
      setNotice(t('人物卡已保存。已确认称呼将用于后续生成。', 'Character saved. Confirmed names will be used in future generations.'));
    } catch (reason) { setError(errorMessage(reason, language)); }
    finally { setSaving(false); }
  }
  const valid = Boolean(draft?.appearance.trim() && (draft.status !== 'confirmed' || draft.preferred_name.trim()));

  return <section className="ve-character-panel" aria-label={t('人物卡', 'Character cards')}>
    <button className="ve-character-heading" type="button" aria-expanded={open} onClick={() => { setOpen(value => !value); if (!open && !library && !loading) void load(); }}><Users size={17} /><strong>{t('人物卡', 'Character cards')}</strong>{library && <span>{library.characters.length}</span>}<ChevronDown size={15} /></button>
    {open && <div className="ve-character-body">
      {loading && <Loading />}
      {library && <><p className="ve-evidence-caption">{t('按外观区分人物，确认后统一后续版本的称呼。', 'Identify characters by appearance and confirm names for future versions.')}</p>
        <div className="ve-character-list">{library.characters.map(character => <article key={character.id} className="ve-character-card">
          {character.thumbnail ? <img src={character.thumbnail.url} alt={character.appearance} loading="lazy" /> : <span className="ve-character-placeholder"><Users size={21} /></span>}
          <div><small>{code(character)}</small><strong>{character.preferred_name || t('未命名人物', 'Unnamed character')}</strong><p>{character.appearance}</p>{character.thumbnail && <small>{t('原片 ', 'Source ') + frameTime(character.thumbnail.timestamp)}</small>}<span>{character.status === 'confirmed' ? t('已确认', 'Confirmed') : t('待确认', 'Unconfirmed')}</span></div>
          <div className="ve-character-card-actions"><button className="ws-icon-button" type="button" disabled={disabled} aria-label={t('编辑人物 ', 'Edit character ') + (character.preferred_name || code(character))} onClick={() => edit(character)}><Pencil size={14} /></button><button className="ws-text-button" type="button" disabled={disabled || !character.preferred_name || !jobId} onClick={() => checkNames(character)}>{t('检查称呼', 'Check names')}</button></div>
        </article>)}</div>
        {!library.characters.length && <p className="ve-evidence-caption">{t('可从口述稿的画面依据中添加人物。', 'Add characters from the visual evidence beside a narration segment.')}</p>}
        <button className="ws-button secondary" type="button" disabled={disabled || library.characters.length >= 40} onClick={() => edit(emptyCharacter())}><Plus size={14} />{t('新增人物卡', 'New character card')}</button>
      </>}
      {error && !draft && <Alert>{error}<button className="ws-text-button" type="button" onClick={() => void load()}>{t('重试', 'Retry')}</button></Alert>}
      {notice && <p role="status" className="ve-evidence-caption">{notice}</p>}
    </div>}
    {draft && !discardOpen && <Modal title={draft.id ? t('编辑人物卡', 'Edit character card') : t('添加人物卡', 'Add character card')} onClose={close} busy={saving}>
      <form onSubmit={event => { event.preventDefault(); void save(); }} className="ve-character-form">
        {frame && <label className="ws-field">{t('关联人物', 'Link character')}<select value={draft.id} disabled={saving} onChange={event => edit(library?.characters.find(item => item.id === event.target.value) ?? emptyCharacter(), frame)}><option value="">{t('新人物', 'New character')}</option>{library?.characters.map(item => <option value={item.id} key={item.id}>{item.preferred_name || code(item)} · {item.appearance}</option>)}</select></label>}
        {draft.thumbnail && <img className="ve-character-preview" src={draft.thumbnail.url} alt={t('人物所在画面，请用外观说明区分', 'Frame containing the character; distinguish them by appearance')} />}
        {draft.id && <small>{code(draft)}</small>}
        {draft.thumbnail && <small>{t('原片时间 ', 'Source time ') + frameTime(draft.thumbnail.timestamp)}</small>}
        <label className="ws-field">{t('外观特征', 'Appearance')}<textarea aria-label={t('人物外观特征', 'Character appearance')} value={draft.appearance} required maxLength={600} disabled={saving} placeholder={t('例如：画面左侧穿红色外套的短发女性', 'For example: short-haired woman in a red coat on the left')} onChange={event => setDraft({ ...draft, appearance: event.target.value })} /></label>
        <label className="ws-field">{t('统一称呼', 'Preferred name')}<input aria-label={t('人物统一称呼', 'Character preferred name')} value={draft.preferred_name} maxLength={100} disabled={saving} onChange={event => setDraft({ ...draft, preferred_name: event.target.value })} /></label>
        <label className="ws-field">{t('此前称呼 / 别名', 'Previous names / aliases')}<input aria-label={t('人物别名', 'Character aliases')} value={aliases} disabled={saving} placeholder={t('以逗号分隔', 'Separate with commas')} onChange={event => setAliases(event.target.value)} /></label>
        <label className="ve-confirm-character"><input type="checkbox" checked={draft.status === 'confirmed'} disabled={saving} onChange={event => setDraft({ ...draft, status: event.target.checked ? 'confirmed' : 'unconfirmed' })} />{t('已确认此人物及称呼', 'Confirm this character and name')}</label>
        {error && <Alert>{error}<span>{t(' 当前人物修改已保留。版本冲突时请取消编辑，再重新加载人物卡。', ' Your character edits are retained. For a revision conflict, cancel editing and reload the cards.')}</span></Alert>}
        <div className="ws-modal-actions"><button type="button" className="ws-button secondary" disabled={saving} onClick={close}>{t('取消', 'Cancel')}</button><button className="ws-button primary" disabled={saving || disabled || !valid || !draftDirty}>{saving ? t('保存中…', 'Saving…') : t('保存人物卡', 'Save character')}</button></div>
      </form>
    </Modal>}
    {discardOpen && <Modal title={t('人物卡尚未保存', 'Unsaved character card')} onClose={() => setDiscardOpen(false)}><p>{t('是否放弃当前人物卡修改？', 'Discard the current character edits?')}</p><div className="ws-modal-actions"><button className="ws-button secondary" onClick={() => setDiscardOpen(false)}>{t('继续编辑', 'Keep editing')}</button><button className="ws-button danger" onClick={discard}>{t('放弃修改', 'Discard changes')}</button></div></Modal>}
    {proposals.length > 0 && <Modal title={t('更新当前口述稿中的称呼', 'Update names in the current script')} onClose={() => setProposals([])}><p className="ws-modal-intro">{t('检查当前口述稿中的称呼。可能相关的段落需核对后选择；应用后仍需重新配音。历史版本不会改变。', 'Check names in the current script. Review possible matches before selecting, then revoice. Previous versions remain unchanged.')}</p><div className="ve-name-proposals">{proposals.map(proposal => <label key={proposal.segmentIndex}><input type="checkbox" checked={selected.includes(proposal.segmentIndex)} onChange={event => setSelected(values => event.target.checked ? [...values, proposal.segmentIndex] : values.filter(value => value !== proposal.segmentIndex))} /><div><strong>{t('段落 ', 'Segment ') + (proposal.segmentIndex + 1)}</strong><small>{proposal.linked ? t('已关联人物', 'Linked character') : t('可能相关，核对后应用', 'Possible match — review before applying')}</small><del>{proposal.before}</del><ins>{proposal.after}</ins></div></label>)}</div><div className="ws-modal-actions"><button className="ws-button secondary" onClick={() => setProposals([])}>{t('暂不替换', 'Keep current text')}</button><button className="ws-button primary" disabled={!selected.length || disabled} onClick={() => { onApply(proposals.filter(proposal => selected.includes(proposal.segmentIndex))); setProposals([]); }}>{t('应用到当前草稿', 'Apply to current draft')}</button></div></Modal>}
  </section>;
}
