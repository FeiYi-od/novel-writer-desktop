import { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Extension } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import type { RichNode } from '../../shared/contracts';
import { paragraphSpacesPlugin } from '../../core/paragraph-spaces';
import { replaceChapterMatches } from '../../core/editor-search';
import { ChapterSearch, chapterSearchKey, emptySearch, type ChapterSearchState, type SearchUpdate } from './editor-search';

const ParagraphSpaces = Extension.create({ name: 'paragraphSpaces', addProseMirrorPlugins: () => [paragraphSpacesPlugin()] });

export function ManuscriptEditor({ content, disabled, active = true, plainText = false, onChange, onReady, jump }: {
  content: RichNode | string; disabled: boolean; active?: boolean; plainText?: boolean; onChange: (json: RichNode, text: string) => void;
  onReady: (json: RichNode, text: string) => void;
  /** Cross-chapter jump: put the caret on the first occurrence of this text and scroll to it. */
  jump?: { text: string; token: number } | null;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState<ChapterSearchState>(emptySearch);
  const [replacement, setReplacement] = useState('');
  const [searchMessage, setSearchMessage] = useState('');
  const queryInput = useRef<HTMLInputElement>(null);
  const editor = useEditor({
    extensions: [StarterKit.configure({
      heading: { levels: [1, 2, 3] }, blockquote: false, bulletList: false, orderedList: false,
      listItem: false, listKeymap: false, code: false, codeBlock: false, horizontalRule: false,
      strike: false, link: false, underline: false, trailingNode: false
    }), ParagraphSpaces, ChapterSearch],
    content,
    editable: !disabled,
    editorProps: { attributes: { 'aria-label': '小说正文', spellcheck: 'false' } },
    onCreate: ({ editor: current }) => onReady(current.getJSON() as RichNode, current.getText()),
    onUpdate: ({ editor: current }) => onChange(current.getJSON() as RichNode, current.getText())
  });
  useEffect(() => { editor?.setEditable(!disabled, false); }, [editor, disabled]);
  // Cross-chapter jump: select the first occurrence of the hit text and scroll it into view.
  useEffect(() => {
    if (!editor || !jump?.text.trim()) return;
    const lines = jump.text.split('\n').map(line => line.trim()).filter(line => line.length >= 4);
    const needle = (lines.sort((left, right) => right.length - left.length)[0] ?? jump.text.trim()).slice(0, 60);
    const timer = setTimeout(() => {
      let found: { from: number; to: number } | null = null;
      editor.state.doc.descendants((node, position) => {
        if (found) return false;
        if (!node.isText) return true;
        const text = node.text ?? '';
        const at = text.indexOf(needle);
        if (at >= 0) found = { from: position + at, to: position + at + needle.length };
        return !found;
      });
      if (!found) return;
      editor.chain().focus().setTextSelection(found).scrollIntoView().run();
      // Observable marker for tests and for the author to see the jump happened.
      editor.view.dom.setAttribute('data-jump-text', needle);
    }, 60);
    return () => clearTimeout(timer);
  }, [editor, jump?.token]);
  useEffect(() => {
    if (!editor) return;
    const update = () => setSearch(chapterSearchKey.getState(editor.state) ?? emptySearch);
    editor.on('transaction', update); update();
    return () => { editor.off('transaction', update); };
  }, [editor]);
  useEffect(() => { if (searchOpen && active) { queryInput.current?.focus(); queryInput.current?.select(); } }, [searchOpen, active]);
  function updateSearch(update: SearchUpdate) {
    if (editor) editor.view.dispatch(editor.state.tr.setMeta(chapterSearchKey, update).setMeta('addToHistory', false));
    setSearchMessage('');
  }
  function closeSearch() { setSearchOpen(false); updateSearch({ query: '' }); editor?.commands.focus(); }
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!active || !editor || event.isComposing || editor.view.composing) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && ['f', 'h'].includes(event.key.toLowerCase())) {
        if ((event.target as HTMLElement)?.tagName === 'TEXTAREA') return;
        event.preventDefault(); setSearchOpen(true); queryInput.current?.focus(); queryInput.current?.select();
      } else if (event.key === 'Escape' && searchOpen) { event.preventDefault(); closeSearch(); }
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  });
  function navigate(direction: number) {
    if (!editor || editor.view.composing || !search.matches.length) return;
    const index = (search.active + direction + search.matches.length) % search.matches.length;
    const match = search.matches[index];
    editor.view.dispatch(editor.state.tr.setMeta(chapterSearchKey, { active: index }).setMeta('addToHistory', false).setSelection(TextSelection.create(editor.state.doc, match.from, match.to)).scrollIntoView());
    editor.view.focus(); setSearchMessage('');
  }
  function replace(all: boolean) {
    if (!editor || disabled || !editor.isEditable || !search.matches.length) return;
    if (editor.view.composing) { setSearchMessage('请先完成输入法输入'); return; }
    try {
      const match = search.matches[search.active];
      const result = replaceChapterMatches(editor.state, search, replacement, all ? undefined : match.from);
      if (!all) result.transaction.setMeta(chapterSearchKey, { anchor: match.from + replacement.length });
      editor.view.dispatch(result.transaction); editor.view.focus();
      setSearchMessage(`已替换 ${result.count} 处，可撤销`);
    } catch (e) { setSearchMessage(String(e instanceof Error ? e.message : e)); }
  }
  if (!editor) return null;
  return <>
    <div className="toolbar" aria-label="正文格式">
      <span>宋体</span><span>五号 · 10.5 磅</span><i />
      <button disabled={disabled || plainText} onClick={() => editor.chain().focus().toggleBold().run()} title="粗体 Ctrl+B"><b>B</b></button>
      <button disabled={disabled || plainText} onClick={() => editor.chain().focus().toggleItalic().run()} title="斜体 Ctrl+I"><em>I</em></button>
      <button disabled={disabled} onClick={() => editor.chain().focus().setParagraph().run()}>正文</button>
      <button disabled={disabled || plainText} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>标题</button>
      <i /><button disabled={disabled} onClick={() => editor.chain().focus().undo().run()}>撤销</button>
      <button disabled={disabled} onClick={() => editor.chain().focus().redo().run()}>重做</button>
      <button aria-expanded={searchOpen} onClick={() => { if (searchOpen) closeSearch(); else setSearchOpen(true); }} title="查找 Ctrl+F / 替换 Ctrl+H">查找替换</button>
      <span className="toolbar-note">段首两个可复制全角空格</span>
    </div>
    {searchOpen && <div className="chapter-search" role="search" aria-label="本章查找替换">
      <div className="search-row"><input ref={queryInput} aria-label="查找文字" placeholder="查找本章文字" value={search.query} onChange={e => updateSearch({ query: e.target.value })} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); navigate(e.shiftKey ? -1 : 1); } }} />
        <span className="search-count" aria-live="polite">{search.query ? search.matches.length ? `${search.active + 1} / ${search.matches.length}${search.truncated ? '+' : ''}` : '未找到' : '仅当前章节'}</span>
        <button disabled={!search.matches.length} onClick={() => navigate(-1)} title="Shift+Enter">上一处</button><button disabled={!search.matches.length} onClick={() => navigate(1)} title="Enter">下一处</button>
        <label><input type="checkbox" aria-label="区分大小写" checked={search.matchCase} onChange={e => updateSearch({ matchCase: e.target.checked })} />区分大小写</label>
        <button onClick={closeSearch} aria-label="关闭查找">×</button></div>
      <div className="search-row"><input aria-label="替换文字" placeholder="替换为（留空则删除）" value={replacement} onChange={e => { setReplacement(e.target.value); setSearchMessage(''); }} />
        <button disabled={disabled || !search.matches.length} onClick={() => replace(false)}>替换当前</button><button disabled={disabled || !search.matches.length || search.truncated} onClick={() => replace(true)}>全部替换</button>
        <span className="search-help" role="status">{searchMessage || (disabled ? '正文只读时可查找，不能替换' : search.truncated ? '超过10000处，请缩小查找范围' : '普通文字匹配；保留段首空格')}</span></div>
    </div>}
    <div className="paper-scroll"><div className="paper"><EditorContent editor={editor} /></div></div>
  </>;
}
