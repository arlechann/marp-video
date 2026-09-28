import { dirname, join, resolve } from 'node:path';

import { buildVideo, type BuildOptions } from './build.ts';
import { defaultGapMs, defaultTailMs } from './domain.ts';
import { createExternalOperations, type ExternalOperations } from './external-operations.ts';

export const usage = [
    'Usage: marp-video build slides.md script.md [options]',
    '',
    'Options:',
    '  --output PATH           出力MP4の基準名（既定: slides.md の隣の build/video.mp4）',
    '  --voicevox-url URL      VOICEVOX ENGINE のURL（既定: http://127.0.0.1:50021）',
    `  --gap-ms N              スライド間の余白（既定: ${defaultGapMs}）`,
    `  --tail-ms N             最終スライドの余白（既定: ${defaultTailMs}）`,
    '  --allow-local-files     Marp にローカル素材の読み込みを許可',
    '  --keep-intermediates    中間成果物を保持',
    '  --verbose               外部ツールのログを表示',
    '  --help                  このヘルプを表示',
].join('\n');

export type CliBuildCommand = { kind: 'build'; options: BuildOptions; verbose: boolean };
export type CliCommand = { kind: 'help' } | CliBuildCommand;

const parseMilliseconds = (value: string, name: string): number => {
    if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error(`${name} は0以上の整数で指定してください`);
    }
    return Number(value);
};

export const parseCliArgs = (argv: readonly string[], cwd: string, now: Date): CliCommand => {
    if (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') return { kind: 'help' };
    if (argv[0] !== 'build') throw new Error(`build コマンドを指定してください\n${usage}`);

    const positionals: string[] = [];
    let output: string | undefined;
    let voicevoxUrl = 'http://127.0.0.1:50021';
    let gapMs = defaultGapMs;
    let tailMs = defaultTailMs;
    let allowLocalFiles = false;
    let keepIntermediates = false;
    let verbose = false;

    for (let index = 1; index < argv.length; index++) {
        const arg = argv[index]!;
        if (arg === '--help' || arg === '-h') return { kind: 'help' };
        if (arg === '--allow-local-files') {
            allowLocalFiles = true;
            continue;
        }
        if (arg === '--keep-intermediates') {
            keepIntermediates = true;
            continue;
        }
        if (arg === '--verbose') {
            verbose = true;
            continue;
        }

        const equal = arg.indexOf('=');
        const name = equal >= 0 ? arg.slice(0, equal) : arg;
        if (['--output', '--voicevox-url', '--gap-ms', '--tail-ms'].includes(name)) {
            const value = equal >= 0 ? arg.slice(equal + 1) : argv[++index];
            if (!value || value.startsWith('--')) throw new Error(`${name} の値が必要です`);
            if (name === '--output') output = value;
            if (name === '--voicevox-url') voicevoxUrl = value;
            if (name === '--gap-ms') gapMs = parseMilliseconds(value, name);
            if (name === '--tail-ms') tailMs = parseMilliseconds(value, name);
            continue;
        }
        if (arg.startsWith('-')) throw new Error(`不明なオプションです: ${arg}`);
        positionals.push(arg);
    }
    if (positionals.length !== 2) throw new Error('スライドと台本の2ファイルを指定してください');
    const url = new URL(voicevoxUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
        throw new Error('--voicevox-url は http または https で指定してください');
    const slidesPath = resolve(cwd, positionals[0]!);
    const scriptPath = resolve(cwd, positionals[1]!);
    const baseOutputPath =
        output === undefined ? join(dirname(slidesPath), 'build', 'video.mp4') : resolve(cwd, output);
    if (!baseOutputPath.endsWith('.mp4')) throw new Error('--output は .mp4 ファイル名で指定してください');

    return {
        kind: 'build',
        verbose,
        options: {
            slidesPath,
            scriptPath,
            baseOutputPath,
            voicevoxUrl,
            gapMs,
            tailMs,
            allowLocalFiles,
            keepIntermediates,
            localTime: {
                year: now.getFullYear(),
                month: now.getMonth() + 1,
                day: now.getDate(),
                hour: now.getHours(),
                minute: now.getMinutes(),
                second: now.getSeconds(),
                millisecond: now.getMilliseconds(),
            },
        },
    };
};

export type CliDependencies = {
    cwd?: string;
    now?: () => Date;
    operations?: ExternalOperations;
    writeStdout?: (text: string) => void;
    writeStderr?: (text: string) => void;
};

export const runCli = async (argv: readonly string[], dependencies: CliDependencies = {}): Promise<number> => {
    const writeStdout = dependencies.writeStdout ?? (text => process.stdout.write(text));
    const writeStderr = dependencies.writeStderr ?? (text => process.stderr.write(text));
    try {
        const command = parseCliArgs(
            argv,
            dependencies.cwd ?? process.cwd(),
            (dependencies.now ?? (() => new Date()))()
        );
        if (command.kind === 'help') {
            writeStdout(`${usage}\n`);
            return 0;
        }
        const operations =
            dependencies.operations ??
            createExternalOperations({
                onCommandOutput: command.verbose
                    ? (tool, stdout, stderr) => {
                          if (stdout) writeStderr(`[${tool}] ${stdout}`);
                          if (stderr) writeStderr(`[${tool}] ${stderr}`);
                      }
                    : undefined,
            });
        const result = await buildVideo(command.options, operations, phase => writeStderr(`[${phase}]\n`));
        writeStdout(`${result.outputPath}\n`);
        return 0;
    } catch (reason) {
        writeStderr(`エラー: ${reason instanceof Error ? reason.message : String(reason)}\n`);
        return 1;
    }
};
