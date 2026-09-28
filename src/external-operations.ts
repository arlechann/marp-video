import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EncodeVideoRequest, RenderSlidesRequest, SynthesizeAudioRequest } from './external-stages.ts';

const marpCliScript = fileURLToPath(new URL('../node_modules/@marp-team/marp-cli/marp-cli.js', import.meta.url));
// Rendering/encoding scale with deck length; probing one WAV should be quick.
const commandTimeoutMs = { marp: 5 * 60_000, ffprobe: 30_000, ffmpeg: 30 * 60_000 } as const;

type CommandResult = { stdout: string; stderr: string };
type CommandStream = 'stdout' | 'stderr';
type CommandOutput = (stream: CommandStream, chunk: string) => void;

const runCommand = (
    command: string,
    args: readonly string[],
    label: string,
    timeoutMs: number,
    onOutput?: CommandOutput,
    cwd?: string
): Promise<CommandResult> =>
    new Promise((resolveResult, rejectResult) => {
        const child = spawn(command, [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');

        let stdout = '';
        let stderr = '';
        let outputBytes = 0;
        let failure: Error | undefined;
        let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
        const maxOutputBytes = 10 * 1024 * 1024;

        const stop = (reason: Error): void => {
            if (failure !== undefined) return;
            failure = reason;
            child.kill('SIGTERM');
            // A descendant can keep stdio open after the direct child dies. Do not wait forever for close.
            forceKillTimer = setTimeout(() => {
                child.kill('SIGKILL');
                rejectResult(new Error(`${label} の実行に失敗しました: ${errorMessage(reason)}`, { cause: reason }));
            }, 5_000);
            forceKillTimer.unref();
        };

        const receive = (stream: CommandStream, chunk: string): void => {
            if (failure !== undefined) return;
            const chunkBytes = Buffer.byteLength(chunk);
            if (outputBytes + chunkBytes > maxOutputBytes) {
                stop(new Error(`${label} の出力が上限を超えました`));
                return;
            }
            outputBytes += chunkBytes;
            if (stream === 'stdout') stdout += chunk;
            else stderr += chunk;
            try {
                // Expose chunks as they arrive; waiting for close would hide a stalled Marp process.
                onOutput?.(stream, chunk);
            } catch (reason) {
                stop(new Error(errorMessage(reason), { cause: reason }));
            }
        };
        child.stdout.on('data', (chunk: string) => receive('stdout', chunk));
        child.stderr.on('data', (chunk: string) => receive('stderr', chunk));
        child.on('error', reason => {
            failure = reason;
        });

        const timeoutTimer = setTimeout(() => {
            stop(new Error(`${label} が ${timeoutMs} ms でタイムアウトしました`));
        }, timeoutMs);

        child.on('close', (code, signal) => {
            clearTimeout(timeoutTimer);
            if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
            if (failure !== undefined) {
                rejectResult(new Error(`${label} の実行に失敗しました: ${errorMessage(failure)}`, { cause: failure }));
                return;
            }
            if (code !== 0) {
                const detail = stderr.trim() || stdout.trim();
                rejectResult(
                    new Error(`${label} の実行に失敗しました (終了コード ${code ?? signal}): ${detail || '詳細なし'}`)
                );
                return;
            }
            resolveResult({ stdout, stderr });
        });
    });

const errorMessage = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

const endpoint = (baseUrl: string, path: string, params?: Record<string, string>): URL => {
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('VOICEVOX URL は http または https で指定してください');
    }
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/${path}`;
    url.search = '';
    for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
    return url;
};

const voicevoxRequest = async (url: URL, init?: RequestInit): Promise<Response> => {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
    if (!response.ok) {
        const detail = (await response.text()).slice(0, 1000);
        throw new Error(`VOICEVOX ${url.pathname}: HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    return response;
};

const asRecord = (value: unknown, label: string): Record<string, unknown> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`${label} の応答形式が不正です`);
    }
    return value as Record<string, unknown>;
};

const hasErrorCode = (reason: unknown, code: string): boolean =>
    typeof reason === 'object' && reason !== null && 'code' in reason && reason.code === code;

export type ExternalOperations = {
    createWorkspace: () => Promise<string>;
    removeWorkspace: (workspacePath: string) => Promise<void>;
    readText: (path: string) => Promise<string>;
    getSpeakerIds: (voicevoxUrl: string) => Promise<readonly number[]>;
    renderSlides: (request: RenderSlidesRequest) => Promise<readonly string[]>;
    synthesizeAudio: (request: SynthesizeAudioRequest) => Promise<string>;
    probeDuration: (audioPath: string) => Promise<number>;
    encodeVideo: (request: EncodeVideoRequest) => Promise<string>;
    listExistingPaths: (basePath: string) => Promise<readonly string[]>;
    publishVideo: (temporaryPath: string, outputPath: string) => Promise<void>;
};

export type ExternalOperationOptions = {
    onCommandOutput?: ((tool: string, stdout: string, stderr: string) => void) | undefined;
};

/** Real Node/Marp/VOICEVOX/FFmpeg operations to inject into the stage factories. */
export const createExternalOperations = (options: ExternalOperationOptions = {}): ExternalOperations => {
    // Only paths created by this instance may be cleaned up or published.
    const workspaces = new Set<string>();
    const temporaryVideos = new Set<string>();

    const runExternal = (
        command: string,
        args: readonly string[],
        label: string,
        timeoutMs: number,
        cwd?: string
    ): Promise<CommandResult> =>
        runCommand(
            command,
            args,
            label,
            timeoutMs,
            (stream, chunk) => {
                options.onCommandOutput?.(label, stream === 'stdout' ? chunk : '', stream === 'stderr' ? chunk : '');
            },
            cwd
        );

    const requireWorkspace = (path: string): void => {
        if (!workspaces.has(path)) throw new Error(`この実行で作成していない作業ディレクトリです: ${path}`);
    };

    const createWorkspace = async (): Promise<string> => {
        const path = await mkdtemp(join(tmpdir(), 'marp-video-'));
        try {
            await Promise.all(['slides', 'audio'].map(name => mkdir(join(path, name))));
        } catch (reason) {
            await rm(path, { recursive: true, force: true });
            throw reason;
        }
        workspaces.add(path);
        return path;
    };

    const removeWorkspace = async (workspacePath: string): Promise<void> => {
        requireWorkspace(workspacePath);
        await rm(workspacePath, { recursive: true });
        workspaces.delete(workspacePath);
    };

    const readText = (path: string): Promise<string> => readFile(path, 'utf8');

    const getSpeakerIds = async (voicevoxUrl: string): Promise<readonly number[]> => {
        const response = await voicevoxRequest(endpoint(voicevoxUrl, 'speakers'));
        const speakers: unknown = await response.json();
        if (!Array.isArray(speakers)) throw new Error('VOICEVOX /speakers の応答形式が不正です');
        const ids = speakers.flatMap((speaker: unknown) => {
            const styles = asRecord(speaker, 'VOICEVOX speaker').styles;
            if (!Array.isArray(styles)) throw new Error('VOICEVOX speaker.styles の応答形式が不正です');
            return styles.map((style: unknown) => {
                const id = asRecord(style, 'VOICEVOX style').id;
                if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) {
                    throw new Error('VOICEVOX style.id の応答形式が不正です');
                }
                return id;
            });
        });
        return [...new Set<number>(ids)];
    };

    const renderSlides = async (request: RenderSlidesRequest): Promise<readonly string[]> => {
        requireWorkspace(request.workspacePath);
        const slidesPath = resolve(request.slidesPath);
        const slidesDir = join(request.workspacePath, 'slides');
        // An explicit .png suffix keeps Marp's per-page names as slide.001.png, etc.
        const outputPath = join(slidesDir, 'slide.png');
        const args = [marpCliScript, slidesPath, '--images', 'png', '--output', outputPath];
        // Override a Marp config file too: local assets must be an explicit build choice.
        args.push(request.allowLocalFiles ? '--allow-local-files' : '--no-allow-local-files');
        const { stdout, stderr } = await runExternal(
            process.execPath,
            args,
            'Marp',
            commandTimeoutMs.marp,
            dirname(slidesPath)
        );
        // Marp may exit successfully even when it has blocked a local image.
        if (/detected accessing to local file|blocked by security reason/i.test(`${stdout}\n${stderr}`)) {
            throw new Error('Marp がローカル素材へのアクセスをブロックしました');
        }
        const names = (await readdir(slidesDir)).filter(name => /^slide\.\d+\.png$/.test(name));
        names.sort((a, b) => Number(a.match(/\.(\d+)\.png$/)![1]) - Number(b.match(/\.(\d+)\.png$/)![1]));
        if (names.length === 0) throw new Error('Marp がスライド画像を生成しませんでした');
        return names.map(name => join(slidesDir, name));
    };

    const synthesizeAudio = async (request: SynthesizeAudioRequest): Promise<string> => {
        requireWorkspace(request.workspacePath);
        const { narration, voicevoxUrl } = request;
        try {
            const params = { speaker: String(narration.speaker) };
            const queryUrl = endpoint(voicevoxUrl, 'audio_query', { ...params, text: narration.plainText });
            const query = asRecord(
                await (await voicevoxRequest(queryUrl, { method: 'POST' })).json(),
                'VOICEVOX audio_query'
            );
            for (const [key, value] of Object.entries(narration.queryOverrides)) {
                // Unsupported settings must fail instead of silently changing the requested narration.
                if (!Object.hasOwn(query, key)) throw new Error(`VOICEVOX が読み上げ設定 ${key} に対応していません`);
                query[key] = value;
            }
            const synthesisUrl = endpoint(voicevoxUrl, 'synthesis', params);
            const response = await voicevoxRequest(synthesisUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(query),
            });
            const audioPath = join(request.workspacePath, 'audio', `${String(narration.number).padStart(3, '0')}.wav`);
            await writeFile(audioPath, Buffer.from(await response.arrayBuffer()), { flag: 'wx' });
            return audioPath;
        } catch (reason) {
            throw new Error(`${narration.number}ページ目: ${errorMessage(reason)}`, { cause: reason });
        }
    };

    const probeDuration = async (audioPath: string): Promise<number> => {
        const page = Number(basename(audioPath, '.wav'));
        try {
            const { stdout } = await runExternal(
                'ffprobe',
                [
                    '-v',
                    options.onCommandOutput ? 'info' : 'error',
                    '-show_entries',
                    'format=duration',
                    '-of',
                    'default=noprint_wrappers=1:nokey=1',
                    audioPath,
                ],
                'FFprobe',
                commandTimeoutMs.ffprobe
            );
            const seconds = Number(stdout.trim());
            if (!Number.isFinite(seconds) || seconds < 0) throw new Error(`FFprobe の音声長が不正です: ${audioPath}`);
            return seconds;
        } catch (reason) {
            throw new Error(
                `${Number.isSafeInteger(page) && page > 0 ? `${page}ページ目: ` : ''}${errorMessage(reason)}`,
                {
                    cause: reason,
                }
            );
        }
    };

    const encodeVideo = async (request: EncodeVideoRequest): Promise<string> => {
        requireWorkspace(request.workspacePath);
        const { slideImages, audioPaths, timeline } = request;
        const count = timeline.pages.length;
        if (count === 0 || slideImages.length !== count || audioPaths.length !== count) {
            throw new Error('動画生成に使うスライド・音声・時間割のページ数が一致しません');
        }
        if (timeline.pages.some(page => !Number.isSafeInteger(page.frameCount) || page.frameCount <= 0)) {
            throw new Error('動画生成に使うフレーム数が不正です');
        }
        const outputDir = dirname(resolve(request.baseOutputPath));
        await mkdir(outputDir, { recursive: true });
        const temporaryPath = join(outputDir, `.${basename(request.baseOutputPath, '.mp4')}.${randomUUID()}.tmp.mp4`);
        const imageInputs = slideImages.flatMap((path, index) => [
            '-loop',
            '1',
            '-framerate',
            '30',
            '-t',
            String(timeline.pages[index]!.frameCount / 30),
            '-i',
            path,
        ]);
        const audioInputs = audioPaths.flatMap(path => ['-i', path]);
        const videoFilters = timeline.pages.map(
            (page, index) =>
                `[${index}:v]scale=1280:720:force_original_aspect_ratio=decrease,` +
                `pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p,` +
                `trim=end_frame=${page.frameCount},setpts=PTS-STARTPTS[v${index}]`
        );
        const audioFilters = timeline.pages.map(
            (page, index) =>
                `[${count + index}:a]aformat=sample_rates=48000:channel_layouts=stereo,` +
                `apad,atrim=duration=${page.frameCount / 30},asetpts=PTS-STARTPTS[a${index}]`
        );
        const videoConcat = `${timeline.pages.map((_, index) => `[v${index}]`).join('')}concat=n=${count}:v=1:a=0[v]`;
        const audioConcat = `${timeline.pages.map((_, index) => `[a${index}]`).join('')}concat=n=${count}:v=0:a=1[a]`;
        const filters = [...videoFilters, ...audioFilters, videoConcat, audioConcat].join(';');

        try {
            await runExternal(
                'ffmpeg',
                [
                    '-hide_banner',
                    '-loglevel',
                    options.onCommandOutput ? 'info' : 'error',
                    '-n',
                    ...imageInputs,
                    ...audioInputs,
                    '-filter_complex',
                    filters,
                    '-map',
                    '[v]',
                    '-map',
                    '[a]',
                    '-r',
                    '30',
                    '-c:v',
                    'libx264',
                    '-pix_fmt',
                    'yuv420p',
                    '-c:a',
                    'aac',
                    '-ar',
                    '48000',
                    '-ac',
                    '2',
                    '-movflags',
                    '+faststart',
                    temporaryPath,
                ],
                'FFmpeg',
                commandTimeoutMs.ffmpeg
            );
        } catch (reason) {
            await unlink(temporaryPath).catch((cleanupReason: unknown) => {
                if (!hasErrorCode(cleanupReason, 'ENOENT')) {
                    throw new AggregateError(
                        [reason, cleanupReason],
                        'FFmpeg の失敗後に一時動画を削除できませんでした'
                    );
                }
            });
            throw reason;
        }
        temporaryVideos.add(temporaryPath);
        return temporaryPath;
    };

    const listExistingPaths = async (basePath: string): Promise<readonly string[]> => {
        const directory = dirname(basePath);
        const prefix = basePath.slice(0, basePath.length - basename(basePath).length);
        try {
            return (await readdir(directory)).map(name => `${prefix}${name}`);
        } catch (reason) {
            if (hasErrorCode(reason, 'ENOENT')) return [];
            throw reason;
        }
    };

    const publishVideo = async (temporaryPath: string, outputPath: string): Promise<void> => {
        if (!temporaryVideos.has(temporaryPath)) throw new Error('この実行で生成していない一時動画です');
        // Hard-linking exposes only a complete file and fails with EEXIST instead of overwriting.
        await link(temporaryPath, outputPath);
        await unlink(temporaryPath);
        temporaryVideos.delete(temporaryPath);
    };

    return {
        createWorkspace,
        removeWorkspace,
        readText,
        getSpeakerIds,
        renderSlides,
        synthesizeAudio,
        probeDuration,
        encodeVideo,
        listExistingPaths,
        publishVideo,
    };
};
