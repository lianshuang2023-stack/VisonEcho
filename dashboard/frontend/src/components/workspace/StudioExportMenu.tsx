import { useId, useState } from 'react';
import { Button, Dropdown, Menu, MenuItem, MenuItemLink, MenuList, MenuPopover, MenuTrigger, Option } from '@fluentui/react-components';
import { ChevronDown, Download } from 'lucide-react';
import { exportUrl, outputUrl } from '../../localWorkspaceApi';
import { useUiPreferences } from '../../uiPreferences';
import './studio-export.css';

type Format = 'mp4' | 'srt' | 'vtt' | 'txt';
interface Props {
  jobId: string;
  dirty?: boolean;
  transcriptUnavailable?: boolean;
  narrationUnavailable?: boolean;
  disabled?: boolean;
  compact?: boolean;
}

export default function StudioExportMenu({ jobId, dirty = false, transcriptUnavailable = false, narrationUnavailable = false, disabled = false, compact = false }: Props) {
  const { t } = useUiPreferences();
  const descriptionId = useId();
  const [selected, setSelected] = useState<Format>('mp4');
  const options: { format: Format; title: string; description: string; unavailable: boolean }[] = [
    { format: 'mp4', title: t('MP4 · 视频', 'MP4 · Video'), description: t('保存的视频，包含原声及此版本已生成的口述配音。', 'Saved video with original audio and any narration generated for this version.'), unavailable: false },
    { format: 'srt', title: t('SRT · 通用字幕', 'SRT · Standard subtitles'), description: t('带时间码的对白字幕，适用于常见播放器和剪辑工具。', 'Dialogue subtitles with timecodes for common players and editors.'), unavailable: transcriptUnavailable },
    { format: 'vtt', title: t('VTT · 网页字幕', 'VTT · Web captions'), description: t('带时间码的对白字幕，适用于网页与 HTML5 视频。', 'Dialogue captions with timecodes for web and HTML5 video.'), unavailable: transcriptUnavailable },
    { format: 'txt', title: t('TXT · 口述稿', 'TXT · Narration script'), description: t('已配音段落的口述稿，含时间范围，适合阅读与编辑。', 'Voiced narration text with time ranges for reading and editing.'), unavailable: narrationUnavailable },
  ];
  const current = options.find(option => option.format === selected)!;
  const blocked = disabled || !jobId || current.unavailable;
  const url = selected === 'mp4' ? outputUrl(jobId) + '?download=true' : exportUrl(jobId, selected === 'txt' ? 'description' : 'dialogue', selected);
  const label = t('下载 ', 'Download ') + selected.toUpperCase();

  if (compact) return <Menu positioning={{ position: 'below', align: 'end' }}>
    <MenuTrigger disableButtonEnhancement><Button appearance="primary" icon={<Download size={15} />} disabled={disabled || !jobId} className="ve-export-trigger">{t('导出', 'Export')}<ChevronDown size={13} aria-hidden="true" /></Button></MenuTrigger>
    <MenuPopover className="ve-export-popover"><MenuList aria-label={t('下载文件格式', 'Download file format')}>
      {options.map(option => {
        const href = option.format === 'mp4' ? outputUrl(jobId) + '?download=true' : exportUrl(jobId, option.format === 'txt' ? 'description' : 'dialogue', option.format);
        const contents = <span className="ve-export-option"><strong>{option.title}</strong><small>{option.unavailable ? t('此版本暂时无法读取该内容。', 'This content is unavailable for this version.') : option.description}</small></span>;
        return option.unavailable ? <MenuItem key={option.format} disabled>{contents}</MenuItem> : <MenuItemLink key={option.format} href={href} download>{contents}</MenuItemLink>;
      })}
    </MenuList>{dirty && <p className="ve-export-saved-note">{t('下载已保存版本；当前未保存的修改不会包含在文件中。', 'Downloads use the saved version and exclude current unsaved edits.')}</p>}</MenuPopover>
  </Menu>;

  return <div className="ve-export-menu">
    <div className="ve-export-controls">
      <Dropdown aria-label={t('导出格式', 'Export format')} aria-describedby={descriptionId} selectedOptions={[selected]} value={current.title} disabled={disabled || !jobId} onOptionSelect={(_event, data) => { if (data.optionValue) setSelected(data.optionValue as Format); }}>
        {options.map(option => <Option key={option.format} value={option.format} text={option.title} disabled={option.unavailable}><span className="ve-export-option"><strong>{option.title}</strong><small>{option.unavailable ? t('此版本暂时无法读取该内容。', 'This content is unavailable for this version.') : option.description}</small></span></Option>)}
      </Dropdown>
      {blocked ? <Button appearance="primary" icon={<Download size={15} />} disabled>{label}</Button> : <Button as="a" appearance="primary" icon={<Download size={15} />} href={url} download>{label}</Button>}
    </div>
    <p id={descriptionId} className="ve-export-description">{current.unavailable ? t('此内容暂不可用，请重新加载此版本后再试。', 'This content is unavailable. Reload this version and try again.') : current.description}</p>
    {dirty && <p className="ve-export-saved-note">{t('下载已保存版本；当前未保存的修改不会包含在文件中。', 'Downloads use the saved version and exclude current unsaved edits.')}</p>}
    {transcriptUnavailable && selected !== 'srt' && selected !== 'vtt' && <p className="ve-export-saved-note">{t('对白字幕暂不可用，SRT 与 VTT 已停用。', 'Dialogue subtitles are unavailable. SRT and VTT are disabled.')}</p>}
  </div>;
}
