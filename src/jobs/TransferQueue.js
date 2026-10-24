import { randomUUID } from 'node:crypto';
import { httpError } from '../http/utils.js';

/** One instance in flight; remote delivery is at least once across power loss. */
export class TransferQueue {
  constructor({db,service,autoStart=true}) {this.db=db;this.service=service;this.autoStart=autoStart;this.closing=false;this.current=null;this.running=null;}
  initialize() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS transfer_jobs (id TEXT PRIMARY KEY,connectionId TEXT NOT NULL,connectionRevision INTEGER NOT NULL,connectionName TEXT NOT NULL,direction TEXT NOT NULL,selection TEXT NOT NULL,state TEXT NOT NULL,total INTEGER NOT NULL DEFAULT 0,completed INTEGER NOT NULL DEFAULT 0,failed INTEGER NOT NULL DEFAULT 0,message TEXT NOT NULL DEFAULT '',createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS transfer_items (jobId TEXT NOT NULL,position INTEGER NOT NULL,identity TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',outcome TEXT NOT NULL DEFAULT '',PRIMARY KEY(jobId,position));
      CREATE INDEX IF NOT EXISTS transfer_job_state ON transfer_jobs(state,createdAt);`);
    this.db.prepare("UPDATE transfer_jobs SET state='queued',message='Resuming after restart.',updatedAt=? WHERE state='running'").run(new Date().toISOString());
    this.db.prepare("UPDATE transfer_jobs SET state='canceled',message='Cancellation retained after restart.',updatedAt=? WHERE state='canceling'").run(new Date().toISOString());
    this.db.exec("UPDATE transfer_items SET state='pending' WHERE state='running'");
  }
  row(row) {if(!row)return null;return {...row,selection:JSON.parse(row.selection)};}
  get(id) {const row=this.row(this.db.prepare('SELECT * FROM transfer_jobs WHERE id=?').get(id));if(!row)throw httpError(404,'Transfer job not found.');return row;}
  list() {return {items:this.db.prepare('SELECT * FROM transfer_jobs ORDER BY createdAt DESC,id DESC LIMIT 100').all().map(row=>this.row(row))};}
  hasActive(connectionId) {return Boolean(this.db.prepare("SELECT id FROM transfer_jobs WHERE connectionId=? AND state IN ('queued','running','canceling') LIMIT 1").get(connectionId));}
  update(id,state,message='') {this.db.prepare('UPDATE transfer_jobs SET state=?,message=?,updatedAt=? WHERE id=?').run(state,message,new Date().toISOString(),id);}
  replaceItems(id,records) {
    const insert=this.db.prepare('INSERT INTO transfer_items (jobId,position,identity) VALUES (?,?,?)');
    for(let i=0;i<records.length;i++) {const {studyUid,seriesUid,sopUid,sopClassUid}=records[i];insert.run(id,i,JSON.stringify({studyUid,seriesUid,sopUid,...(sopClassUid?{sopClassUid}:{})}));}
    this.db.prepare('UPDATE transfer_jobs SET total=?,updatedAt=? WHERE id=?').run(records.length,new Date().toISOString(),id);
  }
  create({peer,direction,selection,records}) {
    if(this.closing)throw httpError(503,'Transfers are shutting down.');
    if(this.db.prepare("SELECT COUNT(*) AS count FROM transfer_jobs WHERE state IN ('queued','running','canceling')").get().count>=100)throw httpError(429,'The transfer queue already contains 100 active jobs.');
    const id=randomUUID(),now=new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {this.db.prepare('INSERT INTO transfer_jobs (id,connectionId,connectionRevision,connectionName,direction,selection,state,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?)').run(id,peer.id,peer.revision,peer.name,direction,JSON.stringify(selection),'queued',now,now);if(records)this.replaceItems(id,records);this.db.exec('COMMIT');}
    catch(error){this.db.exec('ROLLBACK');throw error;}
    this.start();return this.get(id);
  }
  cancel(id) {
    const job=this.get(id);if(!['queued','running'].includes(job.state))throw httpError(409,'This transfer is already finished.');
    this.update(id,this.current?.id===id?'canceling':'canceled','Canceled by the administrator. A remote acknowledgement interrupted in flight may require a duplicate-safe retry.');
    if(this.current?.id===id)this.current.controller.abort();
    return this.get(id);
  }
  retry(id) {
    if(this.closing)throw httpError(503,'Transfers are shutting down.');
    const job=this.get(id);if(!['failed','canceled'].includes(job.state))throw httpError(409,'Only failed or canceled transfers can be retried.');
    const peer=this.service.get(job.connectionId);if(peer.revision!==job.connectionRevision)throw httpError(409,'The connection changed since this transfer was created. Create a new transfer to confirm the new destination.');
    this.db.prepare("UPDATE transfer_items SET state='pending',outcome='' WHERE jobId=? AND state!='done'").run(id);
    this.db.prepare('UPDATE transfer_jobs SET failed=0 WHERE id=?').run(id);
    this.update(id,'queued','Retrying unfinished instances; acknowledged instances are retained.');this.start();return this.get(id);
  }
  start() {
    if(!this.autoStart||this.running||this.closing)return;
    this.running=this.run().finally(()=>{this.running=null;if(!this.closing&&this.db.prepare("SELECT id FROM transfer_jobs WHERE state='queued' LIMIT 1").get())this.start();});
  }
  async run() {
    while(!this.closing) {
      const next=this.db.prepare("SELECT id FROM transfer_jobs WHERE state='queued' ORDER BY createdAt,id LIMIT 1").get();if(!next)return;
      const controller=new AbortController();this.current={id:next.id,controller};
      this.update(next.id,'running','Transferring one original instance at a time.');
      try {await this.process(this.get(next.id),controller.signal);}
      catch(error) {const state=this.get(next.id).state;if(state==='canceling')this.update(next.id,'canceled','Canceled by the administrator. A remote acknowledgement interrupted in flight may require a duplicate-safe retry.');else if(state!=='canceled')this.update(next.id,this.closing?'queued':'failed',this.closing?'Paused for shutdown; resumes on restart.':error.statusCode&&error.statusCode<500?error.message:'The peer transfer could not complete. Check its connection and retry unfinished instances.');}
      finally {this.current=null;}
    }
  }
  async process(job,signal) {
    const peer=this.service.get(job.connectionId);if(peer.revision!==job.connectionRevision)throw httpError(409,'The connection changed; create a new transfer to confirm its destination.');
    if(!job.total&&job.direction==='retrieve') {
      const records=await this.service.enumerate(peer,job.selection,signal);signal.throwIfAborted();
      if(!records.length)throw httpError(404,'The selected remote study contains no matching instances.');
      this.db.exec('BEGIN IMMEDIATE');try{this.replaceItems(job.id,records);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
    }
    let hadFailure=false,consecutiveFailures=0;
    for(;;) {
      signal.throwIfAborted();if(this.closing)throw new Error('closing');
      const row=this.db.prepare("SELECT position,identity FROM transfer_items WHERE jobId=? AND state='pending' ORDER BY position LIMIT 1").get(job.id);if(!row)break;
      this.db.prepare("UPDATE transfer_items SET state='running' WHERE jobId=? AND position=?").run(job.id,row.position);
      let result;
      try {result=await this.service.transfer(peer,job.direction,JSON.parse(row.identity),signal);}
      catch(error) {
        this.db.prepare("UPDATE transfer_items SET state=?,outcome=? WHERE jobId=? AND position=?").run(signal.aborted?'pending':'failed',signal.aborted?'':'failed',job.id,row.position);
        if(signal.aborted)throw error;
        hadFailure=true;this.db.prepare('UPDATE transfer_jobs SET failed=failed+1,updatedAt=? WHERE id=?').run(new Date().toISOString(),job.id);
        if(++consecutiveFailures>=3)break;
        continue;
      }
      // An accepted ACK/durable ingest is checkpointed even if cancellation
      // arrives immediately afterward. Never resend a known completed item.
      this.db.exec('BEGIN IMMEDIATE');try{
        this.db.prepare("UPDATE transfer_items SET state='done',outcome=? WHERE jobId=? AND position=?").run(result?.outcome||'completed',job.id,row.position);
        this.db.prepare('UPDATE transfer_jobs SET completed=completed+1,updatedAt=? WHERE id=?').run(new Date().toISOString(),job.id);this.db.exec('COMMIT');
      }catch(error){this.db.exec('ROLLBACK');throw error;}
      consecutiveFailures=0;
    }
    signal.throwIfAborted();this.update(job.id,hadFailure||this.get(job.id).failed?'failed':'completed',hadFailure?'Some instances were not acknowledged. Retry sends only unfinished instances.':'All selected instances were acknowledged.');
  }
  async close() {this.closing=true;this.current?.controller.abort();await this.running;}
}
