import abc
try:
    # IVIS currently uses Elasticsearch 6 and its documentation discourages
    # from using python library whose major vesion is not matching
    # https://elasticsearch-py.readthedocs.io/en/latest/
    import elasticsearch6 as es
    import elasticsearch6.helpers as esh
    import elasticsearch6_dsl as dsl
except:
    import elasticsearch as es
    import elasticsearch.helpers as esh
    import elasticsearch_dsl as dsl
import datetime as dt
import dateutil as du
import numpy as np
import pendulum

try:
    from ivis import ivis
except:
    class ivis:  # stub for local testing
        elasticsearch = es.Elasticsearch('localhost')

DATEFORMAT = "YYYY-MM-DD[T]HH:mm:ss.SSS[Z]"  # brackets are used for escaping

def _string2date(s: str):
    # convert timestamps to pendulum.DateTime
    return pendulum.from_format(s, DATEFORMAT)

def _date2string(date: pendulum.DateTime):
    return date.format(DATEFORMAT)


class TsWriter:
    def __init__(self, index_name, ts_field, value_field):
        pass


class TsReader:
    def __init__(self, index_name, ts_field, value_field, from_ts='', to_ts=''):
        self.index_name = index_name
        self.ts_field = ts_field
        self.value_field = value_field

        self.latest_ts = None

        self.from_ts = from_ts
        self.to_ts = to_ts

    def set_latest(self, ts):
        self.latest_ts = ts

    def read(self):
        return self._read()

    def _read(self):
        s = dsl.Search(using=ivis.elasticsearch, index=self.index_name).sort(
            {self.ts_field: 'asc'})

        if self.from_ts:
            s = s.filter('range', **{self.ts_field: {'gte': self.from_ts}})
        if self.to_ts:
            s = s.filter('range', **{self.ts_field: {'lt': self.to_ts}})

        if self.latest_ts:  # query only not yet seen values
            s = s.filter('range', **{self.ts_field: {'gt': self.latest_ts}})

        timestamps = []
        values = []

        batch_size = 10000

        i = 0
        while True:
            res = s[i * batch_size:(i + 1) * batch_size].execute()
            timestamps.extend(map(lambda x: x[self.ts_field], res))
            values.extend(map(lambda x: x[self.value_field], res))

            i += 1
            if len(res) < batch_size:
                break

        if len(timestamps) > 0:
            self.set_latest(timestamps[-1])

        # convert string timestamps to pendulum.DateTime
        timestamps = [_string2date(x) for x in timestamps]

        return timestamps, values

# TODO: Old code, needs to be reworked


def estimate_end_ts(first_ts, interval, buckets_count):
    """Estimate end date, such that if you split data between start_ts and end_ts
    with given interval, you get at least (and not significantly more than)
    buckets_count buckets.

    Warning: This is only approximate estimation and end_ts doesn't coincide with a respective
    bucket end!Last bucket should therefore be ignored. """
    try:
        start_date = dt.datetime.strptime(first_ts, pythondateformat)
    except ValueError:
        start_date = dt.datetime.strptime(first_ts, pythondateformat2)

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


esdateformat = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"
pythondateformat = "%Y-%m-%dT%H:%M:%S.000Z"
pythondateformat2 = "%Y-%m-%dT%H:%M:%S"

# TODO: From old code, neetds to be reworked


class TsAggReader:
    def __init__(self, index_name, ts_field, value_field, agg_interval,
                 agg_method='avg'):
        self.index_name = index_name
        self.ts_field = ts_field
        self.value_field = value_field

        self.agg_method = agg_method
        self.agg_interval = agg_interval

        self.latest_ts = None

    def set_latest(self, ts):
        self.latest_ts = ts

    def read(self):
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
                        data[m] = data[m - 1] + step

        def get_first_ts(es, index_name, ts_name, start_ts=''):
            query = {'size': 1,
                     'sort': {ts_name: 'asc'}}  # we only need the first record
            if start_ts is None or start_ts == '':
                query['query'] = {'match_all': {}}
            else:
                query['query'] = {}
                query['query']['range'] = {ts_name: {'gte': start_ts}}
            results = es.search(index=index_name, body=query)

            return results['hits']['hits'][0]['_source'][ts_name]

        def read_ts_test(es, index_name, ts_name, value_name, start_ts, sample_interval, agg_method, buckets_count):

            approx_end_ts = estimate_end_ts(
                start_ts, sample_interval, buckets_count)
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

            vs = [x['resampled']['value']  # [value_name]
                  for x in [x for x in results['aggregations']['by_sample']['buckets']]]
            ts = [x['key_as_string']
                  for x in [x for x in results['aggregations']['by_sample']['buckets']]]

            return (vs, ts)

        def read_ts_resampled2(es, index_name, ts_name, value_name, start_ts='',    aggregation=False, sample_interval='1M', agg_method='avg'):
            buckets = 100  # approximate count of buckets to get in one request
            first_ts = get_first_ts(es, index_name, ts_name, start_ts)

            vs = []
            ts = []

            while True:
                nvs, nts = read_ts_test(es, index_name, ts_name, value_name,
                                        first_ts, sample_interval, agg_method, buckets)
                if (len(nts) > 1):
                    # we overlap the last bucket with a new one to fix alignment issues
                    first_ts = nts[-1]
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

        ts, ds = read_ts_resampled2(ivis.elasticsearch,
                                    self.index_name,
                                    self.ts_field,
                                    self.value_field,
                                    self.latest_ts,
                                    aggregation=True,
                                    sample_interval=self.agg_interval,
                                    agg_method=self.agg_method)
        if len(ts) > 0:
            self.set_latest(ts[-1])

        return ds, ts

    def _old_read(self):  # read new observations
        agg = dsl.A('date_histogram', field=self.ts_field,
                    interval=self.agg_interval,
                    format="yyyy-MM-dd'T'HH:mm:ss.SSS'Z'")
        s = dsl.Search(using=ivis.elasticsearch, index=self.index_name).sort(
            {self.ts_field: 'asc'})
        if self.latest_ts:  # query only not yet seen values
            s = s.filter('range', **{self.ts_field: {'gt': self.latest_ts}})
        s.aggs.bucket()

        res = s.execute()
        return res

def estimate_delta(timestamps, sample_size=1000):
    # timestamps is of [pendulum.DateTime]
    last_ts = timestamps[-1] # TODO
    # Only take sample of sample_size into account. We are taking a median here
    # to compansate for *a few* ptential missing values. In case there are many,
    # data should definitely somehow preprocessed.

    # Default value of 1000 might be a bit of a overkill, but it should still be
    # reasonably fast to process. We on the other hand don't want to unnecessarily
    # go through all the data to find the exact median, because we presume the
    # data to be evenly spaced, except for a few potential missing values.
    timestamps = timestamps[:sample_size]

    # convert timestamps to floats for a bit
    timestamps = [x.float_timestamp for x in timestamps]
    # take difference between each two following timestamps
    zipped = zip(timestamps[1:], timestamps[:-1])
    differences = [x[0] - x[1] for x in zipped]
    # TODO: doing this in numpy would have been faster?
    median = np.median(differences)

    # convert back to pendulum
    delta_time = pendulum.duration(seconds=median)
    return TsDelta(last_ts, delta_time)

def logical_delta(interval):
    intervals = {
        'ms': pendulum.Duration(milliseconds=1),
        's': pendulum.Duration(seconds=1),
        'm': pendulum.Duration(minutes=1),
        'h': pendulum.Duration(hours=1),
        'd': pendulum.Duration(days=1),
        'M': pendulum.duration(months=1),
        'q': pendulum.duration(months=3),  # FIXME: Does this work?
        'y': pendulum.duration(years=1)
    }

    # Note: This also parses some weird things like '1M0' (like '10M')
    # it might be better to explicitly check the format and raise exception?
    num = ''.join([x for x in interval if x.isdigit()])
    marker = ''.join([x for x in interval if not x.isdigit()])

    try:
        return int(num) * intervals[marker]
    except KeyError:
        raise ValueError

class TsDelta: # invent future timestamps
    def __init__(self, last_ts, delta_time: pendulum.Duration):
        self.valid = False
        self.last_ts = last_ts
        self.delta_time = delta_time

    def _next_ts(self):
        return self.last_ts + self.delta_time

    def peek(self): # preview next timestamp
        return self._next_ts()

    def read(self): # read (and consume) next timestamp
        self.last_ts = self._next_ts()
        return self.last_ts

    def set_latest(self, latest_ts):
        self.last_ts = latest_ts

    def copy(self):
        return TsDelta(self.last_ts, self.delta_time)


def _pred_signals(namespace: int):
    SIGNALS = [
        {
            "cid": "ts",
            "name": "ts",
            "description": "ts",
            "namespace": namespace,
            "type": "date",
            "indexed": True,
            "settings": {}
        },
        {
            "cid": "predicted_value",
            "name": "predicted_value",
            "description": "predicted_value",
            "namespace": namespace,
            "type": "double",
            "indexed": False,
            "settings": {}
        },
        {  # We may not do cofidence intervals after all
            "cid": "ci_max",
            "name": "ci_max",
            "description": "ci_max",
            "namespace": namespace,
            "type": "double",
            "indexed": False,
            "settings": {}
        },
        {
            "cid": "ci_min",
            "name": "ci_min",
            "description": "ci_min",
            "namespace": namespace,
            "type": "double",
            "indexed": False,
            "settings": {}
        }
    ]

    return SIGNALS

def _create_predictions_signal_set(set_name: str, namespace: int):
    return ivis.create_signal_set(set_name, namespace, set_name, set_name, signals=_pred_signals(namespace))

def _get_field(set_name: str, field_name: str):
    return ivis.entities['signals'][set_name][field_name]['field']

class PredWriter:
    # note: has to handle delta estimation - via object we give to it
    def __init__(self, index_name, time_delta):
        self.time_delta = time_delta

    def write1(self, ts, pred):
        pass


class PredReader:
    def __init__(self, index_name):
        self.TsReader = TsReader(index_name, 'ts', 'value')

if __name__ == "__main__":
    def test():
        tsr = TsReader('mhn-co2', 'ts', 'value')
        print(tsr._read())

        tsar = TsAggReader('mhn-co2', 'ts', 'value', '1M')
        print(tsar.read())

    test()
