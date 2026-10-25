export type DeletionPreview = { studyUid: string; revision: string; seriesCount: number; instanceCount: number; bytes: number; reclaimableBytes: number };
export type DeletionResult = { studyUid: string; deleted: true; instanceCount: number; bytes: number; reclaimedBytes: number; reclamationPending: boolean };
const uid = (value: unknown) => typeof value === 'string' && value.length <= 64 && /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*$/.test(value);
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export function studyExportPath(studyUid: string) {
  if (!uid(studyUid)) throw new Error('Select a valid archived study.');
  return `/api/v1/studies/${encodeURIComponent(studyUid)}/export`;
}
export function deletionPreview(value: unknown, studyUid: string): DeletionPreview {
  const preview = value as DeletionPreview;
  if (!preview || preview.studyUid !== studyUid || !uid(studyUid) || typeof preview.revision !== 'string' || !preview.revision || preview.revision.length > 256
    || /[\x00-\x1f\x7f]/.test(preview.revision) || ![preview.seriesCount, preview.instanceCount, preview.bytes, preview.reclaimableBytes].every(count) || preview.reclaimableBytes > preview.bytes) throw new Error('The study deletion preview was invalid. Reload the preview before continuing.');
  return { studyUid, revision: preview.revision, seriesCount: preview.seriesCount, instanceCount: preview.instanceCount, bytes: preview.bytes,
    reclaimableBytes: preview.reclaimableBytes };
}
export function deletionBody(preview: DeletionPreview, confirmation: string) {
  deletionPreview(preview, preview.studyUid);
  if (confirmation !== 'DELETE') throw new Error('Type DELETE exactly to confirm removal.');
  return JSON.stringify({ confirmation: 'DELETE', revision: preview.revision });
}
export function deletionResult(value: unknown, studyUid: string): DeletionResult {
  const result = value as DeletionResult;
  if (!result || result.studyUid !== studyUid || result.deleted !== true || ![result.instanceCount, result.bytes, result.reclaimedBytes].every(count)
    || result.reclaimedBytes > result.bytes || typeof result.reclamationPending !== 'boolean') throw new Error('The removal outcome could not be verified. Refresh the library before retrying.');
  return { studyUid, deleted: true, instanceCount: result.instanceCount, bytes: result.bytes, reclaimedBytes: result.reclaimedBytes, reclamationPending: result.reclamationPending };
}
