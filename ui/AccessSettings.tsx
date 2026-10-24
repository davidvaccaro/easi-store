import React, { useEffect, useId, useRef, useState } from 'react';

type TrustedClient = { callingAeTitle: string; address: string };
type AccessPolicy = { version: 1; profile: 'authenticated' | 'local-research'; dimse: { allowLoopback: boolean; peers: TrustedClient[] } };
type Request = <T>(path: string, options?: RequestInit) => Promise<T>;
const message = (error: unknown) => error instanceof Error ? error.message : 'Access settings could not be saved.';
const profileName = (profile: AccessPolicy['profile']) => profile === 'local-research' ? 'Local research' : 'Authenticated clients';

function policy(value: AccessPolicy): AccessPolicy {
  if (value?.version !== 1 || !['authenticated', 'local-research'].includes(value.profile) ||
      typeof value.dimse?.allowLoopback !== 'boolean' || !Array.isArray(value.dimse.peers) ||
      value.dimse.peers.some(peer => typeof peer.callingAeTitle !== 'string' || typeof peer.address !== 'string')) {
    throw new Error('The server returned an unsupported access policy. Refresh this page after updating EASI Store.');
  }
  return value;
}

export function AccessSettings({ request, onSaved }: { request: Request; onSaved?: () => void }) {
  const id = useId(), savingRequest = useRef<AbortController | null>(null);
  const [draft, setDraft] = useState<AccessPolicy | null>(null), [saved, setSaved] = useState<AccessPolicy | null>(null);
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [reload, setReload] = useState(0);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [callingAeTitle, setCallingAeTitle] = useState(''), [address, setAddress] = useState('');
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    request<AccessPolicy>('/access-policy', { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) { const value = policy(result); setSaved(value); setDraft(value); }
    }).catch(error => { if (!controller.signal.aborted) setError(message(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); savingRequest.current?.abort(); };
  }, [request, reload]);
  const research = draft?.profile === 'local-research', dirty = Boolean(draft && JSON.stringify(draft) !== JSON.stringify(saved));

  function update(change: (value: AccessPolicy) => AccessPolicy) {
    if (!draft || saving) return;
    setDraft(change(draft)); setError(''); setNotice('');
  }
  function addClient() {
    if (!draft || saving || research) return;
    const peer = { callingAeTitle: callingAeTitle.trim(), address: address.trim() };
    if (!/^[\x20-\x7e]{1,16}$/.test(peer.callingAeTitle) || peer.callingAeTitle.includes('\\')) {
      setError('Enter a calling AE title using 1–16 ASCII characters, without a backslash.'); return;
    }
    if (!peer.address || peer.address.length > 45 || /[^0-9a-fA-F:.]/.test(peer.address)) {
      setError('Enter an exact IPv4 or IPv6 address. Hostnames, CIDR ranges and zone IDs are not supported.'); return;
    }
    if (draft.dimse.peers.some(item => item.callingAeTitle === peer.callingAeTitle && item.address === peer.address)) {
      setError('This calling AE and address are already listed.'); return;
    }
    if (draft.dimse.peers.length >= 256) { setError('At most 256 trusted DIMSE clients can be configured.'); return; }
    update(value => ({ ...value, dimse: { ...value.dimse, peers: [...value.dimse.peers, peer] } }));
    setCallingAeTitle(''); setAddress('');
  }
  function reset() {
    setDraft(saved); setError(''); setNotice(''); setCallingAeTitle(''); setAddress('');
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (!draft || saving) return;
    if (!research && (callingAeTitle.trim() || address.trim())) {
      setError('Choose Add client to include the entered DIMSE client, or clear those fields before saving.'); return;
    }
    setSaving(true); setError(''); setNotice('');
    const controller = new AbortController(); savingRequest.current = controller;
    try {
      const result = policy(await request<AccessPolicy>('/access-policy', { method: 'PUT', body: JSON.stringify(draft), signal: controller.signal }));
      if (controller.signal.aborted) return;
      setSaved(result); setDraft(result); setCallingAeTitle(''); setAddress('');
      setNotice('Access settings saved. DICOMweb changes apply now; DIMSE rules apply to new connections.');
      onSaved?.();
    } catch (error) { if (!controller.signal.aborted) setError(message(error)); }
    finally { if (savingRequest.current === controller) savingRequest.current = null; if (!controller.signal.aborted) setSaving(false); }
  }
  return <section className="content-panel access-settings" aria-labelledby={`${id}-title`} aria-busy={loading || saving}>
    <div className="section-label access-heading"><div><span className="eyebrow">CLIENT ACCESS</span><h2 id={`${id}-title`}>Choose how imaging clients connect</h2></div>
      {saved && <span className="outline-pill"><span className="status-dot"/>{profileName(saved.profile)}</span>}
    </div>
    <p className="access-intro">Choose a profile for DICOMweb and incoming DICOM connections. Administration always requires sign-in.</p>
    {loading ? <div className="access-loading" role="status"><span className="spinner"/> Loading access settings…</div> : !draft ? <>
      <div className="inline-error" role="alert">{error || 'Access settings are unavailable.'}</div><button className="button secondary small" type="button" onClick={() => setReload(value => value + 1)}>Retry loading settings</button>
    </> : <form onSubmit={save}>
      <fieldset className="access-profiles" disabled={saving}><legend className="visually-hidden">Access profile</legend>
        <label className={`access-profile${!research ? ' selected' : ''}`}>
          <input type="radio" name={`${id}-profile`} value="authenticated" checked={!research} onChange={() => update(value => ({ ...value, profile: 'authenticated' }))} aria-describedby={`${id}-authenticated`}/>
          <span><strong>Authenticated clients</strong><span id={`${id}-authenticated`}>DICOMweb requires a signed-in session or bearer token. DIMSE uses the trusted AE and IP rules below.</span></span>
        </label>
        <label className={`access-profile${research ? ' selected' : ''}`}>
          <input type="radio" name={`${id}-profile`} value="local-research" checked={research} onChange={() => update(value => ({ ...value, profile: 'local-research' }))} aria-describedby={`${id}-research`}/>
          <span><strong>Local research <small>THIS DEVICE ONLY</small></strong><span id={`${id}-research`}>Let local DICOMweb and DIMSE clients connect without credentials. Available only when both services are bound to loopback.</span></span>
        </label>
      </fieldset>
      <div className="access-protected"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6z M8 12l3 3 5-6"/></svg><p>The management API, settings, configured connections and transfer jobs remain protected in both profiles.</p></div>
      <details className="access-dimse"><summary>Trusted DIMSE clients <span>{draft.dimse.peers.length} configured</span></summary>
        <p className="access-help">DIMSE uses calling AE titles and exact client IP addresses, independently of HTTP sessions and bearer tokens. These rules control admission; DIMSE TLS is not available in this preview.</p>
        <label className="access-local-toggle"><input type="checkbox" checked={research || draft.dimse.allowLoopback} disabled={saving || research} onChange={event => update(value => ({ ...value, dimse: { ...value.dimse, allowLoopback: event.target.checked } }))}/><span><strong>Allow local DIMSE clients</strong><small>{research ? 'Local research always accepts clients on this device. Trusted network rules apply in the authenticated profile.' : 'Accept loopback connections from this device without an additional AE rule.'}</small></span></label>
        {!!draft.dimse.peers.length && <div className="access-peer-scroll"><table className="access-peer-list"><thead><tr><th>Calling AE title</th><th>Client IP address</th><th><span className="visually-hidden">Actions</span></th></tr></thead><tbody>{draft.dimse.peers.map((peer, index) => <tr key={JSON.stringify(peer)}><td><code>{peer.callingAeTitle}</code></td><td><code>{peer.address}</code></td><td><button className="button secondary small" type="button" disabled={saving || research} aria-label={`Remove ${peer.callingAeTitle} at ${peer.address}`} onClick={() => update(value => ({ ...value, dimse: { ...value.dimse, peers: value.dimse.peers.filter((_, position) => position !== index) } }))}>Remove</button></td></tr>)}</tbody></table></div>}
        {!draft.dimse.peers.length && <p className="access-help">No additional DIMSE clients are configured.</p>}
        <fieldset className="access-peer-fields" disabled={saving || research || draft.dimse.peers.length >= 256}><legend className="visually-hidden">Add a trusted DIMSE client</legend>
          <label>Calling AE title<input value={callingAeTitle} onChange={event => { setCallingAeTitle(event.target.value); setError(''); setNotice(''); }} maxLength={16} autoComplete="off" spellCheck={false} placeholder="RESEARCH_PACS"/></label>
          <label>Exact client IP address<input value={address} onChange={event => { setAddress(event.target.value); setError(''); setNotice(''); }} maxLength={45} autoComplete="off" spellCheck={false} placeholder="192.168.1.20 or ::1"/></label>
          <button className="button secondary" type="button" onClick={addClient} disabled={!callingAeTitle.trim() || !address.trim()}>Add client</button>
        </fieldset>
        <p className="access-help">Both the calling AE and source IP must match a listed rule. Network clients also require an explicitly configured network listener.</p>
      </details>
      {error && <div className="inline-error" role="alert">{error}</div>}
      {notice && <div className="inline-success" role="status">{notice}</div>}
      <div className="access-footer"><span role="status">{dirty ? 'Changes have not been saved.' : 'Changes apply only when you save.'}</span><div className="button-row">
        <button className="button secondary" type="button" disabled={saving || !dirty && !callingAeTitle && !address} onClick={reset}>Discard changes</button>
        <button className="button primary" type="submit" disabled={saving || !dirty}>{saving && <span className="spinner"/>}{saving ? 'Saving…' : 'Save access settings'}</button>
      </div></div>
    </form>}
  </section>;
}
