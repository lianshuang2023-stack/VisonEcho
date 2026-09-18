export type VideoLanguage = 'en-US' | 'zh-CN';
export type DialogueLanguage = VideoLanguage | 'auto' | 'none';
export type NarrationMode = 'auto' | 'standard' | 'extended';

export interface SpeechVoice {
  id: string;
  label: string;
  gender?: string;
}

export interface SpeechLanguage {
  id: VideoLanguage;
  label: string;
  voice?: string;
  voices?: SpeechVoice[];
}

export interface BackendHealth {
  status: 'ok';
  provider: 'azure';
  model: string;
  speech_region_configured: boolean;
  configured: boolean;
  issues: string[];
  max_video_seconds?: number;
  max_upload_mb?: number;
  languages?: SpeechLanguage[];
}

export interface ExecutionStep {
  detail?: { completed_segments?: number; num_segments?: number; frame_count?: number };
  name: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  entered_at: string | null;
  exited_at: string | null;
}

export interface ExecutionStarted {
  execution_arn: string;
  start_date: string;
}

export interface ExecutionStatus extends ExecutionStarted {
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'ABORTED';
  stop_date: string | null;
  steps: ExecutionStep[];
  error: string | null;
  cause: string | null;
}

export interface ProjectExecution extends ExecutionStatus {
  detect_characters?: boolean;
  video_id?: string;
  language?: VideoLanguage;
  dialogue_language?: DialogueLanguage;
  voice?: string;
  kind?: 'generate' | 'render';
  source_execution_id?: string;
}

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
  narration_mode?: Exclude<NarrationMode, 'auto'>;
  reviewed?: boolean;
  last_error?: string | null;
  archived: boolean;
  deleted?: boolean;
  deleted_at?: string;
  execution_count: number;
  latest_execution_id: string | null;
  latest_result_id: string | null;
  thumbnail_url: string;
}

export interface ProjectDetail {
  project: VideoProject;
  executions: ProjectExecution[];
  latest_result_id: string | null;
}

export interface ProjectTrash {
  collections: ProjectCollection[];
  videos: VideoProject[];
}

export interface TranscriptCue {
  speaker?: string | null;
  low_confidence?: boolean;
  id: string;
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  cues: TranscriptCue[];
  revision: number;
  language?: DialogueLanguage;
  dialogue_language?: DialogueLanguage;
  quality?: {
    speaker_count?: number;
    diarization_available?: boolean;
    overlapping_utterance_count?: number;
    review_required?: boolean;
    low_confidence_phrase_count?: number;
    low_confidence_word_count?: number;
  };
}

export interface TranscriptCalibration {
  calibration_id: string;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  error?: string | null;
  result?: Transcript;
}

export interface NarrationSegment {
  source_start?: number;
  source_end?: number;
  insertion_time?: number;
  character_ids?: string[];
  segment_index: number;
  start_time: number;
  end_time: number;
  silence_duration: number;
  dvi_text: string;
  audio_duration: number | null;
  pass: boolean;
  skip_reason?: string;
}

export interface TimelineInsertion {
  source_time: number;
  output_start: number;
  output_end: number;
  duration: number;
}

export interface NarrationEditor {
  dialogue_status?: 'recognized' | 'no_speech' | 'unrecognized';
  dialogue_reason?: 'recognized' | 'no_audio_track' | 'silent_audio' | 'initial_silence_timeout' | 'no_recognized_dialogue' | 'speech_not_recognized' | 'user_declared_no_dialogue';
  narration_style?: 'concise' | 'cinematic';
  character_detection?: { status: 'DISABLED' | 'SUCCEEDED' | 'FAILED'; added_count?: number; updated_count?: number; skipped_count?: number; candidate_count?: number; error?: string | null; coverage?: { frame_count: number; segment_count: number } };
  segments: NarrationSegment[];
  language: VideoLanguage;
  dialogue_language?: DialogueLanguage;
  voice: string;
  reviewed?: boolean;
  reviewed_at?: string | null;
  narration_mode?: Exclude<NarrationMode, 'auto'>;
  outcome?: 'audio_description' | 'partial' | 'subtitles_only';
  summary?: {
    video_duration?: number;
    source_video_duration?: number;
    passed_segments?: number;
    total_segments?: number;
    message?: string;
  };
  insertions?: TimelineInsertion[];
}

export type EvidenceIssue = 'wrong_person' | 'wrong_action' | 'missing_content';
export interface EvidenceFrame { id: string; timestamp: number; url: string }
export interface EvidenceFeedback { revision: number; issues: EvidenceIssue[]; note: string }
export interface SegmentEvidence {
  generation_reason?: string;
  window_reason?: 'dialogue_gap' | 'extended_pause';
  nearby_dialogue?: { text: string; start?: number; end?: number }[];
  segment_index: number;
  source_start: number;
  source_end: number;
  provenance: 'model' | 'review';
  frames: EvidenceFrame[];
  observations: { fact: string; frame_ids: string[] }[];
  feedback: EvidenceFeedback;
}
export interface CharacterOccurrence { job_id: string; segment_index: number }
export interface CharacterThumbnail extends CharacterOccurrence { frame_id: string; timestamp: number; url: string }
export interface VideoCharacter {
  before_name?: string;
  name_available_from?: number;
  id: string;
  appearance: string;
  preferred_name: string;
  status: 'unconfirmed' | 'confirmed' | 'recognized';
  recognition?: { kind: 'fictional'; name: string; confidence: 'high' | 'medium' | 'low'; evidence: string };
  aliases: string[];
  thumbnail: CharacterThumbnail | null;
  occurrences: CharacterOccurrence[];
}
export interface CharacterLibrary { revision: number; characters: VideoCharacter[] }
export type SegmentReviewState = 'draft' | 'modified' | 'approved' | 'needs_rewrite';
export interface SegmentReview {
  segment_index: number;
  state: SegmentReviewState;
  text: string;
  available_seconds: number;
  speech_seconds: number;
  timing_source: 'measured' | 'estimated';
  margin_seconds: number;
  risks: string[];
  high_risk: boolean;
}
export interface StudioReviewDocument {
  revision: number;
  transcript_revision: number;
  segments: SegmentReview[];
  counts: { total: number; pending: number; approved: number; conflicts: number; uncertain: number };
  can_export: boolean;
  review_complete?: boolean;
  blockers: string[];
}
export type CharacterFrameSelection = CharacterThumbnail;
export interface CharacterDetection {
  detection_id: string;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  job_id: string;
  added_count?: number;
  updated_count?: number;
  candidate_count?: number;
  skipped_count?: number;
  error_code?: number;
  coverage?: { frame_count: number; segment_count: number };
  error?: string | null;
}
