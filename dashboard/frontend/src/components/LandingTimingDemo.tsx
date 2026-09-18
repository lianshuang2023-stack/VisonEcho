import { useId, useState } from 'react';
import { useUiPreferences } from '../uiPreferences';
import './landing-timing.css';

type Mode = 'natural' | 'extended';
interface Span { start: number; end: number; label: string; kind: 'picture' | 'pause' | 'dialogue' | 'narration' | 'ambient' }

export default function LandingTimingDemo() {
  const { t } = useUiPreferences();
  const id = useId();
  const [mode, setMode] = useState<Mode>('natural');
  const [time, setTime] = useState(4);
  const extended = mode === 'extended';
  const duration = extended ? 14 : 10;
  const held = extended && time >= 5 && time < 9;
  const sourceTime = extended ? time < 5 ? time : time < 9 ? 5 : time - 4 : time;
  const narration = extended ? time >= 5 && time < 9 : time >= 3 && time < 7;
  const dialogue = time < 3 || (time >= (extended ? 11 : 7) && time < duration);
  const activity = time >= duration ? t('示例结束', 'End of example') : held
    ? t('画面停在第 5 秒，解说播放中。', 'Picture held at 5 seconds. Narration plays.')
    : narration ? t('画面继续，解说在对白间隙播放。', 'Picture continues. Narration fills the dialogue gap.')
      : dialogue ? t('画面继续，原片对白播放中。', 'Picture continues. Original dialogue plays.')
        : t('画面继续，保留原声。', 'Picture continues with the original sound.');
  const valueText = t('成片', 'Output') + ' ' + time.toFixed(1) + ' ' + t('秒', 'seconds') + '. ' + t('原片', 'Source') + ' ' + sourceTime.toFixed(1) + ' ' + t('秒', 'seconds') + '. ' + activity;
  const picture: Span[] = extended ? [
    { start: 0, end: 5, label: t('画面继续', 'Picture plays'), kind: 'picture' },
    { start: 5, end: 9, label: t('暂停画面', 'Picture held'), kind: 'pause' },
    { start: 9, end: 14, label: t('画面继续', 'Picture plays'), kind: 'picture' },
  ] : [{ start: 0, end: 10, label: t('画面持续播放', 'Picture plays continuously'), kind: 'picture' }];
  const sound: Span[] = extended ? [
    { start: 0, end: 3, label: t('对白', 'Dialogue'), kind: 'dialogue' },
    { start: 3, end: 5, label: t('原声', 'Sound'), kind: 'ambient' },
    { start: 5, end: 9, label: t('解说', 'Narration'), kind: 'narration' },
    { start: 9, end: 11, label: t('原声', 'Sound'), kind: 'ambient' },
    { start: 11, end: 14, label: t('对白', 'Dialogue'), kind: 'dialogue' },
  ] : [
    { start: 0, end: 3, label: t('对白', 'Dialogue'), kind: 'dialogue' },
    { start: 3, end: 7, label: t('解说', 'Narration'), kind: 'narration' },
    { start: 7, end: 10, label: t('对白', 'Dialogue'), kind: 'dialogue' },
  ];
  function select(next: Mode) {
    if (next === mode) return;
    setMode(next); setTime(next === 'extended' ? 6 : 4);
  }
  function lane(label: string, spans: Span[]) {
    return <div className="lp-timing-lane"><span className="lp-timing-lane-label">{label}</span>
      <div className="lp-timing-track" role="img" aria-label={label + ': ' + spans.map(span => span.label + ' ' + span.start + '–' + span.end + ' ' + t('秒', 'seconds')).join('; ')}>
        {spans.map(span => <span key={span.start} className={'lp-timing-span is-' + span.kind} style={{ width: (span.end - span.start) / duration * 100 + '%' }} aria-hidden="true">{span.label}</span>)}
        <span className="lp-timing-cursor" style={{ left: time / duration * 100 + '%' }} aria-hidden="true" />
      </div></div>;
  }
  return <section id="timing" className="lp-timing lp-wrap" data-reveal aria-labelledby={id + '-title'}>
    <div className="lp-section-title"><h2 id={id + '-title'}>{t('解说怎样放进视频', 'How narration fits')}</h2><p>{t('移动时间点，看看画面与声音怎样配合。', 'Move through the timeline to see how picture and sound work together.')}</p></div>
    <div className="lp-timing-topline"><div className="lp-timing-modes" role="group" aria-label={t('解说时序示例模式', 'Narration timing example mode')}>
      <button type="button" aria-pressed={!extended} onClick={() => select('natural')}>{t('利用对白间隙', 'In dialogue gaps')}</button>
      <button type="button" aria-pressed={extended} onClick={() => select('extended')}>{t('暂停画面补充', 'With pauses')}</button>
    </div><p className="lp-timing-example" id={id + '-example'}>{t('时序示意，非实际视频', 'Timing illustration, not a real video')}</p></div>
    <div className="lp-timing-diagram">
      <div className="lp-timing-duration"><span>{t('原片', 'Source')} <strong>10 {t('秒', 's')}</strong></span><span>{t('成片', 'Output')} <strong>{duration} {t('秒', 's')}</strong></span></div>
      {lane(t('画面', 'Picture'), picture)}{lane(t('声音', 'Audio'), sound)}
      <div className="lp-timing-scrub"><label htmlFor={id + '-range'}>{t('成片时间', 'Output time')}</label><div>
        <input id={id + '-range'} type="range" min={0} max={duration} step={0.1} value={time} aria-label={t('探索解说时间点', 'Explore narration timing')} aria-describedby={id + '-example'} aria-valuetext={valueText} onChange={event => setTime(Number(event.target.value))} />
        <div className="lp-timing-scale" aria-hidden="true"><span>0 {t('秒', 's')}</span><span>{duration} {t('秒', 's')}</span></div>
      </div></div>
      <div className="lp-timing-position"><span>{t('成片时间', 'Output time')} <output aria-live="off" data-testid="timing-output-time">{time.toFixed(1)} {t('秒', 's')}</output></span><span>{t('原片时间', 'Source time')} <output aria-live="off" data-testid="timing-source-time">{sourceTime.toFixed(1)} {t('秒', 's')}</output></span></div>
      <p className="lp-timing-activity">{activity}</p>
    </div>
  </section>;
}
