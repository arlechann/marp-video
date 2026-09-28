import assert from 'node:assert/strict';
import test from 'node:test';

import {
    asConverter,
    attachPlainTexts,
    chooseOutputPath,
    execPipeline,
    parseScript,
    parseScriptFrontMatter,
    parseScriptPages,
    planTimeline,
    resolveNarrationPages,
} from '../src/index.ts';

const scriptText = [
    '---',
    'voicevox:',
    '  speaker: 3',
    '  speedScale: 1.0',
    '  pages:',
    '    "2":',
    '      speaker: 8',
    '      speedScale: 0.9',
    '---',
    '',
    '# 導入',
    '',
    '~~~text',
    '---',
    '~~~',
    '',
    '---',
    '',
    '# 本題',
    '',
    '説明します。',
].join('\n');

test('台本をFront Matterとページに分け、コードブロック内の---は残す', () => {
    const parsed = parseScript(scriptText);

    assert.equal(parsed.pages.length, 2);
    assert.match(parsed.pages[0]!.markdown, /~~~text\n---\n~~~/);
    assert.match(parsed.pages[1]!.markdown, /# 本題/);
    assert.deepEqual(parsed.voicevox.common, { speaker: 3, speedScale: 1 });
    assert.deepEqual(parsed.voicevox.pages[2], { speaker: 8, speedScale: 0.9 });
});

test('Front Matterの解析とMarkdown本文のページ分割を個別に実行できる', () => {
    const { voicevox, body } = parseScriptFrontMatter(scriptText);
    const pages = parseScriptPages(body);

    assert.deepEqual(voicevox.common, { speaker: 3, speedScale: 1 });
    assert.deepEqual(voicevox.pages[2], { speaker: 8, speedScale: 0.9 });
    assert.match(body, /~~~text\n---\n~~~/);
    assert.equal(pages.length, 2);
    assert.deepEqual({ voicevox, pages }, parseScript(scriptText));
});

test('各パーサーは担当する入力を単独で検証する', () => {
    assert.throws(
        () => parseScriptFrontMatter('---\nvoicevox:\n  speaker: 3\n  speaker: 8\n---\n本文'),
        /重複|duplicate/i
    );
    assert.deepEqual(
        parseScriptPages('# 一枚だけ').map(page => page.markdown),
        ['# 一枚だけ']
    );
    assert.throws(() => parseScriptPages('一枚目\n---\n二枚目'), /空行/);
});

test('不正なFront Matterと空ページを拒否する', () => {
    assert.throws(() => parseScript('# Front Matterなし'), /Front Matter/i);
    assert.throws(() => parseScript('---\nvoicevox:\n  speaker: 3\n  speaker: 8\n---\n\n本文'), /重複|duplicate/i);
    assert.throws(() => parseScript('---\nvoicevox:\n  speaker: 3\n---\n\n本文\n\n---\n'), /空ページ/i);
});

test('ページ番号の引用符、設定の型、ページ境界の空行を検証する', () => {
    assert.throws(() => parseScript('---\nvoicevox:\n  pages:\n    1:\n      speaker: 3\n---\n\n本文'), /引用符/);
    assert.throws(() => parseScript('---\nvoicevox:\n  speaker: "3"\n---\n\n本文'), /speaker/);
    assert.throws(() => parseScript('---\nvoicevox:\n  speaker: 3\n---\n\n最初\n---\n次'), /空行/);
});

test('ページ順で話者設定を解決し、利用可能なスタイルを確認する', () => {
    const pages = resolveNarrationPages({
        script: parseScript(scriptText),
        slideCount: 2,
        speakerIds: [3, 8],
    });

    assert.deepEqual(
        pages.map(page => [page.number, page.speaker, page.queryOverrides.speedScale]),
        [
            [1, 3, 1],
            [2, 8, 0.9],
        ]
    );
    assert.match(pages[1]!.markdown, /説明します/);
});

test('無音時間倍率は既定で1.5とし、台本の共通・ページ別指定を優先する', () => {
    const defaults = resolveNarrationPages({
        script: parseScript('---\nvoicevox:\n  speaker: 3\n---\n\n一枚目'),
        slideCount: 1,
        speakerIds: [3],
    });
    assert.equal(defaults[0]!.queryOverrides.pauseLengthScale, 1.5);

    const overridden = resolveNarrationPages({
        script: parseScript(
            '---\nvoicevox:\n  speaker: 3\n  pauseLengthScale: 2\n  pages:\n    "2":\n      pauseLengthScale: 0.75\n---\n\n一枚目\n\n---\n\n二枚目'
        ),
        slideCount: 2,
        speakerIds: [3],
    });
    assert.deepEqual(
        overridden.map(page => page.queryOverrides.pauseLengthScale),
        [2, 0.75]
    );
});

test('スライド数・話者・ページ別設定の不一致を拒否する', () => {
    const script = parseScript(scriptText);

    assert.throws(() => resolveNarrationPages({ script, slideCount: 1, speakerIds: [3, 8] }), /ページ数/);
    assert.throws(() => resolveNarrationPages({ script, slideCount: 2, speakerIds: [3] }), /speaker|スタイル/i);
    assert.throws(
        () =>
            resolveNarrationPages({
                script: parseScript('---\nvoicevox:\n  speaker: 3\n  pages:\n    "3":\n      speaker: 8\n---\n\n本文'),
                slideCount: 1,
                speakerIds: [3, 8],
            }),
        /3ページ目|ページ番号/
    );
});

test('Markdownのテキスト化結果をページに対応させ、空の読み上げを拒否する', () => {
    const pages = resolveNarrationPages({
        script: parseScript(scriptText),
        slideCount: 2,
        speakerIds: [3, 8],
    });

    const narrations = attachPlainTexts({ pages, texts: ['導入', ' 本題\n説明します。'] });
    assert.equal(narrations[1]!.plainText, ' 本題\n説明します。');
    assert.throws(() => attachPlainTexts({ pages, texts: ['導入', '   \n'] }), /2ページ目|空/);
});

test('音声長と余白からフレーム単位の時間割を計算する', () => {
    const timeline = planTimeline({ audioDurationsSeconds: [1, 2] });

    assert.deepEqual(
        timeline.pages.map(page => [page.number, page.startFrame, page.frameCount]),
        [
            [1, 0, 60],
            [2, 60, 150],
        ]
    );
    assert.equal(timeline.totalFrames, 210);
    assert.ok(Math.abs(timeline.pages[0]!.silenceSeconds - 1) < 1e-9);
    assert.ok(Math.abs(timeline.pages[1]!.silenceSeconds - 3) < 1e-9);
});

test('フレーム境界上の小数秒で余計な1フレームを作らない', () => {
    const timeline = planTimeline({ audioDurationsSeconds: [0.013, 0.5], gapMs: 687, tailMs: 0 });
    assert.deepEqual(
        timeline.pages.map(page => page.frameCount),
        [21, 15]
    );
    assert.equal(timeline.totalFrames, 36);
});

test('タイムスタンプ付きの出力名を決め、同名があれば連番を付ける', () => {
    const basePath = '/presentation/build/video.mp4';
    const localTime = { year: 2026, month: 9, day: 29, hour: 12, minute: 34, second: 56, millisecond: 789 };
    const first = chooseOutputPath({ basePath, localTime, existingPaths: [] });
    const second = chooseOutputPath({ basePath, localTime, existingPaths: [first] });

    assert.equal(first, '/presentation/build/video-20260929T123456789.mp4');
    assert.equal(second, '/presentation/build/video-20260929T123456789-2.mp4');
});

test('ドメイン関数をCPSコンバータとして接続できる', async () => {
    let result: ReturnType<typeof resolveNarrationPages> | undefined;

    await execPipeline(
        [
            asConverter(parseScript),
            asConverter((script: ReturnType<typeof parseScript>) =>
                resolveNarrationPages({
                    script,
                    slideCount: 2,
                    speakerIds: [3, 8],
                })
            ),
            (pages: ReturnType<typeof resolveNarrationPages>) => {
                result = pages;
            },
        ],
        scriptText
    );

    assert.deepEqual(
        result?.map(page => page.speaker),
        [3, 8]
    );
});

test('ドメイン関数の失敗をコンバータのerror経由で伝える', async () => {
    const failure = new Error('invalid domain input');
    let continued = false;

    await assert.rejects(
        execPipeline([
            asConverter((): never => {
                throw failure;
            }),
            () => {
                continued = true;
            },
        ]),
        failure
    );

    assert.equal(continued, false);
});
