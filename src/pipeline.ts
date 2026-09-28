export type Next<Output> = (value: Output) => Promise<void>;
export type ReportError = (reason: unknown) => void;

export type PipelineStep<Input, Output> = (
    input: Input,
    next: Next<Output>,
    error: ReportError
) => void | Promise<void>;

// Heterogeneous stages cannot share one Input/Output type at this runtime boundary.
type AnyStep = PipelineStep<any, any>;

/**
 * Runs CPS stages in order. A stage may stop by calling neither continuation.
 * A stage may call next or error once, before its returned promise settles.
 */
export const execPipeline = async (stages: readonly AnyStep[], initialInput?: unknown): Promise<void> => {
    const run = async (index: number, input: unknown): Promise<void> => {
        const stage = stages[index] as AnyStep | undefined;
        if (stage === undefined) return;

        // These values change through CPS callbacks, so they are genuinely mutable.
        let disposition: 'pending' | 'continued' | 'failed' = 'pending';
        let stageSettled = false;
        let downstream: Promise<void> | undefined;
        let reportedFailure: unknown;

        const next: Next<unknown> = value => {
            if (stageSettled) {
                throw new Error('next must be called before the stage completes');
            }
            if (disposition === 'continued') {
                throw new Error('next may be called only once per stage');
            }
            if (disposition === 'failed') {
                throw new Error('next cannot be called after error');
            }

            disposition = 'continued';
            downstream = run(index + 1, value);
            // A stage may call next without awaiting it. Observe a rejection until
            // this runner can await the downstream promise after the stage settles.
            void downstream.catch(() => {});
            return downstream;
        };

        const error: ReportError = reason => {
            if (stageSettled) {
                throw new Error('error must be called before the stage completes');
            }
            if (disposition === 'continued') {
                throw new Error('error cannot be called after next');
            }
            if (disposition === 'failed') {
                throw new Error('error may be called only once per stage');
            }

            disposition = 'failed';
            reportedFailure = reason;
        };

        const stageOutcome = await (async () => {
            try {
                await stage(input, next, error);
                return { failed: false as const };
            } catch (reason) {
                return { failed: true as const, reason };
            } finally {
                stageSettled = true;
            }
        })();
        const downstreamOutcome =
            downstream === undefined
                ? { failed: false as const }
                : await downstream.then(
                      () => ({ failed: false as const }),
                      (reason: unknown) => ({ failed: true as const, reason })
                  );

        // TypeScript does not track assignments made by callbacks while stage() runs.
        const didReportError = (): boolean => disposition === 'failed';
        // Preserve the originating failure when both a stage and a later stage fail.
        if (didReportError()) throw reportedFailure;
        if (stageOutcome.failed) throw stageOutcome.reason;
        if (downstreamOutcome.failed) throw downstreamOutcome.reason;
    };

    await run(0, initialInput);
};
