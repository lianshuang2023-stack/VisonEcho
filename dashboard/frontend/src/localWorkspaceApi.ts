import { requestJson } from './api';
import type {
  CharacterDetection, CharacterLibrary, EvidenceFeedback, SegmentEvidence, DialogueLanguage, ExecutionStarted, NarrationEditor, NarrationMode, NarrationSegment,
  ProjectCollection, ProjectDetail, ProjectTrash, Transcript, TranscriptCalibration,
  VideoLanguage, VideoProject,
} from './types';

export type {
  CharacterDetection, CharacterLibrary, CharacterFrameSelection, CharacterOccurrence, CharacterThumbnail, VideoCharacter, EvidenceFeedback, EvidenceFrame, EvidenceIssue, SegmentEvidence,
  DialogueLanguage, NarrationEditor, NarrationMode, NarrationSegment, ProjectCollection,
  ProjectDetail, ProjectExecution, ProjectStatus, ProjectTrash, TimelineInsertion,
  Transcript, TranscriptCalibration, TranscriptCue, VideoLanguage, VideoProject, WorkflowStatus,
} from './types';

const pathId = encodeURIComponent;
const projectPath = (videoId: string) => `/projects/${pathId(videoId)}`;
const versionPath = (jobId: string) => `/videos/${pathId(jobId)}`;
const collectionPath = (collectionId: string) => `/collections/${pathId(collectionId)}`;

export async function listCollections(): Promise<ProjectCollection[]> {
  const result = await requestJson<{ collections: ProjectCollection[] }>('/collections');
  return result.collections;
}

export function createCollection(title: string): Promise<ProjectCollection> {
  return requestJson('/collections', { method: 'POST', body: JSON.stringify({ title }) });
}

export function renameCollection(collectionId: string, title: string): Promise<ProjectCollection> {
  return requestJson(collectionPath(collectionId), { method: 'PATCH', body: JSON.stringify({ title }) });
}

export function deleteCollection(collectionId: string): Promise<ProjectCollection> {
  return requestJson(collectionPath(collectionId), { method: 'DELETE' });
}

export function restoreCollection(collectionId: string): Promise<ProjectCollection> {
  return requestJson(`${collectionPath(collectionId)}/restore`, { method: 'POST' });
}

export function listTrash(): Promise<ProjectTrash> {
  return requestJson('/trash');
}

export async function listProjects(archived = false, collectionId?: string): Promise<VideoProject[]> {
  const query = new URLSearchParams({ status: archived ? 'archived' : 'all' });
  if (collectionId) query.set('collection_id', collectionId);
  const result = await requestJson<{ projects: VideoProject[] }>(`/projects?${query}`);
  return result.projects;
}

export async function listHistoryVideos(): Promise<VideoProject[]> {
  const [active, archived] = await Promise.all([listProjects(), listProjects(true)]);
  return [...new Map([...active, ...archived].map(video => [video.video_id, video])).values()];
}

export function getProject(videoId: string): Promise<ProjectDetail> {
  return requestJson(projectPath(videoId));
}

export function patchProject(videoId: string, patch: { title?: string; archived?: boolean; collection_id?: string }): Promise<VideoProject> {
  return requestJson(projectPath(videoId), { method: 'PATCH', body: JSON.stringify(patch) });
}

export function deleteVideo(videoId: string): Promise<{ video_id: string; deleted: boolean }> {
  return requestJson(projectPath(videoId), { method: 'DELETE' });
}

export function restoreVideo(videoId: string): Promise<VideoProject> {
  return requestJson(`${projectPath(videoId)}/restore`, { method: 'POST' });
}

export function getTranscript(jobId: string): Promise<Transcript> {
  return requestJson(`${versionPath(jobId)}/transcript`);
}

export function saveTranscript(jobId: string, transcript: Transcript): Promise<Transcript> {
  return requestJson(`${versionPath(jobId)}/transcript`, {
    method: 'PUT',
    body: JSON.stringify({ cues: transcript.cues, revision: transcript.revision }),
  });
}

export function calibrateTranscript(jobId: string, language: DialogueLanguage, revision: number): Promise<TranscriptCalibration> {
  return requestJson(`${versionPath(jobId)}/transcript/calibrate`, {
    method: 'POST', body: JSON.stringify({ language, revision }),
  });
}

export function getTranscriptCalibration(calibrationId: string): Promise<TranscriptCalibration> {
  return requestJson(`/transcript-calibrations/${pathId(calibrationId)}`);
}

export function getNarration(jobId: string): Promise<NarrationEditor> {
  return requestJson(`${versionPath(jobId)}/editor`);
}

export function generateNarration(
  videoId: string, language: VideoLanguage, voice: string,
  narrationMode?: NarrationMode, dialogueLanguage: DialogueLanguage = 'auto', detectCharacters = true,
): Promise<ExecutionStarted> {
  return requestJson('/trigger/executions', {
    method: 'POST',
    body: JSON.stringify({
      video_id: videoId, language, dialogue_language: dialogueLanguage, voice, detect_characters: detectCharacters,
      ...(narrationMode ? { narration_mode: narrationMode } : {}),
    }),
  });
}

export function renderNarration(jobId: string, segments: NarrationSegment[], voice: string): Promise<ExecutionStarted> {
  return requestJson(`${versionPath(jobId)}/render`, {
    method: 'POST',
    body: JSON.stringify({
      segments: segments.map(({ segment_index, dvi_text }) => ({ segment_index, dvi_text })),
      voice,
    }),
  });
}

export function exportUrl(jobId: string, kind: 'dialogue' | 'description', format: 'srt' | 'vtt' | 'txt'): string {
  return `/api${versionPath(jobId)}/export?${new URLSearchParams({ kind, format })}`;
}

export function outputUrl(jobId: string): string {
  return `/api/media/output/${pathId(jobId)}`;
}

export function getSegmentEvidence(jobId: string, segmentIndex: number): Promise<SegmentEvidence> {
  return requestJson(`${versionPath(jobId)}/segments/${segmentIndex}/evidence`);
}

export function saveEvidenceFeedback(jobId: string, segmentIndex: number, feedback: EvidenceFeedback): Promise<EvidenceFeedback> {
  return requestJson(`${versionPath(jobId)}/segments/${segmentIndex}/feedback`, {
    method: 'PUT', body: JSON.stringify(feedback),
  });
}

export function getCharacters(projectId: string): Promise<CharacterLibrary> {
  return requestJson(`${projectPath(projectId)}/characters`);
}

export function saveCharacters(projectId: string, library: CharacterLibrary): Promise<CharacterLibrary> {
  return requestJson(`${projectPath(projectId)}/characters`, {
    method: 'PUT',
    body: JSON.stringify({ revision: library.revision, characters: library.characters.map(character => ({
      ...character, thumbnail: character.thumbnail ? {
        job_id: character.thumbnail.job_id, segment_index: character.thumbnail.segment_index, frame_id: character.thumbnail.frame_id,
      } : null,
    })) }),
  });
}

function characterDetection(value: CharacterDetection): CharacterDetection {
  if (!value || typeof value.detection_id !== 'string' || !value.detection_id || typeof value.job_id !== 'string' || !['RUNNING', 'SUCCEEDED', 'FAILED'].includes(value.status)) {
    throw new Error('The service returned an invalid character detection status. Reload and try again.');
  }
  return value;
}

export async function detectCharacters(jobId: string, revision: number, language: VideoLanguage): Promise<CharacterDetection> {
  return characterDetection(await requestJson(versionPath(jobId) + '/characters/detect', { method: 'POST', body: JSON.stringify({ revision, language }) }));
}

export async function getCharacterDetection(detectionId: string): Promise<CharacterDetection> {
  return characterDetection(await requestJson('/character-detections/' + pathId(detectionId)));
}

export async function getLatestCharacterDetection(projectId: string): Promise<CharacterDetection | null> {
  const value = await requestJson<CharacterDetection | null>(projectPath(projectId) + '/characters/detection/latest');
  return value === null ? null : characterDetection(value);
}
