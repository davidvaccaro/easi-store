import { Readable } from 'node:stream';
import { createDicom, uid } from '../synthetic.js';
import { ArchiveError } from '../archive/errors.js';
import { DATASET_LIMITS } from './DatasetService.js';

/** A small, independently generated cohort to exercise research workflows.
 * Objects use the ordinary durable import path and remain in the archive. */
export async function createResearchDemo(service, { signal } = {}) {
    if (service.list().total >= DATASET_LIMITS.datasets) throw new ArchiveError('Remove an unused dataset definition before creating a research demo.', 413, 'dataset-limit');
    const selection = [];
    for (let subject = 1; subject <= 6; subject++) {
        for (let examination = 1; examination <= 2; examination++) {
            const studyUid = uid(), seriesUid = uid(), modality = examination === 1 ? 'CT' : 'MR';
            selection.push({ studyUid, seriesUid });
            for (let image = 1; image <= 3; image++) {
                signal?.throwIfAborted();
                const bytes = createDicom({ studyUid, seriesUid, patientId: `EASI-RESEARCH-${String(subject).padStart(3, '0')}`,
                    issuer: 'EASI-SYNTHETIC-RESEARCH', patientName: `Generated^Research${subject}`,
                    studyDescription: `${modality} research example · generated`, seriesDescription: `Research ${modality} · synthetic`,
                    modality, sopClassUid: modality === 'MR' ? '1.2.840.10008.5.1.4.1.1.4' : '1.2.840.10008.5.1.4.1.1.2',
                    instanceNumber: image, studyDate: examination === 1 ? '20260115' : '20260415', rows: 64, columns: 64 });
                await service.archive.ingest(Readable.from([bytes]), { source: 'synthetic-research-demo' });
            }
        }
    }
    signal?.throwIfAborted();
    return service.create({ name: 'Research cohort · synthetic', description: 'Six generated subjects, two examinations each. Review, freeze and reproduce an exact dataset.',
        labels: ['synthetic', 'research demo'], reviewNotes: 'Independently generated test images for exercising dataset selection, subject grouping and verified downloads. No clinical annotations or diagnostic meaning.', selection });
}
