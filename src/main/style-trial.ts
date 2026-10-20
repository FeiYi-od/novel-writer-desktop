import { compareStyleVariants, measureStyle, type StyleComparison, type StyleVariant } from '../core/style-compare';

export interface StyleTrialRequest { brief: string; styles: { styleId: string; styleName: string }[]; maxChars?: number }
export interface StyleTrialVariant extends StyleVariant { error?: string }
export interface StyleTrialResult { variants: StyleTrialVariant[]; comparison: StyleComparison; failures: number }
export type StyleTrialSender = (style: { styleId: string; styleName: string }, brief: string, signal: AbortSignal) => Promise<string>;
/** Writes the same brief once per style, one after another (never in parallel, so模型额度 and the
 * provider's rate limits stay predictable), then compares the results objectively. A failing style
 * is reported instead of aborting the whole trial. */
export class StyleTrialService {
  private active: { controller: AbortController } | null = null;
  constructor(private readonly send: StyleTrialSender) {}
  get running() { return this.active !== null; }
  cancel() { this.active?.controller.abort(); }
  async run(request: StyleTrialRequest): Promise<StyleTrialResult> {
    const brief = request.brief.trim();
    if (!brief) throw new Error('请先写清楚这段剧情要求');
    if (brief.length > 4000) throw new Error('剧情要求过长（最多 4000 字）');
    if (!request.styles.length) throw new Error('请至少选择一个文风');
    if (request.styles.length > 6) throw new Error('一次最多比较 6 种文风');
    if (new Set(request.styles.map(item => item.styleId)).size !== request.styles.length) throw new Error('文风不能重复选择');
    if (this.active) throw new Error('已有试写比较在进行，请等待或停止');
    const controller = new AbortController();
    this.active = { controller };
    try {
      const variants: StyleTrialVariant[] = [];
      let failures = 0;
      for (const style of request.styles) {
        controller.signal.throwIfAborted();
        try {
          const text = (await this.send(style, brief, controller.signal)).trim();
          if (!text) throw new Error('模型返回空内容');
          variants.push({ styleId: style.styleId, styleName: style.styleName, text: request.maxChars ? text.slice(0, request.maxChars) : text });
        } catch (error) {
          if (controller.signal.aborted) throw error;
          failures += 1;
          variants.push({ styleId: style.styleId, styleName: style.styleName, text: '', error: error instanceof Error ? error.message : String(error) });
        }
      }
      const written = variants.filter(item => !item.error);
      const comparison = compareStyleVariants(written);
      return { variants, comparison, failures };
    } finally { this.active = null; }
  }
  /** Quick metrics for one draft, used by the UI preview table. */
  metricsFor(text: string) { return measureStyle(text); }
}
