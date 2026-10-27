#!/usr/bin/env python3
"""Load verified instance paths as CPU MONAI tensors, without creating labels.

Run download_dataset.py first. This deliberately narrow starter handles native
little-endian monochrome instances. It preserves the reader's raw axes: a
multiframe tensor is [channel, frame, row, column], not an assembled 3D volume.
Configure and qualify task-specific geometry, normalization, codecs and labels
before using a real research cohort. No training or clinical validation occurs.
"""
import argparse
import hashlib
import json
from pathlib import Path

import pydicom
import torch
from monai.data import Dataset, PydicomReader, load_decathlon_datalist
from monai.transforms import Compose, EnsureChannelFirstd, LoadImaged


NATIVE_SYNTAXES = {'1.2.840.10008.1.2', '1.2.840.10008.1.2.1'}
PARTITIONS = {'training': 'train', 'validation': 'validation', 'test': 'test', 'unassigned': None}


def file_digest(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def load_dataset(directory, partition='training', limit=1, max_pixels=64_000_000):
    """Return a lazy MONAI Dataset of explicitly chosen, reverified originals."""
    if partition not in PARTITIONS or type(limit) is not int or not 1 <= limit <= 100 or type(max_pixels) is not int or not 1 <= max_pixels <= 64_000_000:
        raise ValueError('Choose a known partition, 1–100 instances and a bounded pixel limit.')
    root = Path(directory).resolve(strict=True)
    report = json.loads((root / 'report.json').read_text())
    provenance = json.loads((root / 'provenance.json').read_text())
    raw_manifest = (root / 'manifest.json').read_bytes()
    manifest = json.loads(raw_manifest)
    datalist = json.loads((root / 'datalist.json').read_text())
    digest = hashlib.sha256(raw_manifest).hexdigest()
    if (report.get('complete') is not True or provenance.get('complete') is not True
            or provenance.get('manifestSha256') != digest or datalist.get('manifestSha256') != digest
            or manifest.get('snapshotId') != datalist.get('snapshotId')):
        raise ValueError('Run the frozen dataset downloader successfully before loading tensors.')
    members = {member['memberId']: member for member in manifest['members']}
    # is_segmentation=False is essential: no label paths or masks are invented.
    records = load_decathlon_datalist(str(root / 'datalist.json'), is_segmentation=False, data_list_key=partition)
    if not records:
        raise ValueError('This partition contains no image instances. Choose a populated partition.')
    originals = root / 'originals'
    if originals.is_symlink():
        raise ValueError('The original-object directory must not be a symbolic link.')
    chosen = records[:limit]
    for record in chosen:
        member = members.get(record.get('memberId'))
        if (not member or member['role'] != 'image' or member['partition'] != PARTITIONS[partition]
                or record.get('subjectId') != member['subjectId'] or record.get('sha256') != member['sha256']):
            raise ValueError('A datalist record differs from its frozen membership.')
        expected = originals / (member['memberId'] + '.dcm')
        if expected.is_symlink() or Path(record['image']).resolve(strict=True) != expected or expected.stat().st_size != member['bytes'] or file_digest(expected) != member['sha256']:
            raise ValueError('An original path, size or SHA-256 differs from the frozen manifest.')
        header = pydicom.dcmread(expected, stop_before_pixels=True)
        if (str(header.file_meta.TransferSyntaxUID) not in NATIVE_SYNTAXES
                or str(header.file_meta.TransferSyntaxUID) != member['transferSyntaxUid']
                or str(header.SOPInstanceUID) != member['sopUid']
                or int(getattr(header, 'SamplesPerPixel', 0)) != 1
                or str(getattr(header, 'PhotometricInterpretation', '')) not in ('MONOCHROME1', 'MONOCHROME2')):
            raise ValueError('This starter requires native little-endian monochrome image instances. Qualify other decoding profiles separately.')
        rows, columns, frames = int(header.Rows), int(header.Columns), int(getattr(header, 'NumberOfFrames', 1))
        if min(rows, columns, frames) < 1 or rows * columns * frames > max_pixels:
            raise ValueError('An instance exceeds the starter pixel limit.')
    # Keep each DICOM as one item. Do not give a directory/list to the reader:
    # that would introduce separate series ordering and volume assumptions.
    return Dataset(chosen, Compose([
        LoadImaged(keys='image', reader=PydicomReader(swap_ij=False, affine_lps_to_ras=False, channel_dim='no_channel'), image_only=True),
        EnsureChannelFirstd(keys='image'),
    ]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', help='Completed download_dataset.py output directory.')
    parser.add_argument('--partition', choices=PARTITIONS, default='training')
    parser.add_argument('--limit', type=int, default=1, help='Number of instance tensors to load (1–100).')
    args = parser.parse_args()
    try:
        dataset = load_dataset(args.directory, args.partition, args.limit)
        for index in range(len(dataset)):
            item = dataset[index]
            tensor = item['image']
            if tensor.device.type != 'cpu' or not torch.isfinite(tensor).all():
                raise ValueError('Expected a finite CPU tensor.')
            print(json.dumps({'memberId': item['memberId'], 'shape': list(tensor.shape), 'dtype': str(tensor.dtype),
                              'device': str(tensor.device), 'min': float(tensor.min()), 'max': float(tensor.max())}))
    except (ValueError, OSError, KeyError) as error:
        parser.exit(1, str(error) + '\n')


if __name__ == '__main__':
    main()
