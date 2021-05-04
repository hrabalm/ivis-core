import logging

from collections import defaultdict
from itertools import chain
from ivis import ivis

def ensure_output_sets_exist(output_config):
    source_set = output_config['source_set']
    namespace = ivis.entities['signalSets'][source_set]['namespace']
    future_sets = [output_config['future_set']]
    ahead_sets = output_config['ahead_sets'].values()
    for set_cid in chain(future_sets, ahead_sets):
        if set_cid not in ivis.entities['signalSets']:
            ivis.create_signal_set(
                set_cid, namespace, signals=output_config['signals'])

class PredictionsWriter:
    """Helper object for writing time series predictions following the common
    output format.

    Example usage:
    with PredictionWriter(output_config) as writer:
        writer.write(record, ahead)

    Or with explicit close():
    writer = PredictionWriter(output_config)
    writer.write(record, ahead)
    writer.close()
    """
    def __init__(self, output_config, buffer_size=1000):
        class RecordsHandler:
            """Helper wrapper around a dictionary of lists that keeps track of
            total count of elements."""

            def __init__(self):
                self.records_by_set = defaultdict(list)
                self.count = 0

            def __len__(self):
                return self.count

            def __getitem__(self, key):
                return self.records_by_set[key]

            def insert(self, set_cid: str, record):
                self.records_by_set[set_cid].append(record)
                self.count += 1

            def items(self):
                for k, v in self.records_by_set.items():
                    yield k, v
        self.RecordsHandler = RecordsHandler

        self.records_by_set = RecordsHandler()
        self.config = output_config
        self.closed = False
        self.buffer_size = buffer_size

    def _ahead_set(self, ahead: int):
        return self.config['ahead_sets'][str(ahead)]

    def _future_set(self):
        return self.config['future_set']

    def write(self, record, ahead: int):
        """Write record to appropriate signal sets (buffered)

        Args:
            record ([type]): [description]
            ahead (int): [description]

        Raises:
            ValueError: [description]
        """
        if self.closed:
            raise ValueError("write on closed PredictionsWriter")

        ahead_set = self._ahead_set(ahead)
        future_set = self._future_set()

        self.records_by_set.insert(ahead_set, record)
        self.records_by_set.insert(future_set, record)

        if len(self.records_by_set) >= self.buffer_size:
            self.flush()

    def write_unbuffered(self, record, ahead:int):
        if self.closed:
            raise ValueError("write_unbuffered on closed PredictionsWriter")

        ahead_set = self._ahead_set(ahead)
        future_set = self._future_set()

        ivis.insert_record(ahead_set, record)
        ivis.insert_record(future_set, record)

    def clear_future(self):
        set_cid = self._future_set()
        ivis.clear_records(set_cid)

    def flush(self):
        for set_cid, records in self.records_by_set.items():
            ivis.insert_records(set_cid, records)
        self.records_by_set = self.RecordsHandler()

    def close(self):
        if len(self.records_by_set) > 0:
            self.flush()
        self.closed = True

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def __del__(self):
        if not self.closed:
            logging.warning("PredictionsWriter was not closed.")
        self.close()
