import test from 'node:test';
import assert from 'node:assert/strict';
import { assessReadiness,classifyObject,READINESS_LIMITATIONS } from '../src/datasets/Readiness.js';

const record={patientKey:'opaque-local-key',grouping:'issuer-patient-id',studyUid:'1.2.3',seriesUid:'1.2.3.4',sopClassUid:'1.2.840.10008.5.1.4.1.1.2',
  modality:'CT',transferSyntaxUid:'1.2.840.10008.1.2.1',rows:512,columns:512,frames:1,bytes:1000,instanceNumber:'1'};
test('technical checks flag missing image dimensions and instance numbers and mixed encodings',()=>{
  const result=assessReadiness([{...record,rows:0,columns:0,instanceNumber:''},{...record,transferSyntaxUid:'1.2.840.10008.1.2.4.90',sopClassUid:'1.2.840.10008.5.1.4.1.1.4'}]);
  const codes=result.series[0].warnings.map(row=>row.code);
  for(const code of ['missing-image-dimensions','mixed-image-dimensions','mixed-transfer-syntaxes','mixed-sop-classes','missing-instance-numbers'])assert.ok(codes.includes(code),code);
  assert.deepEqual(result.summary,{subjects:1,patients:1,studies:1,series:1,instances:2,bytes:2000});
  assert.deepEqual(result.limitations,READINESS_LIMITATIONS);
});
test('conservative SOP roles avoid treating arbitrary pixel-bearing or spectroscopy objects as training images',()=>{
  assert.equal(classifyObject('1.2.840.10008.5.1.4.1.1.4.1'),'image');
  // MR spectroscopy contains spectroscopy data, not a native image pixel plane.
  assert.equal(classifyObject('1.2.840.10008.5.1.4.1.1.4.2'),'other');
  assert.equal(classifyObject('1.2.840.10008.5.1.4.1.1.77.1.5.3'),'other');
  assert.equal(classifyObject('1.2.840.10008.5.1.4.1.1.66.4'),'segmentation');
  assert.equal(classifyObject('1.2.840.10008.5.1.4.1.1.88.22'),'structured-report');
  const result=assessReadiness([{...record,sopClassUid:'2.25.123',rows:0,columns:0}]);
  assert.ok(result.warnings.some(row=>row.code==='no-recognized-image-objects'));
  assert.equal(result.series[0].warnings.some(row=>row.code==='missing-image-dimensions'),false);
});
