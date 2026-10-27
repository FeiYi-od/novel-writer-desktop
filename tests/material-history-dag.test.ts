import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { encodeMaterialHistoryDag, parseMaterialHistoryDag, MATERIAL_DAG_LIMITS, type MaterialDagManifest } from '../src/main/material-history-dag';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const now = '2026-10-27T00:00:00.000Z';
const descriptors = (blobs: Map<string, Buffer>) => [...blobs].map(([sha256, bytes]) => ({ sha256, bytes: bytes.length })).sort((a,b) => a.sha256.localeCompare(b.sha256));
function fixture(merge = false) {
  const projectId = randomUUID(), blobs = new Map<string, Buffer>();
  const content = Buffer.from('　　虚构星港未确认草稿。\r\n'), binary = Buffer.from([0,255,128,1]);
  const store = (bytes: Buffer) => { const key = sha(bytes); blobs.set(key, bytes); return key; };
  const contentHash = store(content), binaryHash = store(binary), emptyHash = store(Buffer.alloc(0));
  const entry = { path: '角色/草稿.md', bytes: content.length, sha256: contentHash };
  const ids = [randomUUID(),randomUUID(),randomUUID(),...(merge ? [randomUUID()] : [])];
  const transport = ids.map((id,index) => {
    const parents = index === 0 ? [] : index === 3 ? [ids[1]!,ids[2]!] : [ids[0]!];
    const raw = Buffer.from(JSON.stringify({schemaVersion:1,projectId,revisionId:id,createdAt:now,parents,entries:[entry]},null,2).replace(/\n/gu,'\r\n')+'\r\n');
    return { id, manifestSha256:store(raw) };
  });
  const manifest: MaterialDagManifest = {schemaVersion:1,kind:'material-history-dag-archive',projectId,archiveId:randomUUID(),createdAt:now,fingerprint:sha(Buffer.from('frozen fictional sources')),
    transport,local:[{id:ids.at(-1)!,createdAt:now,entries:[entry,{path:'头像.png',bytes:binary.length,sha256:binaryHash},{path:'空.txt',bytes:0,sha256:emptyHash}]}],leaves:merge?[ids[3]!]:[ids[1]!,ids[2]!],blobs:descriptors(blobs)};
  return { manifest, blobs, ids, content, contentHash, binary, binaryHash };
}
type Fixture = ReturnType<typeof fixture>;
async function rawZip(f: Pick<Fixture,'manifest'|'blobs'>, extra?: [string,Buffer]) {
  const zip = new JSZip();
  for(const [key,bytes] of f.blobs) zip.file(`files/${key}`,bytes);
  zip.file('manifest.json',json(f.manifest)); if(extra)zip.file(...extra);
  const archive=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
  const completion={...f.manifest,file:'完整资料历史.zip',bytes:[...f.blobs.values()].reduce((sum,bytes)=>sum+bytes.length,0),archiveBytes:archive.length,sha256:sha(archive)};
  return {archive,completion:json(completion)};
}
function changeRevision(f: Fixture, index: number, change: (value: any) => void) {
  const selected=f.manifest.transport[index]!, previous=selected.manifestSha256;
  const value=JSON.parse(f.blobs.get(previous)!.toString('utf8'));change(value);
  const raw=json(value);selected.manifestSha256=sha(raw);f.blobs.delete(previous);f.blobs.set(selected.manifestSha256,raw);f.manifest.blobs=descriptors(f.blobs);
}
const parse = (f: Fixture, pair: { archive: Uint8Array; completion: Uint8Array }) => parseMaterialHistoryDag(pair.archive,pair.completion,f.manifest.projectId);

for(const merge of [false,true])test(`DAG ZIP preserves ${merge?'merged ancestry':'all live branches'}, local binary and exact raw CRLF bytes`,async()=>{
  const f=fixture(merge), before=new Map([...f.blobs].map(([key,value])=>[key,Buffer.from(value)]));
  const pair=await encodeMaterialHistoryDag(f.manifest,f.blobs), result=parse(f,pair);
  assert.deepEqual(result.manifest,f.manifest);assert.equal(result.sha256,sha(pair.archive));assert.equal(result.archiveBytes,pair.archive.length);
  assert.equal(result.bytes,[...before.values()].reduce((sum,bytes)=>sum+bytes.length,0));
  assert.equal(result.blobs.size,merge?7:6,'Shared file content must occur only once across snapshots');
  for(const [key,value]of before)assert.deepEqual(result.blobs.get(key),value);
  assert.deepEqual(result.blobs.get(f.binaryHash),f.binary);
  assert.ok(result.blobs.get(f.manifest.transport[0]!.manifestSha256)!.includes(Buffer.from('\r\n')));
});

test('DAG ZIP handles empty local history without inventing a blob or transport branch',async()=>{
  const manifest:MaterialDagManifest={schemaVersion:1,kind:'material-history-dag-archive',projectId:randomUUID(),archiveId:randomUUID(),createdAt:now,fingerprint:'0'.repeat(64),transport:[],local:[{id:randomUUID(),createdAt:now,entries:[]}],leaves:[],blobs:[]};
  const pair=await encodeMaterialHistoryDag(manifest,new Map());const result=parseMaterialHistoryDag(pair.archive,pair.completion,manifest.projectId);
  assert.equal(result.bytes,0);assert.equal(result.blobs.size,0);assert.deepEqual(result.manifest.local,manifest.local);
});

test('DAG encoder snapshots metadata, Map and Buffer bytes before compression awaits',async()=>{
  const f=fixture(), bytes=Buffer.from(f.content), projectId=f.manifest.projectId, contentHash=f.contentHash;
  const pending=encodeMaterialHistoryDag(f.manifest,f.blobs);
  f.blobs.get(contentHash)!.fill(0);f.blobs.clear();f.manifest.local[0]!.entries[0]!.path='later.txt';f.manifest.projectId=randomUUID();
  const pair=await pending,result=parseMaterialHistoryDag(pair.archive,pair.completion,projectId);
  assert.deepEqual(result.blobs.get(contentHash),bytes);assert.equal(result.manifest.local[0]!.entries[0]!.path,'角色/草稿.md');
});

test('DAG parser requires same-book completion and exact paired metadata, byte count, length and digest',async t=>{
  for(const mutation of ['book','schema','kind','name','bytes','length','digest','fingerprint']as const)await t.test(mutation,async()=>{
    const f=fixture(),pair=await rawZip(f),completion=JSON.parse(pair.completion.toString('utf8'));
    if(mutation==='book')completion.projectId=randomUUID();else if(mutation==='schema')completion.schemaVersion=2;
    else if(mutation==='kind')completion.kind='material-history-archive';else if(mutation==='name')completion.file='renamed.zip';
    else if(mutation==='bytes')completion.bytes++;else if(mutation==='length')completion.archiveBytes++;
    else if(mutation==='digest')completion.sha256='0'.repeat(64);else completion.fingerprint='1'.repeat(64);
    assert.throws(()=>parseMaterialHistoryDag(pair.archive,json(completion),f.manifest.projectId));
  });
});

test('DAG archive rejects absent, unused, duplicated, tampered or misdeclared blobs',async t=>{
  for(const mutation of ['missing','unused','duplicate','tampered','length','extra-zip']as const)await t.test(mutation,async()=>{
    const f=fixture();let extra:[string,Buffer]|undefined;
    if(mutation==='missing')f.blobs.delete(f.contentHash);
    if(mutation==='unused'){const bytes=Buffer.from('unreferenced fictional');f.blobs.set(sha(bytes),bytes);f.manifest.blobs=descriptors(f.blobs);}
    if(mutation==='duplicate')f.manifest.blobs.push({...f.manifest.blobs[0]!});
    if(mutation==='tampered')f.blobs.set(f.contentHash,Buffer.alloc(f.content.length));
    if(mutation==='length')f.manifest.blobs[0]!.bytes++;
    if(mutation==='extra-zip')extra=['files/extra.txt',Buffer.from('extra')];
    const pair=await rawZip(f,extra);assert.throws(()=>parse(f,pair));
    if(mutation!=='extra-zip')await assert.rejects(encodeMaterialHistoryDag(f.manifest,f.blobs));
  });
});

test('DAG graph validation rejects missing parents, cycles, duplicate parents/IDs and incorrect leaves',async t=>{
  for(const mutation of ['missing-parent','self-cycle','cycle','duplicate-parent','duplicate-version','case-id','duplicate-local','missing-leaf','extra-leaf','duplicate-leaf']as const)await t.test(mutation,async()=>{
    const f=fixture();
    if(mutation==='missing-parent')changeRevision(f,1,value=>{value.parents=[randomUUID()];});
    else if(mutation==='self-cycle')changeRevision(f,1,value=>{value.parents=[f.ids[1]];});
    else if(mutation==='cycle')changeRevision(f,0,value=>{value.parents=[f.ids[1]];});
    else if(mutation==='duplicate-parent')changeRevision(f,1,value=>{value.parents=[f.ids[0],f.ids[0]];});
    else if(mutation==='duplicate-version')f.manifest.transport.push({...f.manifest.transport[0]!});
    else if(mutation==='case-id')f.manifest.transport.push({...f.manifest.transport[0]!,id:f.ids[0]!.toUpperCase()});
    else if(mutation==='duplicate-local')f.manifest.local.push({...f.manifest.local[0]!});
    else if(mutation==='missing-leaf')f.manifest.leaves.pop();
    else if(mutation==='extra-leaf')f.manifest.leaves.push(f.ids[0]!);
    else f.manifest.leaves.push(f.manifest.leaves[0]!);
    await assert.rejects(encodeMaterialHistoryDag(f.manifest,f.blobs));const pair=await rawZip(f);assert.throws(()=>parse(f,pair));
  });
});

test('DAG raw manifests preserve a strict supported schema and the declared book/version identity',async t=>{
  for(const mutation of ['book','id','schema','unknown','invalid-json','bad-utf8','bom']as const)await t.test(mutation,async()=>{
    const f=fixture();
    if(['book','id','schema','unknown'].includes(mutation))changeRevision(f,0,value=>{
      if(mutation==='book')value.projectId=randomUUID();else if(mutation==='id')value.revisionId=randomUUID();else if(mutation==='schema')value.schemaVersion=2;else value.extension='unsupported';
    });
    else {const selected=f.manifest.transport[0]!,old=selected.manifestSha256;let raw=mutation==='invalid-json'?Buffer.from('{unfinished'):mutation==='bad-utf8'?Buffer.from([0xc3,0x28]):Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),f.blobs.get(old)!]);f.blobs.delete(old);selected.manifestSha256=sha(raw);f.blobs.set(selected.manifestSha256,raw);f.manifest.blobs=descriptors(f.blobs);}
    await assert.rejects(encodeMaterialHistoryDag(f.manifest,f.blobs));assert.throws(()=>parse(f,{} as never));
    const pair=await rawZip(f);assert.throws(()=>parse(f,pair));
  });
});

test('DAG file paths reject traversal, devices, unknown hidden paths, Unicode/case collisions and file parents',async t=>{
  for(const paths of [['../escape.txt'],['C:/escape.txt'],['NUL.txt'],['.hidden'],['Case/a.txt','case/b.txt'],['é.txt','e\u0301.txt'],['same.txt','same.txt'],['root','root/child.txt'],[`${'deep/'.repeat(31)}end.txt`]])await t.test(paths.join('|'),async()=>{
    const f=fixture(),entry=f.manifest.local[0]!.entries[0]!;
    f.manifest.local[0]!.entries=paths.map(path=>({...entry,path}));
    await assert.rejects(encodeMaterialHistoryDag(f.manifest,f.blobs));const pair=await rawZip(f);assert.throws(()=>parse(f,pair));
  });
});

test('DAG declared reference lengths cannot hide a missing or differently sized payload',async()=>{
  const f=fixture();changeRevision(f,0,value=>{value.entries[0].bytes++;});
  await assert.rejects(encodeMaterialHistoryDag(f.manifest,f.blobs),/长度/u);const pair=await rawZip(f);assert.throws(()=>parse(f,pair),/长度/u);
});

test('DAG budgets reject empty archives, too many versions and references before ZIP generation',async t=>{
  await t.test('no history',async()=>{const f=fixture();f.manifest.transport=[];f.manifest.local=[];f.manifest.leaves=[];f.blobs.clear();f.manifest.blobs=[];await assert.rejects(encodeMaterialHistoryDag(f.manifest,f.blobs),/暂无/u);});
  await t.test('1001 local versions',async()=>{const f=fixture();f.manifest.local=Array.from({length:1001},()=>({id:randomUUID(),createdAt:now,entries:[]}));await assert.rejects(encodeMaterialHistoryDag(f.manifest,f.blobs));});
  await t.test('10001 references despite deduplication',async()=>{const f=fixture();f.manifest.transport=[];f.manifest.leaves=[];const entry=f.manifest.local[0]!.entries[0]!;f.blobs=new Map([[f.contentHash,f.content]]);f.manifest.blobs=descriptors(f.blobs);f.manifest.local=[{id:randomUUID(),createdAt:now,entries:Array.from({length:9999},(_,i)=>({...entry,path:`${i}.txt`}))},{id:randomUUID(),createdAt:now,entries:[{...entry,path:'a.txt'},{...entry,path:'b.txt'}]}];await assert.rejects(encodeMaterialHistoryDag(f.manifest,f.blobs),/引用超过10000/u);});
});

test('DAG budgets bound unique content, repeated referenced bytes and raw manifest sizes',async t=>{
  await t.test('unique over64 MiB',async()=>{const f=fixture();f.blobs=new Map();for(let i=0;i<3;i++){const bytes=Buffer.alloc(i===2?1:32*1024*1024,i);f.blobs.set(sha(bytes),bytes);}f.manifest.blobs=descriptors(f.blobs);await assert.rejects(encodeMaterialHistoryDag(f.manifest,f.blobs),/64 MiB/u);});
  await t.test('repeated references over256 MiB',async()=>{const f=fixture(),bytes=Buffer.alloc(32*1024*1024,1),key=sha(bytes);f.blobs=new Map([[key,bytes]]);f.manifest.blobs=descriptors(f.blobs);f.manifest.transport=[];f.manifest.leaves=[];f.manifest.local=[{id:randomUUID(),createdAt:now,entries:Array.from({length:9},(_,i)=>({path:`${i}.bin`,bytes:bytes.length,sha256:key}))}];await assert.rejects(encodeMaterialHistoryDag(f.manifest,f.blobs),/256 MiB/u);});
  await t.test('one raw over2 MiB',async()=>{const f=fixture(),item=f.manifest.transport[0]!,old=item.manifestSha256,raw=Buffer.concat([f.blobs.get(old)!,Buffer.alloc(2*1024*1024,0x20)]);f.blobs.delete(old);item.manifestSha256=sha(raw);f.blobs.set(item.manifestSha256,raw);f.manifest.blobs=descriptors(f.blobs);await assert.rejects(encodeMaterialHistoryDag(f.manifest,f.blobs),/2 MiB/u);});
  await t.test('raw manifest aggregate over8 MiB',async()=>{const f=fixture();f.blobs=new Map();f.manifest.transport=Array.from({length:5},()=>{const id=randomUUID(),value=json({schemaVersion:1,projectId:f.manifest.projectId,revisionId:id,createdAt:now,parents:[],entries:[]}),raw=Buffer.concat([value,Buffer.alloc(2*1024*1024-value.length,0x20)]),key=sha(raw);f.blobs.set(key,raw);return {id,manifestSha256:key};});f.manifest.local=[];f.manifest.leaves=f.manifest.transport.map(item=>item.id);f.manifest.blobs=descriptors(f.blobs);await assert.rejects(encodeMaterialHistoryDag(f.manifest,f.blobs),/累计超过8 MiB/u);});
});

test('DAG manifest byte budget is enforced before archive allocation',async()=>{
  const f=fixture(),entry=f.manifest.local[0]!.entries[0]!;f.manifest.transport=[];f.manifest.leaves=[];f.blobs=new Map([[f.contentHash,f.content]]);f.manifest.blobs=descriptors(f.blobs);
  f.manifest.local=[{id:randomUUID(),createdAt:now,entries:Array.from({length:10000},(_,index)=>({...entry,path:`${'文'.repeat(390)}${String(index).padStart(5,'0')}`}))}];
  await assert.rejects(encodeMaterialHistoryDag(f.manifest,f.blobs),/清单超过8 MiB/u);
});

test('DAG parser inherits narrow container validation and bounds external input',async()=>{
  const f=fixture(),pair=await rawZip(f),completion=JSON.parse(pair.completion.toString('utf8'));
  const archive=Buffer.concat([pair.archive,Buffer.from([0])]);completion.archiveBytes=archive.length;completion.sha256=sha(archive);
  assert.throws(()=>parseMaterialHistoryDag(archive,json(completion),f.manifest.projectId),/目录|尾部/u);
  assert.throws(()=>parseMaterialHistoryDag(pair.archive,Buffer.alloc(MATERIAL_DAG_LIMITS.manifestBytes+1),f.manifest.projectId),/8 MiB/u);
  assert.throws(()=>parseMaterialHistoryDag(Buffer.alloc(MATERIAL_DAG_LIMITS.archiveBytes+1),pair.completion,f.manifest.projectId),/80 MiB/u);
});
