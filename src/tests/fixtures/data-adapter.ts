import { Effect, Layer } from "effect";
import {
  DataAdapter,
  type DataNotAvailableError,
  type Field,
  type SourceNotAvailableError
} from "../../data-adapter/types.js";

export type DataValues = Readonly<Partial<Record<Field, number>>>;

export type DataAdapterFailure = DataNotAvailableError | SourceNotAvailableError;

export type DataAdapterResponse = DataValues | { readonly failure: DataAdapterFailure };

export type DataAdapterTest = {
  readonly layer: Layer.Layer<DataAdapter>;
  readonly respond: (response: DataAdapterResponse) => void;
};

const isFailure = (response: DataAdapterResponse): response is { readonly failure: DataAdapterFailure } =>
  "failure" in response;

/**
 * A script that omits a field the code under test reads fails the test instead
 * of silently answering 0.
 */
const pick = <F extends Field>(values: DataValues, fields: ReadonlyArray<F>): Record<Field, number> => {
  const picked: Record<string, number> = {};
  for (const field of fields) {
    const value = values[field];
    if (value === undefined) {
      throw new Error(`DataAdapter test script has no value for "${field}"`);
    }
    picked[field] = value;
  }
  return picked;
};

/**
 * Scripted `DataAdapter` seam: queued responses are consumed in call order and
 * the last response keeps repeating. Each test builds its own script, so no
 * response state is shared between tests.
 */
export const makeDataAdapterTest = (config: {
  readonly latestValues: ReadonlyArray<DataAdapterResponse>;
  readonly lowestValue?: number;
}): DataAdapterTest => {
  if (config.latestValues.length === 0) {
    throw new Error("makeDataAdapterTest requires at least one latest-values response");
  }

  let queue: Array<DataAdapterResponse> = [...config.latestValues];
  let last = queue[queue.length - 1];

  const nextResponse = (): DataAdapterResponse => {
    const next = queue.shift() ?? last;
    last = next;
    return next;
  };

  const queryLatestValues = <F extends Field>(fields: F[]): Effect.Effect<Record<F, number>, DataAdapterFailure> => {
    const response = nextResponse();
    return isFailure(response) ? Effect.fail(response.failure) : Effect.succeed(pick(response, fields));
  };

  return {
    layer: Layer.succeed(
      DataAdapter,
      DataAdapter.of({
        queryLatestValues,
        getLowestValueInLastXMinutes: () => Effect.succeed(config.lowestValue ?? 0)
      })
    ),
    respond: (response) => {
      queue = [];
      last = response;
    }
  };
};
