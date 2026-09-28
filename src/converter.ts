import type { PipelineStep } from './pipeline.ts';

/** Pure transformations remain independent from CPS; only this adapter knows both interfaces. */
export const asConverter =
    <Input, Output>(transform: (input: Input) => Output): PipelineStep<Input, Output> =>
    (input, next, error) => {
        let output: Output;
        try {
            output = transform(input);
        } catch (reason) {
            error(reason);
            return;
        }
        // Do not catch next(): a downstream rejection is not a domain error.
        return next(output);
    };
