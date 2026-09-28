import assert from 'node:assert/strict';
import test from 'node:test';

import { execPipeline } from '../src/index.ts';

test('同期・非同期の段階とファクトリで作った段階を順に実行する', async () => {
  const events: string[] = [];
  const makeConverter = (prefix: string) =>
    (input: number, next: (value: string) => Promise<void>) => {
      events.push(`convert:${input}`);
      void next(`${prefix}${input}`);
    };

  const pipeline = [
    (input: undefined, next: (value: number) => Promise<void>) => {
      assert.equal(input, undefined);
      events.push('start');
      void next(2);
    },
    async (input: number, next: (value: number) => Promise<void>) => {
      events.push('async:start');
      await Promise.resolve();
      events.push('async:end');
      void next(input * 3);
    },
    makeConverter('value:'),
    (input: string, next: (value: string) => Promise<void>) => {
      events.push(input);
      void next(input);
    },
  ];

  await execPipeline(pipeline);

  assert.deepEqual(events, ['start', 'async:start', 'async:end', 'convert:6', 'value:6']);
});

test('初期入力を最初の段階へ渡せる', async () => {
  const values: number[] = [];

  await execPipeline([
    (input: number, next: (value: number) => Promise<void>) => {
      values.push(input);
      return next(input + 1);
    },
    (input: number) => {
      values.push(input);
    },
  ], 4);

  assert.deepEqual(values, [4, 5]);
});

test('nextを呼ばなければ後続の段階を実行しない', async () => {
  const values: string[] = [];

  await execPipeline([
    (_input: undefined, next: (value: string) => Promise<void>) => {
      values.push('first');
      void next('data');
    },
    () => {
      values.push('stop');
    },
    () => {
      values.push('unexpected');
    },
  ]);

  assert.deepEqual(values, ['first', 'stop']);
});

test('後続段階の失敗を、nextをawaitしない呼び出し元にも伝える', async () => {
  const failure = new Error('conversion failed');

  await assert.rejects(execPipeline([
    (_input: undefined, next: (value: string) => Promise<void>) => {
      void next('data');
    },
    async () => {
      await Promise.resolve();
      throw failure;
    },
  ]), failure);
});

test('同じ段階からnextを2回呼ぶと失敗し、後続は1回だけ実行する', async () => {
  let calls = 0;

  await assert.rejects(execPipeline([
    (_input: undefined, next: (value: string) => Promise<void>) => {
      void next('first');
      void next('second');
    },
    () => {
      calls += 1;
    },
  ]), /next.*2回|next.*once/i);

  assert.equal(calls, 1);
});

test('errorで報告した理由を返し、後続を実行しない', async () => {
  const failure = new Error('invalid script');
  let continued = false;

  await assert.rejects(execPipeline([
    (_input: undefined, _next: (value: string) => Promise<void>, error: (reason: unknown) => void) => {
      error(failure);
    },
    () => {
      continued = true;
    },
  ]), failure);

  assert.equal(continued, false);
});

test('非同期段階からのerror報告でもパイプラインを失敗させる', async () => {
  const failure = new Error('voice synthesis failed');

  await assert.rejects(execPipeline([
    async (_input: undefined, _next: (value: string) => Promise<void>, error: (reason: unknown) => void) => {
      await Promise.resolve();
      error(failure);
    },
  ]), failure);
});

test('nextをawaitしない段階にも、後続のerror報告を伝える', async () => {
  const failure = new Error('render failed');

  await assert.rejects(execPipeline([
    (_input: undefined, next: (value: string) => Promise<void>) => {
      void next('data');
    },
    (_input: string, _next: (value: string) => Promise<void>, error: (reason: unknown) => void) => {
      error(failure);
    },
  ]), failure);
});

test('同じ段階からnextとerrorの両方を呼ぶと失敗する', async () => {
  let calls = 0;

  await assert.rejects(execPipeline([
    (_input: undefined, next: (value: string) => Promise<void>, error: (reason: unknown) => void) => {
      void next('data');
      error(new Error('late error'));
    },
    () => {
      calls += 1;
    },
  ]), /next.*error|error.*next/i);

  assert.equal(calls, 1);
});
