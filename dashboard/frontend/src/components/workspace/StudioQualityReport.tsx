import { useUiPreferences } from '../../uiPreferences';
import StudioExportMenu from './StudioExportMenu';

export default function StudioQualityReport({ dirty, jobId, transcriptError = '', editorError = '' }: { dirty: boolean; jobId: string; transcriptError?: string; editorError?: string }) {
  const { t } = useUiPreferences();
  return <section className="ve-quality" aria-label={t('导出', 'Export')}>
    <h2>{t('导出', 'Export')}</h2>
    <p>{t('选择格式，下载当前已保存版本。审校状态不影响导出。', 'Choose a format to download the saved version. Review is optional.')}</p>
    <StudioExportMenu key={jobId} jobId={jobId} dirty={dirty} transcriptUnavailable={!!transcriptError} narrationUnavailable={!!editorError} />
  </section>;
}
