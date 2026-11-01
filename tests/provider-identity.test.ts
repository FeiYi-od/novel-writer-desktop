import test from 'node:test';
import assert from 'node:assert/strict';
import { identifyProvider } from '../src/core/provider-identity';

test('模型来源标识仅匹配明确 API 主机，代理和伪装域名回退', () => {
  assert.equal(identifyProvider('https://api.openai.com/v1'), 'openai');
  assert.equal(identifyProvider('https://generativelanguage.googleapis.com/v1beta'), 'gemini');
  assert.equal(identifyProvider('https://api.deepseek.com/v1'), 'deepseek');
  assert.equal(identifyProvider('https://dashscope.aliyuncs.com/compatible-mode/v1'), 'qwen');
  assert.equal(identifyProvider('https://api.anthropic.com/v1'), 'claude');
  assert.equal(identifyProvider('http://127.0.0.1:11434','ollama'), 'ollama');
  assert.equal(identifyProvider('https://example.com','gemini'), 'custom');
  assert.equal(identifyProvider('https://api.openai.com.evil.example/v1'), 'custom');
  assert.equal(identifyProvider('https://api.openai.com@evil.example/v1'), 'custom');
  assert.equal(identifyProvider('ftp://api.openai.com'), 'custom');
  assert.equal(identifyProvider(''), 'custom');
});
