#!/usr/bin/env python3

from ivis import ivis
import ivis.ts as ts
import ivis.ts.arima as ar
import elasticsearch as es
import pmdarima as pmd
import pendulum
import joblib
import io
import base64
import logging


class ModelWrapper:
    """Wraps around our ARIMA model and adds handling of timestamps."""

    def __init__(self, trained_model: ar.ArimaPredictor, delta):
        self.trained_model = trained_model
        self.delta = delta

    def predict(self, count: int):
        delta = self.delta.copy()
        timestamps = [delta.read() for _ in range(count)]
        predictions = self.trained_model.predict(count)
        return timestamps, predictions

    def append1(self, timestamp, observation):
        """Add a single new observation."""

        if isinstance(timestamp, str):
            timestamp = ts._string2date(timestamp)

        # check whether the new timestamp is approximately at the expected
        # datetime, e.g. that there was not a skipped observation
        diff = (timestamp - self.delta.last_ts) / self.delta.delta_time

        if diff > 1.5:
            # there are some skipped values, since we already have a trained
            # model, we can try to fill it with its own prediction

            # ideally, this should not happen, data should be regular or
            # preprocessed

            while True:
                diff = (timestamp - self.delta.last_ts) / self.delta.delta_time
                expected = self.delta.copy().read()
                if diff <= 1.5:
                    break
                logging.warning(
                f"Missing observation, expected {expected}, got {timestamp} instead.")

                prediction = self.trained_model.predict(1)[0]
                self.trained_model.append([prediction])
                self.delta.set_latest(expected)

        self.trained_model.append([observation])

        # We will now update timestamp estimator with real observation's
        # timestamp. This should help the real sensors and the model stay in
        # sync. Otherwise, even small timestamp errors would accumulate given
        # enough time.
        self.delta.set_latest(timestamp)

    def append_predict(self, timestamps, observations):
        pred_ts = []
        pred_values = []
        for t, o in zip(timestamps, observations):
            self.append1(t, o)
            timestamp, prediction = self.predict(1)

            # append new observation to the model
            pred_ts.append(timestamp[0])
            # create a new one-ahead prediction
            pred_values.append(prediction[0])

        return pred_ts, pred_values


def get_source_index_name(params):
    return ivis.entities['signalSets'][params['sigSet']]['index']


def get_source_index_field_name(params, field_name):
    return ivis.entities['signals'][params['sigSet']][field_name]['field']


def get_min_training_ts(params) -> str:
    """Return the first timestamp that will be used by the model. This can be
    used to ignore data that is too old so that the model ignores it altogether"""
    return ''


def get_max_training_ts(params) -> str:
    """Return the first timestamp that should not be used as training data and
    validation data during the first run. This is needed when working with large
    signal set that may not fit into the memory."""
    return ''  # TODO: From params


def get_training_portion(params) -> float:
    """Return what portion of the first batch is used for training the model."""
    return 0.75  # TODO


def get_is_autoarima(params) -> bool:
    return True


def get_arima_order(params):
    """ARIMA order, e.g. (5,0,1). Only applicable when not using autoarima."""
    return (5, 0, 1)


def get_is_aggregated(params) -> bool:
    if 'resampling' in params and params['resampling']:
        return True
    else:
        return False


def get_aggregation_interval(params) -> str:
    return params['resampling_interval']


def create_data_reader(params):
    # Creates two readers, one for the first batch of data (training and
    # validation) that will be read at once. The other for all remaining and
    # future data
    index_name = get_source_index_name(params)
    ts_field = get_source_index_field_name(params, 'ts')
    value_field = get_source_index_field_name(params, 'value')

    # first ts that is not potentially part of the training data
    split_ts = get_max_training_ts(params)

    if not get_is_aggregated(params):
        reader = ts.TsReader(index_name, ts_field,
                             value_field, to_ts=split_ts)
    else:
        # ex.
        interval = get_aggregation_interval(params)
        reader = ts.TsAggReader(index_name, ts_field,
                                value_field, interval, from_ts=split_ts)

    return reader


def train_model(params) -> ModelWrapper:
    train_percentage = get_training_portion(params)
    autoarima = get_is_autoarima(params)

    # create readers and writers
    reader_train = create_data_reader(params)

    # load training data
    timestamps, values = reader_train.read()

    # convert signal values from str to float
    values = list(map(float, values))

    # split into training and the first batch of validation
    ts_train, ts_test = pmd.model_selection.train_test_split(
        timestamps, train_size=train_percentage)
    val_train, val_test = pmd.model_selection.train_test_split(
        values, train_size=train_percentage)

    # note that we don't use timestamps of the test data - we will rather try
    # to guess these timestamps the same way we will have to when actually
    # predicting the future values

    logging.info(f"Training model on dataset of size {len(val_train)}")
    logging.info(f"Validating model on dataset of size {len(val_test)}")

    # train model
    if autoarima:
        model = pmd.auto_arima(val_train)
    else:
        order = get_arima_order(params)
        model = pmd.ARIMA(order)
        model.fit(val_train)

    # convert to custom predictor if possible - TODO: Maybe raise except?
    model = ar.ArimaPredictor(model, val_train)
    # TODO: TsDeltaLogical instead if working with aggregation
    delta = ts.estimate_delta(ts_train)

    wrapped_model = ModelWrapper(model, delta)

    # Add test data into the model and predict one-ahead at the same time
    process_new_observations(wrapped_model, ts_test, val_test)

    # Remove the boundary from the reader and reuse it to read the following
    # values
    reader_future = reader_train
    reader_future.to_ts = ''

    return wrapped_model, reader_future


def process_new_observations(wrapped_model, timestamps, observations):
    logging.info(f"Processing {len(observations)} new observations.")

    predictions = wrapped_model.append_predict(timestamps, observations)
    return predictions


def store_model(wrapped_model, reader):  # TODO: Storing into files might be better
    new_state = {
        'wrapped_model': wrapped_model,
        'reader': reader
    }
    f = io.BytesIO()
    joblib.dump(new_state, f, compress=('xz', 6))
    b = base64.b64encode(f.getvalue()).decode('ascii')
    ivis.store_state(b)
    logging.info(f"Storing model, size: {len(b)/1024} KB.")


def load_model(state):
    old_state = base64.b64decode(state)
    f = io.BytesIO(old_state)
    old_state = joblib.load(f)
    print(old_state)

    return old_state['wrapped_model'], old_state['reader']


def main():
    es = ivis.elasticsearch
    state = ivis.state
    params = ivis.params
    entities = ivis.entities

    print(f"params: {params}")

    # Parse params, decide what to do
    if state is None:  # job is running for a first time
        # train new model
        model, reader = train_model(params)
        store_model(model, reader)
    else:
        # load existing model
        model, reader = load_model(state)

        # read new observations
        timestamps, values = reader.read()

        # TODO: I think I should update delta estimator using the
        # latest timestamp

        values = list(map(float, values))

        predictions = process_new_observations(model, timestamps, values)
        print(f"timestamps: {timestamps}")
        print(f"predictions: {predictions}")

        # store the updated model and reader
        store_model(model, reader)


if __name__ == "__main__":
    import sys
    logging.basicConfig(stream=sys.stdout, level=logging.INFO)
    main()
