import { chooseOutputPath, type LocalTimestamp, type NarrationPage, type planTimeline } from './domain.ts';
import type { PipelineStep } from './pipeline.ts';

type Operation<Input, Output> = (input: Input) => Output | PromiseLike<Output>;
type Narration = NarrationPage & { plainText: string };
type Timeline = ReturnType<typeof planTimeline>;

// Keep callback/error protocol in one place; each exported factory below defines an actual build step.
const runOperation =
    <Input, Output>(operation: Operation<Input, Output>): PipelineStep<Input, Output> =>
    async (input, next, error) => {
        let output: Output;
        try {
            output = await operation(input);
        } catch (reason) {
            error(reason);
            return;
        }
        // A failure after next() belongs to a later stage, not to this operation.
        await next(output);
    };

export const makeWithWorkspace =
    <Input extends { keepIntermediates?: boolean }>(
        createWorkspace: () => Promise<string>,
        removeWorkspace: (workspacePath: string) => Promise<void>
    ): PipelineStep<Input, Input & { workspacePath: string }> =>
    async (input, next, error) => {
        let workspacePath: string;
        try {
            workspacePath = await createWorkspace();
        } catch (reason) {
            error(reason);
            return;
        }

        let downstreamFailed = false;
        let downstreamFailure: unknown;
        try {
            await next({ ...input, workspacePath });
        } catch (reason) {
            downstreamFailed = true;
            downstreamFailure = reason;
        }

        let cleanupFailed = false;
        let cleanupFailure: unknown;
        if (!input.keepIntermediates) {
            try {
                await removeWorkspace(workspacePath);
            } catch (reason) {
                cleanupFailed = true;
                cleanupFailure = reason;
            }
        }

        // Preserve the build error if cleanup also fails; cleanup runs after the whole downstream chain.
        if (downstreamFailed) throw downstreamFailure;
        if (cleanupFailed) throw cleanupFailure;
    };

export const makeLoadScript = <Input extends { scriptPath: string }>(
    readText: (path: string) => Promise<string>
): PipelineStep<Input, Input & { scriptContent: string }> =>
    runOperation(async input => ({ ...input, scriptContent: await readText(input.scriptPath) }));

export const makeCheckVoicevox = <Input extends { voicevoxUrl: string }>(
    getSpeakerIds: (url: string) => Promise<readonly number[]>
): PipelineStep<Input, Input & { speakerIds: readonly number[] }> =>
    runOperation(async input => ({ ...input, speakerIds: await getSpeakerIds(input.voicevoxUrl) }));

export type RenderSlidesRequest = {
    slidesPath: string;
    workspacePath: string;
    allowLocalFiles: boolean;
};

export const makeRenderSlides = <
    Input extends { slidesPath: string; workspacePath: string; allowLocalFiles?: boolean },
>(
    renderSlides: (request: RenderSlidesRequest) => Promise<readonly string[]>
): PipelineStep<Input, Input & { slideImages: readonly string[] }> =>
    runOperation(async input => ({
        ...input,
        slideImages: await renderSlides({
            slidesPath: input.slidesPath,
            workspacePath: input.workspacePath,
            allowLocalFiles: input.allowLocalFiles ?? false,
        }),
    }));

export type SynthesizeAudioRequest = { narration: Narration; workspacePath: string; voicevoxUrl: string };

export const makeSynthesizeAudio = <
    Input extends { narrations: readonly Narration[]; workspacePath: string; voicevoxUrl: string },
>(
    synthesizeAudio: (request: SynthesizeAudioRequest) => Promise<string>
): PipelineStep<Input, Input & { audioPaths: readonly string[] }> =>
    runOperation(async input => {
        const audioPaths: string[] = [];
        // Keep synthesis sequential so page order and first-failure behavior are deterministic.
        for (const narration of input.narrations) {
            audioPaths.push(
                await synthesizeAudio({ narration, workspacePath: input.workspacePath, voicevoxUrl: input.voicevoxUrl })
            );
        }
        return { ...input, audioPaths };
    });

export const makeProbeAudio = <Input extends { audioPaths: readonly string[] }>(
    probeDuration: (audioPath: string) => Promise<number>
): PipelineStep<Input, Input & { audioDurationsSeconds: readonly number[] }> =>
    runOperation(async input => ({
        ...input,
        audioDurationsSeconds: await Promise.all(input.audioPaths.map(probeDuration)),
    }));

export type EncodeVideoRequest = {
    slideImages: readonly string[];
    audioPaths: readonly string[];
    timeline: Timeline;
    workspacePath: string;
    baseOutputPath: string;
};

export const makeEncodeVideo = <Input extends EncodeVideoRequest>(
    encodeVideo: (request: EncodeVideoRequest) => Promise<string>
): PipelineStep<Input, Input & { temporaryVideoPath: string }> =>
    runOperation(async input => ({
        ...input,
        temporaryVideoPath: await encodeVideo({
            slideImages: input.slideImages,
            audioPaths: input.audioPaths,
            timeline: input.timeline,
            workspacePath: input.workspacePath,
            baseOutputPath: input.baseOutputPath,
        }),
    }));

export const makeSelectOutputPath = <Input extends { baseOutputPath: string; localTime: LocalTimestamp }>(
    listExistingPaths: (basePath: string) => Promise<readonly string[]>
): PipelineStep<Input, Input & { outputPath: string }> =>
    runOperation(async input => ({
        ...input,
        outputPath: chooseOutputPath({
            basePath: input.baseOutputPath,
            localTime: input.localTime,
            existingPaths: await listExistingPaths(input.baseOutputPath),
        }),
    }));

export const makePublishVideo = <Input extends { temporaryVideoPath: string; outputPath: string }>(
    // The injected implementation must place the file atomically without overwriting an existing video.
    publishVideo: (temporaryPath: string, outputPath: string) => Promise<void>
): PipelineStep<Input, Input & { finalVideoPath: string }> =>
    runOperation(async input => {
        await publishVideo(input.temporaryVideoPath, input.outputPath);
        return { ...input, finalVideoPath: input.outputPath };
    });
