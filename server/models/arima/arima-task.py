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

# Reason we do this is that model itself doesn't deal with timestamps, only a
# series of data. ModelWrapper adds this handling of timestamps
class ModelWrapper:
    def __init__(self, trained_model: ar.ArimaPredictor, delta):
        self.trained_model = trained_model
        self.delta = delta

    def predict(self, count: int):
        delta = self.delta.copy()
        timestamps = [delta.read() for _ in range(count)]
        predictions = self.trained_model.predict(count)
        return timestamps, predictions

    def append_predict(self, observations):  # TODO: Maybe I need timestamps here?
        delta = self.delta.copy()
        timestamps = [delta.read() for _ in observations]
        predictions = self.trained_model.append_predict(observations)
        self.delta.set_latest(timestamps[-1]) # TODO: Only usable when passed timestamps
        return timestamps, predictions

def get_source_index_name(params):
    return ivis.entities['signalSets'][params['sigSet']]['index']

def get_source_index_field_name(params, field_name):
    return ivis.entities['signals'][params['sigSet']][field_name]['field']

def create_data_reader(params):
    # TODO: Temporary
    index_name = get_source_index_name(params)
    ts_field = get_source_index_field_name(params, 'ts')
    value_field = get_source_index_field_name(params, 'value')

    if True:
        reader = ts.TsReader(index_name, ts_field, value_field)
    else:
        # ex.
        reader = ts.TsAggReader(index_name, ts_field, value_field, '1M')

    return reader

def train_model(params) -> ModelWrapper:
    train_percentage = 0.75
    autoarima = True
    # parse params

    # create readers and writers
    reader = create_data_reader(params)

    # load training data
    timestamps, values = reader.read()

    # split into training and the first batch of validation
    ts_train, _ = pmd.model_selection.train_test_split(
        timestamps, train_size=train_percentage)
    val_train, val_test = pmd.model_selection.train_test_split(
        values, train_size=train_percentage)

    # note that we don't use timestamps of the test data - we will rather try
    # to guess these timestamps the same way we will have to when actually
    # predicting the future values

    # train model
    if autoarima:
        model = pmd.auto_arima(val_train)
    else:
        model = pmd.ARIMA((5, 0, 0))
        model.fit(val_train)

    # convert to custom predictor if possible - TODO: Maybe raise except?
    model = ar.ArimaPredictor(model, val_train)
    # TODO: TsDeltaLogical instead if working with aggregation
    delta = ts.estimate_delta(ts_train)

    wrapped_model = ModelWrapper(model, delta)

    # Add test data into the model and predict one-ahead at the same time
    process_new_observations(wrapped_model, val_test)

    return wrapped_model

def process_new_observations(wrapped_model, observations):
    print(observations)

def store_model(wrapped_model):  # TODO: Storing into files might be better
    new_state = {wrapped_model}
    f = io.BytesIO()
    joblib.dump(new_state, f, compress=('xz', 6))
    b = base64.b64encode(f.getvalue()).decode('ascii')
    ivis.store_state(b)

def load_model(state):
    old_state = state
    old_state = base64.b64decode(old_state)
    f = io.BytesIO(old_state)
    old_state = joblib.load(f)
    print(old_state)

def main():
    es = ivis.elasticsearch
    state = ivis.state
    params = ivis.params
    entities = ivis.entities

    # Parse params, decide what to do
    if state is None: # job is running for a first time
        # train new model
        model = train_model(params)
        store_model(model)
    else:
        # load existing model
        load_model(state)

if __name__ == "__main__":
    main()
