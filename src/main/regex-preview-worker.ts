import { parentPort, workerData } from 'node:worker_threads';
import { applyRegexScripts, substituteMacros } from '../core/st-macros';
import { freezeRegexPreviewTask, REGEX_PREVIEW_LIMITS } from './regex-preview';

if (!parentPort) throw new Error('正则预览只能在隔离线程中执行');
const port = parentPort;
try {
  const input = freezeRegexPreviewTask(workerData);
  const expanded = substituteMacros(input.text, input.env, Math.random, REGEX_PREVIEW_LIMITS.outputCharacters);
  const applied = applyRegexScripts(expanded, input.scripts, input.env, REGEX_PREVIEW_LIMITS.outputCharacters);
  port.postMessage({ ok: true, projectId: input.projectId, requestId: input.requestId, expanded, applied });
} catch (error) {
  port.postMessage({ ok: false, projectId: workerData?.projectId, requestId: workerData?.requestId,
    error: (error instanceof Error ? error.message : '正则预览执行失败').slice(0, 500) });
} finally { port.close(); }
