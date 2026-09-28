import MarkdownIt from 'markdown-it';
import { isMap, isScalar, parseDocument, type YAMLMap } from 'yaml';

// Keep CLI defaults and direct domain calls aligned.
export const defaultGapMs = 1_000;
export const defaultTailMs = 3_000;
const defaultPauseLengthScale = 1.5;

export type VoicevoxSettings = {
    speaker?: number;
    speedScale?: number;
    pitchScale?: number;
    intonationScale?: number;
    volumeScale?: number;
    prePhonemeLength?: number;
    postPhonemeLength?: number;
    pauseLength?: number | null;
    pauseLengthScale?: number;
};
export type ScriptPage = { number: number; markdown: string };
export type ScriptVoicevox = { common: VoicevoxSettings; pages: Record<number, VoicevoxSettings> };
export type ParsedScriptFrontMatter = { voicevox: ScriptVoicevox; body: string };
export type ParsedScript = { voicevox: ScriptVoicevox; pages: ScriptPage[] };

const rules: Record<string, (v: unknown) => boolean> = {
    speaker: v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0,
    speedScale: v => typeof v === 'number' && Number.isFinite(v) && v > 0,
    pitchScale: v => typeof v === 'number' && Number.isFinite(v),
    intonationScale: v => typeof v === 'number' && Number.isFinite(v),
    volumeScale: v => typeof v === 'number' && Number.isFinite(v) && v >= 0,
    prePhonemeLength: v => typeof v === 'number' && Number.isFinite(v) && v >= 0,
    postPhonemeLength: v => typeof v === 'number' && Number.isFinite(v) && v >= 0,
    pauseLength: v => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0),
    pauseLengthScale: v => typeof v === 'number' && Number.isFinite(v) && v >= 0,
};

const mapEntries = (map: YAMLMap, location: string): Array<[string, unknown]> =>
    map.items.map(({ key, value }) => {
        if (!isScalar(key) || typeof key.value !== 'string')
            throw new Error(`${location}: キーは文字列で指定してください`);
        return [key.value, value];
    });

const parseSettings = (map: unknown, location: string): VoicevoxSettings => {
    if (!isMap(map)) throw new Error(`${location}: 設定はマッピングで指定してください`);
    return Object.fromEntries(
        mapEntries(map, location).map(([key, node]) => {
            const value = isScalar(node) ? node.value : undefined;
            if (!Object.hasOwn(rules, key) || !rules[key]!(value))
                throw new Error(`${location}.${key}: 不正な読み上げ設定値です`);
            return [key, value];
        })
    );
};

const markdown = new MarkdownIt('commonmark');

export const parseScriptFrontMatter = (content: string): ParsedScriptFrontMatter => {
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    if (lines[0] !== '---') throw new Error('YAML Front Matter が必要です');
    const close = lines.indexOf('---', 1);
    if (close < 0) throw new Error('YAML Front Matter の終了行がありません');
    const document = parseDocument(lines.slice(1, close).join('\n'), { uniqueKeys: true });
    if (document.errors.length) {
        const issue = document.errors[0]!;
        throw new Error(`Front Matter: ${issue.code === 'DUPLICATE_KEY' ? '重複したキー: ' : ''}${issue.message}`);
    }
    if (!isMap(document.contents)) throw new Error('Front Matter はマッピングで指定してください');
    const top = mapEntries(document.contents, 'Front Matter');
    if (top.length !== 1 || top[0]![0] !== 'voicevox' || !isMap(top[0]![1]))
        throw new Error('Front Matter の最上位キーは voicevox のみ指定してください');
    const voicevoxEntries = mapEntries(top[0]![1] as YAMLMap, 'voicevox');
    const common = Object.fromEntries(
        voicevoxEntries
            .filter(([key]) => key !== 'pages')
            .map(([key, node]) => {
                if (!Object.hasOwn(rules, key)) throw new Error(`voicevox.${key}: 未知の設定です`);
                const value = isScalar(node) ? node.value : undefined;
                if (!rules[key]!(value)) throw new Error(`voicevox.${key}: 不正な読み上げ設定値です`);
                return [key, value];
            })
    ) as VoicevoxSettings;
    const pageNode = voicevoxEntries.find(([key]) => key === 'pages')?.[1];
    if (pageNode !== undefined && !isMap(pageNode)) throw new Error('voicevox.pages はマッピングで指定してください');
    const pages: Record<number, VoicevoxSettings> = Object.fromEntries(
        (isMap(pageNode) ? pageNode.items : []).map(({ key, value }) => {
            // YAML also accepts numeric map keys; quoting makes page identifiers unambiguous.
            if (
                !isScalar(key) ||
                typeof key.value !== 'string' ||
                !/^[1-9]\d*$/.test(key.value) ||
                !Number.isSafeInteger(Number(key.value)) ||
                !['QUOTE_DOUBLE', 'QUOTE_SINGLE'].includes(key.type ?? '')
            ) {
                throw new Error('voicevox.pages のページ番号は引用符付きの十進数文字列で指定してください');
            }
            return [Number(key.value), parseSettings(value, `voicevox.pages.${key.value}`)];
        })
    );
    // Keep the body as Markdown source; the next parser alone decides page boundaries.
    return { voicevox: { common, pages }, body: lines.slice(close + 1).join('\n') };
};

export const parseScriptPages = (body: string): ScriptPage[] => {
    const bodyLines = body.replace(/\r\n/g, '\n').split('\n');
    // Token ranges protect fenced and indented code without duplicating Markdown syntax rules.
    const protectedLines = new Set(
        markdown
            .parse(bodyLines.join('\n'), {})
            .flatMap(token =>
                (token.type === 'fence' || token.type === 'code_block') && token.map
                    ? Array.from({ length: token.map[1] - token.map[0] }, (_, index) => token.map![0] + index)
                    : []
            )
    );
    const boundaries = bodyLines.flatMap((line, index) => {
        if (line !== '---' || protectedLines.has(index)) return [];
        if (
            index === 0 ||
            bodyLines[index - 1]?.trim() !== '' ||
            index === bodyLines.length - 1 ||
            bodyLines[index + 1]?.trim() !== ''
        ) {
            throw new Error(`ページ境界 --- の前後には空行が必要です（本文 ${index + 1} 行目）`);
        }
        return [index];
    });
    const starts = [0, ...boundaries.map(index => index + 1)];
    const ends = [...boundaries, bodyLines.length];
    const chunks = starts.map((start, index) => bodyLines.slice(start, ends[index]).join('\n'));
    return chunks.map((chunk, index) => {
        if (!chunk.trim()) throw new Error(`${index + 1}ページ目は空ページです`);
        return { number: index + 1, markdown: chunk.trim() };
    });
};

export const parseScript = (content: string): ParsedScript => {
    const { voicevox, body } = parseScriptFrontMatter(content);
    return { voicevox, pages: parseScriptPages(body) };
};

export type NarrationPage = ScriptPage & { speaker: number; queryOverrides: Omit<VoicevoxSettings, 'speaker'> };

export const resolveNarrationPages = (input: {
    script: ParsedScript;
    slideCount: number;
    speakerIds: readonly number[];
}): NarrationPage[] => {
    const { script, slideCount, speakerIds } = input;
    if (!Number.isSafeInteger(slideCount) || slideCount < 1 || script.pages.length !== slideCount)
        throw new Error(`スライドと台本のページ数が一致しません: ${slideCount} / ${script.pages.length}`);
    Object.keys(script.voicevox.pages)
        .map(Number)
        .forEach(number => {
            if (number > script.pages.length) throw new Error(`${number}ページ目の設定に対応するページがありません`);
        });
    return script.pages.map(page => {
        // The app's pause default precedes script settings, so explicit common/page values win.
        const { speaker, ...queryOverrides } = {
            pauseLengthScale: defaultPauseLengthScale,
            ...script.voicevox.common,
            ...script.voicevox.pages[page.number],
        };
        if (typeof speaker !== 'number' || !speakerIds.includes(speaker))
            throw new Error(`${page.number}ページ目の speaker スタイルIDが利用できません: ${speaker}`);
        return { ...page, speaker, queryOverrides };
    });
};

export const attachPlainTexts = (input: {
    pages: readonly NarrationPage[];
    texts: readonly string[];
}): Array<NarrationPage & { plainText: string }> => {
    if (input.pages.length !== input.texts.length) throw new Error('ページ数と変換結果の数が一致しません');
    return input.pages.map((page, index) => {
        const plainText = input.texts[index]!;
        if (!plainText.trim()) throw new Error(`${page.number}ページ目の読み上げテキストが空です`);
        return { ...page, plainText };
    });
};

export const planTimeline = (input: {
    audioDurationsSeconds: readonly number[];
    gapMs?: number;
    tailMs?: number;
}): {
    pages: Array<{ number: number; startFrame: number; frameCount: number; silenceSeconds: number }>;
    totalFrames: number;
} => {
    const { audioDurationsSeconds, gapMs = defaultGapMs, tailMs = defaultTailMs } = input;
    if (!audioDurationsSeconds.length || ![gapMs, tailMs].every(v => Number.isSafeInteger(v) && v >= 0))
        throw new Error('時間割のページ数または余白時間が不正です');
    const frameCounts = audioDurationsSeconds.map((duration, index) => {
        if (!Number.isFinite(duration) || duration < 0) throw new Error(`${index + 1}ページ目の音声長が不正です`);
        const exactFrames = (duration + (index === audioDurationsSeconds.length - 1 ? tailMs : gapMs) / 1000) * 30;
        const nearestFrame = Math.round(exactFrames);
        // Float rounding can otherwise add one frame at an exact boundary.
        return Math.abs(exactFrames - nearestFrame) < 1e-9 ? nearestFrame : Math.ceil(exactFrames);
    });
    // Each page starts where the previous one ends; this value is inherently sequential.
    let startFrame = 0;
    const pages = frameCounts.map((frameCount, index) => {
        const page = {
            number: index + 1,
            startFrame,
            frameCount,
            silenceSeconds: frameCount / 30 - audioDurationsSeconds[index]!,
        };
        startFrame += frameCount;
        return page;
    });
    return { pages, totalFrames: startFrame };
};

export type LocalTimestamp = {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    millisecond: number;
};

export const chooseOutputPath = (input: {
    basePath: string;
    localTime: LocalTimestamp;
    existingPaths: readonly string[];
}): string => {
    const { basePath, localTime: t, existingPaths } = input;
    if (!basePath.endsWith('.mp4')) throw new Error('出力ファイル名は .mp4 で指定してください');
    if (
        ![t.year, t.month, t.day, t.hour, t.minute, t.second, t.millisecond].every(Number.isInteger) ||
        t.year < 0 ||
        t.year > 9999 ||
        t.month < 1 ||
        t.month > 12 ||
        t.day < 1 ||
        t.day > 31 ||
        t.hour < 0 ||
        t.hour > 23 ||
        t.minute < 0 ||
        t.minute > 59 ||
        t.second < 0 ||
        t.second > 59 ||
        t.millisecond < 0 ||
        t.millisecond > 999
    )
        throw new Error('ローカル時刻が不正です');
    const two = (v: number) => String(v).padStart(2, '0');
    const stamp = `${String(t.year).padStart(4, '0')}${two(t.month)}${two(t.day)}T${two(t.hour)}${two(t.minute)}${two(t.second)}${String(t.millisecond).padStart(3, '0')}`;
    const prefix = `${basePath.slice(0, -4)}-${stamp}`;
    const existing = new Set(existingPaths);
    // Among N occupied paths, at least one of the first N+1 candidates is free.
    return Array.from({ length: existing.size + 1 }, (_, index) =>
        index === 0 ? `${prefix}.mp4` : `${prefix}-${index + 1}.mp4`
    ).find(candidate => !existing.has(candidate))!;
};
