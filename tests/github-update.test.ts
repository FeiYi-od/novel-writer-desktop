import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkGitHubUpdate } from '../src/main/github-update';

const release = (tag_name: string, draft = false) => ({ tag_name, draft });
const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchResponse = (data: unknown): typeof fetch => async () => json(data);

test('compare beta numbers and stable releases correctly, ignoring drafts', async () => {
  const fetcher = fetchResponse([release('v0.1.1-beta.9'), release('v0.1.1-beta.10'), release('v9.0.0', true)]);
  const value = await checkGitHubUpdate('0.1.1-beta.9', { fetcher });
  assert.equal(value.latestVersion, 'v0.1.1-beta.10');
  assert.equal(value.updateAvailable, true);
  assert.equal(value.releaseUrl, 'https://github.com/FeiYi-od/novel-writer-desktop/releases/tag/v0.1.1-beta.10');
  assert.equal((await checkGitHubUpdate('0.1.1', { fetcher })).updateAvailable, false);
  assert.equal((await checkGitHubUpdate('0.1.1-beta.999', { fetcher: fetchResponse([release('v0.1.1')]) })).updateAvailable, true);
});

test('compare arbitrary-length semver numbers and prerelease identifiers', async () => {
  const data = [release('v12345678901234567890.1.0-alpha.2'), release('v12345678901234567890.1.0-alpha.10')];
  assert.equal((await checkGitHubUpdate('12345678901234567890.1.0-alpha.2', { fetcher: fetchResponse(data) })).latestVersion, 'v12345678901234567890.1.0-alpha.10');
  const other = [release('v1.0.0-1'), release('v1.0.0-alpha'), release('v1.0.0-alpha.1')];
  assert.equal((await checkGitHubUpdate('0.1.1', { fetcher: fetchResponse(other) })).latestVersion, 'v1.0.0-alpha.1');
});

test('malformed, empty, and draft-only release lists cannot be reported current', async () => {
  for (const data of [[], [release('v1.0.0', true)], [release('../bad')], [release('v1.0.0-01')], [{}], { bad: true }]) {
    await assert.rejects(checkGitHubUpdate('0.1.1', { fetcher: fetchResponse(data) }));
  }
  await assert.rejects(checkGitHubUpdate('not-a-version', { fetcher: fetchResponse([release('v1.0.0')]) }), /当前应用版本格式无效/u);
});

test('fixed HTTPS endpoint receives credential only in header and redirect is rejected', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (input, init) => {
    calls++;
    assert.equal(input, 'https://api.github.com/repos/FeiYi-od/novel-writer-desktop/releases?per_page=100&page=1');
    assert.equal(init?.redirect, 'error');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer local-test-token');
    return json([release('v0.1.2')]);
  };
  const result = await checkGitHubUpdate('0.1.1', { token: 'local-test-token', fetcher });
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(result).includes('local-test-token'));
  await assert.rejects(checkGitHubUpdate('0.1.1', { token: 'bad\nheader', fetcher }), /授权格式无效/u);
  await assert.rejects(checkGitHubUpdate('0.1.1', { fetcher: async () => { throw new Error('secret from network'); } }), error => error instanceof Error && !error.message.includes('secret'));
});

test('distinguish authentication, rate limit, HTTP errors and malformed body', async () => {
  for (const status of [401, 404]) await assert.rejects(checkGitHubUpdate('0.1.1', { fetcher: async () => new Response('', { status }) }), /授权/u);
  for (const status of [403, 429]) await assert.rejects(checkGitHubUpdate('0.1.1', { fetcher: async () => new Response('', { status }) }), /拒绝访问或请求次数受限/u);
  await assert.rejects(checkGitHubUpdate('0.1.1', { fetcher: async () => new Response('', { status: 500 }) }), /返回异常/u);
  await assert.rejects(checkGitHubUpdate('0.1.1', { fetcher: async () => new Response('not json') }), /格式无效/u);
});

test('pagination fetches all pages; truncated list never appears current', async () => {
  const fullPage = Array.from({ length: 100 }, () => release('v0.1.0'));
  const seen: string[] = [];
  const fetcher: typeof fetch = async input => { seen.push(String(input)); return json(seen.length === 1 ? fullPage : [release('v0.1.2')]); };
  assert.equal((await checkGitHubUpdate('0.1.1', { fetcher })).latestVersion, 'v0.1.2');
  assert.equal(seen.length, 2);
  assert.match(seen[1], /page=2$/u);
  await assert.rejects(checkGitHubUpdate('0.1.1', { fetcher: fetchResponse(fullPage) }), /无法完整检查/u);
});

test('bounded body and deadline reject safely without leaking stream errors', async () => {
  await assert.rejects(checkGitHubUpdate('0.1.1', { fetcher: async () => new Response('[]', { headers: { 'content-length': '3000000' } }) }), /信息过大/u);
  const huge = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); controller.close(); } });
  await assert.rejects(checkGitHubUpdate('0.1.1', { fetcher: async () => new Response(huge) }), /信息过大/u);
  const broken = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('private token')); } });
  await assert.rejects(checkGitHubUpdate('0.1.1', { fetcher: async () => new Response(broken) }), error => error instanceof Error && !error.message.includes('private token'));
  await assert.rejects(checkGitHubUpdate('0.1.1', { timeoutMs: 5, fetcher: () => new Promise(() => {}) }), /超时/u);
});
