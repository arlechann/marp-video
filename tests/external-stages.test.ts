import assert from 'node:assert/strict';
import test from 'node:test';

import {
    execPipeline,
    makeCheckVoicevox,
    makeWithWorkspace,
    makeEncodeVideo,
    makeLoadScript,
    makeProbeAudio,
    makePublishVideo,
    makeRenderSlides,
    makeSelectOutputPath,
    makeSynthesizeAudio,
    parseScript,
    planTimeline,
    resolveNarrationPages,
    attachPlainTexts,
} from '../src/index.ts';

test('外部操作を注入した前処理段階が台本・話者・スライド画像を順に引き継ぐ', async () => {
    const calls: string[] = [];
    let result:
        | {
              workspacePath: string;
              scriptContent: string;
              speakerIds: readonly number[];
              slideImages: readonly string[];
          }
        | undefined;

    await execPipeline(
        [
            makeWithWorkspace(
                async () => {
                    calls.push('workspace');
                    return '/work';
                },
                async path => {
                    calls.push(`cleanup:${path}`);
                }
            ),
            makeLoadScript(async path => {
                calls.push(`read:${path}`);
                return '# 台本';
            }),
            makeCheckVoicevox(async url => {
                calls.push(`speakers:${url}`);
                return [3, 8];
            }),
            makeRenderSlides(async request => {
                calls.push(`marp:${request.slidesPath}:${request.workspacePath}:${request.allowLocalFiles}`);
                return ['/work/slide.001.png', '/work/slide.002.png'];
            }),
            (value: typeof result) => {
                calls.push('done');
                result = value;
            },
        ],
        {
            scriptPath: 'script.md',
            slidesPath: 'slides.md',
            voicevoxUrl: 'http://localhost:50021',
            allowLocalFiles: true,
        }
    );

    assert.deepEqual(calls, [
        'workspace',
        'read:script.md',
        'speakers:http://localhost:50021',
        'marp:slides.md:/work:true',
        'done',
        'cleanup:/work',
    ]);
    assert.equal(result?.scriptContent, '# 台本');
    assert.deepEqual(result?.speakerIds, [3, 8]);
    assert.deepEqual(result?.slideImages, ['/work/slide.001.png', '/work/slide.002.png']);
});

test('音声・動画・配置の各段階がページ順と時間割を保って操作を呼び出す', async () => {
    const calls: string[] = [];
    let result:
        | {
              audioPaths: readonly string[];
              audioDurationsSeconds: readonly number[];
              temporaryVideoPath: string;
              outputPath: string;
              finalVideoPath: string;
          }
        | undefined;
    const script = parseScript('---\nvoicevox:\n  speaker: 3\n---\n\n# 一枚目\n\n---\n\n# 二枚目');
    const pages = resolveNarrationPages({ script, slideCount: 2, speakerIds: [3] });
    const narrations = attachPlainTexts({ pages, texts: ['一枚目', '二枚目'] });
    const timeline = planTimeline({ audioDurationsSeconds: [1, 2] });

    await execPipeline(
        [
            makeSynthesizeAudio(async ({ narration, workspacePath }) => {
                calls.push(`voice:${narration.number}:${narration.speaker}:${narration.plainText}:${workspacePath}`);
                return `/work/${narration.number}.wav`;
            }),
            makeProbeAudio(async path => {
                calls.push(`probe:${path}`);
                return path.endsWith('/1.wav') ? 1 : 2;
            }),
            makeEncodeVideo(async request => {
                calls.push(
                    `encode:${request.slideImages.length}:${request.audioPaths.length}:${request.timeline.totalFrames}`
                );
                return '/work/temp.mp4';
            }),
            makeSelectOutputPath(async basePath => {
                calls.push(`existing:${basePath}`);
                return ['/out/video-20260929T123456789.mp4'];
            }),
            makePublishVideo(async (temporaryPath, outputPath) => {
                calls.push(`publish:${temporaryPath}:${outputPath}`);
            }),
            (value: typeof result) => {
                result = value;
            },
        ],
        {
            workspacePath: '/work',
            voicevoxUrl: 'http://localhost:50021',
            narrations,
            timeline,
            slideImages: ['/work/slide.001.png', '/work/slide.002.png'],
            baseOutputPath: '/out/video.mp4',
            localTime: { year: 2026, month: 9, day: 29, hour: 12, minute: 34, second: 56, millisecond: 789 },
        }
    );

    assert.deepEqual(result?.audioPaths, ['/work/1.wav', '/work/2.wav']);
    assert.deepEqual(result?.audioDurationsSeconds, [1, 2]);
    assert.equal(result?.temporaryVideoPath, '/work/temp.mp4');
    assert.equal(result?.outputPath, '/out/video-20260929T123456789-2.mp4');
    assert.equal(result?.finalVideoPath, result?.outputPath);
    assert.deepEqual(calls, [
        'voice:1:3:一枚目:/work',
        'voice:2:3:二枚目:/work',
        'probe:/work/1.wav',
        'probe:/work/2.wav',
        'encode:2:2:210',
        'existing:/out/video.mp4',
        'publish:/work/temp.mp4:/out/video-20260929T123456789-2.mp4',
    ]);
});

test('VOICEVOX確認に失敗したらスライド生成を始めない', async () => {
    const failure = new Error('VOICEVOX unavailable');
    let rendered = false;

    await assert.rejects(
        execPipeline(
            [
                makeCheckVoicevox(async () => {
                    throw failure;
                }),
                makeRenderSlides(async () => {
                    rendered = true;
                    return ['slide.png'];
                }),
            ],
            { voicevoxUrl: 'http://localhost:50021', slidesPath: 'slides.md', workspacePath: '/work' }
        ),
        failure
    );
    assert.equal(rendered, false);
});

test('後続が失敗しても作業ディレクトリを片付ける', async () => {
    const failure = new Error('Marp failed');
    const calls: string[] = [];
    await assert.rejects(
        execPipeline(
            [
                makeWithWorkspace(
                    async () => {
                        calls.push('create');
                        return '/work';
                    },
                    async path => {
                        calls.push(`cleanup:${path}`);
                    }
                ),
                () => {
                    throw failure;
                },
            ],
            {}
        ),
        failure
    );
    assert.deepEqual(calls, ['create', 'cleanup:/work']);
});

test('中間成果物を保持する指定では作業ディレクトリを片付けない', async () => {
    let cleaned = false;
    await execPipeline(
        [
            makeWithWorkspace(
                async () => '/work',
                async () => {
                    cleaned = true;
                }
            ),
        ],
        { keepIntermediates: true }
    );
    assert.equal(cleaned, false);
});

test('ページ音声の生成に失敗したら残りのページと動画生成を始めない', async () => {
    const failure = new Error('VOICEVOX synthesis failed');
    const calls: number[] = [];
    let encoded = false;
    const script = parseScript('---\nvoicevox:\n  speaker: 3\n---\n\n一枚目\n\n---\n\n二枚目');
    const pages = resolveNarrationPages({ script, slideCount: 2, speakerIds: [3] });
    const narrations = attachPlainTexts({ pages, texts: ['一枚目', '二枚目'] });

    await assert.rejects(
        execPipeline(
            [
                makeSynthesizeAudio(async ({ narration }) => {
                    calls.push(narration.number);
                    throw failure;
                }),
                makeEncodeVideo(async () => {
                    encoded = true;
                    return '/work/temp.mp4';
                }),
            ],
            { workspacePath: '/work', voicevoxUrl: 'http://localhost:50021', narrations }
        ),
        failure
    );
    assert.deepEqual(calls, [1]);
    assert.equal(encoded, false);
});

test('出力配置が失敗した場合は完成ファイルとして報告しない', async () => {
    const failure = new Error('output already exists');
    let completed = false;

    await assert.rejects(
        execPipeline(
            [
                makePublishVideo(async () => {
                    throw failure;
                }),
                () => {
                    completed = true;
                },
            ],
            { temporaryVideoPath: '/work/temp.mp4', outputPath: '/out/video.mp4' }
        ),
        failure
    );
    assert.equal(completed, false);
});
