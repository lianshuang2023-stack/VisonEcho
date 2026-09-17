import type { ExecutionStatus } from './types';

export type VideoLanguage = 'en-US' | 'zh-CN';
export type DialogueLanguage = VideoLanguage | 'auto';
export type ProjectStatus = 'draft' | 'processing' | 'ready' | 'failed';
export type WorkflowStatus = 'draft' | 'processing' | 'review' | 'exportable' | 'failed';
export interface ProjectCollection {
  id: string;
  title: string;
  video_count: number;
  created_at: string;
  updated_at: string;
  deleted: boolean;
  deleted_at?: string;
  thumbnail_url?: string;
}
export interface VideoProject {
  video_id: string;
  collection_id?: string;
  collection_title?: string;
  deleted?: boolean;
  deleted_at?: string;
  title: string;
  filename: string;
  duration: number;
  size_mb: number;
  created_at: string;
  updated_at: string;
  last_modified: string;
  status: ProjectStatus;
  workflow_status?: WorkflowStatus;
  narration_available?: boolean | null;
  narration_notice?: string | null;
  narration_mode?: 'standard' | 'extended';
  reviewed?: boolean;
  last_error?: string | null;
  archived: boolean;
  execution_count: number;
  latest_execution_id: string | null;
  latest_result_id: string | null;
  thumbnail_url: string;
}
export interface ProjectExecution extends ExecutionStatus {
  video_id?: string;
  language?: VideoLanguage;
  dialogue_language?: DialogueLanguage;
  voice?: string;
  kind?: 'generate' | 'render';
  source_execution_id?: string;
}
export interface ProjectDetail {
  project: VideoProject;
  executions: ProjectExecution[];
  latest_result_id: string | null;
}
export interface TranscriptCue { id: string; start: number; end: number; text: string }
export interface Transcript { cues: TranscriptCue[]; revision: number; language?: DialogueLanguage; dialogue_language?: DialogueLanguage; quality?: { review_required?: boolean; low_confidence_phrase_count?: number; low_confidence_word_count?: number } }
export interface TranscriptCalibration {
  calibration_id: string;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  error?: string | null;
  result?: Transcript;
}
export interface NarrationSegment {
  segment_index: number;
  start_time: number;
  end_time: number;
  silence_duration: number;
  dvi_text: string;
  audio_duration: number | null;
  pass: boolean;
  skip_reason?: string;
}
export interface TimelineInsertion { source_time: number; output_start: number; output_end: number; duration: number }
export interface NarrationEditor { segments: NarrationSegment[]; language: VideoLanguage; dialogue_language?: DialogueLanguage; voice: string; reviewed?: boolean; reviewed_at?: string | null; narration_mode?: 'standard' | 'extended'; outcome?: 'audio_description' | 'partial' | 'subtitles_only'; summary?: { video_duration?: number; source_video_duration?: number; passed_segments?: number; total_segments?: number; message?: string }; insertions?: TimelineInsertion[] }
export interface ProjectTrash { collections: ProjectCollection[]; videos: VideoProject[] }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch('/api' + path, {
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
    signal: init?.signal ?? AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const message = typeof body.error === 'string' ? body.error : typeof body.detail === 'string' ? body.detail : '请求失败（' + response.status + '），请稍后重试。';
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}
const id = encodeURIComponent;
export async function listCollections(): Promise<ProjectCollection[]> {
  const data = await request<{ collections: ProjectCollection[] }>('/collections');
  return data.collections;
}
export const createCollection = (title: string) => request<ProjectCollection>('/collections', { method: 'POST', body: JSON.stringify({ title }) });
export const renameCollection = (collectionId: string, title: string) => request<ProjectCollection>('/collections/' + id(collectionId), { method: 'PATCH', body: JSON.stringify({ title }) });
export const deleteCollection = (collectionId: string) => request<ProjectCollection>('/collections/' + id(collectionId), { method: 'DELETE' });
export const restoreCollection = (collectionId: string) => request<ProjectCollection>('/collections/' + id(collectionId) + '/restore', { method: 'POST' });
export const listTrash = () => request<ProjectTrash>('/trash');
export async function listProjects(archived = false, collectionId?: string): Promise<VideoProject[]> {
  const data = await request<{ projects: VideoProject[] }>('/projects?status=' + (archived ? 'archived' : 'all') + (collectionId ? '&collection_id=' + id(collectionId) : ''));
  return data.projects;
}
export async function listHistoryVideos(): Promise<VideoProject[]> {
  const [active, archived] = await Promise.all([listProjects(), listProjects(true)]);
  return Array.from(new Map([...active, ...archived].map(video => [video.video_id, video])).values());
}
export const getProject = (projectId: string) => request<ProjectDetail>('/projects/' + id(projectId));
export const patchProject = (projectId: string, patch: { title?: string; archived?: boolean; collection_id?: string }) => request<VideoProject>('/projects/' + id(projectId), { method: 'PATCH', body: JSON.stringify(patch) });
export const deleteVideo = (videoId: string) => request<{ video_id: string; deleted: boolean }>('/projects/' + id(videoId), { method: 'DELETE' });
export const restoreVideo = (videoId: string) => request<VideoProject>('/projects/' + id(videoId) + '/restore', { method: 'POST' });
export const getTranscript = (jobId: string) => request<Transcript>('/videos/' + id(jobId) + '/transcript');
export const saveTranscript = (jobId: string, transcript: Transcript) => request<Transcript>('/videos/' + id(jobId) + '/transcript', { method: 'PUT', body: JSON.stringify({ cues: transcript.cues, revision: transcript.revision }) });
export const calibrateTranscript = (jobId: string, language: DialogueLanguage, revision: number) => request<TranscriptCalibration>('/videos/' + id(jobId) + '/transcript/calibrate', { method: 'POST', body: JSON.stringify({ language, revision }) });
export const getTranscriptCalibration = (calibrationId: string) => request<TranscriptCalibration>('/transcript-calibrations/' + id(calibrationId));
export const getNarration = (jobId: string) => request<NarrationEditor>('/videos/' + id(jobId) + '/editor');
export const setVideoReview = (jobId: string, reviewed: boolean, transcriptRevision: number) => request<{ reviewed: boolean; reviewed_at: string | null; transcript_revision: number }>('/videos/' + id(jobId) + '/review', { method: 'POST', body: JSON.stringify({ reviewed, transcript_revision: transcriptRevision }) });
export const generateNarration = (videoId: string, language: VideoLanguage, voice: string, narrationMode?: 'auto' | 'standard' | 'extended', dialogueLanguage: DialogueLanguage = 'auto') => request<{ execution_arn: string; start_date: string }>('/trigger/executions', { method: 'POST', body: JSON.stringify({ video_id: videoId, language, dialogue_language: dialogueLanguage, voice, ...(narrationMode ? { narration_mode: narrationMode } : {}) }) });
export const renderNarration = (jobId: string, segments: NarrationSegment[], voice: string) => request<{ execution_arn: string; start_date: string }>('/videos/' + id(jobId) + '/render', { method: 'POST', body: JSON.stringify({ segments: segments.map(({ segment_index, dvi_text }) => ({ segment_index, dvi_text })), voice }) });
export const exportUrl = (jobId: string, kind: 'dialogue' | 'description', format: 'srt' | 'vtt' | 'txt') => '/api/videos/' + id(jobId) + '/export?kind=' + kind + '&format=' + format;
export const outputUrl = (jobId: string) => '/api/media/output/' + id(jobId);
