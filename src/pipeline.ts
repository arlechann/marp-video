export type Next<Output> = (value: Output) => Promise<void>;
export type ReportError = (reason: unknown) => void;

export type PipelineStep<Input, Output> = (
  input: Input,
  next: Next<Output>,
  error: ReportError,
) => void | Promise<void>;

type AnyStep = PipelineStep<any, any>;

/**
 * Runs CPS stages in order. A stage may stop by calling neither continuation.
 * A stage may call next or error once, before its returned promise settles.
 */
export async function execPipeline(
  stages: readonly AnyStep[],
  initialInput?: unknown,
): Promise<void> {
  async function run(index: number, input: unknown): Promise<void> {
    const stage = stages[index] as AnyStep | undefined;
    if (stage === undefined) return;

    const state: { disposition: 'pending' | 'continued' | 'failed' } = {
      disposition: 'pending',
    };
    let stageSettled = false;
    let downstream: Promise<void> | undefined;
    let reportedFailure: unknown;

    const next: Next<unknown> = (value) => {
      if (stageSettled) {
        throw new Error('next must be called before the stage completes');
      }
      if (state.disposition === 'continued') {
        throw new Error('next may be called only once per stage');
      }
      if (state.disposition === 'failed') {
        throw new Error('next cannot be called after error');
      }

      state.disposition = 'continued';
      downstream = run(index + 1, value);
      // A stage may call next without awaiting it. Observe a rejection until
      // this runner can await the downstream promise after the stage settles.
      void downstream.catch(() => {});
      return downstream;
    };

    const error: ReportError = (reason) => {
      if (stageSettled) {
        throw new Error('error must be called before the stage completes');
      }
      if (state.disposition === 'continued') {
        throw new Error('error cannot be called after next');
      }
      if (state.disposition === 'failed') {
        throw new Error('error may be called only once per stage');
      }

      state.disposition = 'failed';
      reportedFailure = reason;
    };

    let thrown = false;
    let thrownFailure: unknown;
    try {
      await stage(input, next, error);
    } catch (reason) {
      thrown = true;
      thrownFailure = reason;
    } finally {
      stageSettled = true;
    }

    let failed = state.disposition === 'failed' || thrown;
    let failure = state.disposition === 'failed' ? reportedFailure : thrownFailure;
    if (downstream !== undefined) {
      try {
        await downstream;
      } catch (reason) {
        if (!failed) {
          failed = true;
          failure = reason;
        }
      }
    }

    if (failed) throw failure;
  }

  await run(0, initialInput);
}
