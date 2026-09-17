import { useUiPreferences } from '../../uiPreferences';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SyntheticEvent } from 'react';
import { ArrowRight, Film, RefreshCw, Volume2 } from 'lucide-react';
import { fetchInputVideoUrl } from '../../api';
import { getNarration, getProject, getTranscript, outputUrl } from '../../localWorkspaceApi';
import type { NarrationSegment, TimelineInsertion, TranscriptCue, VideoProject } from '../../localWorkspaceApi';
import { toSourceTime, toOutputTime } from './timeline';
import { Alert, Loading, Modal } from './WorkspaceShared';
import { duration } from './workspaceUtils';

type Source = 'original' | 'described';
interface PreviewData {
  videoId: string;
  originalUrl: string;
  resultId: string;
  cues: TranscriptCue[];
  segments: NarrationSegment[];
  errors: { label: [string, string]; reason: unknown }[];
  dialogueLoaded: boolean;
  narrationLoaded: boolean;
  insertions: TimelineInsertion[];
  outputDuration: number;
}
interface PlaybackPosition {
  time: number;
  playing: boolean;
  volume: number;
  muted: boolean;
  rate: number;
}
interface TimelineItem { id: string; start: number; end: number; text: string }

const emptyData: PreviewData = { videoId: '', originalUrl: '', resultId: '', cues: [], segments: [], errors: [], dialogueLoaded: false, narrationLoaded: false, insertions: [], outputDuration: 0 };
const validRange = (start: number, end: number) => Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start;

function TimelineTrack({ label, kind, items, currentTime, total, available, onSeek }: { label: string; kind: Source; items: TimelineItem[]; currentTime: number; total: number; available: boolean; onSeek: (time: number) => void }) {
  const { t } = useUiPreferences();
  return <div className={'ve-comparison-track-row ' + kind}>
    <span className="ve-comparison-track-label">{label}</span>
    <div className="ve-comparison-track" role="group" aria-label={label + t("时间轴", " timeline")}>
      {items.map(item => {
        const active = currentTime >= item.start && currentTime < item.end;
        return <button key={item.id} type="button" className={'ve-comparison-cue ' + (active ? 'active' : '')}
          aria-label={label + ' ' + duration(item.start) + '，' + item.text} aria-current={active ? 'true' : undefined}
          title={duration(item.start) + ' — ' + duration(item.end) + ' · ' + item.text}
          style={{ left: (item.start / total * 100) + '%', width: ((item.end - item.start) / total * 100) + '%' }}
          onClick={() => onSeek(item.start)} />;
      })}
      {!items.length && <span className="ve-comparison-track-empty">{available ? (kind === 'original' ? t("未识别到对白", "No dialogue detected") : t("暂无已配音解说", "No voiced narration yet")) : t("时间轴暂不可用", "Timeline unavailable")}</span>}
      {total > 0 && <span className="ve-comparison-playhead" aria-hidden="true" style={{ left: (Math.min(currentTime, total) / total * 100) + '%' }} />}
    </div>
  </div>;
}

export default function ComparisonPreview({ video, onClose, onEdit }: { video: VideoProject; onClose: () => void; onEdit: () => void }) {
  const { t } = useUiPreferences();
  const [data, setData] = useState<PreviewData>(emptyData);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [source, setSource] = useState<Source>('original');
  const [mediaAttempt, setMediaAttempt] = useState(0);
  const [mediaLoading, setMediaLoading] = useState(true);
  const [mediaError, setMediaError] = useState(false);
  const [playNotice, setPlayNotice] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const pendingPosition = useRef<PlaybackPosition | null>(null);

  useEffect(() => {
    let active = true;
    async function load() {
      const [input, detail] = await Promise.allSettled([fetchInputVideoUrl(video.video_id), getProject(video.video_id)]);
      if (!active) return;
      const errors: PreviewData['errors'] = [];
      const originalUrl = input.status === 'fulfilled' ? input.value : '';
      if (input.status === 'rejected') errors.push({ label: ["原声视频加载失败：", "Original video failed to load: "], reason: input.reason });
      if (detail.status === 'rejected') errors.push({ label: ["作品信息加载失败：", "Video details failed to load: "], reason: detail.reason });
      const resultId = detail.status === 'fulfilled' ? detail.value.latest_result_id ?? '' : video.latest_result_id ?? '';
      let cues: TranscriptCue[] = [];
      let segments: NarrationSegment[] = [];
      let dialogueLoaded = false;
      let narrationLoaded = false;
      let insertions: TimelineInsertion[] = [];
      let outputDuration = video.duration;
      if (resultId) {
        const [narration, transcript] = await Promise.allSettled([getNarration(resultId), getTranscript(resultId)]);
        if (!active) return;
        if (narration.status === 'fulfilled') { segments = narration.value.segments; narrationLoaded = true; insertions = narration.value.insertions || []; outputDuration = narration.value.summary?.video_duration || video.duration; }
        else errors.push({ label: ["口述时间轴加载失败：", "Narration timeline failed to load: "], reason: narration.reason });
        if (transcript.status === 'fulfilled') { cues = transcript.value.cues; dialogueLoaded = true; }
        else errors.push({ label: ["对白时间轴加载失败：", "Dialogue timeline failed to load: "], reason: transcript.reason });
      }
      setData({ videoId: video.video_id, originalUrl, resultId, cues, segments, errors, dialogueLoaded, narrationLoaded, insertions, outputDuration });
      setLoading(false);
    }
    void load();
    return () => { active = false; };
  }, [video.video_id, video.latest_result_id, video.duration, attempt]);

  const busy = loading || data.videoId !== video.video_id;
  const selectedSource = source === 'described' && data.resultId ? 'described' : 'original';
  const mediaUrl = selectedSource === 'described' ? outputUrl(data.resultId) : data.originalUrl;
  const total = data.insertions.length ? data.outputDuration : Number.isFinite(mediaDuration) && mediaDuration > 0 ? mediaDuration : Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
  const timelineTime = selectedSource === 'original' && data.insertions.length ? toOutputTime(currentTime, data.insertions) : currentTime;
  const dialogue = useMemo(() => data.cues.filter(cue => validRange(cue.start, cue.end) && cue.start < total)
    .map(cue => ({ ...cue, end: Math.min(cue.end, total) })), [data.cues, total]);
  const narration = useMemo(() => data.segments.filter(segment => segment.pass && segment.dvi_text.trim() && segment.audio_duration !== null && Number.isFinite(segment.audio_duration) && segment.audio_duration > 0)
    .map(segment => ({ id: String(segment.segment_index), start: segment.start_time, end: Math.min(total, segment.start_time + (segment.audio_duration ?? 0)), text: segment.dvi_text }))
    .filter(segment => validRange(segment.start, segment.end) && segment.start < total), [data.segments, total]);
  const activeCue = dialogue.find(cue => timelineTime >= cue.start && timelineTime < cue.end);
  const activeNarration = selectedSource === 'described' ? narration.find(segment => timelineTime >= segment.start && timelineTime < segment.end) : undefined;

  function rememberPosition(keepPlaying = true): PlaybackPosition {
    const player = videoRef.current;
    return { time: player?.currentTime ?? currentTime, playing: keepPlaying && !!player && !player.paused && !player.ended, volume: player?.volume ?? 1, muted: player?.muted ?? false, rate: player?.playbackRate ?? 1 };
  }
  function switchSource(next: Source) {
    if (next === selectedSource) return;
    // Keep the original position when the user switches again before metadata arrives.
    pendingPosition.current ??= rememberPosition();
    if (data.insertions.length) pendingPosition.current.time = next === 'original' ? toSourceTime(pendingPosition.current.time, data.insertions) : toOutputTime(pendingPosition.current.time, data.insertions);
    setMediaError(false); setMediaLoading(true); setPlayNotice(false); setSource(next);
  }
  function loadedMetadata(event: SyntheticEvent<HTMLVideoElement>) {
    const player = event.currentTarget;
    if (player !== videoRef.current) return;
    setMediaDuration(player.duration); setMediaLoading(false);
    const position = pendingPosition.current;
    if (!position) return;
    const end = Number.isFinite(player.duration) ? player.duration : total;
    const nextTime = Math.max(0, end > 0 ? Math.min(position.time, end) : position.time);
    player.currentTime = nextTime; player.volume = position.volume; player.muted = position.muted; player.playbackRate = position.rate;
    setCurrentTime(nextTime); pendingPosition.current = null;
    if (position.playing) {
      void player.play().catch(() => {
        if (player === videoRef.current) setPlayNotice(true);
      });
    }
  }
  function seek(time: number) {
    const target = selectedSource === 'original' ? toSourceTime(time, data.insertions) : time;
    const nextTime = Math.max(0, Math.min(target, selectedSource === 'original' ? video.duration : total));
    const player = videoRef.current;
    if (player && player.readyState >= 1 && !mediaError) player.currentTime = nextTime;
    else pendingPosition.current = { ...(pendingPosition.current ?? rememberPosition(false)), time: nextTime };
    setCurrentTime(nextTime);
  }
  function retryData() {
    pendingPosition.current = rememberPosition(false);
    setLoading(true); setMediaLoading(true); setMediaError(false); setPlayNotice(false); setAttempt(value => value + 1);
  }
  function retryMedia() {
    pendingPosition.current = { ...(pendingPosition.current ?? rememberPosition(false)), playing: false };
    setMediaError(false); setMediaLoading(true); setPlayNotice(false); setMediaAttempt(value => value + 1);
  }

  return <div className="ve-comparison"><Modal title={t("对比预览", "Compare versions")} onClose={onClose}>
    <div className="ve-comparison-heading"><div><h3>{video.title}</h3><p>{t("切换原声与口述版；扩展版本按原片位置对应", "Switch between original and audio description with matching source positions.")}</p></div>
      <div className="ve-comparison-switch" role="group" aria-label={t("预览版本", "Preview version")}>
        <button type="button" aria-pressed={selectedSource === 'original'} disabled={busy || !data.originalUrl} onClick={() => switchSource('original')}><Film size={15} />{t("原声", "Original")}</button>
        <button type="button" aria-pressed={selectedSource === 'described'} disabled={busy || !data.resultId} onClick={() => switchSource('described')}><Volume2 size={15} />{t("口述版", "Audio description")}</button>
      </div>
    </div>
    {busy ? <Loading text={t("正在加载对比预览…", "Loading comparison…")} /> : <>
      {data.errors.length > 0 && <div className="ve-comparison-error"><Alert>{data.errors.map(({ label, reason }, index) => <p key={index}>{t(...label)}{reason instanceof Error ? reason.message : t("操作未完成，请重试。", "The action could not be completed. Please try again.")}</p>)}</Alert><button className="ws-button secondary" onClick={retryData}><RefreshCw size={14} />{t("重新加载预览", "Reload preview")}</button></div>}
      {!data.resultId && <div className="ve-comparison-unavailable"><strong>{t("还没有口述版", "No audio description version yet")}</strong><p>{t("生成口述解说后，即可在这里对比。", "Generate audio description to compare versions here.")}</p></div>}
      {mediaUrl ? <div className="ve-comparison-player" aria-busy={mediaLoading}>
        <video key={video.video_id + ':' + selectedSource + ':' + mediaAttempt} ref={videoRef} src={mediaUrl} controls playsInline preload="metadata" tabIndex={0}
          aria-label={(selectedSource === 'original' ? t("原声", "Original") : t("口述版", "Audio description")) + t("预览：", " preview: ") + video.title}
          onLoadedMetadata={loadedMetadata}
          onTimeUpdate={event => { if (!pendingPosition.current) setCurrentTime(event.currentTarget.currentTime); }}
          onError={() => { setMediaError(true); setMediaLoading(false); }} />
        {mediaLoading && <span className="ve-comparison-media-loading" role="status">{t("正在加载视频…", "Loading video…")}</span>}
        {mediaError && <div className="ve-comparison-media-error"><Alert>{t("视频暂时无法播放，请重试。", "Video is temporarily unavailable. Please retry.")}</Alert><button className="ws-button secondary" onClick={retryMedia}><RefreshCw size={14} />{t("重试播放", "Retry playback")}</button></div>}
      </div> : <div className="ve-comparison-media-empty"><Film size={30} /><p>{t("原声视频暂不可用", "Original video is unavailable")}{data.resultId ? t("，可切换到口述版预览。", ". Switch to the audio description preview.") : t('。', '.')}</p></div>}
      {playNotice && <p className="ve-comparison-notice" role="status">{t("已保留播放位置，点击播放继续。", "Playback position saved. Press play to continue.")}</p>}
      {data.resultId && <section className="ve-comparison-timeline" aria-label={t("对白与解说时间轴", "Dialogue and narration timeline")}>
        <div className="ve-comparison-timeline-heading"><strong>{t("声音时间轴", "Audio timeline")}</strong><output aria-label={t("当前播放位置", "Current playback position")}>{duration(timelineTime)} / {duration(total)}</output></div>
        <TimelineTrack label={t("原对白", "Dialogue")} kind="original" items={dialogue} currentTime={timelineTime} total={total} available={data.dialogueLoaded} onSeek={seek} />
        <TimelineTrack label={t("口述解说", "Audio description")} kind="described" items={narration} currentTime={timelineTime} total={total} available={data.narrationLoaded} onSeek={seek} />
        <div className="ve-comparison-timeline-scale" aria-hidden="true"><span>{duration(0)}</span><span>{duration(total / 2)}</span><span>{duration(total)}</span></div>
      </section>}
      {data.resultId && <div className="ve-comparison-text">
        <div className={'ve-comparison-text-cue original ' + (activeCue ? 'active' : '')}><span>{t("原对白", "Dialogue")}</span><p>{activeCue?.text || (data.dialogueLoaded ? t("当前无对白", "No dialogue at this point") : t("对白文本暂不可用", "Dialogue text unavailable"))}</p></div>
        <div className={'ve-comparison-text-cue described ' + (activeNarration ? 'active' : '')}><span>{t("口述解说", "Audio description")}</span><p>{activeNarration?.text || (data.narrationLoaded ? t("当前无口述解说", "No narration at this point") : t("口述文本暂不可用", "Narration text unavailable"))}</p></div>
      </div>}
    </>}
    <div className="ws-modal-actions ve-comparison-actions"><button className="ws-button secondary" onClick={onClose}>{t("完成预览", "Done")}</button><button className="ws-button primary" onClick={onEdit}>{data.resultId || video.latest_result_id ? t("继续编辑", "Continue editing") : t("去生成口述版", "Generate audio description")}<ArrowRight size={15} /></button></div>
  </Modal></div>;
}
