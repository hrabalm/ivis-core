#!/usr/bin/env python3
import numpy as np
import pmdarima as pm
import pandas as pd
from pmdarima.model_selection import train_test_split
from sklearn.metrics import mean_squared_error
import datetime as dt
import dateutil as du
import joblib
import argparse

#esdateformat = "yyyy-MM-dd'T'HH:mm:ss:SS"  # TODO: Remove SS?
esdateformat = "yyyy-MM-dd'T'HH:mm:ss"
#pythondateformat = "%Y-%m-%dT%H:%M:%S:00"
pythondateformat = "%Y-%m-%dT%H:%M:%S"
esdateformat = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"
pythondateformat = "%Y-%m-%dT%H:%M:%S.000Z"

def str2datetime(s):
    return dt.datetime.strptime(s, pythondateformat)

def datetime2str(ts): # TODO
    return ""

deltas = {'M': None}

input_config = {
    'index_name': 'mhn-co2', # es index containing obervations
    'ts_name': 'ts',
    'value_name': 'value',
    'aggregation': True,
    'sample_interval': '1M',
    'agg_method': 'avg',  # alternatives: max, min, sum, etc
    'start_ts': '',
    # 'end_ts': '', # TODO: might be useless?
    'train_portion': 0.75,
    'auto': True,
    'seasonal': True,
    'm': 12, # seasonal_m
    'max_p': 5,
    'max_d': 2,
    'max_q': 5,
    # if not None, differencing test will be skipped and these will be used
    'd': None,
    'D': None,
    # custom model, relevant if auto = False
    'p': 0,
    'q': 2,
    'P': 2,
    'Q': 2,

    'model_uniq_name': '',
    'oneahead_name': '',
    'mprediction_name': '',
}

arima_params = ['seasonal', 'm', 'p', 'q', 'P', 'Q']
autoarima_params = ['seasonal', 'm', 'max_p', 'max_d', 'max_q']
global_params = {'error_action': 'ignore', 'maxiter': 50, 'trace': True}



def linear_interp(data):  # interpolation of empty buckets
    # there should be no empty buckets on both sides
    for i in range(len(data)):
        if data[i] == None:  # empty bucket
            # find first non empty bucket
            j = -1
            for k in range(i+1, len(data)):
                if data[k] != None:
                    j = k
                    break
            # interpolate values between i (inc.) and j (exc.)
            left = data[i-1]
            right = data[j]
            step = (right-left)/(j-i+1)

            for m in range(i, j):
                data[m] = data[m-1]+step


def read_ts(es, index_name, ts_name, value_name, start_ts='', aggregation=False, sample_interval='1M', agg_method='avg'):
    if not aggregation:
        return read_ts_directly(es, index_name, ts_name, value_name, start_ts)
    else:
        return read_ts_resampled2(es, index_name, ts_name, value_name, start_ts, aggregation, sample_interval, agg_method)


def read_ts_directly(es, index_name, ts_name, value_name, start_ts=''):
    query = {
        # 'size': 10000,
        'query': {'match_all': {}},
        'sort': {ts_name: 'asc'}
    }

    if start_ts != '':
        query['query'] = {}  # we don't want to match_all after all
        query['query']['range'] = {ts_name: {'gte': start_ts}}

    #es = Elasticsearch()
    # elasticsearch6-py might have a bug: skipped shards are counted as unsuccessful - fixed in 7+?
    results = eshelp.scan(es, query, index=index_name,
                          preserve_order=True, size=10000, raise_on_error=True)
    # https://github.com/elastic/elasticsearch-py/commit/fc78c992ef6ceca157f369186760c8c550fb3bc4
    # https://discuss.elastic.co/t/elasticsearch-dsl-python-scanerror/201980

    # TODO: Use arrays instead of lists
    rs = [(x['_source'][ts_name], x['_source'][value_name])
          for x in results]
    ts = [x[0] for x in rs]
    vs = [x[1] for x in rs]
    return (ts, vs)


# doesn't handle 'large aggregations'
def read_ts_resampled(es, index_name, ts_name, value_name, start_ts='', aggregation=False, sample_interval='1M', agg_method='avg'):
    query = {}
    query['size'] = 0  # we only want agg. results
    query['aggs'] = {
        "by_month": {
            "date_histogram": {
                "field": ts_name,
                "interval": sample_interval,
                "format": esdateformat,
                # "min_doc_count": 1, # don't return empty buckets
            },
            "aggs": {
                "m_avg": {
                    agg_method: {
                        "field": "value"
                    }
                }
            }
        }
    }

    results = es.search(index=index_name, body=query)
    vs = [x['m_avg'][value_name]
          for x in [x for x in results['aggregations']['by_month']['buckets']]]
    ts = [x['key_as_string']
          for x in [x for x in results['aggregations']['by_month']['buckets']]]
    linear_interp(vs)
    return (ts, vs)


def get_first_ts(es, index_name, ts_name, start_ts=''):
    query = {'size': 1,
             'sort': {ts_name: 'asc'}}  # we only need the first record
    if start_ts == '':
        query['query'] = {'match_all': {}}
    else:
        query['query']['range'] = {ts_name: {'gte': start_ts}}
    results = es.search(index=index_name, body=query)

    return results['hits']['hits'][0]['_source'][ts_name]


def estimate_end_ts(first_ts, interval, buckets_count):
    """Estimate end date, such that if you split data between start_ts and end_ts
    with given interval, you get at least (and not significantly more than)
    buckets_count buckets.

    Warning: This is only approximate estimation and end_ts doesn't coincide with a respective
    bucket end! Last bucket should therefore be ignored."""
    start_date = dt.datetime.strptime(first_ts, pythondateformat)


    markers = {
        'y': dt.timedelta(days=365),
        'q': dt.timedelta(days=93),
        'M': dt.timedelta(days=31),
        'w': dt.timedelta(days=8),
        'd': dt.timedelta(hours=26),
        'h': dt.timedelta(minutes=61),
        'm': dt.timedelta(minutes=1),
        's': dt.timedelta(seconds=1),
    }

    num = ''
    mark = ''

    for s in interval:
        if s.isdigit():
            num += s
        else:
            mark += s

    num = int(num)
    delta = markers[mark]

    return start_date+num*buckets_count*delta


def read_ts_test(es, index_name, ts_name, value_name, start_ts, sample_interval, agg_method, buckets_count):

    approx_end_ts = estimate_end_ts(start_ts, sample_interval, buckets_count)
    query = {
        "query": {"range": {ts_name: {"gte": start_ts, "lt": approx_end_ts}}},
        "size": 0,  # we aren't interested in records themselves
        "aggs": {
            "by_sample": {
                "date_histogram": {
                    "field": ts_name,
                    "interval": sample_interval,
                    "format": esdateformat,
                },
                "aggs": {
                    "resampled": {
                        agg_method: {
                            "field": value_name
                        }
                    }
                }
            }
        }
    }

    vs = []
    ts = []

    results = es.search(index=index_name, body=query)

    vs = [x['resampled']['value']#[value_name]
          for x in [x for x in results['aggregations']['by_sample']['buckets']]]
    ts = [x['key_as_string']
          for x in [x for x in results['aggregations']['by_sample']['buckets']]]

    return (vs, ts)

def read_ts_resampled2(es, index_name, ts_name, value_name, start_ts='', aggregation=False, sample_interval='1M', agg_method='avg'):
    buckets = 100  # approximate count of buckets to get in one request
    first_ts = get_first_ts(es, index_name, ts_name, start_ts)

    vs = []
    ts = []

    while True:
        nvs, nts = read_ts_test(es, index_name, ts_name, value_name, first_ts, sample_interval, agg_method, buckets)
        if (len(nts) > 1):
            first_ts = nts[-1] # we overlap the last bucket with a new one to fix alignment issues
            nvs.pop()
            nts.pop()

            vs.extend(nvs)
            ts.extend(nts)
        else:
            vs.extend(nvs)
            ts.extend(nts)
            break

    linear_interp(vs)

    return (ts, vs)


def plot_dummy(writers):
    from matplotlib import pyplot as plt
    from matplotlib.ticker import AutoLocator
    from matplotlib.dates import YearLocator, MonthLocator, DateFormatter

    plt.figure()
    ax = plt.gca()
    ax.xaxis.set_major_locator(AutoLocator())
    ax.xaxis.set_major_formatter(DateFormatter('%Y-%m-%d'))

    colors = ['blue', 'red', 'green', 'cyan']
    for i, w in enumerate(writers):
        print(w.ts)
        print(w.ds)
        plt.plot(w.ts, w.ds, c=colors[i])
        plt.fill_between(w.ts, [x[0] for x in w.cis], [x[1] for x in w.cis], alpha=0.05, color=colors[i])

    plt.show()


class SARIMAXWrapper:
    def __init__(self, count=0, ahead=5, model=None, last=None):
        self.count = count
        self.ahead = ahead
        self.model = model
        self.last = last

    def create_model(self, input_config, train_data):
        # create SARIMA model
        parameters = {}

        # common
        parameters['suppress_warnings'] = True

        if input_config['seasonal']:
            parameters['seasonal'] = True
            parameters['m'] = input_config['m']
            if input_config['D'] != None:
                parameters['D'] = input_config['D']

        if input_config['auto']:
            parameters['error_action'] = 'ignore'
            parameters['maxiter'] = 50  # number of iterations when fitting
            parameters['trace'] = True
            parameters['max_p'] = input_config['max_p']
            parameters['max_d'] = input_config['max_d']
            parameters['max_q'] = input_config['max_q']

            if input_config['d'] != None:
                parameters['d'] = input_config['d']

            self.model = pm.auto_arima(train_data, **parameters)
        else:
            if input_config['seasonal']:
                parameters['seasonal_order'] = (
                    input_config['P'], input_config['D'], input_config['Q'], input_config['m'])
            self.model = pm.ARIMA(
                (input_config['p'], input_config['d'], input_config['q']), **parameters)
            self.model.fit(train_data)

        self.count += len(train_data)

    def add_new_obs(self, new_data):
        self.model.update(new_data)
        self.count += len(new_data)

        start = self.count-len(new_data)

        in_sample_predictions, ci = self.model.predict_in_sample(
            start=start, return_conf_int=True)

        return in_sample_predictions, ci

    def predict(self, count):
        return self.model.predict(count, return_conf_int=True)

    def predict_ahead(self):
        return self.predict(self.ahead)

    def save(self):
        return {}

# buffered, have to call sync after last write

class TSReader:
    def __init__(self, ivis):
        pass

    def read_new(self):
        """ read new records

        returns (data, ts)
        """
        pass


class DummyReader:
    def __init__(self):
        import statsmodels.api as sm
        ds = sm.datasets.co2.load()

        self.ts = [x[0] for x in ds.data]
        self.ds = [x[1] for x in ds.data]
        self.read = False

    def read_new(self):
        if self.read:
            return []

        return self.ds, self.ts


class PredWriter:
    def __init__(self, ivis, namespace, signal_set_name, signal_set_desc):
        self.ivis = ivis
        self.signal_set_name = signal_set_name
        self.signal_set_desc = signal_set_desc
        self.namespace = namespace
        self.state = None

    def write(self, data, ts, cis=None):  # TODO: Doc <-  data, ts are array-like
        if cis is None:
            cis = [None for x in data]

        for i in range(len(data)):
            self._write_pred(data[i], ts[i], cis[i])

    def clear(self):
        raise NotImplementedError

    def _create_output_signal_set(self):
        SIGNALS = {
            {
                "cid": "ts",
                "name": "ts",
                "description": "ts",
                "namespace": self.namespace,
                "type": "date",
                "indexed": True,
                "settings": {}
            },
            {
                "cid": "predicted_value",
                "name": "predicted_value",
                "description": "predicted_value",
                "namespace": self.namespace,
                "type": "double",
                "indexed": False,
                "settings": {}
            },
            {
                "cid": "ci_max",
                "name": "ci_max",
                "description": "ci_max",
                "namespace": self.namespace,
                "type": "double",
                "indexed": False,
                "settings": {}
            },
            {
                "cid": "ci_min",
                "name": "ci_min",
                "description": "ci_min",
                "namespace": self.namespace,
                "type": "double",
                "indexed": False,
                "settings": {}
            }
        }

        self.state = self.ivis.create_signal_set(self.signal_set_name, self.namespace, self.signal_set_name, self.signal_set_desc, signals=SIGNALS)

    def _write_pred(self, pred, ts, ci):
        if not ci:
            ci = (None, None)
        doc = {
            self.state[self.signal_set_name]['fields']['ci_max']: ci[0],
            self.state[self.signal_set_name]['fields']['predicted_value']: pred,
            self.state[self.signal_set_name]['fields']['ci_min']: ci[1],
            self.state[self.signal_set_name]['fields']['ts']: ts,
        }

        res = self.ivis.elasticsearch.index(index=self.state[self.signal_set_name]['index'], doc_type='_doc', body=doc)


class DummyPredWriter:
    def __init__(self):
        self.ds = []
        self.ts = []
        self.cis = []

    def write(self, data, ts, cis=None):  # TODO: Doc <-  data, ts are array-like
        self.ds += list(data)
        self.ts += list(ts)

        if cis is None:
            cis = [None for x in data]
        self.cis += list(cis)  # TODO: don't convert to list

    def clear(self):
        self.ds = []
        self.ts = []
        self.cis = []


class IVISPredictionModel:
    def __init__(self, config, reader, history_writer, future_writer, delta=None):
        self.model = None
        self.sw = None # TODO: Get rid of this
        self.old_observations = None
        self.old_observations_ts = None
        self.new_observations = None
        self.new_observations_ts = None
        self.config = config
        self.delta = delta

        self.newest_observation_ts = dt.datetime.min  # Very Long Time Ago

        self.period = None # Period between observations, exact if agg, otherwise avg or median of those between training data obvsvs

        self.rmses = None  # array of rmses (paired with old observations)
        self.rmse = None

        self.reader = reader
        self.history_writer = history_writer
        self.future_writer = future_writer

    def initialize(self):  # first run
        # load training data
        self._get_new_observations()
        self._train_new_model()  # train the model on training data only

        # calculate delta if necessary
        self._calculate_delta()

        # TODO: append test data
        self._calculate_ahead_predictions()

        # compute RMSE

    def update_on_new_observations(self):  # subsequent runs

        # load new observations
        self._get_new_observations()

        # append observations to the trained model, update history data
        self._update_model()

        # TODO: update RMSE

    def check_config(self):
        pass

    def _calculate_delta(self):
        if (self.delta is None):
            ts = self.old_observations_ts
            deltas = []
            for i in range(len(ts) - 1):
                d = pd.Timestamp(ts[i + 1]).to_pydatetime() - pd.Timestamp(ts[i]).to_pydatetime()
                deltas.append(d)
            #print("deltas:", deltas)
            self.delta = deltas[len(deltas)//2] # approx median

    def _get_new_observations(self):
        """Get all new (not yet seen) observations from elastic search"""
        # new_observations should be empty, because at the end of each iteration,
        # they are supposed to be maked old
        assert (self.new_observations is None and self.new_observations_ts is None)

        ds, ts = self.reader.read_new()

        # TODO: This should be moved to aggregation abstract reader
        # Ignore the last observation if 'now' intersects with it's bucket (when agg is used)
        #now = dt.datetime.now()
        #if False: # TODO
        #    # throw away the last member
        #    ts = ts[:-1]
        #    ds = ds[:-1]

        self.new_observations = ds
        self.new_observations_ts = ts

        # Store ts of last observation (so that we know where to start in next interation)
        self.newest_observation_ts = ts[-1]

    def _train_new_model(self):
        train_size = int(self.config['train_portion']
                         * len(self.new_observations))
        train_data, test_data = train_test_split(
            self.new_observations, train_size=train_size)
        train_ts, test_ts = train_test_split(
            self.new_observations_ts, train_size=train_size)

        sw = SARIMAXWrapper()
        sw.create_model(self.config, train_data)
        self.sw = sw # TODO: Remove

        self.model = sw.model  # TODO: Don't use SARIMAXWrapper
        print(self.model.summary())

        # TODO: predictions on train data
        # Might be unnecessary after all?

        self.old_observations = train_data
        self.old_observations_ts = train_ts

        self.new_observations = test_data
        self.new_observations_ts = test_ts

        self._update_model()

        print(self.model.summary())


    def _update_model(self):
        """Adds new observations to the model and computes in sample predictions on them"""
        pred, pred_ci = self.sw.add_new_obs(self.new_observations)
        pred_ts = self.new_observations_ts

        self.history_writer.write(pred, pred_ts, pred_ci)

        self.old_observations += self.new_observations
        self.old_observations_ts += self.new_observations_ts

        self.new_observations = None
        self.new_observations_ts = None


    def _calculate_ahead_predictions(self):
        self.future_writer.clear() # delete old future predictions

        ahead_count = 5
        pred, ci = self.model.predict(ahead_count, return_conf_int=True)
        ts = self._estimate_future_timestamps(ahead_count)
        self.future_writer.write(pred, ts, ci)

    def _estimate_future_timestamps(self, count):
        ts = []
        c = pd.Timestamp(self.newest_observation_ts).to_pydatetime()
        print(c, self.delta)
        for x in range(count):
            c = c + self.delta
            ts.append(c)
        return ts

    def _update_rmse(self):
        pass



def main():
    IVIS = False

    reader = DummyReader()  # move up
    history_writer = DummyPredWriter()
    future_writer = DummyPredWriter()
    state = None

    if IVIS:
        from ivis import ivis
        from elasticsearch import Elasticsearch
        import elasticsearch.helpers as eshelp

        es = ivis.elasticsearch
        state = ivis.state
        params = ivis.parameters
        entities = ivis.entities

        sig_set = entities['signalSets'][params['sigSet']]
        ts = entities['signals'][params['sigSet']][params['ts']]
        values = entities['signals'][params['sigSet']][params['source']]
        ns = sig_set['namespace']
    else:
        # Try loading saved model
        try:
            state = joblib.load("model_state.xz")
        except:
            state = None

        # TODO: Create proper reader and writers (es backend)

    if state is not None: # reuse the old model
        # get model from state
        # look for new values
        # get new predictions
        ivis_model = state['ivis_model']
        ivis_model.update_on_new_observations()
        print("Trying to update")
         #print(state)
    else: # new model
        # TODO: Handle config
        arima_config = {
            'auto': True,
            'seasonal': False,
            'train_portion': 0.75,

            'max_p': 5,
            'max_d': 2,
            'max_q': 5,
            'd': 0,
        }

        ivis_model = IVISPredictionModel(arima_config, reader, history_writer, future_writer)

        #input_config['index_name'] = sig_set['index']
        #input_config['ts_name'] = ts['field']
        #input_config['value_name'] = values['field']
        #input_config['seasonality'] = params['seasonality']
        # load training and test data
        #ts, ds = read_ts(es,
        #                input_config['index_name'],
        #                input_config['ts_name'],
        #                input_config['value_name'],
        #                aggregation=input_config['aggregation'],
        #                start_ts=input_config['start_ts'],
        #                sample_interval=input_config['sample_interval'])

        ivis_model.initialize()

        plot_dummy([history_writer, future_writer])

        # TODO: Save model
        new_state = { 'ivis_model': ivis_model }
        if IVIS:
            pass # TODO
        else:
            joblib.dump(new_state, "model_state.xz")
            #joblib.dump(new_state, "model_state.bin") # uncompresses



if __name__ == "__main__":
    parser = argparse.ArgumentParser("Train/update/use (S)ARIMA model on timeseries data")
    parser.add_argument("--localtest", default=False, action="store_true", help="Local testing mode")

    args = parser.parse_args()
    print(args)

    main()

    #if not args.localtest:
    #    __ivis_main__()
    #else:
        #__test_main__()
    #    pass

