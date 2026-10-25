import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { parseMaterialHistoryArchive } from '../src/main/material-history-zip';

const projectId = randomUUID(), hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
async function fixture(files: Record<string, Uint8Array> = { '创作笔记.md': Buffer.from('　　虚构星港。\n') }, compression: 'STORE' | 'DEFLATE' = 'DEFLATE') {
  const entries = Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, bytes]) => ({path, bytes:bytes.length, sha256:hash(bytes)}));
  const manifest = {schemaVersion:1,kind:'material-history-archive',projectId,source:'transport',id:randomUUID(),archiveId:randomUUID(),createdAt:new Date().toISOString(),entries};
  const zip = new JSZip();
  for (const [name, bytes] of Object.entries(files)) zip.file(`files/${name}`, bytes);
  zip.file('manifest.json', encode(manifest));
  const bytes = await zip.generateAsync({type:'nodebuffer',compression});
  const completion = {...manifest,file:'历史资料.zip',bytes:entries.reduce((sum,e)=>sum+e.bytes,0),archiveBytes:bytes.length,sha256:hash(bytes)};
  return {bytes,completion,manifest,files};
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function parse(value: Fixture, bytes = value.bytes, completion = value.completion) {
  return parseMaterialHistoryArchive(bytes, encode(completion), projectId);
}
function retag(value: Fixture, bytes: Buffer) { return {...value.completion,archiveBytes:bytes.length,sha256:hash(bytes)}; }
function central(bytes: Buffer) {
  const result: {offset:number;local:number;name:string;extra:number;extraLength:number}[] = [];
  const end = bytes.length-22, count = bytes.readUInt16LE(end+10); let offset = bytes.readUInt32LE(end+16);
  for(let n=0;n<count;n++) {
    const length = bytes.readUInt16LE(offset+28), extraLength = bytes.readUInt16LE(offset+30), comment=bytes.readUInt16LE(offset+32);
    result.push({offset,local:bytes.readUInt32LE(offset+42),name:bytes.subarray(offset+46,offset+46+length).toString(),extra:offset+46+length,extraLength});
    offset += 46+length+extraLength+comment;
  }
  return result;
}
function changed(value: Fixture, update: (bytes:Buffer)=>void) {
  const bytes=Buffer.from(value.bytes);update(bytes);return {bytes,completion:retag(value,bytes)};
}
function localAndCentral(value: Fixture, name:string, modify:(bytes:Buffer, row:ReturnType<typeof central>[number])=>void) {
  return changed(value, bytes=> { const row=central(bytes).find(e=>e.name===name);assert.ok(row);modify(bytes,row); });
}

for(const compression of ['STORE','DEFLATE'] as const) test(`历史ZIP解析：${compression}中文目录、二进制与真实全角空格原字节往返`,async()=>{
  const value=await fixture({'角色/星港.md':Buffer.from('　　未确认草稿。\r\n'),'头像.png':Buffer.from([0,128,255,0]),'空.txt':Buffer.alloc(0)},compression);
  const result=parse(value);assert.equal(result.manifest.projectId,projectId);assert.equal(result.sha256,hash(value.bytes));
  assert.equal(result.archiveBytes,value.bytes.length);assert.equal(result.bytes,value.completion.bytes);
  for(const [name,bytes] of Object.entries(value.files)) assert.deepEqual(result.data.get(name),bytes);
});

test('历史ZIP解析：空历史只有内部清单也合法',async()=>{
  const value=await fixture({});const result=parse(value);assert.equal(result.data.size,0);assert.equal(result.bytes,0);
});

test('历史ZIP解析：缺失、过大、无效UTF8完成清单拒绝',async()=>{
  const value=await fixture();
  for(const completion of [Buffer.alloc(0),Buffer.alloc(8*1024*1024+1),Buffer.from([0xff])])
    assert.throws(()=>parseMaterialHistoryArchive(value.bytes,completion,projectId));
});

test('历史ZIP解析：错书、未知schema、未知字段和内外清单不一致拒绝',async()=>{
  const value=await fixture();
  assert.throws(()=>parseMaterialHistoryArchive(value.bytes,encode(value.completion),randomUUID()),/另一部小说/);
  for(const completion of [{...value.completion,schemaVersion:2},{...value.completion,extra:true},{...value.completion,source:'local'},{...value.completion,bytes:0},{...value.completion,file:'别的.zip'}])
    assert.throws(()=>parseMaterialHistoryArchive(value.bytes,encode(completion),projectId));
});

test('历史ZIP解析：外侧ZIP哈希和长度必须匹配',async()=>{
  const value=await fixture();
  assert.throws(()=>parse(value,value.bytes,{...value.completion,sha256:'0'.repeat(64)}),/哈希或长度/);
  assert.throws(()=>parse(value,value.bytes,{...value.completion,archiveBytes:value.bytes.length+1}),/哈希或长度/);
});

test('历史ZIP解析：内部清单缺少文件、额外条目、未知分区和额外目录拒绝',async()=>{
  const value=await fixture();
  for(const change of ['missing','extra','partition','directory','no-manifest']) {
    const zip=await JSZip.loadAsync(value.bytes);
    if(change==='missing') zip.remove('files/创作笔记.md');
    if(change==='extra') zip.file('files/额外.txt','不得隐式导入');
    if(change==='partition') zip.file('其他/额外.txt','拒绝');
    if(change==='directory') zip.folder('files/空目录');
    if(change==='no-manifest') zip.remove('manifest.json');
    const bytes=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
    assert.throws(()=>parse(value,bytes,retag(value,bytes)),change);
  }
});

test('历史ZIP解析：内容被改写，即使外侧ZIP哈希重算也拒绝',async()=>{
  const value=await fixture(),zip=await JSZip.loadAsync(value.bytes);zip.file('files/创作笔记.md','被改写');
  const bytes=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
  assert.throws(()=>parse(value,bytes,retag(value,bytes)),/文件哈希/);
});

test('历史ZIP解析：路径穿越、ADS、设备名、隐藏路径、深目录及大小写Unicode冲突拒绝',async()=>{
  for(const paths of [['../逃逸.txt'],['章:数据.txt'],['NUL.txt'],['.secret.txt'],[Array.from({length:32},(_,n)=>String(n)).join('/')+'.txt'],['角色/A.txt','角色/a.txt'],['é.txt','e\u0301.txt'],['DIR/a.txt','dir/b.txt']]) {
    const value=await fixture(Object.fromEntries(paths.map(name=>[name,Buffer.from(name)])));
    assert.throws(()=>parse(value),paths.join(','));
  }
});

test('历史ZIP解析：本地头名称、尺寸、CRC与中央目录必须一致',async()=>{
  const value=await fixture({'a.txt':Buffer.from('abc')});
  for(const offset of [14,18,22,30]) {
    const malformed=localAndCentral(value,'files/a.txt',(bytes,row)=>{bytes[row.local+offset]^=1;});
    assert.throws(()=>parse(value,malformed.bytes,malformed.completion),/本地头|名称/);
  }
});

test('历史ZIP解析：CRC错误和数据损坏在展开时拒绝',async()=>{
  const value=await fixture({'a.txt':Buffer.from('abc')},'STORE');
  const malformed=localAndCentral(value,'files/a.txt',(bytes,row)=>{
    const crc=bytes.readUInt32LE(row.offset+16)^1;bytes.writeUInt32LE(crc>>>0,row.offset+16);bytes.writeUInt32LE(crc>>>0,row.local+14);
  });
  assert.throws(()=>parse(value,malformed.bytes,malformed.completion),/CRC/);
});

test('历史ZIP解析：中央目录重复名称在读取内容前拒绝',async()=>{
  const value=await fixture({'a.txt':Buffer.from('a'),'b.txt':Buffer.from('b')});
  const malformed=localAndCentral(value,'files/b.txt',(bytes,row)=>{
    Buffer.from('files/a.txt').copy(bytes,row.offset+46);Buffer.from('files/a.txt').copy(bytes,row.local+30);
  });
  assert.throws(()=>parse(value,malformed.bytes,malformed.completion),/重复/);
});

test('历史ZIP解析：加密、descriptor、ZIP64、分卷与Unix链接拒绝',async()=>{
  const value=await fixture({'a.txt':Buffer.from('a')});
  for(const mode of ['encrypted','descriptor','zip64','disk','symlink']) {
    const malformed=localAndCentral(value,'files/a.txt',(bytes,row)=>{
      if(mode==='encrypted'||mode==='descriptor') {const flags=bytes.readUInt16LE(row.offset+8)|(mode==='encrypted'?1:8);bytes.writeUInt16LE(flags,row.offset+8);bytes.writeUInt16LE(flags,row.local+6);}
      if(mode==='zip64') {bytes.writeUInt32LE(0xffffffff,row.offset+24);bytes.writeUInt32LE(0xffffffff,row.local+22);}
      if(mode==='disk') bytes.writeUInt16LE(1,row.offset+34);
      if(mode==='symlink') {bytes.writeUInt16LE(0x0314,row.offset+4);bytes.writeUInt32LE(0xa1ff0000,row.offset+38);}
    });
    assert.throws(()=>parse(value,malformed.bytes,malformed.completion),mode);
  }
});

test('历史ZIP解析：中央目录的Unicode扩展不能重新命名条目或隐含ZIP64',async()=>{
  const value=await fixture();
  for(const mode of ['crc','name','unknown']) {
    const malformed=localAndCentral(value,'files/创作笔记.md',(bytes,row)=>{
      assert.ok(row.extraLength>9);assert.equal(bytes.readUInt16LE(row.extra),0x7075);
      if(mode==='crc') bytes[row.extra+5]^=1;
      if(mode==='name') bytes[row.extra+9]^=1;
      if(mode==='unknown') bytes.writeUInt16LE(1,row.extra);
    });
    assert.throws(()=>parse(value,malformed.bytes,malformed.completion),/Unicode|扩展/);
  }
});

test('历史ZIP解析：前缀、尾部和EOCD分卷/未知目录拒绝',async()=>{
  const value=await fixture();
  for(const bytes of [Buffer.concat([Buffer.from('MZ'),value.bytes]),Buffer.concat([value.bytes,Buffer.from('尾')])])
    assert.throws(()=>parse(value,bytes,retag(value,bytes)));
  for(const delta of [4,6,8,12,16]) {
    const malformed=changed(value,bytes=>{bytes[bytes.length-22+delta]^=1;});
    assert.throws(()=>parse(value,malformed.bytes,malformed.completion));
  }
});

test('历史ZIP解析：声明单文件超限和总展开超限在inflate前拒绝',async()=>{
  const value=await fixture({'a.txt':Buffer.from('a'),'b.txt':Buffer.from('b'),'c.txt':Buffer.from('c')});
  const single=localAndCentral(value,'files/a.txt',(bytes,row)=>{bytes.writeUInt32LE(32*1024*1024+1,row.offset+24);bytes.writeUInt32LE(32*1024*1024+1,row.local+22);});
  assert.throws(()=>parse(value,single.bytes,single.completion),/超限/);
  const total=changed(value,bytes=>{for(const row of central(bytes).filter(row=>/^files\/[abc]\.txt$/u.test(row.name))){bytes.writeUInt32LE(32*1024*1024,row.offset+24);bytes.writeUInt32LE(32*1024*1024,row.local+22);}});
  assert.throws(()=>parse(value,total.bytes,total.completion),/展开内容/);
});

test('历史ZIP解析：伪造极小展开尺寸的压缩内容受硬上限拒绝',async()=>{
  const value=await fixture({'a.txt':Buffer.alloc(1024*1024,65)});
  const malformed=localAndCentral(value,'files/a.txt',(bytes,row)=>{bytes.writeUInt32LE(1,row.offset+24);bytes.writeUInt32LE(1,row.local+22);});
  assert.throws(()=>parse(value,malformed.bytes,malformed.completion),/实际大小超过声明/);
});

test('历史ZIP解析：64MiB正文恰好上限仍可携带独立清单',async()=>{
  const value=await fixture({'a.txt':Buffer.alloc(32*1024*1024,65),'b.txt':Buffer.alloc(32*1024*1024,66)});
  const result=parse(value);assert.equal(result.bytes,64*1024*1024);assert.equal(result.data.size,2);
  assert.equal(result.data.get('b.txt')!.at(-1),66);
});
