import { asConverter } from './converter.ts';
import {
    attachPlainTexts,
    parseScript,
    planTimeline,
    resolveNarrationPages,
    type LocalTimestamp,
    type NarrationPage,
    type ParsedScript,
} from './domain.ts';
import type { ExternalOperations } from './external-operations.ts';
import {
    makeCheckVoicevox,
    makeEncodeVideo,
    makeLoadScript,
    makeProbeAudio,
    makePublishVideo,
    makeRenderSlides,
    makeSelectOutputPath,
    makeSynthesizeAudio,
    makeWithWorkspace,
} from './external-stages.ts';
import { execPipeline, type PipelineStep } from './pipeline.ts';
import { markdownToPlainText } from './plain-text.ts';

export type BuildOptions = {
    slidesPath: string;
    scriptPath: string;
    baseOutputPath: string;
    voicevoxUrl: string;
    gapMs: number;
    tailMs: number;
    allowLocalFiles: boolean;
    keepIntermediates: boolean;
    localTime: LocalTimestamp;
};

export type BuildResult = { outputPath: string; workspacePath: string };

type WorkspaceState = BuildOptions & { workspacePath: string };
type ScriptState = WorkspaceState & { scriptContent: string };
type ParsedState = ScriptState & { script: ParsedScript };
type SpeakerState = ParsedState & { speakerIds: readonly number[] };
type SlideState = SpeakerState & { slideImages: readonly string[] };
type NarrationState = SlideState & { narrations: Array<NarrationPage & { plainText: string }> };
type AudioState = NarrationState & { audioPaths: readonly string[] };
type ProbedState = AudioState & { audioDurationsSeconds: readonly number[] };
type TimedState = ProbedState & { timeline: ReturnType<typeof planTimeline> };
type EncodedState = TimedState & { temporaryVideoPath: string };
type SelectedState = EncodedState & { outputPath: string };
type PublishedState = SelectedState & { finalVideoPath: string };

export const buildVideo = async (
    options: BuildOptions,
    operations: ExternalOperations,
    onProgress?: (phase: string) => void
): Promise<BuildResult> => {
    let phase = '準備';
    let result: BuildResult | undefined;
    const mark =
        <Input>(name: string): PipelineStep<Input, Input> =>
        (input, next) => {
            phase = name;
            onProgress?.(name);
            return next(input);
        };

    const pipeline = [
        mark<BuildOptions>('作業領域の準備'),
        makeWithWorkspace<BuildOptions>(async () => {
            const workspacePath = await operations.createWorkspace();
            if (options.keepIntermediates) onProgress?.(`中間成果物: ${workspacePath}`);
            return workspacePath;
        }, operations.removeWorkspace),
        mark<WorkspaceState>('台本の読み込み'),
        makeLoadScript<WorkspaceState>(operations.readText),
        mark<ScriptState>('台本の解析'),
        asConverter((state: ScriptState): ParsedState => ({ ...state, script: parseScript(state.scriptContent) })),
        mark<ParsedState>('VOICEVOXの確認'),
        makeCheckVoicevox<ParsedState>(operations.getSpeakerIds),
        // Check the script's speakers before starting browser rendering or synthesis.
        asConverter((state: SpeakerState) => {
            resolveNarrationPages({
                script: state.script,
                slideCount: state.script.pages.length,
                speakerIds: state.speakerIds,
            });
            return state;
        }),
        mark<SpeakerState>('スライド画像の生成'),
        makeRenderSlides<SpeakerState>(operations.renderSlides),
        mark<SlideState>('ページ数と読み上げテキストの確認'),
        asConverter((state: SlideState): NarrationState => {
            const pages = resolveNarrationPages({
                script: state.script,
                slideCount: state.slideImages.length,
                speakerIds: state.speakerIds,
            });
            const texts = pages.map(page => markdownToPlainText(page.markdown, page.number));
            return { ...state, narrations: attachPlainTexts({ pages, texts }) };
        }),
        mark<NarrationState>('音声の生成'),
        makeSynthesizeAudio<NarrationState>(operations.synthesizeAudio),
        mark<AudioState>('音声長の取得'),
        makeProbeAudio<AudioState>(operations.probeDuration),
        mark<ProbedState>('時間割の計算'),
        asConverter((state: ProbedState): TimedState => ({
            ...state,
            timeline: planTimeline({
                audioDurationsSeconds: state.audioDurationsSeconds,
                gapMs: state.gapMs,
                tailMs: state.tailMs,
            }),
        })),
        mark<TimedState>('動画の生成'),
        makeEncodeVideo<TimedState>(operations.encodeVideo),
        mark<EncodedState>('出力名の決定'),
        makeSelectOutputPath<EncodedState>(operations.listExistingPaths),
        mark<SelectedState>('完成ファイルの配置'),
        makePublishVideo<SelectedState>(operations.publishVideo),
        (state: PublishedState) => {
            result = { outputPath: state.finalVideoPath, workspacePath: state.workspacePath };
        },
    ];

    try {
        await execPipeline(pipeline, options);
    } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        throw new Error(`${phase}: ${message}`, { cause: reason });
    }
    if (result === undefined) throw new Error(`${phase}: ビルド結果がありません`);
    return result;
};
