import { useId, useState } from 'react';
import { ArrowRight, BookOpen, Clapperboard, Files, Headphones } from 'lucide-react';
import { useUiPreferences } from '../uiPreferences';
import './landing-impact.css';

type Audience = 'creators' | 'education' | 'teams';

export default function LandingImpact() {
  const { t } = useUiPreferences();
  const [audience, setAudience] = useState<Audience>('creators');
  const panelId = useId();
  const scenarios = {
    creators: {
      label: t('内容创作者', 'Creators'), Icon: Clapperboard,
      title: t('让已完成的作品，多一种观看方式。', 'Give an existing story another way to be followed.'),
      context: t('短片、访谈、文化记录', 'Short films, interviews and cultural stories'),
      workflow: t('上传已有视频，校对动作与场景描述，再导出口述版本。', 'Upload a finished video, review descriptions of actions and scenes, then export a narrated version.'),
      value: t('为视障与低视力观众提供更多画面信息，也为作品的无障碍发布准备可复用素材。', 'Offer blind and low-vision audiences more visual context, and prepare reusable assets for an accessible release.'),
      business: t('口述影像可作为视频制作的增值交付。', 'Offer audio description as an additional video deliverable.'),
      deliverables: ['MP4', 'SRT / VTT', t('口述稿 TXT', 'Description TXT')],
    },
    education: {
      label: t('教育工作者', 'Education'), Icon: BookOpen,
      title: t('课堂的关键信息，不只停留在画面里。', 'Make the lesson available beyond the picture.'),
      context: t('课程片段、操作示范、学习资源', 'Lesson clips, demonstrations and learning resources'),
      workflow: t('为示范视频补充可见的动作与变化，结合原声核对术语，保留字幕与文字稿。', 'Describe visible actions and changes in a demonstration, check terminology against the original audio, and keep subtitles and a script.'),
      value: t('支持学生按自己的方式获取和复习信息。复杂图表与专业细节仍由教师把关。', 'Support students in accessing and revisiting information in their own way. Teachers still review complex diagrams and specialist details.'),
      business: t('可探索课程资源库的机构试点服务。', 'Explore institutional pilots for accessible course libraries.'),
      deliverables: [t('解说视频', 'Narrated video'), t('可编辑字幕', 'Editable subtitles'), t('复习文字稿', 'Review script')],
    },
    teams: {
      label: t('内容制作团队', 'Content teams'), Icon: Files,
      title: t('把无障碍版本，纳入日常制作。', 'Make accessibility part of the production workflow.'),
      context: t('品牌内容、视频资料库、无障碍制作', 'Brand content, video libraries and accessibility production'),
      workflow: t('用 AI 起草，按画面依据校对，整理人物称呼，并保存每次制作版本。', 'Start with an AI draft, review against visual evidence, keep character names consistent, and save each production version.'),
      value: t('为重复的整理工作提供起点，让团队把精力放在描述质量和发布前检查。', 'Provide a starting point for recurring preparation work, so teams can focus on description quality and checks before release.'),
      business: t('可探索按项目交付的口述影像制作服务。', 'Explore project-based audio-description production services.'),
      deliverables: [t('制作版本', 'Production versions'), t('人物卡', 'Character cards'), t('视频与字幕', 'Video & subtitles')],
    },
  };
  const selected = scenarios[audience];

  return <section id="impact" className="lp-impact lp-wrap" aria-labelledby="impact-title" data-reveal>
    <div className="lp-impact-purpose">
      <div><p className="lp-eyebrow">{t('故事里的平等机会', 'EQUAL OPPORTUNITY TO TAKE PART')}</p><h2 id="impact-title">{t('平等地进入', 'Equal access')}<br />{t('每一个故事。', 'to the story.')}</h2></div>
      <div className="lp-impact-belief"><Headphones size={24} strokeWidth={1.6} aria-hidden="true" /><p>{t('一段沉默的动作，一次场景的转换，都可能影响理解。把这些信息说清楚，让视障与低视力观众能自主欣赏、学习和参与讨论。', 'A silent action or a change of scene can shape understanding. Describing it gives blind and low-vision audiences the context to enjoy, learn and join the conversation on their own terms.')}</p><span>{t('让技术扩展选择，让观众保有自己的理解。', 'Technology can widen the choice. The interpretation belongs to the audience.')}</span></div>
    </div>

    <div className="lp-impact-value-heading"><p className="lp-impact-label">{t('应用与商业价值', 'PRACTICAL & BUSINESS VALUE')}</p><h3>{t('让包容，也成为持续的价值。', 'More access. Lasting value.')}</h3></div>
    <div className="lp-impact-usecases">
      <div className="lp-impact-selector">
        <p className="lp-impact-label">{t('用在你的工作里', 'PUT IT TO WORK')}</p>
        <div role="group" aria-label={t('选择使用场景', 'Choose a use case')}>
          {(Object.keys(scenarios) as Audience[]).map(key => {
            const { Icon, label } = scenarios[key];
            return <button type="button" key={key} aria-pressed={audience === key} aria-controls={panelId} onClick={() => setAudience(key)}><Icon size={18} strokeWidth={1.6} aria-hidden="true" /><span>{label}</span><ArrowRight size={16} aria-hidden="true" /></button>;
          })}
        </div>
      </div>
      <article id={panelId} className="lp-impact-scenario" aria-labelledby={panelId + '-title'} aria-live="polite" aria-atomic="true" data-reveal>
        <p className="lp-impact-context">{selected.context}</p>
        <h3 id={panelId + '-title'}>{selected.title}</h3>
        <dl><div><dt>{t('怎样制作', 'The workflow')}</dt><dd>{selected.workflow}</dd></div><div><dt>{t('带来的价值', 'The opportunity')}</dt><dd>{selected.value}</dd></div><div><dt>{t('商业探索', 'Business potential')}</dt><dd>{selected.business}</dd></div></dl>
        <div className="lp-impact-deliverables"><span>{t('可带走的成果', 'WHAT YOU TAKE AWAY')}</span><ul>{selected.deliverables.map(item => <li key={item}>{item}</li>)}</ul></div>
      </article>
    </div>
  </section>;
}
