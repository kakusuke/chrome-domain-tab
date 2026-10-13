import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTabUrl, compareLabels, colorFor } from '../src/domain.js';

test('サブドメインを逆順に分解する', () => {
  assert.deepEqual(parseTabUrl('https://api.v2.google.com/path'), {
    host: 'api.v2.google.com',
    site: 'google.com',
    siteLabel: 'com.google',
    subLabels: ['v2', 'api'],
  });
});

test('登録可能ドメインそのもののホストはサブラベルなし', () => {
  assert.deepEqual(parseTabUrl('https://google.com/').subLabels, []);
});

test('多段サフィックスを考慮する', () => {
  const p = parseTabUrl('https://www.example.co.jp/');
  assert.equal(p.siteLabel, 'jp.co.example');
  assert.deepEqual(p.subLabels, ['www']);
  assert.equal(parseTabUrl('https://foo.github.io/').siteLabel, 'io.github.foo');
  assert.equal(parseTabUrl('https://bucket.s3.amazonaws.com/').siteLabel, 'com.amazonaws.s3.bucket');
});

test('IP アドレスと localhost はそのまま', () => {
  assert.equal(parseTabUrl('http://192.168.0.1:8080/').siteLabel, '192.168.0.1');
  assert.equal(parseTabUrl('http://[::1]/').siteLabel, '[::1]');
  assert.equal(parseTabUrl('http://localhost:3000/').siteLabel, 'localhost');
});

test('http(s) 以外は対象外', () => {
  assert.equal(parseTabUrl('chrome://newtab/'), null);
  assert.equal(parseTabUrl('file:///tmp/a.html'), null);
  assert.equal(parseTabUrl(''), null);
});

test('親ドメインが先、同階層は辞書順', () => {
  const sorted = [['www'], [], ['api'], ['v2', 'api']].sort(compareLabels);
  assert.deepEqual(sorted, [[], ['api'], ['v2', 'api'], ['www']]);
});

test('同じサイトは同じ色', () => {
  assert.equal(colorFor('google.com'), colorFor('google.com'));
});
