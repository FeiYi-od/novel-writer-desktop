import { buildStylePrompt, type StylePromptMessage } from '../core/style-trial-prompt';
import type { StyleTrialSender } from './style-trial';

export type RawCompletion = (messages: StylePromptMessage[], signal: AbortSignal) => Promise<string>;
/** Adapts a raw completion function into a style-trial sender: rules are resolved per style by the
 * caller, and every failure propagates so the trial can record it for that style only. */
export function createStyleTrialSender(input: {
  complete: RawCompletion;
  rulesFor: (styleId: string) => string | Promise<string>;
  targetChars?: number;
}): StyleTrialSender {
  return async (style, brief, signal) => {
    const rules = await input.rulesFor(style.styleId);
    signal.throwIfAborted();
    const messages = buildStylePrompt({ brief, styleName: style.styleName, rules, targetChars: input.targetChars });
    const text = await input.complete(messages, signal);
    signal.throwIfAborted();
    return text;
  };
}
