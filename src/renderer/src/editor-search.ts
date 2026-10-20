import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { findChapterMatches, type SearchOptions, type SearchResult } from '../../core/editor-search';

export interface ChapterSearchState extends SearchOptions, SearchResult { active: number }
export type SearchUpdate = Partial<SearchOptions> & { active?: number; anchor?: number };
export const chapterSearchKey = new PluginKey<ChapterSearchState>('chapterSearch');
export const emptySearch: ChapterSearchState = { query: '', matchCase: false, matches: [], truncated: false, active: 0 };

export const ChapterSearch = Extension.create({
  name: 'chapterSearch',
  addProseMirrorPlugins() {
    return [new Plugin<ChapterSearchState>({
      key: chapterSearchKey,
      state: {
        init: () => ({ ...emptySearch }),
        apply(tr, previous) {
          const update = tr.getMeta(chapterSearchKey) as SearchUpdate | undefined;
          if (!tr.docChanged && !update) return previous;
          const query = update?.query ?? previous.query, matchCase = update?.matchCase ?? previous.matchCase;
          const changed = query !== previous.query || matchCase !== previous.matchCase;
          const result = tr.docChanged || changed ? findChapterMatches(tr.doc, { query, matchCase }) : previous;
          let active = changed ? 0 : update?.active ?? previous.active;
          if (!changed && (tr.docChanged || update?.anchor !== undefined)) {
            const oldFrom = previous.matches[previous.active]?.from ?? 0;
            const anchor = update?.anchor ?? tr.mapping.map(oldFrom);
            const next = result.matches.findIndex(match => match.from >= anchor);
            active = next < 0 ? 0 : next;
          }
          return { query, matchCase, matches: result.matches, truncated: result.truncated, active: Math.max(0, Math.min(active, result.matches.length - 1)) };
        }
      },
      props: {
        decorations(state) {
          const search = chapterSearchKey.getState(state);
          return search ? DecorationSet.create(state.doc, search.matches.map((match, index) => Decoration.inline(match.from, match.to, { class: index === search.active ? 'search-hit search-hit-active' : 'search-hit' }))) : null;
        }
      }
    })];
  }
});
