import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCliArgs, runCli } from '../src/index.ts';

test('余白オプションを省略すると通常ページ1秒・最終ページ3秒になる', () => {
    const command = parseCliArgs(['build', 'slides.md', 'script.md'], '/presentation', new Date(2026, 8, 29));
    assert.equal(command.kind, 'build');
    if (command.kind !== 'build') return;
    assert.equal(command.options.gapMs, 1000);
    assert.equal(command.options.tailMs, 3000);
});

test('ヘルプに新しい既定値を表示する', async () => {
    const output: string[] = [];
    const status = await runCli(['--help'], {
        writeStdout: text => {
            output.push(text);
        },
    });
    assert.equal(status, 0);
    assert.match(output.join(''), /--gap-ms N[^\n]*1000/);
    assert.match(output.join(''), /--tail-ms N[^\n]*3000/);
});
