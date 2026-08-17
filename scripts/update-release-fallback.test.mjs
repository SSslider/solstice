#!/usr/bin/env node

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const helperPath = process.argv[2] ?? './vscode/src/vs/platform/update/electron-main/githubReleaseUpdate.ts';
const {
	createUpdateFromGitHubRelease,
	isRetryableUpdateFeedStatus,
	requestUpdateWithFallback
} = await import(pathToFileURL(helperPath).href);

const primaryUrl = 'https://raw.githubusercontent.com/SSslider/versions/refs/heads/master/stable/win32/x64/user/latest.json';
const releasesApiUrl = 'https://api.github.com/repos/SSslider/solstice/releases/latest';
const digest = 'a'.repeat(64);
const release = {
	tag_name: '1.121.04107',
	published_at: '2026-08-17T13:33:42Z',
	draft: false,
	prerelease: false,
	assets: [
		{
			name: 'SolsticeUserSetup-x64-1.121.04107.exe.sha256',
			browser_download_url: 'https://example.invalid/sidecar'
		},
		{
			name: 'SolsticeUserSetup-arm64-1.121.04107.exe',
			browser_download_url: 'https://example.invalid/wrong-arch'
		},
		{
			name: 'SolsticeUserSetup-x64-1.121.04107.exe',
			browser_download_url: 'https://github.com/SSslider/solstice/releases/download/1.121.04107/SolsticeUserSetup-x64-1.121.04107.exe',
			digest: `sha256:${digest}`
		},
		{
			name: 'SolsticeSetup-x64-1.121.04107.exe',
			browser_download_url: 'https://github.com/SSslider/solstice/releases/download/1.121.04107/SolsticeSetup-x64-1.121.04107.exe',
			digest: `sha256:${digest}`
		},
		{
			name: 'Solstice-win32-x64-1.121.04107.zip',
			browser_download_url: 'https://github.com/SSslider/solstice/releases/download/1.121.04107/Solstice-win32-x64-1.121.04107.zip',
			digest: `sha256:${digest}`
		}
	]
};

function options(requestJson, overrides = {}) {
	return {
		primaryUrl,
		releasesApiUrl,
		applicationName: 'Solstice',
		requestJson,
		sleep: async () => {},
		...overrides
	};
}

test('only 429 and 5xx statuses are retryable', () => {
	assert.equal(isRetryableUpdateFeedStatus(429), true);
	assert.equal(isRetryableUpdateFeedStatus(500), true);
	assert.equal(isRetryableUpdateFeedStatus(599), true);
	assert.equal(isRetryableUpdateFeedStatus(404), false);
	assert.equal(isRetryableUpdateFeedStatus(400), false);
	assert.equal(isRetryableUpdateFeedStatus(600), false);
});

test('maps the exact Windows user asset and preserves GitHub sha256 provenance', () => {
	assert.deepEqual(createUpdateFromGitHubRelease(release, primaryUrl, 'Solstice'), {
		version: '1.121.04107',
		productVersion: '1.121.4107.0',
		url: 'https://github.com/SSslider/solstice/releases/download/1.121.04107/SolsticeUserSetup-x64-1.121.04107.exe',
		timestamp: Date.parse('2026-08-17T13:33:42Z'),
		sha256hash: digest
	});
});

test('maps system and archive feeds to their exact assets', () => {
	const system = createUpdateFromGitHubRelease(release, primaryUrl.replace('/user/', '/system/'), 'Solstice');
	const archive = createUpdateFromGitHubRelease(release, primaryUrl.replace('/user/', '/archive/'), 'Solstice');
	assert.match(system.url, /SolsticeSetup-x64-1\.121\.04107\.exe$/);
	assert.match(archive.url, /Solstice-win32-x64-1\.121\.04107\.zip$/);
});

test('rejects insider feeds and releases without the exact target asset', () => {
	assert.equal(createUpdateFromGitHubRelease(release, primaryUrl.replace('/stable/', '/insider/'), 'Solstice'), undefined);
	assert.equal(createUpdateFromGitHubRelease({ ...release, assets: [] }, primaryUrl, 'Solstice'), undefined);
	assert.equal(createUpdateFromGitHubRelease({ ...release, assets: [{ ...release.assets[2], digest: null }] }, primaryUrl, 'Solstice'), undefined);
});

test('uses a healthy primary feed without retry or fallback', async () => {
	const requests = [];
	const expected = { version: 'primary', productVersion: '1.121.4107.0', url: 'https://example.invalid/update.exe' };
	const result = await requestUpdateWithFallback(options(async url => {
		requests.push(url);
		return { statusCode: 200, body: expected };
	}));
	assert.deepEqual(result, { update: expected, source: 'primary' });
	assert.deepEqual(requests, [primaryUrl]);
});

test('retries 429 with 500/1500ms backoff, then uses Releases API', async () => {
	const requests = [];
	const sleeps = [];
	const retries = [];
	const result = await requestUpdateWithFallback(options(async url => {
		requests.push(url);
		return url === primaryUrl ? { statusCode: 429, body: null } : { statusCode: 200, body: release };
	}, {
		sleep: async delay => { sleeps.push(delay); },
		onRetry: (status, delay, attempt) => retries.push([status, delay, attempt])
	}));
	assert.equal(result.source, 'github-releases');
	assert.equal(result.update.productVersion, '1.121.4107.0');
	assert.deepEqual(requests, [primaryUrl, primaryUrl, primaryUrl, releasesApiUrl]);
	assert.deepEqual(sleeps, [500, 1500]);
	assert.deepEqual(retries, [[429, 500, 1], [429, 1500, 2]]);
});

test('falls back after retryable 5xx responses', async () => {
	let primaryAttempts = 0;
	const result = await requestUpdateWithFallback(options(async url => {
		if (url === primaryUrl) {
			primaryAttempts++;
			return { statusCode: primaryAttempts === 1 ? 503 : 502, body: null };
		}
		return { statusCode: 200, body: release };
	}));
	assert.equal(primaryAttempts, 3);
	assert.equal(result.source, 'github-releases');
});

test('does not hide a non-retryable primary 404', async () => {
	let requests = 0;
	await assert.rejects(
		requestUpdateWithFallback(options(async () => {
			requests++;
			return { statusCode: 404, body: null };
		})),
		/HTTP 404/
	);
	assert.equal(requests, 1);
});

test('does not route non-Windows feeds through a partial Releases fallback', async () => {
	let requests = 0;
	await assert.rejects(
		requestUpdateWithFallback(options(async () => {
			requests++;
			return { statusCode: 429, body: null };
		}, { primaryUrl: primaryUrl.replace('/win32/', '/darwin/').replace('/user/', '/') })),
		/HTTP 429/
	);
	assert.equal(requests, 1);
});

test('fails loudly when the Releases API is unavailable', async () => {
	await assert.rejects(
		requestUpdateWithFallback(options(async url => url === primaryUrl
			? { statusCode: 429, body: null }
			: { statusCode: 500, body: null })),
		/fallback failed with HTTP 500/
	);
});
