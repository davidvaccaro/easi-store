#!/usr/bin/env python3
"""Download one frozen EASI Store snapshot using only Python's standard library.

Original DICOM files remain encoded DICOM, including compressed/multiframe images
and derived objects. This example performs no anonymization, pixel conversion,
SEG-to-mask conversion, labeling, or clinical validation. See README.md.
"""
import argparse
import concurrent.futures
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import stat
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request

MAX_MANIFEST_BYTES = 96 * 1024 * 1024
MAX_MEMBERS = 100000
CHUNK_BYTES = 1024 * 1024
STOP = threading.Event()


class DownloadError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, newurl):
        return None


def json_bytes(value):
    return (json.dumps(value, indent=2, ensure_ascii=True) + '\n').encode('utf-8')


def no_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise DownloadError('invalid-manifest', 'The snapshot manifest contains duplicate fields.')
        result[key] = value
    return result


def checked_base_url(value):
    try:
        url = urllib.parse.urlsplit(value)
        port = url.port
        hostname = url.hostname
        loopback = hostname == 'localhost' or ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        loopback = False
        try:
            url = urllib.parse.urlsplit(value)
            port = url.port
            hostname = url.hostname
        except ValueError:
            raise DownloadError('invalid-base-url', 'Use a complete HTTP(S) Store base URL.') from None
    if (url.scheme not in ('http', 'https') or not hostname or url.username is not None
            or url.password is not None or url.query or url.fragment
            or any(part in ('.', '..') for part in url.path.split('/'))
            or '%' in url.path or re.search(r'[\x00-\x20\x7f]', value)
            or (port is not None and not 1 <= port <= 65535)):
        raise DownloadError('invalid-base-url', 'Use a complete HTTP(S) Store base URL without credentials, query, or fragment.')
    if url.scheme != 'https' and not loopback:
        raise DownloadError('insecure-base-url', 'Use HTTPS for a non-loopback Store endpoint.')
    return value.rstrip('/')


def special_file(info):
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, 'st_file_attributes', 0) & 0x400)


def check_path(path, require_directory=False):
    # Refuse links/junctions in every existing parent as well as the final file.
    # The output directory must be private to this process/user while running.
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current = current / part
        try:
            info = current.lstat()
        except FileNotFoundError:
            continue
        if special_file(info) or (current != path and not stat.S_ISDIR(info.st_mode)):
            raise DownloadError('unsafe-output', 'The output path contains a link or non-directory parent.')
        if current == path and require_directory and not stat.S_ISDIR(info.st_mode):
            raise DownloadError('unsafe-output', 'The output location must be a directory.')
    return path


def output_directory(value):
    path = Path(os.path.abspath(value))
    check_path(path, require_directory=True)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    check_path(path, require_directory=True)
    return path


def open_regular(path, flags, mode=0o600):
    check_path(path)
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise DownloadError('unsafe-output', 'Output files must be regular files without multiple hard links.')
    except FileNotFoundError:
        pass
    descriptor = os.open(path, flags | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0) | getattr(os, 'O_BINARY', 0), mode)
    info = os.fstat(descriptor)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        os.close(descriptor)
        raise DownloadError('unsafe-output', 'Only regular files may be used inside the output directory.')
    return descriptor


class OutputLock:
    def __init__(self, root):
        self.root = root
        self.descriptor = None

    def __enter__(self):
        self.descriptor = open_regular(self.root / '.download.lock', os.O_RDWR | os.O_CREAT)
        try:
            if os.name == 'nt':
                import msvcrt
                os.write(self.descriptor, b'0')
                os.lseek(self.descriptor, 0, os.SEEK_SET)
                msvcrt.locking(self.descriptor, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(self.descriptor)
            self.descriptor = None
            raise DownloadError('output-busy', 'Another downloader is using this output directory.') from None
        return self

    def __exit__(self, *unused):
        os.close(self.descriptor)


def atomic_write(path, content):
    check_path(path)
    partial = path.with_name(path.name + '.partial')
    descriptor = open_regular(partial, os.O_WRONLY | os.O_CREAT | os.O_TRUNC)
    with os.fdopen(descriptor, 'wb') as output:
        output.write(content)
        output.flush()
        os.fsync(output.fileno())
    check_path(path)
    os.replace(partial, path)


def read_regular(path, limit):
    descriptor = open_regular(path, os.O_RDONLY)
    with os.fdopen(descriptor, 'rb') as source:
        if os.fstat(source.fileno()).st_size > limit:
            raise DownloadError('local-file-too-large', 'A local metadata file exceeds its allowed size.')
        return source.read(limit + 1)


def verify_existing(path, expected_bytes, expected_sha256):
    try:
        descriptor = open_regular(path, os.O_RDONLY)
    except FileNotFoundError:
        return False
    digest = hashlib.sha256()
    with os.fdopen(descriptor, 'rb') as source:
        if os.fstat(source.fileno()).st_size != expected_bytes:
            return False
        for chunk in iter(lambda: source.read(CHUNK_BYTES), b''):
            if STOP.is_set():
                raise DownloadError('interrupted', 'The download was interrupted; verified originals can be resumed.')
            digest.update(chunk)
    return digest.hexdigest() == expected_sha256


class StoreClient:
    def __init__(self, base_url, token, timeout):
        self.base_url, self.token, self.timeout = base_url, token, timeout
        # Environment proxy settings and redirects must not move an archive
        # credential to a different endpoint. TLS verification stays enabled.
        self.opener = urllib.request.build_opener(NoRedirect(), urllib.request.ProxyHandler({}))

    def get(self, relative, accept):
        headers = {'Accept': accept, 'Accept-Encoding': 'identity', 'User-Agent': 'EASI-Store-Snapshot-Example/1'}
        if self.token:
            headers['Authorization'] = 'Bearer ' + self.token
        request = urllib.request.Request(self.base_url + relative, headers=headers)
        try:
            return self.opener.open(request, timeout=self.timeout)
        except urllib.error.HTTPError as error:
            error.close()
            code = error.code
            if 300 <= code < 400:
                raise DownloadError('redirect-refused', 'Store redirected the request; use its explicit final base URL.') from None
            if code in (401, 403):
                raise DownloadError('authentication-required', 'Store requires an authorized bearer token for this snapshot.') from None
            if code in (404, 410):
                raise DownloadError('member-missing', 'The frozen snapshot or original is no longer available.') from None
            if code in (409, 412):
                raise DownloadError('member-changed', 'The frozen snapshot or original no longer matches its recorded state.') from None
            if code == 503:
                raise DownloadError('source-unavailable', 'Store could not verify or serve the frozen original. Review archive status before retrying.') from None
            raise DownloadError('http-error', 'Store did not complete the request (HTTP %d).' % code) from None
        except (OSError, urllib.error.URLError, ValueError):
            raise DownloadError('connection-failed', 'The configured Store endpoint could not complete the request.') from None

    def manifest(self, relative):
        with self.get(relative, 'application/json') as response:
            advertised_sha256 = response.headers.get('X-EASI-Manifest-SHA256')
            chunks, size = [], 0
            while True:
                if STOP.is_set():
                    raise DownloadError('interrupted', 'The download was interrupted; verified originals can be resumed.')
                chunk = response.read(CHUNK_BYTES)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_MANIFEST_BYTES:
                    raise DownloadError('manifest-too-large', 'The snapshot manifest exceeds 96 MiB.')
                chunks.append(chunk)
        raw = b''.join(chunks)
        if advertised_sha256 is not None and (not re.fullmatch(r'[a-f0-9]{64}', advertised_sha256)
                or hashlib.sha256(raw).hexdigest() != advertised_sha256):
            raise DownloadError('manifest-hash-mismatch', 'The received manifest differs from Store’s advertised SHA-256.')
        return raw

    def download(self, relative, path, expected_bytes, expected_sha256):
        if verify_existing(path, expected_bytes, expected_sha256):
            return 'verified-existing'
        if STOP.is_set():
            raise DownloadError('interrupted', 'The download was interrupted; verified originals can be resumed.')
        partial = path.with_name(path.name + '.partial')
        size, digest = 0, hashlib.sha256()
        with self.get(relative, 'application/dicom') as response:
            content_length = response.headers.get('Content-Length')
            if content_length is not None and (not content_length.isdigit() or int(content_length) != expected_bytes):
                raise DownloadError('size-mismatch', 'The original size differs from the frozen snapshot.')
            if response.headers.get('Content-Encoding', 'identity').lower() != 'identity':
                raise DownloadError('encoding-mismatch', 'The original response must preserve its exact encoded bytes.')
            descriptor = open_regular(partial, os.O_WRONLY | os.O_CREAT | os.O_TRUNC)
            with os.fdopen(descriptor, 'wb') as output:
                while True:
                    if STOP.is_set():
                        raise DownloadError('interrupted', 'The download was interrupted; verified originals can be resumed.')
                    chunk = response.read(CHUNK_BYTES)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > expected_bytes:
                        raise DownloadError('size-mismatch', 'The original size differs from the frozen snapshot.')
                    digest.update(chunk)
                    output.write(chunk)
                if size != expected_bytes:
                    raise DownloadError('size-mismatch', 'The original size differs from the frozen snapshot.')
                if digest.hexdigest() != expected_sha256:
                    raise DownloadError('hash-mismatch', 'The original SHA-256 differs from the frozen snapshot.')
                output.flush()
                os.fsync(output.fileno())
        check_path(path)
        os.replace(partial, path)
        return 'downloaded'


def identifier(value):
    return isinstance(value, str) and re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', value) is not None


def snapshot_path(dataset_id, version):
    return '/api/v1/datasets/%s/versions/%d' % (dataset_id, version)


def parse_manifest(raw, dataset_id, version):
    try:
        value = json.loads(raw.decode('utf-8'), object_pairs_hook=no_duplicate_keys,
                           parse_constant=lambda unused: (_ for _ in ()).throw(ValueError()))
    except (ValueError, UnicodeError, RecursionError):
        raise DownloadError('invalid-manifest', 'Store did not return a valid UTF-8 snapshot manifest.') from None
    if (not isinstance(value, dict) or type(value.get('schemaVersion')) is not int or value.get('schemaVersion') != 1
            or value.get('kind') != 'easi-store-dataset' or value.get('datasetId') != dataset_id
            or type(value.get('version')) is not int or value.get('version') != version or not identifier(value.get('snapshotId'))
            or not isinstance(value.get('members'), list) or not 1 <= len(value['members']) <= MAX_MEMBERS):
        raise DownloadError('invalid-manifest', 'The manifest is not the requested supported frozen snapshot.')
    seen, subjects, total_bytes = set(), {}, 0
    for member in value['members']:
        if not isinstance(member, dict):
            raise DownloadError('invalid-manifest', 'The snapshot contains an invalid member.')
        member_id, subject_id = member.get('memberId'), member.get('subjectId')
        partition, size = member.get('partition'), member.get('bytes')
        if (not identifier(member_id) or member_id in seen or not identifier(subject_id)
                or partition not in (None, 'train', 'validation', 'test')
                or type(size) is not int or not 0 < size <= 8 * 1024 ** 3
                or not isinstance(member.get('sha256'), str) or not re.fullmatch(r'[a-f0-9]{64}', member['sha256'])
                or member.get('role') not in ('image', 'segmentation', 'structured-report', 'other')
                or member.get('grouping') not in ('issuer-patient-id', 'source-patient-id', 'study-fallback')):
            raise DownloadError('invalid-manifest', 'The snapshot contains an invalid member or output identifier.')
        for key in ('studyUid', 'seriesUid', 'sopUid', 'sopClassUid', 'transferSyntaxUid'):
            uid = member.get(key)
            if (not isinstance(uid, str) or len(uid) > 64 or not re.fullmatch(r'[0-9]+(?:\.[0-9]+)+', uid)
                    or any(len(part) > 1 and part.startswith('0') for part in uid.split('.'))):
                raise DownloadError('invalid-manifest', 'The snapshot contains an invalid DICOM identifier.')
        expected_path = snapshot_path(dataset_id, version) + '/members/' + member_id + '/original'
        if member.get('originalPath') != expected_path:
            raise DownloadError('invalid-member-path', 'A member download path differs from its frozen identifier.')
        if subject_id in subjects and subjects[subject_id] != partition:
            raise DownloadError('split-conflict', 'A subject crosses dataset partitions; the snapshot cannot be used safely.')
        subjects[subject_id] = partition
        seen.add(member_id)
        total_bytes += size
    summary = value.get('summary')
    if (not isinstance(summary, dict) or summary.get('instances') != len(seen)
            or summary.get('bytes') != total_bytes or summary.get('subjects') != len(subjects)
            or (value.get('split') is None and any(partition is not None for partition in subjects.values()))
            or (value.get('split') is not None and any(partition is None for partition in subjects.values()))):
        raise DownloadError('invalid-manifest', 'The manifest summary or partition assignment is inconsistent.')
    return value


def write_datalist(root, manifest, manifest_sha256):
    result = {'name': 'EASI Store frozen DICOM snapshot', 'schemaVersion': 1,
              'datasetId': manifest['datasetId'], 'version': manifest['version'],
              'snapshotId': manifest['snapshotId'], 'manifestSha256': manifest_sha256,
              'description': 'Instance-level encoded DICOM paths, not converted training tensors or validated labels. '
                             'Configure a suitable DICOM loader and task-specific preprocessing. No SEG-to-mask conversion occurs.',
              'training': [], 'validation': [], 'test': [], 'unassigned': [], 'dicom_objects': []}
    for member in manifest['members']:
        record = {'memberId': member['memberId'], 'subjectId': member['subjectId'],
                  'partition': member['partition'], 'studyUid': member['studyUid'], 'seriesUid': member['seriesUid'],
                  'sopUid': member['sopUid'], 'sopClassUid': member['sopClassUid'],
                  'transferSyntaxUid': member['transferSyntaxUid'], 'bytes': member['bytes'], 'sha256': member['sha256']}
        relative = 'originals/' + member['memberId'] + '.dcm'
        if member['role'] == 'image':
            record['image'] = relative
            section = {'train': 'training', 'validation': 'validation', 'test': 'test', None: 'unassigned'}[member['partition']]
            result[section].append(record)
        else:
            record.update({'dicom': relative, 'role': member['role']})
            result['dicom_objects'].append(record)
    atomic_write(root / 'datalist.json', json_bytes(result))


def run(args):
    token = os.environ.get(args.token_env, '')
    if len(token) > 8192 or re.search(r'[\x00-\x20\x7f]', token):
        raise DownloadError('invalid-token', 'The selected token environment variable contains an invalid bearer token.')
    base_url = checked_base_url(args.base_url)
    root = output_directory(args.output)
    client = StoreClient(base_url, token, args.timeout)
    report = {'schemaVersion': 1, 'datasetId': args.dataset, 'version': args.version,
              'complete': False, 'interrupted': False, 'counts': {'downloaded': 0, 'verified-existing': 0, 'failed': 0}, 'members': []}
    with OutputLock(root):
        # A prior success receipt must never represent the current failed run.
        datalist = root / 'datalist.json'
        check_path(datalist)
        if datalist.exists():
            descriptor = open_regular(datalist, os.O_RDONLY)
            os.close(descriptor)
            datalist.unlink()
        try:
            relative = snapshot_path(args.dataset, args.version) + '/manifest'
            raw = client.manifest(relative)
            manifest_sha256 = hashlib.sha256(raw).hexdigest()
            report['manifestSha256'] = manifest_sha256
            if args.manifest_sha256 and args.manifest_sha256 != manifest_sha256:
                raise DownloadError('manifest-hash-mismatch', 'The manifest SHA-256 differs from the explicitly pinned value.')
            manifest = parse_manifest(raw, args.dataset, args.version)
            report['snapshotId'] = manifest['snapshotId']
            manifest_path = root / 'manifest.json'
            if manifest_path.exists() or manifest_path.is_symlink():
                if read_regular(manifest_path, MAX_MANIFEST_BYTES) != raw:
                    raise DownloadError('snapshot-changed', 'This output directory belongs to different manifest bytes; choose a new directory.')
            else:
                atomic_write(manifest_path, raw)
            originals = root / 'originals'
            check_path(originals, require_directory=True)
            originals.mkdir(mode=0o700, exist_ok=True)
            check_path(originals, require_directory=True)
            provenance = {'schemaVersion': 1, 'datasetId': args.dataset, 'version': args.version,
                          'snapshotId': manifest['snapshotId'], 'manifestSha256': manifest_sha256,
                          'hashAlgorithm': 'sha256', 'originalBytesPreserved': True, 'anonymized': False, 'complete': False,
                          'content': 'Encoded DICOM originals; no decoding, transcoding, SEG conversion or label inference.',
                          'memberCount': len(manifest['members']), 'bytes': manifest['summary']['bytes']}
            atomic_write(root / 'provenance.json', json_bytes(provenance))

            def one(member):
                result = {'memberId': member['memberId'], 'sha256': member['sha256'], 'bytes': member['bytes']}
                try:
                    route = snapshot_path(args.dataset, args.version) + '/members/' + member['memberId'] + '/original'
                    result['status'] = client.download(route, originals / (member['memberId'] + '.dcm'), member['bytes'], member['sha256'])
                except DownloadError as error:
                    result.update({'status': 'failed', 'error': {'code': error.code, 'message': str(error)}})
                except Exception:
                    result.update({'status': 'failed', 'error': {'code': 'transfer-failed', 'message': 'The original could not be safely downloaded or written.'}})
                return result

            iterator = iter(manifest['members'])
            with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
                pending = {}
                for unused in range(args.workers):
                    member = next(iterator, None)
                    if member is not None:
                        pending[executor.submit(one, member)] = member
                while pending:
                    done, unused = concurrent.futures.wait(pending, return_when=concurrent.futures.FIRST_COMPLETED)
                    for future in done:
                        pending.pop(future)
                        result = future.result()
                        report['members'].append(result)
                        report['counts'][result['status']] += 1
                        if not STOP.is_set():
                            member = next(iterator, None)
                            if member is not None:
                                pending[executor.submit(one, member)] = member
            report['interrupted'] = STOP.is_set()
            report['complete'] = not STOP.is_set() and report['counts']['failed'] == 0 and len(report['members']) == len(manifest['members'])
            report['expectedMembers'] = len(manifest['members'])
            report['notAttempted'] = len(manifest['members']) - len(report['members'])
            order = {member['memberId']: index for index, member in enumerate(manifest['members'])}
            report['members'].sort(key=lambda member: order[member['memberId']])
            if report['complete']:
                write_datalist(root, manifest, manifest_sha256)
            provenance['complete'] = report['complete']
            atomic_write(root / 'provenance.json', json_bytes(provenance))
        except DownloadError as error:
            report['error'] = {'code': error.code, 'message': str(error)}
        except Exception:
            report['error'] = {'code': 'download-failed', 'message': 'The snapshot could not be safely downloaded or written.'}
        atomic_write(root / 'report.json', json_bytes(report))
    print(json.dumps({'complete': report['complete'], 'counts': report['counts'],
                      'interrupted': report['interrupted'], 'error': report.get('error'), 'report': str(root / 'report.json')}))
    return 0 if report['complete'] else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', required=True, help='Explicit Store HTTP(S) base URL; HTTP is restricted to loopback.')
    parser.add_argument('--dataset', required=True, help='Dataset UUID from Store.')
    parser.add_argument('--version', required=True, type=int, help='Frozen dataset version (positive integer).')
    parser.add_argument('--output', required=True, help='Private output directory; no symbolic links or junctions.')
    parser.add_argument('--token-env', default='EASI_STORE_TOKEN', help='Name of an environment variable containing the API bearer token.')
    parser.add_argument('--manifest-sha256', help='Optional exact manifest body SHA-256 for provenance pinning.')
    parser.add_argument('--workers', type=int, default=4, help='Concurrent file downloads (1–16; default 4).')
    parser.add_argument('--timeout', type=int, default=30, help='Per-socket timeout in seconds (1–120; default 30).')
    args = parser.parse_args()
    if (not identifier(args.dataset) or not 1 <= args.version <= 2147483647 or not 1 <= args.workers <= 16
            or not 1 <= args.timeout <= 120 or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,127}', args.token_env)
            or args.manifest_sha256 is not None and not re.fullmatch(r'[a-f0-9]{64}', args.manifest_sha256)):
        parser.error('Invalid dataset/version, worker/timeout bounds, environment variable name or manifest SHA-256.')
    for name in ('SIGINT', 'SIGTERM'):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), lambda unused_signal, unused_frame: STOP.set())
    try:
        return run(args)
    except DownloadError as error:
        print(json.dumps({'complete': False, 'error': {'code': error.code, 'message': str(error)}}))
        return 1
    except Exception:
        print(json.dumps({'complete': False, 'error': {'code': 'download-failed', 'message': 'The snapshot output could not be safely accessed.'}}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
