import { useEffect, useMemo, useRef, useState } from 'react';
import type { DocxStructureAction, DocxStructureCell, DocxStructureEditResult, DocxStructureHeader, DocxStructureSnapshot, DocxStructureTable } from '../../shared/docx-structure';
import type { FidelityTarget } from './FidelityCopyEditor';
import { exitSaves, useSaveBeforeExit } from './save-before-exit';
import './docx-structure.css';

interface DraftRow { key: string; originalIndex: number | null; cells: DocxStructureCell[] }
interface DraftTable extends Omit<DocxStructureTable, 'rows'> { rows: DraftRow[] }
interface RowOperation { kind: 'append' | 'remove'; tableIndex: number; key: string }
interface StructureDraft { tables: DraftTable[]; headers: DocxStructureHeader[]; rowOperations: RowOperation[] }
function canAppendRow(draft: StructureDraft, table: DraftTable) {
  const width = table.rows[0]?.cells.length ?? 0;
  const cells = draft.tables.reduce((total, item) => total + item.rows.reduce((sum, row) => sum + row.cells.length, 0), 0);
  return table.editable && width > 0 && table.rows.length < 1000
    && (table.rows.length + 1) * width <= 10000 && cells + width <= 10000;
}
const cleanError = (value: unknown) => String(value instanceof Error ? value.message : value).replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '');
const same = (left: string[], right: string[]) => left.length === right.length && left.every((value, index) => value === right[index]);
const identity = (target: FidelityTarget) => `${target.projectId}\0${target.path}\0${target.hash}`;
const draftOf = (snapshot: DocxStructureSnapshot): StructureDraft => ({
  tables: snapshot.tables.map(table => ({ ...table, rows: table.rows.map(row => ({ key: `original-${row.index}`, originalIndex: row.index, cells: row.cells.map(cell => ({ ...cell, paragraphs: [...cell.paragraphs] })) })) })),
  headers: snapshot.headers.map(header => ({ ...header, paragraphs: [...header.paragraphs] })), rowOperations: []
});

/** Replay structural changes in order to retain the correct row template, then edit final cells. */
function actionsOf(snapshot: DocxStructureSnapshot | null, draft: StructureDraft | null): DocxStructureAction[] {
  if (!snapshot || !draft) return [];
  const actions: DocxStructureAction[] = [];
  for (const table of draft.tables) {
    const original = snapshot.tables.find(item => item.index === table.index);
    if (!original) continue;
    const rowKeys = original.rows.map(row => `original-${row.index}`);
    const rowsChanged = rowKeys.length !== table.rows.length || rowKeys.some((value, index) => table.rows[index]?.key !== value);
    if (rowsChanged) for (const operation of draft.rowOperations.filter(item => item.tableIndex === table.index)) {
      if (operation.kind === 'append') {
        actions.push({ kind: 'appendRow', tableIndex: table.index }); rowKeys.push(operation.key);
      } else {
        const rowIndex = rowKeys.indexOf(operation.key);
        if (rowIndex >= 0) { actions.push({ kind: 'removeRow', tableIndex: table.index, rowIndex }); rowKeys.splice(rowIndex, 1); }
      }
    }
    table.rows.forEach((row, rowIndex) => {
      const before = original.rows.find(item => item.index === row.originalIndex);
      for (const cell of row.cells) {
        const oldCell = before?.cells.find(item => item.index === cell.index);
        if (!oldCell || !same(oldCell.paragraphs, cell.paragraphs)) actions.push({ kind: 'cell', tableIndex: table.index, rowIndex, cellIndex: cell.index, paragraphs: [...cell.paragraphs] });
      }
    });
  }
  for (const header of draft.headers) {
    const before = snapshot.headers.find(item => item.part === header.part);
    if (before && !same(before.paragraphs, header.paragraphs)) actions.push({ kind: 'header', part: header.part, paragraphs: [...header.paragraphs] });
  }
  return actions;
}

export function DocxStructurePanel({ target, blocked, onClose, onDirty, onBusy, onSaved, onSaveExit }: {
  target: FidelityTarget;
  blocked: boolean;
  onClose: () => void;
  onDirty: (value: boolean) => void;
  onBusy: (value: boolean) => void;
  onSaved: (result: DocxStructureEditResult) => Promise<void>;
  onSaveExit: () => Promise<void>;
}) {
  const [snapshot, setSnapshot] = useState<DocxStructureSnapshot | null>(null);
  const [draft, setDraft] = useState<StructureDraft | null>(null);
  const [busy, setBusy] = useState(true); const [error, setError] = useState('');
  const [saved, setSaved] = useState<DocxStructureEditResult | null>(null);
  const snapshotRef = useRef(snapshot); const draftRef = useRef(draft); const savedRef = useRef(saved);
  const busyRef = useRef(true); const mounted = useRef(false); const ticket = useRef(0);
  const targetRef = useRef(identity(target)); targetRef.current = identity(target);
  const dialog = useRef<HTMLElement>(null); const message = useRef<HTMLDivElement>(null);
  const newRowId = useRef(0);
  const actions = useMemo(() => actionsOf(snapshot, draft), [snapshot, draft]);
  const dirty = actions.length > 0 && !saved;
  const inactive = busy || blocked || !!saved;
  const valid = (frozen: FidelityTarget, request: number) => mounted.current && targetRef.current === identity(frozen) && ticket.current === request;
  const update = (value: StructureDraft) => { draftRef.current = value; setDraft(value); setError(''); };

  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    if (busy && dialog.current?.contains(document.activeElement) !== true) dialog.current?.focus();
  }, [busy]);
  useEffect(() => { if (error || saved) message.current?.scrollIntoView({ block: 'nearest' }); }, [error, saved]);
  useEffect(() => { onDirty(dirty); return () => onDirty(false); }, [dirty, onDirty]);
  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  useEffect(() => {
    mounted.current = true; const frozen = { ...target }; const request = ++ticket.current;
    busyRef.current = true; setBusy(true); setError(''); setSnapshot(null); setDraft(null); setSaved(null);
    snapshotRef.current = null; draftRef.current = null; savedRef.current = null;
    const release = exitSaves.register('读取 Word 表格与页眉页脚', () => ({ dirty: false, busy: true }));
    void window.writer.readDocxStructure(frozen.projectId, frozen.path, frozen.hash).then(value => {
      if (!valid(frozen, request)) return;
      if (value.projectId !== frozen.projectId || value.path !== frozen.path || value.hash !== frozen.hash)
        throw new Error('原稿版本或小说不匹配，请关闭后重新打开章节');
      const next = draftOf(value); snapshotRef.current = value; draftRef.current = next;
      setSnapshot(value); setDraft(next);
    }).catch(failure => { if (valid(frozen, request)) setError(cleanError(failure)); }).finally(() => {
      release(); if (valid(frozen, request)) { busyRef.current = false; setBusy(false); }
    });
    return () => { mounted.current = false; ticket.current++; };
  }, [target.projectId, target.path, target.hash]);

  async function save() {
    if (busyRef.current) throw new Error('Word 结构副本正在处理，请等待完成');
    if (blocked) throw new Error('请等待当前操作完成后再另存结构副本');
    if (!snapshotRef.current || !draftRef.current) throw new Error('尚未读取 Word 结构，不能保存');
    if (savedRef.current) return;
    const frozen = { ...target }; const changes = actionsOf(snapshotRef.current, draftRef.current);
    if (!changes.length) return;
    if (changes.length > 100) { setError('本批超过 100 项结构修改，请减少修改后另存；当前编辑内容保留'); throw new Error('结构修改超过 100 项'); }
    const request = ++ticket.current;
    busyRef.current = true; setBusy(true); setError('');
    const release = exitSaves.register('正在保存 Word 结构副本', () => ({ dirty: false, busy: true }));
    try {
      const result = await window.writer.editDocxStructureBatch(frozen.projectId, frozen.path, changes, frozen.hash);
      if (!valid(frozen, request)) return;
      if (result.projectId !== frozen.projectId || result.sourcePath !== frozen.path || result.sourceHash !== frozen.hash)
        throw new Error('结构副本结果与原稿归属或版本不匹配，未在本页应用');
      savedRef.current = result; setSaved(result);
      await onSaved(result);
    } catch (failure) { if (valid(frozen, request)) setError(cleanError(failure)); throw failure; }
    finally { release(); if (valid(frozen, request)) { busyRef.current = false; setBusy(false); } }
  }
  useSaveBeforeExit('Word 表格与页眉页脚副本', () => ({
    dirty: !savedRef.current && actionsOf(snapshotRef.current, draftRef.current).length > 0,
    busy: busyRef.current,
    save
  }));
  const close = () => {
    if (busyRef.current || blocked) return;
    if (!savedRef.current && actionsOf(snapshotRef.current, draftRef.current).length && !window.confirm('结构副本还有未保存修改，确定放弃并关闭吗？原稿不变。')) return;
    onClose();
  };
  const setCell = (tableIndex: number, rowKey: string, cellIndex: number, paragraphs: string[]) => {
    if (!draftRef.current || inactive) return;
    update({ ...draftRef.current, tables: draftRef.current.tables.map(table => table.index === tableIndex ? { ...table, rows: table.rows.map(row => row.key === rowKey ? { ...row, cells: row.cells.map(cell => cell.index === cellIndex ? { ...cell, paragraphs } : cell) } : row) } : table) });
  };
  const appendRow = (tableIndex: number) => {
    const current = draftRef.current; const table = current?.tables.find(item => item.index === tableIndex); const last = table?.rows.at(-1);
    if (!current || !table || !last || inactive || !canAppendRow(current, table)) return;
    const next: DraftRow = { key: `added-${++newRowId.current}`, originalIndex: null, cells: last.cells.map(cell => ({ ...cell, paragraphs: cell.paragraphs.map(() => '') })) };
    update({ ...current, tables: current.tables.map(item => item.index === tableIndex ? { ...item, rows: [...item.rows, next] } : item), rowOperations: [...current.rowOperations, { kind: 'append', tableIndex, key: next.key }] });
  };
  const removeRow = (tableIndex: number, rowKey: string) => {
    const current = draftRef.current; const table = current?.tables.find(item => item.index === tableIndex);
    if (!current || !table?.editable || table.rows.length <= 1 || inactive) return;
    if (!window.confirm('从本次结构副本中删除这一行？原稿中的该行仍会保留。')) return;
    update({ ...current, tables: current.tables.map(item => item.index === tableIndex ? { ...item, rows: item.rows.filter(row => row.key !== rowKey) } : item), rowOperations: [...current.rowOperations, { kind: 'remove', tableIndex, key: rowKey }] });
  };
  const setHeader = (part: string, index: number, value: string) => {
    const current = draftRef.current; if (!current || inactive) return;
    update({ ...current, headers: current.headers.map(header => header.part === part ? { ...header, paragraphs: header.paragraphs.map((text, offset) => offset === index ? value : text) } : header) });
  };
  const saveExit = async () => {
    const frozen = { ...target };
    try { await onSaveExit(); }
    catch (failure) { if (mounted.current && targetRef.current === identity(frozen)) setError(cleanError(failure)); }
  };

  return <div className="modal-overlay docx-structure-overlay"><section ref={dialog} tabIndex={-1} className="book-modal docx-structure-panel" role="dialog" aria-modal="true" aria-labelledby="docx-structure-title" aria-busy={busy} data-testid="docx-structure-panel" onKeyDown={event => {
    if (event.nativeEvent.isComposing) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); if (!inactive && dirty) void save().catch(() => {}); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === 'Tab') {
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),textarea:not(:disabled)')]; const first = controls[0], last = controls.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
    }
  }}>
    <header><div><h2 id="docx-structure-title">Word 表格与页眉页脚</h2><p>{target.path}</p></div><button type="button" data-testid="docx-structure-close" disabled={busy || blocked} onClick={close}>关闭</button></header>
    <p className="docx-structure-help">编辑简单表格的文字和行、已有页眉页脚的各段文字，最后统一另存一个新 DOCX。原稿及未改部件保留；这里展示结构和文本，不提供 Word 页面排版。合并、嵌套、图片、域等复杂结构会说明限制并保持只读。</p>
    <div ref={message}>{error && <div role="alert" className="error" data-testid="docx-structure-error">{error}<span>本页尚未保存的修改保留，请核对原稿版本后再处理。</span></div>}{saved && <p role="status" className="docx-structure-result">结构副本已生成：<code>{saved.path}</code>原稿保持不变；请关闭此页后打开新副本继续编辑。</p>}</div>
    <div className="docx-structure-content">
      {draft && <><section aria-label="Word 表格"><h3>表格 · {draft.tables.length}</h3>{draft.tables.length === 0 && <p className="docx-structure-help">文档中没有表格。</p>}
        {draft.tables.map(table => <article key={table.index} className="docx-structure-table" data-testid="docx-structure-table" data-table-index={table.index}><header><h4>第 {table.index + 1} 个表格</h4><button type="button" data-testid="docx-structure-add-row" data-table-index={table.index} disabled={inactive || !canAppendRow(draft, table)} onClick={() => appendRow(table.index)}>末尾新增一行</button></header>
          {table.editable && !canAppendRow(draft, table) && <p className="docx-structure-help">已达到表格或预览上限（每表最多1000行、预览合计10000格），不能继续新增行。</p>}
          {!table.editable && <p className="docx-structure-warning">只读：{table.reason || '此表格包含暂不支持安全编辑的结构，请使用 Word/WPS 处理。'}</p>}
          <div className="docx-structure-table-scroll"><table><tbody>{table.rows.map((row, rowIndex) => <tr key={row.key}>{row.cells.map(cell => <td key={cell.index}><div className="docx-structure-cell-title">第 {rowIndex + 1} 行 · 第 {cell.index + 1} 格{row.originalIndex === null && <span>新增</span>}</div>
            {!cell.editable && <p className="docx-structure-warning">只读：{cell.reason || '此单元格含不支持的结构'}</p>}
            {cell.paragraphs.map((text, paragraphIndex) => <label key={paragraphIndex}><span>第 {paragraphIndex + 1} 段</span><textarea data-testid="docx-structure-cell" data-table-index={table.index} data-row-index={rowIndex} data-cell-index={cell.index} data-paragraph-index={paragraphIndex} aria-label={`表格${table.index + 1}第${rowIndex + 1}行第${cell.index + 1}格第${paragraphIndex + 1}段`} value={text} disabled={inactive || !table.editable || !cell.editable} onChange={event => setCell(table.index, row.key, cell.index, cell.paragraphs.map((value, offset) => offset === paragraphIndex ? event.target.value : value))} /></label>)}
            {table.editable && cell.editable && <div className="docx-structure-cell-controls"><button type="button" data-testid="docx-structure-cell-add-paragraph" disabled={inactive || cell.paragraphs.length >= 200} onClick={() => setCell(table.index, row.key, cell.index, [...cell.paragraphs, ''])}>新增段落</button><button type="button" data-testid="docx-structure-cell-remove-paragraph" disabled={inactive || cell.paragraphs.length <= 1} onClick={() => { if (cell.paragraphs.at(-1)?.trim() && !window.confirm('删除这个单元格的末段？原稿仍会保留。')) return; setCell(table.index, row.key, cell.index, cell.paragraphs.slice(0, -1)); }}>删除末段</button></div>}
          </td>)}<td className="docx-structure-row-action"><button type="button" data-testid="docx-structure-remove-row" data-table-index={table.index} data-row-index={rowIndex} disabled={inactive || !table.editable || table.rows.length <= 1} onClick={() => removeRow(table.index, row.key)}>删除此行</button></td></tr>)}</tbody></table></div>
        </article>)}</section>
        <section aria-label="Word 页眉页脚"><h3>已有页眉与页脚 · {draft.headers.length}</h3>{draft.headers.length === 0 && <p className="docx-structure-help">文档没有已有页眉页脚部件，此处不新建部件或修改分节引用。</p>}
          {draft.headers.map(header => <article key={header.part} className="docx-structure-header" data-testid="docx-structure-header" data-part={header.part}><h4>{header.part.includes('/footer') ? '页脚' : '页眉'} <code>{header.part}</code></h4>
            {!header.editable && <p className="docx-structure-warning">只读：{header.reason || '此部件含暂不支持安全编辑的结构，请使用 Word/WPS 处理。'}</p>}
            {header.paragraphs.map((text, index) => <label key={index}><span>第 {index + 1} 段</span><textarea data-testid="docx-structure-header-text" data-part={header.part} data-paragraph-index={index} aria-label={`${header.part}第${index + 1}段`} disabled={inactive || !header.editable} value={text} onChange={event => setHeader(header.part, index, event.target.value)} /></label>)}
            <p className="docx-structure-help">保留现有段落数、页面引用及样式。含页码域、图形等部件保持只读。</p>
          </article>)}</section></>}
    </div>
    <footer><p role="status" data-testid="docx-structure-status">{busy ? '正在读取 / 保存结构副本…' : saved ? '新副本已生成，原稿保留' : !snapshot ? '尚未成功读取结构' : dirty ? `已暂存 ${actions.length} 项修改${actions.length > 100 ? '，超过单批 100 项限制，请减少修改' : '，尚未保存'}` : '当前没有修改'}{blocked && '；请等待当前操作完成'}</p><div><button type="button" className="docx-structure-exit" data-testid="docx-structure-exit" disabled={busy || blocked || actions.length > 100} onClick={() => void saveExit()}>保存副本并退出应用</button><button type="button" className="primary" data-testid="docx-structure-save" disabled={inactive || !dirty || actions.length > 100} onClick={() => void save().catch(() => {})}>另存结构副本</button></div></footer>
  </section></div>;
}
