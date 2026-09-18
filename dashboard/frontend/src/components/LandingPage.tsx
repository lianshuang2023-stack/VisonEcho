import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, AudioLines, Check, ChevronDown, Clapperboard, Download, Frame, Headphones, Languages, LockKeyhole, Moon, Pause, Play, Subtitles, Sun, Users, Waves } from 'lucide-react';
import { useUiPreferences } from '../uiPreferences';
import LandingImpact from './LandingImpact';
import LandingTimingDemo from './LandingTimingDemo';
import { useLandingMotion } from './useLandingMotion';
import './landing.css';

interface Props {
  onStart: () => void;
  onLogin: () => void;
  busy: boolean;
  error: string;
  onRetry?: () => void;
  hasWorkspace?: boolean;
}

const mediaRoot = '/assets/landing';

export default function LandingPage({ onStart, onLogin, busy, error, onRetry, hasWorkspace = false }: Props) {
  const { t, language, theme, setLanguage, setTheme } = useUiPreferences();
  const [described, setDescribed] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [mediaError, setMediaError] = useState(false);
  const [motionEnabled, setMotionEnabled] = useState(true);
  const [audioFocus, setAudioFocus] = useState(false);
  const root = useLandingMotion(motionEnabled);
  const video = useRef<HTMLVideoElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const pendingSeek = useRef<number | null>(null);
  const sampleLanguage = language === 'en' ? 'en' : 'zh';
  const source = `${mediaRoot}/sample-${described ? sampleLanguage : 'original'}.mp4`;
  useEffect(() => {
    // The overview mounts after the hash changes. Restore its intended position
    // once the content exists instead of keeping the studio's scroll offset.
    const sectionId = window.location.hash.slice(1);
    const section = ['features', 'timing', 'impact', 'how-it-works', 'questions', 'introduction', 'sample'].includes(sectionId)
      ? root.current?.querySelector<HTMLElement>(`#${sectionId}`) : null;
    if (section) section.scrollIntoView?.({ block: 'start', behavior: 'instant' });
    else window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    title.current?.focus({ preventScroll: true });
  }, [root]);

  function selectTrack(next: boolean) {
    if (next === described) return;
    video.current?.pause();
    setPlaying(false); setMediaError(false); setDescribed(next);
  }
  async function playSample() {
    if (!video.current) return;
    if (!video.current.paused) { video.current.pause(); return; }
    try { await video.current.play(); } catch { setMediaError(true); }
  }
  function seekSample(seconds: number) {
    if (video.current) {
      if (video.current.readyState > 0) video.current.currentTime = seconds;
      else { pendingSeek.current = seconds; video.current.load(); }
      video.current.scrollIntoView({ block: 'center', behavior: 'instant' });
      video.current.focus({ preventScroll: true });
    }
  }
  const featureItems = [
    { Icon: Subtitles, title: t('对白字幕，逐句校准', 'Subtitles you can refine'), description: t('识别普通话或英语对白，编辑文字与时间，让字幕跟上原声。', 'Transcribe Mandarin or English dialogue. Edit each line and its timing against the original audio.') },
    { Icon: Users, title: t('同一个人，同一个称呼', 'A familiar name, scene to scene'), description: t('自动提取人物卡，整理外观与称呼。特征明确的虚构角色可自动命名，其余留待确认。', 'Build character cards with appearances and names. Recognize distinctive fictional characters, and review uncertain matches.') },
    { Icon: AudioLines, title: t('选择语言，也选择声音', 'Your language. Your voice.'), description: t('中英文解说各有三种音色。可利用对白间隙，或暂停画面加入更完整的描述。', 'Choose from three voices each in Mandarin and English. Fit narration into dialogue gaps or pause the picture for more detail.') },
  ];
  const steps = [
    { title: t('上传', 'Upload'), text: t('添加 MP4，选择解说语言和音色。', 'Add an MP4. Choose your narration language and voice.') },
    { title: t('生成', 'Generate'), text: t('识别对白、分析画面，生成字幕与口述稿。', 'Transcribe dialogue and draft descriptions from video frames.') },
    { title: t('校对', 'Review'), text: t('对照关键帧，调整文字、称呼和时间。', 'Check the frames. Refine the words, names and timing.') },
    { title: t('导出', 'Export'), text: t('保存口述 MP4、字幕与文本稿件。', 'Download a narrated MP4, subtitle files and your script.') },
  ];
  const questions = [
    { q: t('什么是口述影像？', 'What is audio description?'), a: t('口述影像用声音补充对白没有表达的画面信息，例如动作、表情和场景变化，帮助视障与低视力观众理解视频。', 'Audio description adds spoken details that dialogue alone does not convey, such as actions, expressions and scene changes, for blind and low-vision audiences.') },
    { q: t('试用需要注册吗？', 'Do I need an account to try it?'), a: t('不需要。访客可上传最多 5 个 MP4，单个不超过 1 GB、60 秒，共有 5 次 AI 处理额度。生成、重新配音、字幕校准和人物识别共用额度。访客会话有效期为 24 小时，注册可保留当前试用作品。', 'No. Guests can upload up to 5 MP4 videos, each up to 1 GB and 60 seconds, with 5 shared AI operations. Generation, revoicing, subtitle calibration and character detection use that allowance. A guest session lasts 24 hours; register to keep the work in your current session.') },
    { q: t('别人能看到我的视频吗？', 'Can other users see my videos?'), a: t('账号与访客拥有各自的工作区。视频及生成内容保存在服务端，画面和音频会发送至 Azure 完成 AI 处理；其他工作区无法直接访问你的作品。', 'Accounts and guest sessions have separate workspaces. Videos and results are stored on the server; frames and audio are sent to Azure for AI processing. Other workspaces cannot directly access your videos.') },
    { q: t('生成之后还需要检查吗？', 'Should I review the generated description?'), a: t('需要。AI 可能误解画面、对白或人物。发布前请对照原片检查字幕、口述稿和配音；画面依据与人物卡就是为这一步准备的。', 'Yes. AI can misinterpret scenes, dialogue or characters. Check subtitles, descriptions and narration against the original before sharing. Visual evidence and character cards help with that review.') },
    { q: t('可以导出哪些文件？', 'What can I export?'), a: t('带口述解说的 MP4、SRT 或 VTT 字幕，以及 TXT 稿件。字幕是独立文件，保留对白原语言，不会自动翻译或烧录到视频。', 'A narrated MP4, SRT or VTT subtitles, and a TXT script. Subtitles are separate files in the dialogue’s original language; they are not automatically translated or burned into the video.') },
  ];

  return <div className="ve-landing" ref={root}>
    <a className="lp-skip" href="#introduction">{t('跳到介绍内容', 'Skip to content')}</a>
    <header className="lp-header lp-wrap">
      <a href="#introduction" className="lp-brand" aria-label="VisionEcho"><Clapperboard size={25} strokeWidth={1.8} aria-hidden="true" /><span>VisionEcho</span></a>
      <nav className="lp-nav" aria-label={t('页面导航', 'Main navigation')}>
        <a href="#features">{t('核心功能', 'Features')}</a><a href="#timing">{t('交互体验', 'Explore')}</a><a href="#impact">{t('意义与价值', 'Our purpose')}</a><a href="#questions">{t('常见问题', 'FAQ')}</a>
      </nav>
      <div className="lp-controls">
        <button type="button" className="lp-icon" aria-label={t('切换页面为英文', 'Switch interface to Chinese')} onClick={() => { video.current?.pause(); setPlaying(false); setLanguage(language === 'en' ? 'zh-CN' : 'en'); }}><Languages size={18} aria-hidden="true" /><span>{language === 'en' ? '中文' : 'EN'}</span></button>
        <button type="button" className="lp-icon lp-theme" aria-label={theme === 'light' ? t('切换到暗色', 'Switch to dark theme') : t('切换到亮色', 'Switch to light theme')} onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <Moon size={18} aria-hidden="true" /> : <Sun size={18} aria-hidden="true" />}</button>
        <button type="button" className="lp-login" onClick={onLogin} disabled={busy}>{hasWorkspace ? t('进入工作区', 'Open studio') : t('登录', 'Log in')}<ArrowRight size={15} aria-hidden="true" /></button>
      </div>
    </header>

    <main id="introduction">
      <section className="lp-hero lp-wrap" aria-labelledby="landing-title">
        <div className="lp-hero-copy">
          <p className="lp-eyebrow">{t('让视频更易被理解', 'AUDIO DESCRIPTION FOR VIDEO')}</p>
          <h1 id="landing-title" ref={title} tabIndex={-1}>{t('让画面', 'Let the story')}<br /><em>{t('被听见。', 'be heard.')}</em></h1>
          <p className="lp-hero-intro">{t('为视频添加口述解说，让更多人听懂故事里的每一处细节。', 'Create and refine audio descriptions, so more people can follow the story in your videos.')}</p>
          <div className="lp-hero-actions"><button type="button" className="lp-button" disabled={busy} onClick={onStart}>{busy ? t('正在打开…', 'Opening…') : hasWorkspace ? t('进入工作区', 'Open studio') : t('先试用一下', 'Try as a guest')}<ArrowRight size={18} aria-hidden="true" /></button><a className="lp-text-link" href="#features">{t('了解功能', 'Explore features')}<ArrowDown size={15} aria-hidden="true" /></a></div>
          {error && <div className="lp-error" role="alert"><p>{error}</p>{onRetry && <button type="button" onClick={onRetry}>{t('重新检查连接', 'Retry connection')}</button>}</div>}
        </div>
        <div className="lp-sample" id="sample">
          <div className="lp-sample-toolbar"><span><AudioLines size={17} aria-hidden="true" />{t('听听有什么不同', 'Hear the difference')}</span><div className="lp-track-toggle" role="group" aria-label={t('演示音轨', 'Sample audio track')}><button type="button" aria-pressed={!described} onClick={() => selectTrack(false)}>{t('原画面', 'Original')}</button><button type="button" aria-pressed={described} onClick={() => selectTrack(true)}>{t('加入解说', 'Described')}</button></div></div>
          <div className="lp-video-wrap">
            <video key={source} ref={video} src={source} poster={`${mediaRoot}/lake.webp`} controls={!audioFocus} playsInline preload="metadata" aria-label={t('湖景口述演示视频', 'Lake scene audio description sample')} onLoadedMetadata={() => { if (pendingSeek.current !== null && video.current) { video.current.currentTime = pendingSeek.current; pendingSeek.current = null; } }} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onError={() => setMediaError(true)}>
              {described && <track key={sampleLanguage} kind="captions" src={`${mediaRoot}/sample-${sampleLanguage}.vtt`} srcLang={language === 'en' ? 'en' : 'zh-CN'} label={t('中文口述稿', 'English description')} default />}
            </video>
            {audioFocus && <div className="lp-audio-focus"><Headphones size={30} strokeWidth={1.3} aria-hidden="true" /><strong>{t('专注听见画面', 'Let the words set the scene.')}</strong><span>{described ? t('听听解说补充了哪些画面信息。', 'Listen for the details the narration adds.') : t('原演示片段没有音轨，可切换至「加入解说」。', 'This original sample is silent. Switch to Described.')}</span><button type="button" className="lp-focus-play" onClick={() => void playSample()}>{playing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}{playing ? t('暂停', 'Pause') : t('播放', 'Play')}</button></div>}
            {!audioFocus && !playing && !mediaError && <button type="button" className="lp-play" onClick={() => void playSample()} aria-label={t('播放演示片段', 'Play sample')}><Play size={25} fill="currentColor" aria-hidden="true" /></button>}
          </div>
          <div className="lp-sample-caption"><span>{t('演示片段', 'Illustrative sample')}</span><span>{t('湖畔 · 10 秒', 'By the lake · 10 sec')}</span></div>
          <button type="button" className="lp-audio-toggle" aria-pressed={audioFocus} onClick={() => setAudioFocus(value => !value)}><Headphones size={14} aria-hidden="true" />{audioFocus ? t('显示画面', 'Show the picture') : t('暂时隐藏画面，专注聆听', 'Hide the picture. Focus on the audio.')}</button>
          <details className="lp-sample-transcript"><summary>{t('查看演示稿件', 'Read the sample transcript')}<ChevronDown size={12} aria-hidden="true" /></summary><p>{t('木船的船头朝向碧绿色的湖面。两岸林木茂密，后方耸立着灰白色的山峰。', 'A wooden boat points across a green lake. Dense forest lines the shore beneath steep, pale mountains.')}</p></details>
          {mediaError && <p className="lp-error" role="alert">{t('演示暂时无法播放，请刷新页面重试。', 'The sample could not load. Refresh the page to retry.')}</p>}
        </div>
      </section>

      <div className="lp-context lp-wrap"><p>{t('为创作者、教育者和无障碍制作团队而设计。', 'For creators, educators and accessibility teams.')}</p><span>{t('从一段视频开始。', 'Start with one video.')}</span></div>

      <section id="features" className="lp-features lp-wrap" aria-labelledby="features-title" data-reveal>
        <div className="lp-section-title"><h2 id="features-title">{t('从看见，到说清楚。', 'More context. More control.')}</h2><p>{t('AI 起草，你来判断。把每一段解说打磨到合适。', 'AI makes the first draft. You make the editorial decisions.')}</p></div>
        <div className="lp-feature-layout">
          <article className="lp-evidence">
            <Frame size={26} strokeWidth={1.6} aria-hidden="true" /><h3>{t('每段描述，都能回看画面。', 'See what the description sees.')}</h3><p>{t('展开关键帧，定位原片时间，标记人物、动作或遗漏问题。', 'Open the keyframes, jump to the source, and flag a wrong character, action or missing detail.')}</p>
            <div className="lp-frames">{[0, 4, 8].map(second => <button type="button" key={second} onClick={() => seekSample(second)} aria-label={t('跳到演示 ', 'Seek sample to ') + `00:0${second}`}><img src={`${mediaRoot}/frame-${second}.webp`} alt={t('演示湖景关键帧', 'Lake scene sample frame')} width={320} height={200} loading="lazy" /><span>{`00:0${second}`}<ArrowRight size={13} aria-hidden="true" /></span></button>)}</div>
            <p className="lp-evidence-note"><Check size={15} aria-hidden="true" />{t('点击示例帧，回到上方视频。', 'Select a sample frame to revisit the video above.')}</p>
          </article>
          <div className="lp-feature-list">{featureItems.map(({ Icon, title: name, description }) => <article key={name}><Icon size={24} strokeWidth={1.6} aria-hidden="true" /><div><h3>{name}</h3><p>{description}</p></div></article>)}</div>
        </div>
      </section>

      <LandingTimingDemo />
      <LandingImpact />

      <section id="how-it-works" className="lp-process lp-wrap" aria-labelledby="process-title" data-reveal>
        <div className="lp-section-title"><h2 id="process-title">{t('一段视频，四步制作。', 'A clear path from clip to story.')}</h2></div>
        <ol>{steps.map((step, index) => <li key={step.title}><span className="lp-step-number">{index + 1}</span><h3>{step.title}</h3><p>{step.text}</p></li>)}</ol>
        <div className="lp-export-line"><Download size={18} aria-hidden="true" /><span>{t('制作完成，带走作品。', 'Ready to share, in the files you need.')}</span><span className="lp-formats">MP4 <i>/</i> SRT <i>/</i> VTT <i>/</i> TXT</span></div>
      </section>

      <section id="questions" className="lp-faq lp-wrap" aria-labelledby="faq-title" data-reveal>
        <div className="lp-faq-heading"><h2 id="faq-title">{t('开始之前。', 'Before you begin.')}</h2><p><LockKeyhole size={18} aria-hidden="true" />{t('每个工作区，各自独立。', 'Your workspace stays yours.')}</p></div>
        <div className="lp-faq-list">{questions.map(({ q, a }) => <details key={q}><summary>{q}<ChevronDown size={18} aria-hidden="true" /></summary><p>{a}</p></details>)}</div>
      </section>

      <section className="lp-closing lp-wrap" aria-labelledby="closing-title" data-reveal><div><h2 id="closing-title">{t('让下一段视频，', 'Your next video,')}<br />{t('多一种被理解的方式。', 'with more to hear.')}</h2><p>{t('从一段短片开始，无需先注册。', 'Start with a short clip. No account needed.')}</p></div><button type="button" className="lp-button" onClick={onStart} disabled={busy}>{busy ? t('正在打开…', 'Opening…') : hasWorkspace ? t('进入工作区', 'Open studio') : t('先试用一下', 'Try as a guest')}<ArrowRight size={18} aria-hidden="true" /></button></section>
    </main>
    <footer className="lp-footer lp-wrap"><a className="lp-brand" href="#introduction"><Clapperboard size={21} strokeWidth={1.8} aria-hidden="true" />VisionEcho</a><span>{t('为每一段故事补上画面。', 'Give the picture a voice.')}</span><button type="button" className="lp-motion-toggle" aria-pressed={motionEnabled} onClick={() => setMotionEnabled(value => !value)}><Waves size={15} aria-hidden="true" />{motionEnabled ? t('关闭页面动效', 'Turn motion off') : t('开启页面动效', 'Turn motion on')}</button><a href="#questions">{t('试用与数据说明', 'Trial & data details')}</a></footer>
  </div>;
}
