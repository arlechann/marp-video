export { execPipeline } from './pipeline.ts';
export type { Next, PipelineStep, ReportError } from './pipeline.ts';
export { asConverter } from './converter.ts';
export {
    makeWithWorkspace,
    makeLoadScript,
    makeCheckVoicevox,
    makeRenderSlides,
    makeSynthesizeAudio,
    makeProbeAudio,
    makeEncodeVideo,
    makeSelectOutputPath,
    makePublishVideo,
} from './external-stages.ts';
export type { RenderSlidesRequest, SynthesizeAudioRequest, EncodeVideoRequest } from './external-stages.ts';
export { createExternalOperations } from './external-operations.ts';
export type { ExternalOperations, ExternalOperationOptions } from './external-operations.ts';
export { markdownToPlainText } from './plain-text.ts';
export { buildVideo } from './build.ts';
export type { BuildOptions, BuildResult } from './build.ts';
export { parseCliArgs, runCli, usage } from './cli.ts';
export type { CliCommand, CliBuildCommand, CliDependencies } from './cli.ts';
export {
    parseScriptFrontMatter,
    parseScriptPages,
    parseScript,
    resolveNarrationPages,
    attachPlainTexts,
    planTimeline,
    chooseOutputPath,
} from './domain.ts';
export type {
    VoicevoxSettings,
    ScriptPage,
    ScriptVoicevox,
    ParsedScriptFrontMatter,
    ParsedScript,
    NarrationPage,
    LocalTimestamp,
} from './domain.ts';
