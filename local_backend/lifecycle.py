"""Visibility rules shared by project, video, and task endpoints."""
from fastapi import HTTPException


def collection_deleted(data, collection_id):
    collection = data.get('collections', {}).get(collection_id)
    return bool(collection and (collection.get('deleted') or collection.get('deleted_at')))


def video_deleted(data, video_id):
    source = data.get('inputs', {}).get(video_id)
    return not source or bool(source.get('deleted') or source.get('deleted_at') or
                              collection_deleted(data, source.get('collection_id', 'default')))


def require_video(data, video_id):
    if video_deleted(data, video_id):
        raise HTTPException(404, '视频不存在或已移到回收站。')
    return data['inputs'][video_id]


def require_collection(data, collection_id):
    collection = data.get('collections', {}).get(collection_id)
    if not collection or collection_deleted(data, collection_id):
        raise HTTPException(404, '项目不存在或已移到回收站。')
    return collection


def video_running(data, video_id):
    jobs = data.get('executions', {})
    if any(job.get('video_id') == video_id and job.get('status') == 'RUNNING' for job in jobs.values()):
        return True
    return any(task.get('status') == 'RUNNING' and jobs.get(task.get('job_id'), {}).get('video_id') == video_id
               for task in data.get('calibrations', {}).values())
