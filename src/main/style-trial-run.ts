import type { AIConnection } from '../shared/contracts';
import { streamChat, type ChatMessage } from './ai-provider';
import { StyleTrialService } from './style-trial';
import { createStyleTrialSender } from './style-trial-sender';
import type { StylePromptMessage } from '../core/style-trial-prompt';

type Stream = (profile: AIConnection, key: string, messages: ChatMessage[], signal: AbortSignal, onText: (text: string) => void) => Promise<string>;
export interface ConnectionSource {
  read: () => Promise<{ hash: string }>;
  resolve: (connectionId: string, expectedHash: string) => Promise<{ profile: AIConnection; key: string }>;
}
/** Raw completion over the existing provider stack: same connection, same key handling, same
 * streaming code path as normal writing — the style trial must not invent a second HTTP client. */
export function createRawCompletion(source: ConnectionSource, stream: Stream = streamChat) {
  return async (connectionId: string, messages: StylePromptMessage[], signal: AbortSignal): Promise<string> => {
    const snapshot = await source.read();
    const { profile, key } = await source.resolve(connectionId, snapshot.hash);
    signal.throwIfAborted();
    // streamChat returns the finish reason and delivers text through the callback, so accumulate it.
    let text = '';
    await stream(profile, key, messages, signal, chunk => { text += chunk; });
    return text;
  };
}
/** Builds a trial bound to one connection; rules are looked up per style id. */
export function createStyleTrial(source: ConnectionSource, rulesFor: (styleId: string) => string, stream?: Stream) {
  const complete = createRawCompletion(source, stream);
  return {
    run: (connectionId: string, request: { brief: string; styles: { styleId: string; styleName: string }[]; maxChars?: number }) =>
      new StyleTrialService(createStyleTrialSender({ complete: (messages, signal) => complete(connectionId, messages, signal), rulesFor })).run(request)
  };
}
